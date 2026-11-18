import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..agents.shadowing_agent import (
    create_deterministic_shadowing_report,
    evaluate_shadowing_with_agent,
    generate_coaching_and_merge,
)
from ..config import TEMP_AUDIO_DIR
from ..schemas.shadowing_schemas import ShadowingEvaluateRequest
from ..tools.whisper_tools import (
    analyze_wav_acoustics,
    compare_with_reference_wav,
    convert_to_16khz_mono_wav,
    get_min_duration_sec,
    inspect_wav_header,
    transcribe_audio_with_whisper,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _guess_audio_ext(upload: UploadFile) -> str:
    filename = (upload.filename or "").lower()
    ctype = (upload.content_type or "").lower()
    if filename.endswith(".wav") or "wav" in ctype:
        return ".wav"
    if filename.endswith(".mp4") or filename.endswith(".m4a") or "mp4" in ctype:
        return ".mp4"
    if filename.endswith(".ogg") or "ogg" in ctype:
        return ".ogg"
    return ".webm"


async def _prepare_wav_from_upload(
    upload: UploadFile,
) -> tuple[Path, Path, dict[str, Any], bytes | None]:
    """Saves an uploaded audio file, validates/converts to 16kHz mono PCM WAV, and runs acoustics."""
    file_id = uuid.uuid4().hex[:10]
    ext = _guess_audio_ext(upload)
    raw_path = TEMP_AUDIO_DIR / f"upload_{file_id}{ext}"
    wav_path = TEMP_AUDIO_DIR / f"upload_{file_id}_16k.wav"

    raw_bytes = await upload.read()
    raw_path.write_bytes(raw_bytes)

    if not raw_bytes:
        return raw_path, wav_path, {
            "isSilent": True,
            "isValidWav": False,
            "error": "Uploaded audio file is empty.",
            "durationSec": 0.0,
            "rmsDb": -90.0,
            "energyDb": -90.0,
            "pauseCount": 0,
            "silenceRatio": 1.0,
            "voicedFrames": 0,
            "pitchContour": [],
            "f0StdHz": 0.0,
            "f0StdSt": 0.0,
            "f0MedianHz": 0.0,
        }, None

    # Check if upload is already a WAV file
    is_wav_input = ext == ".wav" or raw_bytes[:4] == b"RIFF"
    if is_wav_input:
        hdr = inspect_wav_header(raw_path)
        if not hdr.get("isValidWav"):
            # Corrupt RIFF/WAV header -> reject immediately (R11)
            acoustics = analyze_wav_acoustics(raw_path)
            return raw_path, wav_path, acoustics, None
        if hdr.get("nchannels") != 1 or hdr.get("sampwidth") != 2:
            # Non-mono or non-16-bit WAV -> reject via analyze_wav_acoustics (R11)
            acoustics = analyze_wav_acoustics(raw_path)
            return raw_path, wav_path, acoustics, None
        if hdr.get("framerate") == 16000:
            acoustics = analyze_wav_acoustics(raw_path)
            return raw_path, raw_path, acoustics, raw_bytes

    # Valid non-16kHz WAV or browser webm/mp4/ogg -> convert to 16kHz mono 16-bit PCM WAV
    try:
        convert_to_16khz_mono_wav(raw_path, wav_path)
        acoustics = analyze_wav_acoustics(wav_path)
        wav_bytes = wav_path.read_bytes() if wav_path.exists() else None
        return raw_path, wav_path, acoustics, wav_bytes
    except Exception as exc:
        logger.warning("Audio conversion failed: %s", exc)
        return raw_path, wav_path, {
            "isSilent": True,
            "isValidWav": False,
            "error": f"Audio decode failed: {exc}",
            "durationSec": 0.0,
            "rmsDb": -90.0,
            "energyDb": -90.0,
            "pauseCount": 0,
            "silenceRatio": 1.0,
            "voicedFrames": 0,
            "pitchContour": [],
            "f0StdHz": 0.0,
            "f0StdSt": 0.0,
            "f0MedianHz": 0.0,
        }, None


def _persist_history_report(report: dict[str, Any], audio_bytes: bytes | None) -> str | None:
    """Persists report and optional WAV bytes to SQLite via adk_backend.db if available."""
    try:
        from .. import db  # type: ignore[attr-defined]
    except ImportError:
        return None

    save_fn = getattr(db, "save_history_report", None)
    if not callable(save_fn):
        return None

    try:
        saved = save_fn(report, audio_bytes=audio_bytes)
        if isinstance(saved, dict):
            return saved.get("recordingId") or saved.get("recording_id") or report.get("recordingId")
        if isinstance(saved, str):
            return saved
    except Exception as exc:
        logger.warning("Failed to persist shadowing report to SQLite: %s", exc)
    return report.get("recordingId")


def _parse_segment_ids(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return []
    stripped = raw.strip()
    if stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except Exception:
            pass
    return [s.strip() for s in stripped.split(",") if s.strip()]


@router.post("/shadowing/transcribe")
async def transcribe_shadowing_preview(
    audio: UploadFile = File(...),
    language: str = Form("en"),
    target_text: str | None = Form(None),
):
    """Phase R3: Post-recording local Whisper preview endpoint (S05).

    Validates WAV acoustics, runs local whisper-server transcription, and returns
    recognized text plus objective acoustic telemetry before the user clicks Analyze.
    """
    clean_lang = "ja" if language == "ja" else "en"
    raw_path: Path | None = None
    eval_wav: Path | None = None

    try:
        raw_path, eval_wav, acoustics, _ = await _prepare_wav_from_upload(audio)

        recognized_text = ""
        whisper_online = False
        whisper_words: list[dict[str, Any]] = []
        mean_confidence: float | None = None
        whisper_error: str | None = None

        if acoustics.get("isValidWav") and not acoustics.get("isSilent") and eval_wav.exists():
            w_res = await transcribe_audio_with_whisper(eval_wav, language=clean_lang)
            recognized_text = (w_res.get("text") or "").strip()
            whisper_online = bool(w_res.get("whisperOnline", False))
            whisper_words = w_res.get("words") or []
            mean_confidence = w_res.get("meanConfidence")
            whisper_error = w_res.get("error")

        resp: dict[str, Any] = {
            "recognizedText": recognized_text,
            "isSilent": bool(acoustics.get("isSilent", True)),
            "isValidWav": bool(acoustics.get("isValidWav", False)),
            "durationSec": float(acoustics.get("durationSec", 0.0)),
            "rmsDb": float(acoustics.get("rmsDb", -90.0)),
            "pauseCount": int(acoustics.get("pauseCount", 0)),
            "silenceRatio": float(acoustics.get("silenceRatio", 1.0)),
            "voicedFrames": int(acoustics.get("voicedFrames", 0)),
            "pitchContour": acoustics.get("pitchContour", []),
            "f0StdHz": float(acoustics.get("f0StdHz", 0.0)),
            "f0StdSt": float(acoustics.get("f0StdSt", 0.0)),
            "whisperOnline": whisper_online,
            "wordConfidences": whisper_words,
            "meanConfidence": mean_confidence,
        }
        if acoustics.get("error"):
            resp["error"] = acoustics["error"]
        elif whisper_error:
            resp["whisperError"] = whisper_error
        return resp
    finally:
        if raw_path is not None:
            raw_path.unlink(missing_ok=True)
        if eval_wav is not None and eval_wav != raw_path:
            eval_wav.unlink(missing_ok=True)


@router.post("/shadowing/analyze")
async def analyze_shadowing_take(
    target_text: str = Form(...),
    language: str = Form("en"),
    mode: str = Form("listen_repeat"),
    recognized_text: str | None = Form(None),
    mean_confidence: float | None = Form(default=None),
    video_id: str | None = Form(None),
    video_title: str | None = Form(None),
    segment_ids: str | None = Form(None),
    duration_sec: float | None = Form(None),
    target_duration_sec: float | None = Form(None),
    audio_start_sec: float | None = Form(None),
    audio_end_sec: float | None = Form(None),
    start_sec: float | None = Form(None),
    end_sec: float | None = Form(None),
    audio: UploadFile | None = File(None),
):
    """Phase R3/R5: Deterministic acoustic + alignment shadowing analysis with ADK coaching."""
    clean_target = (target_text or "").strip()
    if not clean_target:
        raise HTTPException(status_code=400, detail="target_text is required.")

    clean_lang = "ja" if language == "ja" else "en"
    clean_mode = "simultaneous" if mode == "simultaneous" else "listen_repeat"
    eff_target_dur = float(target_duration_sec or 4.0)
    clamped_mean_conf: float | None = (
        max(0.0, min(1.0, float(mean_confidence)))
        if isinstance(mean_confidence, (int, float))
        else None
    )

    raw_path: Path | None = None
    eval_wav: Path | None = None
    wav_bytes: bytes | None = None
    whisper_info: dict[str, Any] = {
        "text": "",
        "words": [],
        "meanConfidence": clamped_mean_conf,
    }
    spoken = (recognized_text or "").strip()

    try:
        if audio is not None:
            raw_path, eval_wav, acoustics, wav_bytes = await _prepare_wav_from_upload(audio)
            eff_dur = float(acoustics.get("durationSec") or duration_sec or 0.0)
            min_dur = get_min_duration_sec(clean_target, clean_lang)

            if (
                acoustics.get("isValidWav")
                and not acoustics.get("isSilent")
                and eff_dur >= min_dur
                and int(acoustics.get("voicedFrames", 0)) >= 5
                and not spoken
                and eval_wav.exists()
            ):
                whisper_info = await transcribe_audio_with_whisper(eval_wav, language=clean_lang)
                spoken = (whisper_info.get("text") or "").strip()
                if whisper_info.get("meanConfidence") is None and clamped_mean_conf is not None:
                    whisper_info["meanConfidence"] = clamped_mean_conf

            eff_start_sec = audio_start_sec if audio_start_sec is not None else start_sec
            eff_end_sec = audio_end_sec if audio_end_sec is not None else end_sec
            ref_cmp = (
                compare_with_reference_wav(
                    learner_acoustics=acoustics,
                    video_id=video_id,
                    start_sec=eff_start_sec,
                    end_sec=eff_end_sec,
                )
                if acoustics.get("isValidWav") and not acoustics.get("isSilent")
                else {"hasReference": False, "referencePitchContour": []}
            )

            det_report = create_deterministic_shadowing_report(
                target_text=clean_target,
                spoken_text=spoken,
                language=clean_lang,
                mode=clean_mode,
                duration_sec=eff_dur,
                target_duration_sec=eff_target_dur,
                acoustics=acoustics,
                whisper_info=whisper_info,
                ref_comparison=ref_cmp,
                simulated_take=False,
            )
        else:
            # No audio uploaded: if recognized_text is empty -> hard gate 0s; otherwise deterministic text check
            eff_dur = float(duration_sec or eff_target_dur or 3.0)
            acoustics = {
                "isSilent": not bool(spoken),
                "isValidWav": True,
                "durationSec": eff_dur,
                "rmsDb": -20.0 if spoken else -90.0,
                "energyDb": -20.0 if spoken else -90.0,
                "energyDynamicRangeDb": 8.0,
                "pauseCount": 0,
                "silenceRatio": 0.15 if spoken else 1.0,
                "voicedFrames": 25 if spoken else 0,
                "f0StdHz": 18.0 if spoken else 0.0,
                "f0StdSt": 2.4 if spoken else 0.0,
                "pitchContour": [],
            }
            det_report = create_deterministic_shadowing_report(
                target_text=clean_target,
                spoken_text=spoken,
                language=clean_lang,
                mode=clean_mode,
                duration_sec=eff_dur,
                target_duration_sec=eff_target_dur,
                acoustics=acoustics,
                whisper_info=whisper_info,
                simulated_take=bool(spoken),
            )

        final_report = await generate_coaching_and_merge(
            det_report,
            language=clean_lang,
            mode=clean_mode,
        )

        report_id = f"rep_{uuid.uuid4().hex[:12]}"
        created_at = datetime.now(UTC).isoformat()
        final_report["id"] = report_id
        final_report["videoId"] = video_id or ""
        final_report["videoTitle"] = video_title or ""
        final_report["segmentIds"] = _parse_segment_ids(segment_ids)
        final_report["language"] = clean_lang
        final_report["mode"] = clean_mode
        final_report["createdAt"] = created_at

        recording_id = _persist_history_report(final_report, wav_bytes)
        if recording_id:
            final_report["recordingId"] = recording_id
            final_report["audioUrl"] = f"/api/audio/{recording_id}"
        else:
            final_report.setdefault("recordingId", None)

        return final_report
    finally:
        if raw_path is not None:
            raw_path.unlink(missing_ok=True)
        if eval_wav is not None and eval_wav != raw_path:
            eval_wav.unlink(missing_ok=True)


@router.post("/shadowing/evaluate")
async def evaluate_shadowing(req: ShadowingEvaluateRequest):
    """Evaluates shadowing attempt (JSON payload endpoint for backward compatibility)."""
    clean_target = req.targetText.strip()
    if not clean_target:
        raise HTTPException(
            status_code=400,
            detail="Target transcript text is required.",
        )

    try:
        report = await evaluate_shadowing_with_agent(
            target_text=clean_target,
            language=req.language,
            mode=req.mode,
            duration_sec=req.durationSec,
            target_duration_sec=req.targetDurationSec,
            audio_base64=req.audioBase64,
            mime_type=req.mimeType,
            web_speech_transcript=req.webSpeechTranscript,
        )

        # Enforce strict hard-gate on invalid/silent audio when audioBase64 was provided
        if req.audioBase64 and report.get("hardGateTriggered") and not (report.get("recognizedTranscript") or "").strip():
            # Return 0-score hard-gated report cleanly rather than fabricating positive scores
            return report

        return report
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Shadowing evaluate error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="The assessment service could not process this take.",
        )
