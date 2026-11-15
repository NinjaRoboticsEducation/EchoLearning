"""Local EchoLearning MCP server exposing shared services over stdio and HTTP JSON-RPC."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import sys
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    from mcp.server.mcpserver import MCPServer as FastMCP

from pydantic import Field

from .config import API_PORT
from .schemas.transcript_schemas import RetokenizeResponse, WordToken
from .tools.tokenizer_tools import tokenize_sentence

# Never write logs to stdout; stdout is reserved for stdio MCP JSON-RPC frames (U09)
logging.basicConfig(stream=sys.stderr, level=logging.INFO)
logger = logging.getLogger("echolearning.mcp")

mcp = FastMCP("EchoLearning")
server = mcp
Language = Literal["en", "ja"]

# In-memory background task handles paired with optional SQLite job persistence
_job_tasks: dict[str, asyncio.Task[Any]] = {}
_job_records: dict[str, dict[str, Any]] = {}


def _get_db():
    """Lazily imports adk_backend.db if available and ensures schema initialization."""
    try:
        from . import db  # type: ignore[attr-defined]

        init_fn = getattr(db, "init_db", None)
        if callable(init_fn):
            init_fn()
        return db
    except Exception:
        return None


def _neutralize_csv_cell(val: Any) -> str:
    """Prevents spreadsheet formula injection (D07) when exporting CSV cells."""
    s = "" if val is None else str(val)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


@mcp.tool()
def get_capabilities() -> dict[str, Any]:
    """List the learning languages, transports, and tools available in EchoLearning."""
    db = _get_db()
    return {
        "name": "EchoLearning",
        "learningLanguages": ["en", "ja"],
        "transports": ["stdio", "streamable_http"],
        "httpEndpoint": f"http://127.0.0.1:{API_PORT}/mcp",
        "sqliteReady": db is not None,
        "tools": [
            "get_capabilities",
            "fetch_transcript",
            "start_transcript_job",
            "get_job_status",
            "cancel_job",
            "retokenize_text",
            "lookup_word",
            "save_vocabulary",
            "list_vocabulary",
            "list_materials",
            "list_history",
            "pronounce_text",
            "export_study_data",
        ],
    }


@mcp.tool()
async def fetch_transcript(
    url_or_id: Annotated[str, Field(min_length=1, max_length=512)],
    preferred_language: Language = "en",
) -> dict[str, Any]:
    """Fetch, align, tokenize, and save a YouTube transcript for shadowing practice."""
    from .routes.transcript_routes import extract_youtube_id, generate_transcript_stream

    video_id = extract_youtube_id(url_or_id)
    if not video_id:
        raise ValueError("Provide a valid 11-character YouTube URL or video ID.")

    final_video: dict[str, Any] | None = None
    error_msg: str | None = None

    async for line in generate_transcript_stream(video_id, preferred_language):
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            event = json.loads(trimmed)
        except Exception:
            continue
        if event.get("type") == "complete":
            final_video = event.get("video")
        elif event.get("type") == "error":
            error_msg = event.get("error")

    if not final_video:
        raise RuntimeError(error_msg or f"Could not fetch transcript for {video_id}.")

    db = _get_db()
    if db is not None:
        save_fn = getattr(db, "save_material", None)
        if callable(save_fn):
            try:
                save_fn(final_video)
            except Exception as exc:
                logger.warning("Failed to persist fetched material %s: %s", video_id, exc)

    return {"status": "ok", "video": final_video}


@mcp.tool()
async def start_transcript_job(
    url_or_id: Annotated[str, Field(min_length=1, max_length=512)],
    preferred_language: Language = "en",
) -> dict[str, Any]:
    """Start an asynchronous transcript extraction job and return its jobId."""
    from .routes.transcript_routes import extract_youtube_id

    video_id = extract_youtube_id(url_or_id)
    if not video_id:
        raise ValueError("Provide a valid 11-character YouTube URL or video ID.")

    job_id = f"job_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    record: dict[str, Any] = {
        "jobId": job_id,
        "videoId": video_id,
        "preferredLanguage": preferred_language,
        "status": "running",
        "createdAt": now,
        "updatedAt": now,
        "result": None,
        "error": None,
    }
    _job_records[job_id] = record
    db = _get_db()
    if db is not None and hasattr(db, "create_job"):
        try:
            db.create_job(job_id, "transcript", {"videoId": video_id, "preferredLanguage": preferred_language})
            db.update_job(job_id, "running")
        except Exception as exc:
            logger.debug("Failed to persist job start in SQLite: %s", exc)

    async def _runner() -> None:
        try:
            res = await fetch_transcript(url_or_id=video_id, preferred_language=preferred_language)
            record["status"] = "succeeded"
            record["result"] = res.get("video")
            db_inner = _get_db()
            if db_inner is not None and hasattr(db_inner, "update_job"):
                db_inner.update_job(job_id, "succeeded", result=record["result"])
        except asyncio.CancelledError:
            record["status"] = "cancelled"
            record["error"] = "Job was cancelled."
            db_inner = _get_db()
            if db_inner is not None and hasattr(db_inner, "update_job"):
                db_inner.update_job(job_id, "cancelled", error=record["error"])
            raise
        except Exception as exc:
            record["status"] = "failed"
            record["error"] = str(exc)
            db_inner = _get_db()
            if db_inner is not None and hasattr(db_inner, "update_job"):
                db_inner.update_job(job_id, "failed", error=record["error"])
        finally:
            record["updatedAt"] = datetime.now(timezone.utc).isoformat()

    _job_tasks[job_id] = asyncio.create_task(_runner())
    return {
        "jobId": job_id,
        "videoId": video_id,
        "status": record["status"],
        "createdAt": now,
    }


@mcp.tool()
def get_job_status(
    job_id: Annotated[str, Field(min_length=1, max_length=128)],
) -> dict[str, Any]:
    """Check the status and result of a transcript generation job."""
    record = _job_records.get(job_id)
    if not record:
        db = _get_db()
        if db is not None and hasattr(db, "get_job"):
            db_rec = db.get_job(job_id)
            if db_rec:
                return db_rec
        return {"jobId": job_id, "status": "not_found", "error": f"Unknown jobId: {job_id}"}
    return dict(record)


@mcp.tool()
def cancel_job(
    job_id: Annotated[str, Field(min_length=1, max_length=128)],
) -> dict[str, Any]:
    """Cancel a running transcript generation job."""
    record = _job_records.get(job_id)
    if not record:
        return {"jobId": job_id, "status": "not_found", "cancelled": False}

    task = _job_tasks.get(job_id)
    if task and not task.done():
        task.cancel()
        record["status"] = "cancelled"
        record["updatedAt"] = datetime.now(timezone.utc).isoformat()
        db = _get_db()
        if db is not None and hasattr(db, "update_job"):
            try:
                db.update_job(job_id, "cancelled", error="Job was cancelled.")
            except Exception:
                pass
        return {"jobId": job_id, "status": "cancelled", "cancelled": True}

    return {"jobId": job_id, "status": record["status"], "cancelled": False}


@mcp.tool()
def retokenize_text(
    text: Annotated[str, Field(min_length=1, max_length=20_000)],
    language: Language = "en",
) -> RetokenizeResponse:
    """Split lesson text into tokens and attach readings (Furigana) where available."""
    if not text.strip():
        raise ValueError("Provide nonblank lesson text.")
    tokens = tokenize_sentence(text.strip(), language)
    return RetokenizeResponse(tokens=[WordToken(**token) for token in tokens])


@mcp.tool()
async def lookup_word(
    word: Annotated[str, Field(min_length=1, max_length=256)],
    sentence: Annotated[str, Field(max_length=2_000)] = "",
    language: Language = "en",
) -> dict[str, Any]:
    """Look up a word in context using the local EchoLearning dictionary service."""
    import re
    import httpx
    from .agents.dictionary_agent import lookup_word_with_agent

    clean_word = re.sub(r"[.,!?;:\"'()「」『』、。！？—\-/?#%&]+", "", word.strip()).strip() or word.strip()
    if not clean_word:
        raise ValueError("Provide a nonblank word.")

    try:
        return await lookup_word_with_agent(
            word=clean_word,
            sentence=sentence,
            language=language,
        )
    except Exception as local_exc:
        logger.debug("Direct dictionary lookup fallback to HTTP: %s", local_exc)
        try:
            async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                response = await client.post(
                    f"http://127.0.0.1:{API_PORT}/api/dictionary/lookup",
                    json={"word": clean_word, "sentence": sentence, "language": language},
                )
                response.raise_for_status()
                return response.json()
        except Exception as http_exc:
            raise RuntimeError(f"Dictionary lookup failed: {http_exc}") from http_exc


@mcp.tool()
def save_vocabulary(
    word: Annotated[str, Field(min_length=1, max_length=256)],
    definition: Annotated[str, Field(min_length=1, max_length=4000)],
    language: Language = "en",
    context: Annotated[str, Field(max_length=2000)] = "",
    phonetic: Annotated[str, Field(max_length=256)] = "",
) -> dict[str, Any]:
    """Save a vocabulary item into EchoLearning's local SQLite vault."""
    db = _get_db()
    if db is None:
        raise RuntimeError("SQLite database module is not initialized.")

    save_fn = getattr(db, "save_vocab_item", None)
    if not callable(save_fn):
        raise RuntimeError("save_vocab_item is unavailable in adk_backend.db.")

    item_id = f"vocab_{uuid.uuid4().hex[:12]}"
    item = {
        "id": item_id,
        "word": word.strip(),
        "lemma": word.strip(),
        "language": language,
        "reading": phonetic.strip() or word.strip(),
        "ipa": phonetic.strip() if language == "en" else None,
        "partOfSpeech": "unknown",
        "contextualMeaning": definition.strip(),
        "dictionaryDefinitions": [definition.strip()],
        "sourceSentence": context.strip(),
        "videoId": "",
        "videoTitle": "MCP Saved Vocabulary",
        "timestampSec": 0.0,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    saved = save_fn(item)
    return {"status": "saved", "item": saved if isinstance(saved, dict) else item}


@mcp.tool()
def list_vocabulary(
    language: Literal["", "en", "ja"] = "",
) -> dict[str, Any]:
    """List saved vocabulary items from EchoLearning's SQLite vault."""
    db = _get_db()
    if db is None:
        return {"items": [], "count": 0}
    list_fn = getattr(db, "list_vocab_items", None)
    items = list_fn() if callable(list_fn) else []
    if language in ("en", "ja"):
        items = [it for it in items if it.get("language") == language]
    return {"items": items, "count": len(items)}


@mcp.tool()
def list_materials() -> dict[str, Any]:
    """List saved YouTube shadowing materials stored in EchoLearning's SQLite vault."""
    db = _get_db()
    if db is None:
        return {"materials": [], "count": 0}
    list_fn = getattr(db, "list_materials", None)
    materials = list_fn() if callable(list_fn) else []
    return {"materials": materials, "count": len(materials)}


@mcp.tool()
def list_history() -> dict[str, Any]:
    """List saved shadowing practice history reports from EchoLearning's SQLite vault."""
    db = _get_db()
    if db is None:
        return {"reports": [], "count": 0}
    list_fn = getattr(db, "list_history_reports", None)
    reports = list_fn() if callable(list_fn) else []
    return {"reports": reports, "count": len(reports)}


@mcp.tool()
async def pronounce_text(
    text: Annotated[str, Field(min_length=1, max_length=500)],
    language: Language = "en",
) -> dict[str, Any]:
    """Synthesize offline spoken audio (base64 WAV) for an English or Japanese phrase."""
    from .routes.tts_routes import TtsRequest, pronounce_text as tts_pronounce

    req = TtsRequest(text=text.strip(), language=language)
    return await tts_pronounce(req)


@mcp.tool()
def export_study_data(
    format: Literal["json", "csv"] = "json",
) -> dict[str, Any]:
    """Export EchoLearning materials, vocabulary, and practice history in JSON or safe CSV."""
    db = _get_db()
    materials = db.list_materials() if db and hasattr(db, "list_materials") else []
    vocabulary = db.list_vocab_items() if db and hasattr(db, "list_vocab_items") else []
    history = db.list_history_reports() if db and hasattr(db, "list_history_reports") else []

    if format == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["word", "language", "reading", "contextualMeaning", "sourceSentence", "createdAt"])
        for item in vocabulary:
            writer.writerow(
                [
                    _neutralize_csv_cell(item.get("word", "")),
                    _neutralize_csv_cell(item.get("language", "")),
                    _neutralize_csv_cell(item.get("reading", "")),
                    _neutralize_csv_cell(item.get("contextualMeaning", "")),
                    _neutralize_csv_cell(item.get("sourceSentence", "")),
                    _neutralize_csv_cell(item.get("createdAt", "")),
                ]
            )
        return {
            "format": "csv",
            "vocabularyCsv": buf.getvalue(),
            "counts": {
                "materials": len(materials),
                "vocabulary": len(vocabulary),
                "history": len(history),
            },
        }

    return {
        "version": 2,
        "format": "json",
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "materials": materials,
        "vocabulary": vocabulary,
        "history": history,
    }


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
