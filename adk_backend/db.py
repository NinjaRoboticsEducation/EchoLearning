"""Durable SQLite WAL persistence and local audio repository for EchoLearning."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .config import get_audio_dir, get_db_path

SAFE_ID_REGEX = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")

DEFAULT_SETTINGS: dict[str, Any] = {
    "tailscale_enabled": True,
    "mcp_http_enabled": True,
    "mcp_stdio_enabled": True,
    "active_model_id": "qwen3.5-9b-q6_k",
}

SETTINGS_KEY_ALIASES: dict[str, str] = {
    "tailscale_enabled": "tailscale_enabled",
    "tailscaleEnabled": "tailscale_enabled",
    "mcp_http_enabled": "mcp_http_enabled",
    "mcpHttpEnabled": "mcp_http_enabled",
    "mcp_stdio_enabled": "mcp_stdio_enabled",
    "mcpStdioEnabled": "mcp_stdio_enabled",
    "active_model_id": "active_model_id",
    "activeModelId": "active_model_id",
    "activeProfileId": "active_model_id",
}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _safe_json_loads(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _ext_for_mime(mime_type: str | None) -> str:
    mt = (mime_type or "audio/wav").lower()
    if "webm" in mt:
        return ".webm"
    if "ogg" in mt:
        return ".ogg"
    if "mp4" in mt or "m4a" in mt:
        return ".m4a"
    if "mpeg" in mt or "mp3" in mt:
        return ".mp3"
    return ".wav"


def get_connection(db_path: Path | None = None) -> sqlite3.Connection:
    """Opens a SQLite connection configured with WAL mode and foreign keys."""
    resolved = db_path or get_db_path()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(resolved), timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


@contextmanager
def db_session(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """Context manager that commits on success, rolls back on error, and closes."""
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Path | None = None) -> Path:
    """Initializes SQLite tables, indexes, and default settings."""
    resolved = db_path or get_db_path()
    get_audio_dir().mkdir(parents=True, exist_ok=True)
    with db_session(resolved) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS materials (
                video_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                channel TEXT NOT NULL DEFAULT '',
                language TEXT NOT NULL DEFAULT 'en',
                level TEXT NOT NULL DEFAULT 'Intermediate',
                duration_sec REAL NOT NULL DEFAULT 0.0,
                caption_source TEXT NOT NULL DEFAULT 'youtube_manual',
                caption_note TEXT NOT NULL DEFAULT '',
                description TEXT,
                source TEXT NOT NULL DEFAULT 'youtube',
                revision INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS material_segments (
                id TEXT NOT NULL,
                video_id TEXT NOT NULL,
                seg_index INTEGER NOT NULL,
                start_time REAL NOT NULL DEFAULT 0.0,
                end_time REAL NOT NULL DEFAULT 0.0,
                text TEXT NOT NULL,
                translation TEXT,
                tokens_json TEXT,
                PRIMARY KEY (video_id, id),
                FOREIGN KEY (video_id) REFERENCES materials(video_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_material_segments_order
                ON material_segments(video_id, seg_index);

            CREATE TABLE IF NOT EXISTS vocabulary (
                id TEXT PRIMARY KEY,
                word TEXT NOT NULL,
                lemma TEXT NOT NULL DEFAULT '',
                language TEXT NOT NULL,
                reading TEXT NOT NULL DEFAULT '',
                romaji TEXT,
                ipa TEXT,
                pitch_accent TEXT,
                part_of_speech TEXT NOT NULL DEFAULT '',
                contextual_meaning TEXT NOT NULL DEFAULT '',
                dictionary_definitions_json TEXT NOT NULL DEFAULT '[]',
                source_sentence TEXT NOT NULL DEFAULT '',
                video_id TEXT NOT NULL DEFAULT '',
                video_title TEXT NOT NULL DEFAULT '',
                timestamp_sec REAL NOT NULL DEFAULT 0.0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_vocab_lang_word
                ON vocabulary(language, lower(word));

            CREATE TABLE IF NOT EXISTS practice_recordings (
                id TEXT PRIMARY KEY,
                report_id TEXT,
                video_id TEXT,
                language TEXT NOT NULL DEFAULT 'en',
                file_path TEXT NOT NULL,
                mime_type TEXT NOT NULL DEFAULT 'audio/wav',
                size_bytes INTEGER NOT NULL DEFAULT 0,
                sha256 TEXT NOT NULL DEFAULT '',
                duration_sec REAL NOT NULL DEFAULT 0.0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS history_reports (
                id TEXT PRIMARY KEY,
                video_id TEXT,
                video_title TEXT,
                language TEXT NOT NULL DEFAULT 'en',
                mode TEXT NOT NULL DEFAULT 'listen_repeat',
                created_at TEXT NOT NULL,
                overall_score REAL NOT NULL DEFAULT 0.0,
                recording_id TEXT,
                is_demo INTEGER NOT NULL DEFAULT 0,
                report_json TEXT NOT NULL,
                FOREIGN KEY (recording_id) REFERENCES practice_recordings(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_history_created
                ON history_reports(created_at DESC);

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS migration_receipts (
                id TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                counts_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        now = _utc_now()
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                """
                INSERT OR IGNORE INTO app_settings (key, value_json, updated_at)
                VALUES (?, ?, ?)
                """,
                (key, json.dumps(value), now),
            )
    return resolved


# ---------------------------------------------------------------------------
# Materials & Segments
# ---------------------------------------------------------------------------


def _row_to_segment(row: sqlite3.Row) -> dict[str, Any]:
    seg: dict[str, Any] = {
        "id": row["id"],
        "index": row["seg_index"],
        "startTime": float(row["start_time"]),
        "endTime": float(row["end_time"]),
        "text": row["text"],
    }
    if row["translation"] is not None:
        seg["translation"] = row["translation"]
    tokens = _safe_json_loads(row["tokens_json"], None)
    if tokens is not None:
        seg["tokens"] = tokens
    return seg


def _row_to_material(row: sqlite3.Row, segments: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "videoId": row["video_id"],
        "title": row["title"],
        "channel": row["channel"],
        "language": row["language"],
        "level": row["level"],
        "durationSec": float(row["duration_sec"]),
        "captionSource": row["caption_source"],
        "captionNote": row["caption_note"],
        "description": row["description"],
        "source": row["source"],
        "revision": int(row["revision"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "segments": segments,
    }


def save_material(material_dict: dict[str, Any]) -> dict[str, Any]:
    """Upserts a VideoMaterial and all its segments transactionally."""
    init_db()
    video_id = str(material_dict.get("videoId") or "").strip()
    if not video_id:
        raise ValueError("videoId is required.")

    now = _utc_now()
    title = str(material_dict.get("title") or f"YouTube Video ({video_id})")
    channel = str(material_dict.get("channel") or "YouTube Creator")
    language = str(material_dict.get("language") or "en")
    if language not in ("en", "ja"):
        language = "en"
    level = str(material_dict.get("level") or "Intermediate")
    duration_sec = float(material_dict.get("durationSec") or 0.0)
    caption_source = str(material_dict.get("captionSource") or "youtube_manual")
    caption_note = str(material_dict.get("captionNote") or "Extracted captions")
    description = material_dict.get("description")
    source = str(material_dict.get("source") or caption_source)
    segments = material_dict.get("segments") or []

    with db_session() as conn:
        existing = conn.execute(
            "SELECT revision, created_at FROM materials WHERE video_id = ?",
            (video_id,),
        ).fetchone()
        revision = (int(existing["revision"]) + 1) if existing else 1
        created_at = existing["created_at"] if existing else str(material_dict.get("createdAt") or now)

        conn.execute(
            """
            INSERT INTO materials (
                video_id, title, channel, language, level, duration_sec,
                caption_source, caption_note, description, source, revision,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
                title = excluded.title,
                channel = excluded.channel,
                language = excluded.language,
                level = excluded.level,
                duration_sec = excluded.duration_sec,
                caption_source = excluded.caption_source,
                caption_note = excluded.caption_note,
                description = excluded.description,
                source = excluded.source,
                revision = excluded.revision,
                updated_at = excluded.updated_at
            """,
            (
                video_id,
                title,
                channel,
                language,
                level,
                duration_sec,
                caption_source,
                caption_note,
                description,
                source,
                revision,
                created_at,
                now,
            ),
        )

        conn.execute("DELETE FROM material_segments WHERE video_id = ?", (video_id,))
        for idx, seg in enumerate(segments):
            if not isinstance(seg, dict):
                continue
            seg_id = str(seg.get("id") or f"seg-{video_id}-{idx}")
            seg_index = int(seg.get("index") if seg.get("index") is not None else idx)
            start_time = float(seg.get("startTime") or 0.0)
            end_time = float(seg.get("endTime") or start_time)
            text = str(seg.get("text") or "")
            translation = seg.get("translation")
            tokens = seg.get("tokens")
            tokens_json = json.dumps(tokens, ensure_ascii=False) if tokens is not None else None
            conn.execute(
                """
                INSERT INTO material_segments (
                    id, video_id, seg_index, start_time, end_time, text, translation, tokens_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (seg_id, video_id, seg_index, start_time, end_time, text, translation, tokens_json),
            )

    saved = get_material(video_id)
    assert saved is not None
    return saved


def get_material(video_id: str) -> dict[str, Any] | None:
    """Fetches a single saved material with ordered segments."""
    init_db()
    with db_session() as conn:
        row = conn.execute(
            "SELECT * FROM materials WHERE video_id = ?",
            (video_id,),
        ).fetchone()
        if not row:
            return None
        seg_rows = conn.execute(
            "SELECT * FROM material_segments WHERE video_id = ? ORDER BY seg_index ASC",
            (video_id,),
        ).fetchall()
        return _row_to_material(row, [_row_to_segment(s) for s in seg_rows])


def list_materials() -> list[dict[str, Any]]:
    """Lists all saved materials ordered by most recently updated."""
    init_db()
    with db_session() as conn:
        mat_rows = conn.execute(
            "SELECT * FROM materials ORDER BY updated_at DESC"
        ).fetchall()
        seg_rows = conn.execute(
            "SELECT * FROM material_segments ORDER BY video_id, seg_index ASC"
        ).fetchall()

        segs_by_video: dict[str, list[dict[str, Any]]] = {}
        for s in seg_rows:
            segs_by_video.setdefault(s["video_id"], []).append(_row_to_segment(s))

        return [_row_to_material(m, segs_by_video.get(m["video_id"], [])) for m in mat_rows]


def update_material_segment(
    video_id: str,
    segment_id: str,
    text: str,
    tokens: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Updates an existing transcript segment's text and optional tokens."""
    init_db()
    now = _utc_now()
    with db_session() as conn:
        existing = conn.execute(
            "SELECT * FROM material_segments WHERE video_id = ? AND id = ?",
            (video_id, segment_id),
        ).fetchone()
        if not existing:
            return None

        tokens_json = (
            json.dumps(tokens, ensure_ascii=False)
            if tokens is not None
            else existing["tokens_json"]
        )
        conn.execute(
            """
            UPDATE material_segments
            SET text = ?, tokens_json = ?
            WHERE video_id = ? AND id = ?
            """,
            (text, tokens_json, video_id, segment_id),
        )
        conn.execute(
            """
            UPDATE materials
            SET revision = revision + 1, updated_at = ?
            WHERE video_id = ?
            """,
            (now, video_id),
        )
        updated = conn.execute(
            "SELECT * FROM material_segments WHERE video_id = ? AND id = ?",
            (video_id, segment_id),
        ).fetchone()
        return _row_to_segment(updated) if updated else None


def delete_material(video_id: str) -> bool:
    """Deletes a saved material and its segments."""
    init_db()
    with db_session() as conn:
        cur = conn.execute("DELETE FROM materials WHERE video_id = ?", (video_id,))
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------


def _row_to_vocab(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "word": row["word"],
        "lemma": row["lemma"],
        "language": row["language"],
        "reading": row["reading"],
        "romaji": row["romaji"],
        "ipa": row["ipa"],
        "pitchAccent": row["pitch_accent"],
        "partOfSpeech": row["part_of_speech"],
        "contextualMeaning": row["contextual_meaning"],
        "dictionaryDefinitions": _safe_json_loads(row["dictionary_definitions_json"], []),
        "sourceSentence": row["source_sentence"],
        "videoId": row["video_id"],
        "videoTitle": row["video_title"],
        "timestampSec": float(row["timestamp_sec"]),
        "createdAt": row["created_at"],
    }


def save_vocab_item(item_dict: dict[str, Any]) -> dict[str, Any]:
    """Saves or updates a vocabulary item, deduplicating by (language, word.lower())."""
    init_db()
    word = str(item_dict.get("word") or "").strip()
    if not word:
        raise ValueError("word is required.")

    language = str(item_dict.get("language") or "en")
    if language not in ("en", "ja"):
        language = "en"

    now = _utc_now()
    item_id = str(item_dict.get("id") or f"vocab_{uuid.uuid4().hex[:12]}")
    lemma = str(item_dict.get("lemma") or word)
    reading = str(item_dict.get("reading") or "")
    romaji = item_dict.get("romaji")
    ipa = item_dict.get("ipa")
    pitch_accent = item_dict.get("pitchAccent")
    part_of_speech = str(item_dict.get("partOfSpeech") or "")
    contextual_meaning = str(item_dict.get("contextualMeaning") or "")
    defs = item_dict.get("dictionaryDefinitions")
    defs_list = [str(d) for d in defs] if isinstance(defs, list) else []
    source_sentence = str(item_dict.get("sourceSentence") or "")
    video_id = str(item_dict.get("videoId") or "")
    video_title = str(item_dict.get("videoTitle") or "")
    timestamp_sec = float(item_dict.get("timestampSec") or 0.0)
    created_at = str(item_dict.get("createdAt") or now)

    with db_session() as conn:
        # Remove duplicate (language, lower(word)) entries if ID differs
        conn.execute(
            "DELETE FROM vocabulary WHERE language = ? AND lower(word) = lower(?) AND id != ?",
            (language, word, item_id),
        )
        conn.execute(
            """
            INSERT INTO vocabulary (
                id, word, lemma, language, reading, romaji, ipa, pitch_accent,
                part_of_speech, contextual_meaning, dictionary_definitions_json,
                source_sentence, video_id, video_title, timestamp_sec, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                word = excluded.word,
                lemma = excluded.lemma,
                language = excluded.language,
                reading = excluded.reading,
                romaji = excluded.romaji,
                ipa = excluded.ipa,
                pitch_accent = excluded.pitch_accent,
                part_of_speech = excluded.part_of_speech,
                contextual_meaning = excluded.contextual_meaning,
                dictionary_definitions_json = excluded.dictionary_definitions_json,
                source_sentence = excluded.source_sentence,
                video_id = excluded.video_id,
                video_title = excluded.video_title,
                timestamp_sec = excluded.timestamp_sec
            """,
            (
                item_id,
                word,
                lemma,
                language,
                reading,
                romaji,
                ipa,
                pitch_accent,
                part_of_speech,
                contextual_meaning,
                json.dumps(defs_list, ensure_ascii=False),
                source_sentence,
                video_id,
                video_title,
                timestamp_sec,
                created_at,
            ),
        )
        row = conn.execute("SELECT * FROM vocabulary WHERE id = ?", (item_id,)).fetchone()
        assert row is not None
        return _row_to_vocab(row)


def list_vocab_items(language: str = "") -> list[dict[str, Any]]:
    """Lists saved vocabulary items, optionally filtered by language."""
    init_db()
    with db_session() as conn:
        if language in ("en", "ja"):
            rows = conn.execute(
                "SELECT * FROM vocabulary WHERE language = ? ORDER BY created_at DESC",
                (language,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM vocabulary ORDER BY created_at DESC"
            ).fetchall()
        return [_row_to_vocab(r) for r in rows]


def delete_vocab_item(vocab_id: str) -> bool:
    """Deletes a single vocabulary item."""
    init_db()
    with db_session() as conn:
        cur = conn.execute("DELETE FROM vocabulary WHERE id = ?", (vocab_id,))
        return cur.rowcount > 0


def clear_vocab_items() -> int:
    """Deletes all vocabulary items and returns count deleted."""
    init_db()
    with db_session() as conn:
        cur = conn.execute("DELETE FROM vocabulary")
        return cur.rowcount


# ---------------------------------------------------------------------------
# Practice Recordings & History Reports
# ---------------------------------------------------------------------------


def _extract_data_url_bytes(audio_data_url: str | None) -> tuple[bytes | None, str]:
    if not audio_data_url or not isinstance(audio_data_url, str):
        return None, "audio/wav"
    if not audio_data_url.startswith("data:") or ";base64," not in audio_data_url:
        return None, "audio/wav"
    header, b64_payload = audio_data_url.split(";base64,", 1)
    mime = header[5:] or "audio/wav"
    try:
        return base64.b64decode(b64_payload), mime
    except Exception:
        return None, mime


def _write_audio_file(recording_id: str, audio_bytes: bytes, mime_type: str) -> tuple[str, str]:
    audio_dir = get_audio_dir()
    audio_dir.mkdir(parents=True, exist_ok=True)
    ext = _ext_for_mime(mime_type)
    filename = f"{recording_id}{ext}"
    target = audio_dir / filename
    tmp_path = audio_dir / f".{filename}.{uuid.uuid4().hex[:6]}.tmp"
    tmp_path.write_bytes(audio_bytes)
    os.replace(tmp_path, target)
    digest = hashlib.sha256(audio_bytes).hexdigest()
    return filename, digest


def save_recording_only(
    audio_bytes: bytes,
    language: str = "en",
    video_id: str | None = None,
    duration_sec: float = 0.0,
    mime_type: str = "audio/wav",
) -> dict[str, Any]:
    """Persists a raw recording to data/audio/ and returns its metadata."""
    init_db()
    recording_id = f"rec_{uuid.uuid4().hex[:12]}"
    filename, digest = _write_audio_file(recording_id, audio_bytes, mime_type)
    now = _utc_now()
    with db_session() as conn:
        conn.execute(
            """
            INSERT INTO practice_recordings (
                id, report_id, video_id, language, file_path, mime_type,
                size_bytes, sha256, duration_sec, created_at
            )
            VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                recording_id,
                video_id,
                language,
                filename,
                mime_type,
                len(audio_bytes),
                digest,
                float(duration_sec or 0.0),
                now,
            ),
        )
    return {
        "recordingId": recording_id,
        "mimeType": mime_type,
        "sizeBytes": len(audio_bytes),
        "sha256": digest,
        "audioUrl": f"/api/audio/{recording_id}",
    }


def _row_to_report(row: sqlite3.Row) -> dict[str, Any]:
    data = _safe_json_loads(row["report_json"], {})
    if not isinstance(data, dict):
        data = {}
    data["id"] = row["id"]
    if row["recording_id"]:
        data["recordingId"] = row["recording_id"]
        data["audioUrl"] = f"/api/audio/{row['recording_id']}"
    data.pop("audioDataUrl", None)
    data["isDemo"] = bool(row["is_demo"])
    return data


def save_history_report(
    report_dict: dict[str, Any],
    audio_bytes: bytes | None = None,
    mime_type: str = "audio/wav",
) -> dict[str, Any]:
    """Persists a shadowing assessment report and optional audio bytes."""
    init_db()
    payload = dict(report_dict)
    raw_audio_url = payload.pop("audioDataUrl", None)
    if audio_bytes is None and raw_audio_url:
        extracted_bytes, extracted_mime = _extract_data_url_bytes(raw_audio_url)
        if extracted_bytes:
            audio_bytes = extracted_bytes
            mime_type = extracted_mime

    now = _utc_now()
    report_id = str(payload.get("id") or f"rep_{uuid.uuid4().hex[:12]}")
    payload["id"] = report_id
    created_at = str(payload.get("createdAt") or now)
    payload["createdAt"] = created_at

    video_id = payload.get("videoId")
    video_title = payload.get("videoTitle")
    language = str(payload.get("language") or "en")
    mode = str(payload.get("mode") or "listen_repeat")
    overall_score = float(payload.get("overallScore") or 0.0)
    is_demo = bool(payload.get("isDemo", False))

    recording_id = payload.get("recordingId")
    if recording_id and not SAFE_ID_REGEX.match(str(recording_id)):
        recording_id = None

    with db_session() as conn:
        if audio_bytes:
            if not recording_id:
                recording_id = f"rec_{uuid.uuid4().hex[:12]}"
            filename, digest = _write_audio_file(recording_id, audio_bytes, mime_type)
            duration_sec = float(
                (payload.get("metrics") or {}).get("durationSec")
                or payload.get("durationSec")
                or 0.0
            )
            conn.execute(
                """
                INSERT INTO practice_recordings (
                    id, report_id, video_id, language, file_path, mime_type,
                    size_bytes, sha256, duration_sec, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    report_id = excluded.report_id,
                    file_path = excluded.file_path,
                    mime_type = excluded.mime_type,
                    size_bytes = excluded.size_bytes,
                    sha256 = excluded.sha256,
                    duration_sec = excluded.duration_sec
                """,
                (
                    recording_id,
                    report_id,
                    video_id,
                    language,
                    filename,
                    mime_type,
                    len(audio_bytes),
                    digest,
                    duration_sec,
                    created_at,
                ),
            )
        elif recording_id:
            # Verify recording exists before linking foreign key
            rec_row = conn.execute(
                "SELECT id FROM practice_recordings WHERE id = ?",
                (recording_id,),
            ).fetchone()
            if rec_row:
                conn.execute(
                    "UPDATE practice_recordings SET report_id = ? WHERE id = ?",
                    (report_id, recording_id),
                )
            else:
                recording_id = None

        if recording_id:
            payload["recordingId"] = recording_id
            payload["audioUrl"] = f"/api/audio/{recording_id}"

        conn.execute(
            """
            INSERT INTO history_reports (
                id, video_id, video_title, language, mode, created_at,
                overall_score, recording_id, is_demo, report_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                video_id = excluded.video_id,
                video_title = excluded.video_title,
                language = excluded.language,
                mode = excluded.mode,
                overall_score = excluded.overall_score,
                recording_id = COALESCE(excluded.recording_id, history_reports.recording_id),
                is_demo = excluded.is_demo,
                report_json = excluded.report_json
            """,
            (
                report_id,
                video_id,
                video_title,
                language,
                mode,
                created_at,
                overall_score,
                recording_id,
                1 if is_demo else 0,
                json.dumps(payload, ensure_ascii=False),
            ),
        )
        row = conn.execute("SELECT * FROM history_reports WHERE id = ?", (report_id,)).fetchone()
        assert row is not None
        return _row_to_report(row)


def list_history_reports() -> list[dict[str, Any]]:
    """Lists all history reports ordered newest first."""
    init_db()
    with db_session() as conn:
        rows = conn.execute(
            "SELECT * FROM history_reports ORDER BY created_at DESC"
        ).fetchall()
        return [_row_to_report(r) for r in rows]


def get_history_report(report_id: str) -> dict[str, Any] | None:
    """Gets a single history report by ID."""
    init_db()
    with db_session() as conn:
        row = conn.execute(
            "SELECT * FROM history_reports WHERE id = ?",
            (report_id,),
        ).fetchone()
        return _row_to_report(row) if row else None


def delete_history_report(report_id: str) -> bool:
    """Deletes a history report and its orphaned recording file if unreferenced."""
    init_db()
    file_to_unlink: Path | None = None
    with db_session() as conn:
        row = conn.execute(
            "SELECT recording_id FROM history_reports WHERE id = ?",
            (report_id,),
        ).fetchone()
        if not row:
            return False
        rec_id = row["recording_id"]
        conn.execute("DELETE FROM history_reports WHERE id = ?", (report_id,))
        if rec_id:
            still_used = conn.execute(
                "SELECT 1 FROM history_reports WHERE recording_id = ?",
                (rec_id,),
            ).fetchone()
            if not still_used:
                rec_row = conn.execute(
                    "SELECT file_path FROM practice_recordings WHERE id = ?",
                    (rec_id,),
                ).fetchone()
                if rec_row:
                    file_to_unlink = get_audio_dir() / rec_row["file_path"]
                conn.execute("DELETE FROM practice_recordings WHERE id = ?", (rec_id,))

    if file_to_unlink and file_to_unlink.exists():
        file_to_unlink.unlink(missing_ok=True)
    return True


def clear_history_reports() -> int:
    """Deletes all history reports and their local audio files."""
    init_db()
    audio_dir = get_audio_dir().resolve()
    files_to_unlink: list[Path] = []
    with db_session() as conn:
        rec_rows = conn.execute("SELECT file_path FROM practice_recordings").fetchall()
        for r in rec_rows:
            files_to_unlink.append(audio_dir / r["file_path"])
        cur = conn.execute("DELETE FROM history_reports")
        conn.execute("DELETE FROM practice_recordings")
        deleted_count = cur.rowcount

    for f in files_to_unlink:
        try:
            resolved = f.resolve()
            if resolved.is_relative_to(audio_dir):
                resolved.unlink(missing_ok=True)
        except Exception:
            pass
    return deleted_count


def get_recording_path(recording_id: str) -> Path | None:
    """Returns the validated local audio file path for a recording ID."""
    if not recording_id or not SAFE_ID_REGEX.match(recording_id):
        return None
    init_db()
    with db_session() as conn:
        row = conn.execute(
            "SELECT file_path FROM practice_recordings WHERE id = ?",
            (recording_id,),
        ).fetchone()
        if not row:
            return None
        audio_dir = get_audio_dir().resolve()
        candidate = (audio_dir / row["file_path"]).resolve()
        if not candidate.is_relative_to(audio_dir) or not candidate.is_file():
            return None
        return candidate


# ---------------------------------------------------------------------------
# App Settings & Counts
# ---------------------------------------------------------------------------


def get_settings() -> dict[str, Any]:
    """Returns the persisted application settings dict."""
    init_db()
    result = dict(DEFAULT_SETTINGS)
    with db_session() as conn:
        rows = conn.execute("SELECT key, value_json FROM app_settings").fetchall()
        for row in rows:
            result[row["key"]] = _safe_json_loads(row["value_json"], result.get(row["key"]))
    return result


def update_settings(patch_dict: dict[str, Any]) -> dict[str, Any]:
    """Updates one or more persisted settings (accepts snake_case or camelCase keys)."""
    init_db()
    now = _utc_now()
    with db_session() as conn:
        for raw_key, value in patch_dict.items():
            canonical = SETTINGS_KEY_ALIASES.get(raw_key)
            if not canonical or value is None:
                continue
            if canonical in ("tailscale_enabled", "mcp_http_enabled", "mcp_stdio_enabled"):
                value = bool(value)
            else:
                value = str(value)
            conn.execute(
                """
                INSERT INTO app_settings (key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (canonical, json.dumps(value), now),
            )
    return get_settings()


def get_counts() -> dict[str, int]:
    """Returns item counts for materials, vocabulary, and history."""
    init_db()
    with db_session() as conn:
        mat_count = conn.execute("SELECT COUNT(*) FROM materials").fetchone()[0]
        voc_count = conn.execute("SELECT COUNT(*) FROM vocabulary").fetchone()[0]
        hist_count = conn.execute("SELECT COUNT(*) FROM history_reports").fetchone()[0]
    return {
        "materials": int(mat_count),
        "vocabulary": int(voc_count),
        "history": int(hist_count),
    }


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


def create_job(job_id: str, kind: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    init_db()
    now = _utc_now()
    with db_session() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO jobs (id, kind, status, payload_json, result_json, error, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, NULL, NULL, ?, ?)
            """,
            (job_id, kind, json.dumps(payload or {}, ensure_ascii=False), now, now),
        )
    return get_job(job_id) or {}


def update_job(
    job_id: str,
    status: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> dict[str, Any] | None:
    init_db()
    now = _utc_now()
    with db_session() as conn:
        conn.execute(
            """
            UPDATE jobs
            SET status = ?, result_json = COALESCE(?, result_json), error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                status,
                json.dumps(result, ensure_ascii=False) if result is not None else None,
                error,
                now,
                job_id,
            ),
        )
    return get_job(job_id)


def get_job(job_id: str) -> dict[str, Any] | None:
    init_db()
    with db_session() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "payload": _safe_json_loads(row["payload_json"], {}),
            "result": _safe_json_loads(row["result_json"], None),
            "error": row["error"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }


# ---------------------------------------------------------------------------
# One-Time Idempotent Browser localStorage Migration
# ---------------------------------------------------------------------------


def import_local_storage(payload_dict: dict[str, Any]) -> dict[str, Any]:
    """Idempotently imports materials, vocabulary, and history from browser localStorage."""
    init_db()
    materials = payload_dict.get("materials") or []
    vocabulary = payload_dict.get("vocabulary") or []
    history = payload_dict.get("history") or []

    imported = {"materials": 0, "vocabulary": 0, "history": 0}
    skipped = {"materials": 0, "vocabulary": 0, "history": 0}
    errors: list[dict[str, Any]] = []

    if isinstance(materials, list):
        for idx, mat in enumerate(materials):
            try:
                if not isinstance(mat, dict) or not str(mat.get("videoId") or "").strip():
                    raise ValueError("Missing videoId")
                save_material(mat)
                imported["materials"] += 1
            except Exception as exc:
                skipped["materials"] += 1
                errors.append({"kind": "material", "index": idx, "reason": str(exc)})

    if isinstance(vocabulary, list):
        for idx, item in enumerate(vocabulary):
            try:
                if not isinstance(item, dict) or not str(item.get("word") or "").strip():
                    raise ValueError("Missing word")
                save_vocab_item(item)
                imported["vocabulary"] += 1
            except Exception as exc:
                skipped["vocabulary"] += 1
                errors.append({"kind": "vocabulary", "index": idx, "reason": str(exc)})

    if isinstance(history, list):
        for idx, rep in enumerate(history):
            try:
                if not isinstance(rep, dict) or not str(rep.get("targetText") or "").strip():
                    raise ValueError("Missing targetText")
                save_history_report(rep)
                imported["history"] += 1
            except Exception as exc:
                skipped["history"] += 1
                errors.append({"kind": "history", "index": idx, "reason": str(exc)})

    digest = hashlib.sha256(
        json.dumps(
            {"m": len(materials), "v": len(vocabulary), "h": len(history)},
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    with db_session() as conn:
        conn.execute(
            """
            INSERT INTO migration_receipts (id, fingerprint, counts_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                f"mig_{uuid.uuid4().hex[:12]}",
                digest,
                json.dumps(imported),
                _utc_now(),
            ),
        )

    return {
        "status": "ok",
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "counts": get_counts(),
    }
