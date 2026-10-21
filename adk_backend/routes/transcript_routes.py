import asyncio
import html
import json
import re
import shutil
import sys
import time
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..agents.transcript_agent import (
    estimate_transcript_level,
    merge_caption_lines_into_complete_segments,
)
from ..config import TEMP_AUDIO_DIR, WHISPER_SERVER_URL
from ..schemas.transcript_schemas import (
    FetchTranscriptRequest,
    RetokenizeRequest,
    RetokenizeResponse,
    WordToken,
)
from ..tools.tokenizer_tools import (
    detect_japanese_characters,
    tokenize_sentence,
)

router = APIRouter()

YOUTUBE_ID_REGEX = re.compile(r"(?:v=|youtu\.be/|embed/|shorts/|live/)?([a-zA-Z0-9_-]{11})")


def extract_youtube_id(input_str: str) -> str | None:
    """Extracts 11-character YouTube video ID from URL or raw ID."""
    trimmed = (input_str or "").strip()
    if re.fullmatch(r"[a-zA-Z0-9_-]{11}", trimmed):
        return trimmed
    match = YOUTUBE_ID_REGEX.search(trimmed)
    return match.group(1) if match else None


def clean_html_entities(text: str) -> str:
    """Decodes HTML entities and strips tags."""
    unescaped = html.unescape(text)
    stripped = re.sub(r"<[^>]+>", "", unescaped)
    return re.sub(r"\s+", " ", stripped).strip()


async def fetch_youtube_oembed(video_id: str) -> dict[str, str]:
    """Fetches title and author from official YouTube oEmbed."""
    try:
        url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
            )
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "title": data.get("title") or f"YouTube Video ({video_id})",
                    "authorName": data.get("author_name") or "YouTube Creator",
                }
    except Exception:
        pass
    return {
        "title": f"YouTube Video ({video_id})",
        "authorName": "YouTube Creator",
    }


def parse_timedtext_body(body: str) -> list[dict[str, Any]]:
    """Parses JSON3 or XML timedtext caption payload into raw caption lines."""
    lines: list[dict[str, Any]] = []
    trimmed = body.strip()
    if not trimmed:
        return lines

    if trimmed.startswith("{"):
        try:
            data = json.loads(trimmed)
            for ev in data.get("events", []):
                segs = ev.get("segs")
                if not segs:
                    continue
                text = clean_html_entities("".join(s.get("utf8", "") for s in segs))
                if text and not re.match(r"^\[.*\]$", text) and not re.match(r"^♪+$", text):
                    lines.append(
                        {
                            "start": (ev.get("tStartMs", 0)) / 1000.0,
                            "dur": (ev.get("dDurationMs", 2500)) / 1000.0,
                            "text": text,
                        }
                    )
            return lines
        except Exception:
            pass

    # XML format parsing (<text start="..." dur="..."> ... </text>)
    for m in re.finditer(
        r'<text\s+[^>]*start="([\d.]+)"[^>]*?(?:dur="([\d.]+)")?[^>]*>([\s\S]*?)</text>',
        trimmed,
    ):
        text = clean_html_entities(m.group(3))
        if text and not re.match(r"^\[.*\]$", text) and not re.match(r"^♪+$", text):
            lines.append(
                {
                    "start": float(m.group(1)),
                    "dur": float(m.group(2)) if m.group(2) else 2.5,
                    "text": text,
                }
            )

    if not lines:
        for m in re.finditer(
            r'<p\s+[^>]*t="(\d+)"[^>]*?(?:d="(\d+)")?[^>]*>([\s\S]*?)</p>',
            trimmed,
        ):
            text = clean_html_entities(m.group(3))
            if text and not re.match(r"^\[.*\]$", text) and not re.match(r"^♪+$", text):
                lines.append(
                    {
                        "start": int(m.group(1)) / 1000.0,
                        "dur": int(m.group(2)) / 1000.0 if m.group(2) else 2.5,
                        "text": text,
                    }
                )

    return lines


