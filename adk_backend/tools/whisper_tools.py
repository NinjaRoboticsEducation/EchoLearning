import base64
import difflib
import math
import re
import struct
import subprocess
import uuid
import wave
from pathlib import Path
from typing import Any

import httpx
from google.adk.tools import ToolContext

from ..config import TEMP_AUDIO_DIR, WHISPER_SERVER_URL
from .tokenizer_tools import tokenize_sentence


def convert_to_16khz_mono_wav(input_path: Path, output_path: Path) -> None:
    """Converts browser audio/webm or audio/mp4 into 16kHz 16-bit mono WAV via ffmpeg."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        timeout=30,
    )


def analyze_wav_acoustics(wav_path: Path) -> dict[str, Any]:
    """Computes objective RMS energy, silence ratio, and mid-speech pause count from a PCM WAV file."""
    try:
        with wave.open(str(wav_path), "rb") as wf:
            sample_rate = wf.getframerate()
            n_frames = wf.getnframes()
            if n_frames == 0 or sample_rate == 0:
                return {
                    "isSilent": True,
                    "rmsDb": -90.0,
                    "pauseCount": 0,
                    "silenceRatio": 1.0,
                }
            raw_bytes = wf.readframes(n_frames)
            samples = struct.unpack(f"<{n_frames}h", raw_bytes)

        window_size = max(1, int(sample_rate * 0.05))  # 50ms windows
        rms_values: list[float] = []
        for i in range(0, len(samples), window_size):
            chunk = samples[i : i + window_size]
            if not chunk:
                continue
            mean_sq = sum(s * s for s in chunk) / len(chunk)
            rms = math.sqrt(mean_sq) / 32768.0
            rms_values.append(rms)

        if not rms_values:
            return {
                "isSilent": True,
                "rmsDb": -90.0,
                "pauseCount": 0,
                "silenceRatio": 1.0,
            }

        overall_rms = sum(rms_values) / len(rms_values)
        rms_db = 20 * math.log10(max(overall_rms, 1e-6))
        silence_threshold = 0.012
        silent_windows = [r < silence_threshold for r in rms_values]
        silence_ratio = sum(1 for s in silent_windows if s) / len(silent_windows)

        # Count mid-utterance pauses (>= 350ms = 7 consecutive 50ms silent windows)
        active_indices = [idx for idx, is_sil in enumerate(silent_windows) if not is_sil]
        pause_count = 0
        if len(active_indices) >= 2:
            interior = silent_windows[active_indices[0] : active_indices[-1] + 1]
            run = 0
            for is_sil in interior:
                if is_sil:
                    run += 1
                else:
                    if run >= 7:
                        pause_count += 1
                    run = 0

        is_silent = rms_db < -48.0 or silence_ratio > 0.94
        return {
            "isSilent": is_silent,
            "rmsDb": round(rms_db, 1),
            "pauseCount": pause_count,
            "silenceRatio": round(silence_ratio, 2),
        }
    except Exception as exc:
        print(f"analyze_wav_acoustics warning: {exc}")
        return {
            "isSilent": False,
            "rmsDb": -24.0,
            "pauseCount": 0,
            "silenceRatio": 0.2,
        }


def compute_deterministic_word_diff(
    target_text: str,
    spoken_text: str,
    language: str,
) -> dict[str, Any]:
    """Computes baseline word/morpheme diff using SequenceMatcher."""
    punct_re = re.compile(r"^[.,!?;:\"'()「」『』、。！？—\-]+$")

    target_tokens = [
        t for t in tokenize_sentence(target_text, language) if not punct_re.match(t["surface"])
    ]
    spoken_tokens = [
        t for t in tokenize_sentence(spoken_text, language) if not punct_re.match(t["surface"])
    ]

    t_norms = [(t.get("reading") or t["surface"]).lower() for t in target_tokens]
    s_norms = [(t.get("reading") or t["surface"]).lower() for t in spoken_tokens]

    matcher = difflib.SequenceMatcher(None, t_norms, s_norms)
    diff_items: list[dict[str, Any]] = []
    matched = 0.0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for idx in range(i1, i2):
                matched += 1.0
                diff_items.append(
                    {
                        "word": target_tokens[idx]["surface"],
                        "reading": target_tokens[idx].get("reading"),
                        "status": "correct",
                    }
                )
        elif tag == "delete":
            for idx in range(i1, i2):
                diff_items.append(
                    {
                        "word": target_tokens[idx]["surface"],
                        "reading": target_tokens[idx].get("reading"),
                        "status": "omitted",
                        "explanation": "Not detected in spoken recording.",
                    }
                )
        elif tag == "replace":
            t_slice = target_tokens[i1:i2]
            s_slice = spoken_tokens[j1:j2]
            for k, t_tok in enumerate(t_slice):
                s_tok = s_slice[k] if k < len(s_slice) else None
                t_phon = (t_tok.get("reading") or t_tok["surface"]).lower()
                s_phon = (s_tok.get("reading") or s_tok["surface"]).lower() if s_tok else ""
                sim = difflib.SequenceMatcher(None, t_phon, s_phon).ratio()
                status = "stt_uncertain" if sim >= 0.65 else "substituted"
                if status == "stt_uncertain":
                    matched += 0.85
                diff_items.append(
                    {
                        "word": s_tok["surface"] if s_tok else t_tok["surface"],
                        "expectedWord": t_tok["surface"],
                        "reading": t_tok.get("reading"),
                        "status": status,
                        "explanation": (
                            "Close phonetic match (possible STT homophone)."
                            if status == "stt_uncertain"
                            else f"Heard '{s_tok['surface'] if s_tok else '?'}' instead of '{t_tok['surface']}'."
                        ),
                    }
                )
        elif tag == "insert":
            for idx in range(j1, j2):
                diff_items.append(
                    {
                        "word": spoken_tokens[idx]["surface"],
                        "status": "inserted",
                        "explanation": "Extra word spoken.",
                    }
                )

    total_target = max(1, len(target_tokens))
    accuracy = round(min(100.0, (matched / total_target) * 100.0), 1)
    return {
        "contentAccuracyEstimate": accuracy,
        "targetTokenCount": len(target_tokens),
        "spokenTokenCount": len(spoken_tokens),
        "baselineWordDiff": diff_items,
    }


async def transcribe_and_analyze_audio(
    language: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """ADK FunctionTool: Transcribes audio from session.state and computes acoustic metrics.

    Reads 'audio_base64', 'mime_type', 'target_text', and 'web_speech_transcript'
    directly from tool_context.state so raw audio bytes NEVER enter the LLM context!

    Args:
        language: 'en' for English or 'ja' for Japanese.
    """
    audio_b64: str | None = tool_context.state.get("audio_base64")
    mime_type: str = tool_context.state.get("mime_type", "audio/webm")
    target_text: str = tool_context.state.get("target_text", "")
    web_speech: str = tool_context.state.get("web_speech_transcript", "")

    # Handle "Simulate Practice Take" (where audio_base64 is None/empty)
    if not audio_b64:
        diff_info = compute_deterministic_word_diff(target_text, web_speech, language)
        return {
            "verbatimTranscript": web_speech,
            "acoustics": {
                "isSilent": not bool(web_speech.strip()),
                "rmsDb": -18.0,
                "pauseCount": 0,
                "silenceRatio": 0.15,
                "simulatedTake": True,
            },
            **diff_info,
        }

    file_id = uuid.uuid4().hex[:10]
    ext = ".mp4" if "mp4" in mime_type else ".webm"
    raw_path = TEMP_AUDIO_DIR / f"in_{file_id}{ext}"
    wav_path = TEMP_AUDIO_DIR / f"pcm_{file_id}.wav"

    try:
        raw_path.write_bytes(base64.b64decode(audio_b64))
        convert_to_16khz_mono_wav(raw_path, wav_path)
        acoustics = analyze_wav_acoustics(wav_path)

        if acoustics["isSilent"] and not web_speech.strip():
            return {
                "verbatimTranscript": "",
                "acoustics": acoustics,
                "contentAccuracyEstimate": 0.0,
                "baselineWordDiff": [],
            }

        verbatim_text = web_speech.strip()
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                with open(wav_path, "rb") as wf:
                    resp = await client.post(
                        f"{WHISPER_SERVER_URL}/v1/audio/transcriptions",
                        files={"file": (wav_path.name, wf, "audio/wav")},
                        data={
                            "model": "large-v3-turbo",
                            "language": language,
                            "response_format": "verbose_json",
                            "temperature": "0.0",
                        },
                    )
                if resp.status_code == 200:
                    w_data = resp.json()
                    w_text = (w_data.get("text") or "").strip()
                    if w_text:
                        verbatim_text = w_text
        except Exception as exc:
            print(f"Whisper server notice (falling back to webSpeechTranscript): {exc}")

        diff_info = compute_deterministic_word_diff(target_text, verbatim_text, language)
        return {
            "verbatimTranscript": verbatim_text,
            "acoustics": acoustics,
            **diff_info,
        }
    finally:
        raw_path.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)