def extract_subtitles_with_ytdl_in_process(
    video_id: str,
    preferred_lang: str | None = None,
) -> dict[str, Any]:
    """Synchronously extracts metadata and public manual/auto subtitles using yt_dlp."""
    try:
        import yt_dlp

        ydl_opts = {
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "quiet": True,
            "no_warnings": True,
        }
        url = f"https://www.youtube.com/watch?v={video_id}"
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            title = info.get("title", "")
            author = info.get("uploader") or info.get("channel") or ""
            duration = int(info.get("duration") or 0)
            subs = info.get("subtitles") or {}
            auto_subs = info.get("automatic_captions") or {}

            target = (preferred_lang or "en").lower()
            alt = "ja" if target == "en" else "en"

            chosen_track = None
            is_auto = False
            lang = target

            # 1. Check manual creator subtitles first
            for l in [target, alt]:
                matched = [k for k in subs.keys() if k.lower().startswith(l)]
                if matched:
                    chosen_track = subs[matched[0]]
                    lang = l
                    is_auto = False
                    break

            # 2. Check auto-generated captions (prioritizing original ASR over auto-translations with tlang)
            if not chosen_track:
                for l in [target, alt]:
                    matched = [k for k in auto_subs.keys() if k.lower().startswith(l)]
                    if matched:
                        formats = auto_subs[matched[0]]
                        orig = [f for f in formats if "tlang=" not in f.get("url", "")]
                        chosen_track = orig or formats
                        lang = l
                        is_auto = True
                        break

            lines: list[dict[str, Any]] = []
            if chosen_track:
                # Prefer json3, then vtt, then first format
                entry = (
                    next((f for f in chosen_track if f.get("ext") == "json3"), None)
                    or next((f for f in chosen_track if f.get("ext") == "vtt"), None)
                    or chosen_track[0]
                )
                sub_url = entry.get("url")
                if sub_url:
                    try:
                        with httpx.Client(timeout=10.0) as client:
                            r = client.get(sub_url)
                            if r.status_code == 200 and len(r.text) > 0:
                                lines = parse_timedtext_body(r.text)
                    except Exception:
                        pass
                    if not lines:
                        try:
                            content = ydl.urlopen(sub_url).read().decode("utf-8")
                            lines = parse_timedtext_body(content)
                        except Exception:
                            pass

            return {
                "title": title,
                "authorName": author,
                "durationSec": duration,
                "language": lang,
                "isAutoGenerated": is_auto,
                "lines": lines,
            }
    except Exception as exc:
        print(f"in-process yt_dlp subtitle extraction notice: {exc}")
        return {
            "title": "",
            "authorName": "",
            "durationSec": 0,
            "language": preferred_lang or "en",
            "isAutoGenerated": False,
            "lines": [],
        }


async def fetch_innertube_captions(
    video_id: str,
    preferred_lang: str | None = None,
) -> dict[str, Any]:
    """Extracts public caption tracks using yt_dlp metadata first, with watch page fallback."""
    # Strategy 1: In-process yt_dlp Python package
    ytdl_res = await asyncio.to_thread(
        extract_subtitles_with_ytdl_in_process, video_id, preferred_lang
    )
    if ytdl_res.get("lines"):
        return ytdl_res

    # Strategy 2: Fallback to direct watch page scraping
    title = ytdl_res.get("title", "")
    author_name = ytdl_res.get("authorName", "")
    duration_sec = ytdl_res.get("durationSec", 0)
    caption_tracks: list[dict[str, Any]] = []

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
        "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410",
    }

    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        try:
            r = await client.get(f"https://www.youtube.com/watch?v={video_id}&hl=en")
            if r.status_code == 200:
                html_content = r.text
                player_match = re.search(
                    r"ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|let|const|</script>)",
                    html_content,
                    re.DOTALL,
                )
                if player_match:
                    try:
                        player_resp = json.loads(player_match.group(1))
                        tracks = (
                            player_resp.get("captions", {})
                            .get("playerCaptionsTracklistRenderer", {})
                            .get("captionTracks", [])
                        )
                        if tracks:
                            caption_tracks = tracks
                        if not duration_sec:
                            duration_sec = int(
                                player_resp.get("videoDetails", {}).get("lengthSeconds", 0)
                            )
                        if not title:
                            title = player_resp.get("videoDetails", {}).get("title", "")
                        if not author_name:
                            author_name = player_resp.get("videoDetails", {}).get("author", "")
                    except Exception:
                        pass
        except Exception:
            pass

        lines: list[dict[str, Any]] = []
        lang = preferred_lang or "en"
        is_auto = False

        if caption_tracks:

            def find_track(prefix: str, manual_only: bool):
                for t in caption_tracks:
                    code = (t.get("languageCode") or "").lower()
                    if code.startswith(prefix):
                        if manual_only and t.get("kind") == "asr":
                            continue
                        return t
                return None

            chosen = (
                find_track("ja", True)
                or find_track("ja", False)
                or find_track("en", True)
                or find_track("en", False)
                if preferred_lang == "ja"
                else find_track("en", True)
                or find_track("en", False)
                or find_track("ja", True)
                or find_track("ja", False)
            ) or caption_tracks[0]

            chosen_url = chosen.get("baseUrl")
            if chosen_url:
                lang = "ja" if (chosen.get("languageCode") or "").lower().startswith("ja") else "en"
                is_auto = chosen.get("kind") == "asr"
                try:
                    cap_url = chosen_url if "&fmt=" in chosen_url else f"{chosen_url}&fmt=json3"
                    cap_resp = await client.get(cap_url)
                    if cap_resp.status_code == 200 and cap_resp.text:
                        lines = parse_timedtext_body(cap_resp.text)
                except Exception:
                    pass

    return {
        "title": title,
        "authorName": author_name,
        "durationSec": duration_sec,
        "language": lang,
        "isAutoGenerated": is_auto,
        "lines": lines,
    }


def download_audio_with_ytdl_in_process(yt_url: str, wav_path: Path) -> bool:
    """Synchronously downloads and extracts 16kHz mono WAV audio using yt_dlp Python package."""
    try:
        import yt_dlp

        out_base = str(wav_path).rsplit(".", 1)[0]
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": f"{out_base}.%(ext)s",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "wav",
                    "preferredquality": "192",
                }
            ],
            "postprocessor_args": ["-ar", "16000", "-ac", "1"],
            "quiet": True,
            "no_warnings": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([yt_url])
        return wav_path.exists() and wav_path.stat().st_size > 500
    except Exception as exc:
        print(f"in-process yt_dlp notice: {exc}")
        return False


async def download_youtube_audio_wav(yt_url: str, wav_path: Path) -> bool:
    """Robustly downloads YouTube audio into 16kHz WAV format.

    Strategy 1: Python in-process yt_dlp via asyncio.to_thread (requires no external yt-dlp binary in PATH).
    Strategy 2: Subprocess execution using resolved binary path (.venv/bin/yt-dlp or system PATH).
    """
    # Strategy 1: In-process yt_dlp Python library
    success = await asyncio.to_thread(download_audio_with_ytdl_in_process, yt_url, wav_path)
    if success and wav_path.exists():
        return True

    # Strategy 2: Resolved binary in virtual environment or PATH
    yt_bin = shutil.which("yt-dlp")
    if not yt_bin:
        venv_bin = Path(sys.executable).parent / "yt-dlp"
        if venv_bin.exists():
            yt_bin = str(venv_bin)

    if yt_bin and Path(yt_bin).exists():
        try:
            cmd = [
                yt_bin,
                "-x",
                "--audio-format",
                "wav",
                "--postprocessor-args",
                "-ar 16000 -ac 1",
                "-o",
                str(wav_path),
                yt_url,
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()
            if wav_path.exists() and wav_path.stat().st_size > 500:
                return True
        except Exception as exc:
            print(f"subprocess yt-dlp notice: {exc}")

    return False


@router.post("/transcript/retokenize", response_model=RetokenizeResponse)
async def retokenize_segment(req: RetokenizeRequest):
    """Retokenizes and updates Furigana when a learner edits a transcript segment inline.

    Supports both Japanese (fugashi MeCab) and English (regex word boundary).
    """
    clean_text = req.text.strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Segment text is required.")

    tokens_raw = tokenize_sentence(clean_text, req.language)
    tokens = [WordToken(**t) for t in tokens_raw]
    return RetokenizeResponse(tokens=tokens)


async def generate_transcript_stream(
    video_id: str,
    preferred_lang: str | None,
) -> AsyncGenerator[str, None]:
    """Generates NDJSON events for /api/transcript/fetch stream with guaranteed exception handling."""
    oembed_meta, caption_info = await asyncio.gather(
        fetch_youtube_oembed(video_id),
        fetch_innertube_captions(video_id, preferred_lang),
    )

    title = caption_info.get("title") or oembed_meta.get("title") or f"YouTube Video ({video_id})"
    channel = caption_info.get("authorName") or oembed_meta.get("authorName") or "YouTube Creator"
    duration_sec = max(15, caption_info.get("durationSec") or 180)

    inferred_lang = (
        "ja"
        if detect_japanese_characters(title)
        else (preferred_lang or caption_info.get("language") or "en")
    )

    # 1. Yield 'meta' event
    yield (
        json.dumps(
            {
                "type": "meta",
                "videoId": video_id,
                "title": title,
                "channel": channel,
                "durationSec": duration_sec,
                "language": inferred_lang,
            }
        )
        + "\n"
    )

    # Fast Path: Public caption track found
    raw_lines = caption_info.get("lines", [])
    if raw_lines:
        merged_segments = merge_caption_lines_into_complete_segments(raw_lines, inferred_lang)
        sample_text = " ".join(s["text"] for s in merged_segments[:4])
        level = await estimate_transcript_level(sample_text, inferred_lang)

        final_segments: list[dict[str, Any]] = []
        for idx, seg in enumerate(merged_segments):
            tokens = tokenize_sentence(seg["text"], inferred_lang)
            final_segments.append(
                {
                    "id": f"yt-{video_id}-{idx}-{int(time.time())}",
                    "index": idx,
                    "startTime": seg["startTime"],
                    "endTime": seg["endTime"],
                    "text": seg["text"],
                    "tokens": tokens,
                }
            )

        source_type = "youtube_asr" if caption_info.get("isAutoGenerated") else "youtube_manual"
        note = (
            "Auto-generated YouTube captions (aligned & tokenized)"
            if caption_info.get("isAutoGenerated")
            else "Verified creator captions"
        )

        final_video = {
            "videoId": video_id,
            "title": title,
            "channel": channel,
            "language": inferred_lang,
            "level": level,
            "durationSec": duration_sec,
            "captionSource": source_type,
            "captionNote": note,
            "segments": final_segments,
        }

        yield json.dumps({"type": "complete", "video": final_video}) + "\n"
        return

    # Fallback Path: No public captions found. Extract audio and transcribe locally
    yield (
        json.dumps(
            {
                "type": "progress",
                "message": "Extracting audio for local Whisper speech recognition...",
                "completedChunks": 0,
                "totalChunks": 2,
            }
        )
        + "\n"
    )

    file_id = uuid.uuid4().hex[:10]
    wav_path = TEMP_AUDIO_DIR / f"yt_{file_id}.wav"
    yt_url = f"https://www.youtube.com/watch?v={video_id}"

    try:
        # Download audio using in-process yt_dlp Python package
        success = await download_youtube_audio_wav(yt_url, wav_path)

        if success and wav_path.exists():
            yield (
                json.dumps(
                    {
                        "type": "progress",
                        "message": "Running local Whisper speech recognition model...",
                        "completedChunks": 1,
                        "totalChunks": 2,
                    }
                )
                + "\n"
            )

            # Transcribe with local whisper-server (dynamically scaled timeout for long videos)
            whisper_timeout = max(300.0, float(duration_sec) * 1.5)
            try:
                async with httpx.AsyncClient(timeout=whisper_timeout) as client:
                    with open(wav_path, "rb") as wf:
                        resp = await client.post(
                            f"{WHISPER_SERVER_URL}/v1/audio/transcriptions",
                            files={"file": (wav_path.name, wf, "audio/wav")},
                            data={
                                "model": "large-v3-turbo",
                                "language": inferred_lang,
                                "response_format": "verbose_json",
                            },
                        )
                    if resp.status_code == 200:
                        w_data = resp.json()
                        w_segs = w_data.get("segments", [])
                        final_segments = []
                        for idx, s in enumerate(w_segs):
                            st = float(s.get("start", idx * 5.0))
                            et = float(s.get("end", (idx + 1) * 5.0))
                            txt = (s.get("text") or "").strip()
                            if not txt:
                                continue
                            tokens = tokenize_sentence(txt, inferred_lang)
                            final_segments.append(
                                {
                                    "id": f"yt-{video_id}-{idx}-{int(time.time())}",
                                    "index": idx,
                                    "startTime": st,
                                    "endTime": et,
                                    "text": txt,
                                    "tokens": tokens,
                                }
                            )

                        if final_segments:
                            final_video = {
                                "videoId": video_id,
                                "title": title,
                                "channel": channel,
                                "language": inferred_lang,
                                "level": "Intermediate",
                                "durationSec": duration_sec,
                                "captionSource": "ai_generated",
                                "captionNote": "Generated locally via Whisper Large-v3-Turbo",
                                "segments": final_segments,
                            }
                            yield json.dumps({"type": "complete", "video": final_video}) + "\n"
                            return
            except Exception as w_exc:
                print(f"whisper-server notice: {w_exc}")

        # If audio extraction or whisper-server failed
        yield (
            json.dumps(
                {
                    "type": "error",
                    "error": (
                        "Could not extract captions for this video. "
                        "You can paste your custom transcript or pick from the Curated Library."
                    ),
                }
            )
            + "\n"
        )
    except Exception as exc:
        print(f"generate_transcript_stream fallback error: {exc}")
        yield (
            json.dumps(
                {
                    "type": "error",
                    "error": (
                        f"Transcript generation notice: {str(exc)}. "
                        "You can paste your custom transcript or pick from the Curated Library."
                    ),
                }
            )
            + "\n"
        )
    finally:
        wav_path.unlink(missing_ok=True)


@router.post("/transcript/fetch")
async def fetch_transcript(req: FetchTranscriptRequest):
    """Fetches, aligns, and tokenizes complete YouTube video transcripts.

    Supports streaming NDJSON (stream: True) with 'meta', 'progress',
    'partial_segments', 'heartbeat', and 'complete' events.
    """
    video_id = extract_youtube_id(req.urlOrId)
    if not video_id:
        raise HTTPException(
            status_code=400,
            detail="Please enter a valid 11-character YouTube video URL or ID.",
        )

    if req.stream:
        return StreamingResponse(
            generate_transcript_stream(video_id, req.preferredLanguage),
            media_type="application/x-ndjson; charset=utf-8",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Non-streaming request: collect stream and return single JSON
    final_video: dict[str, Any] | None = None
    err_msg: str | None = None

    async for line in generate_transcript_stream(video_id, req.preferredLanguage):
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            ev = json.loads(trimmed)
            if ev.get("type") == "complete":
                final_video = ev.get("video")
            elif ev.get("type") == "error":
                err_msg = ev.get("error")
        except Exception:
            pass

    if final_video:
        return {"video": final_video}
    raise HTTPException(status_code=400, detail=err_msg or "Could not fetch transcript.")
