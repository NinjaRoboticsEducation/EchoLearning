import base64
import difflib
import logging
import math
import re
import struct
import subprocess
import sys
import uuid
import wave
from array import array
from pathlib import Path
from typing import Any

import httpx
from google.adk.tools import ToolContext

from ..config import TEMP_AUDIO_DIR, WHISPER_SERVER_URL
from .tokenizer_tools import katakana_to_hiragana, tokenize_sentence

logger = logging.getLogger(__name__)

YT_CACHE_DIR = Path("/tmp/echolearning_yt_cache")
PUNCT_TOKEN_RE = re.compile(r"^[.,!?;:\"'()\[\]{}「」『』、。！？—\-…・〜~]+$")
SMALL_KANA_RE = re.compile(r"[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮヵヶ]")
EN_NORMALIZE_RE = re.compile(r"[^a-z0-9']+")


def convert_to_16khz_mono_wav(input_path: Path, output_path: Path) -> None:
    """Converts browser audio/webm, audio/mp4, or non-standard WAV into 16kHz 16-bit mono WAV via ffmpeg."""
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


def inspect_wav_header(wav_path: Path) -> dict[str, Any]:
    """Inspects WAV header parameters without decoding all frames."""
    try:
        with wave.open(str(wav_path), "rb") as wf:
            return {
                "isValidWav": True,
                "nchannels": wf.getnchannels(),
                "sampwidth": wf.getsampwidth(),
                "framerate": wf.getframerate(),
                "nframes": wf.getnframes(),
            }
    except Exception as exc:
        return {"isValidWav": False, "error": str(exc)}


def _extract_pitch_contour(samples: array | list[int], sample_rate: int) -> dict[str, Any]:
    """Extracts F0 pitch contour (Hz) using normalized autocorrelation over voiced 30ms frames.

    Pure-Python + stdlib implementation (no C-extension crash risk); downsamples >=16kHz audio
    by 2x for fast sub-50ms execution while maintaining 75-450 Hz speech F0 accuracy.
    """
    if not samples or sample_rate <= 0:
        return {
            "pitchContour": [],
            "voicedFrames": 0,
            "f0MeanHz": 0.0,
            "f0StdHz": 0.0,
            "f0RangeHz": 0.0,
        }

    # Decimate by 2 when sample_rate >= 16000 so autocorrelation lag search is fast and crisp
    decim = 2 if sample_rate >= 16000 else 1
    eff_sr = sample_rate / decim
    if decim > 1:
        sig = [samples[i] / 32768.0 for i in range(0, len(samples), decim)]
    else:
        sig = [s / 32768.0 for s in samples]

    frame_len = max(32, int(eff_sr * 0.030))  # 30ms frame
    hop_len = max(16, int(eff_sr * 0.020), max(1, (len(sig) - frame_len) // 200))  # cap ~200 frames
    min_lag = max(2, int(eff_sr / 450.0))     # max 450 Hz
    max_lag = min(frame_len - 2, int(eff_sr / 75.0))  # min 75 Hz

    if len(sig) < frame_len or max_lag <= min_lag:
        return {
            "pitchContour": [],
            "voicedFrames": 0,
            "f0MeanHz": 0.0,
            "f0StdHz": 0.0,
            "f0RangeHz": 0.0,
        }

    raw_f0: list[float | None] = []
    for start in range(0, len(sig) - frame_len + 1, hop_len):
        frame = sig[start : start + frame_len]
        mean_val = sum(frame) / frame_len
        centered = [x - mean_val for x in frame]
        energy = sum(x * x for x in centered)
        frame_rms = math.sqrt(energy / frame_len)

        if frame_rms < 0.012:
            raw_f0.append(None)
            continue

        # Normalized autocorrelation across speech F0 lag window
        nac_values: list[tuple[int, float]] = []
        n_win = frame_len - max_lag
        if n_win < 16:
            raw_f0.append(None)
            continue

        base_slice = centered[:n_win]
        base_energy = sum(x * x for x in base_slice)
        if base_energy <= 1e-12:
            raw_f0.append(None)
            continue

        for lag in range(min_lag, max_lag + 1):
            shifted_energy = sum(centered[i + lag] * centered[i + lag] for i in range(n_win))
            denom = math.sqrt(base_energy * shifted_energy)
            if denom <= 1e-12:
                nac_values.append((lag, 0.0))
                continue
            corr = sum(base_slice[i] * centered[i + lag] for i in range(n_win)) / denom
            nac_values.append((lag, corr))

        if not nac_values:
            raw_f0.append(None)
            continue

        # Find highest peak; avoid sub-harmonic octave errors by picking first peak >= 0.88 * max_corr
        max_corr = max(c for _, c in nac_values)
        if max_corr < 0.55:
            # Aperiodic / white noise / unvoiced fricative
            raw_f0.append(None)
            continue

        best_idx = 0
        threshold = max(0.55, max_corr * 0.88)
        for idx in range(1, len(nac_values) - 1):
            c_prev = nac_values[idx - 1][1]
            c_cur = nac_values[idx][1]
            c_next = nac_values[idx + 1][1]
            if c_cur >= threshold and c_cur >= c_prev and c_cur >= c_next:
                best_idx = idx
                break
        else:
            best_idx = max(range(len(nac_values)), key=lambda idx: nac_values[idx][1])

        best_lag = float(nac_values[best_idx][0])
        # Parabolic interpolation for sub-sample frequency precision
        if 0 < best_idx < len(nac_values) - 1:
            y0 = nac_values[best_idx - 1][1]
            y1 = nac_values[best_idx][1]
            y2 = nac_values[best_idx + 1][1]
            denom_p = 2.0 * (2.0 * y1 - y0 - y2)
            if abs(denom_p) > 1e-9:
                delta = (y2 - y0) / denom_p
                best_lag += max(-0.5, min(0.5, delta))

        f0_hz = eff_sr / max(1.0, best_lag)
        if 70.0 <= f0_hz <= 480.0:
            raw_f0.append(f0_hz)
        else:
            raw_f0.append(None)

    # 3-point median smoothing across voiced neighbors to suppress isolated octave glitches
    smoothed_voiced: list[float] = []
    for i, val in enumerate(raw_f0):
        if val is None:
            continue
        neighbors = [v for v in raw_f0[max(0, i - 1) : min(len(raw_f0), i + 2)] if v is not None]
        neighbors.sort()
        med = neighbors[len(neighbors) // 2]
        smoothed_voiced.append(round(med, 1))

    voiced_count = len(smoothed_voiced)
    if voiced_count == 0:
        return {
            "pitchContour": [],
            "voicedFrames": 0,
            "f0MeanHz": 0.0,
            "f0StdHz": 0.0,
            "f0RangeHz": 0.0,
        }

    f0_mean = sum(smoothed_voiced) / voiced_count
    f0_std = (
        math.sqrt(sum((v - f0_mean) ** 2 for v in smoothed_voiced) / voiced_count)
        if voiced_count >= 2
        else 0.0
    )
    f0_range = max(smoothed_voiced) - min(smoothed_voiced)

    # Downsample contour to at most 120 points for compact JSON payloads
    contour = smoothed_voiced
    if len(contour) > 120:
        step = len(contour) / 120.0
        contour = [contour[min(len(contour) - 1, int(i * step))] for i in range(120)]

    return {
        "pitchContour": contour,
        "voicedFrames": voiced_count,
        "f0MeanHz": round(f0_mean, 1),
        "f0StdHz": round(f0_std, 1),
        "f0RangeHz": round(f0_range, 1),
    }


def analyze_wav_acoustics(wav_path: Path) -> dict[str, Any]:
    """Computes objective RMS energy, silence ratio, pause count, duration, and F0 pitch contour.

    Enforces strict R11 validation: explicitly verifies mono (nchannels == 1) and
    16-bit PCM (sampwidth == 2) before unpacking, and never masks decode/header errors
    as healthy speech.
    """
    invalid_base = {
        "isSilent": True,
        "isValidWav": False,
        "durationSec": 0.0,
        "rmsDb": -90.0,
        "energyDb": -90.0,
        "energyDynamicRangeDb": 0.0,
        "pauseCount": 0,
        "silenceRatio": 1.0,
        "voicedFrames": 0,
        "pitchContour": [],
        "f0MeanHz": 0.0,
        "f0StdHz": 0.0,
        "f0RangeHz": 0.0,
        "peakClipRatio": 0.0,
    }

    try:
        with wave.open(str(wav_path), "rb") as wf:
            nchannels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            sample_rate = wf.getframerate()
            n_frames = wf.getnframes()

            if nchannels != 1 or sampwidth != 2:
                return {
                    **invalid_base,
                    "error": (
                        f"Expected mono 16-bit PCM WAV (got nchannels={nchannels}, sampwidth={sampwidth})."
                    ),
                }

            if sample_rate <= 0 or n_frames <= 0:
                return {
                    **invalid_base,
                    "isValidWav": n_frames == 0 and sample_rate > 0,
                    "error": "Empty WAV file (0 audio frames).",
                }

            raw_bytes = wf.readframes(n_frames)
            expected_bytes = n_frames * nchannels * sampwidth
            if len(raw_bytes) != expected_bytes:
                return {
                    **invalid_base,
                    "error": (
                        f"Truncated or corrupt WAV data (expected {expected_bytes} bytes, got {len(raw_bytes)})."
                    ),
                }

        samples = array("h")
        samples.frombytes(raw_bytes)
        if sys.byteorder != "little":
            samples.byteswap()

        duration_sec = round(n_frames / float(sample_rate), 3)
        window_size = max(1, int(sample_rate * 0.05))  # 50ms windows

        rms_values: list[float] = []
        clipped_count = 0
        for s in samples:
            if abs(s) >= 32700:
                clipped_count += 1

        for i in range(0, len(samples), window_size):
            chunk = samples[i : i + window_size]
            if not chunk:
                continue
            mean_sq = sum(s * s for s in chunk) / len(chunk)
            rms = math.sqrt(mean_sq) / 32768.0
            rms_values.append(rms)

        if not rms_values:
            return {
                **invalid_base,
                "isValidWav": True,
                "durationSec": duration_sec,
                "error": "No RMS energy windows extracted.",
            }

        overall_rms = math.sqrt(sum(r * r for r in rms_values) / len(rms_values))
        rms_db = 20.0 * math.log10(max(overall_rms, 1e-6))

        silence_threshold = 0.012
        silent_windows = [r < silence_threshold for r in rms_values]
        silence_ratio = sum(1 for s in silent_windows if s) / len(silent_windows)

        active_rms_db = [
            20.0 * math.log10(max(r, 1e-6))
            for r in rms_values
            if r >= silence_threshold
        ]
        if len(active_rms_db) >= 2:
            sorted_db = sorted(active_rms_db)
            p10 = sorted_db[max(0, int(0.1 * (len(sorted_db) - 1)))]
            p90 = sorted_db[min(len(sorted_db) - 1, int(0.9 * (len(sorted_db) - 1)))]
            energy_dynamic_range_db = round(max(0.0, p90 - p10), 1)
            energy_db = round(sum(active_rms_db) / len(active_rms_db), 1)
        else:
            energy_dynamic_range_db = 0.0
            energy_db = round(rms_db, 1)

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

        pitch_info = _extract_pitch_contour(samples, sample_rate)
        voiced_frames = pitch_info["voicedFrames"]
        peak_clip_ratio = round(clipped_count / max(1, len(samples)), 4)

        is_silent = rms_db < -48.0 or silence_ratio > 0.94 or voiced_frames < 3
        return {
            "isSilent": is_silent,
            "isValidWav": True,
            "durationSec": duration_sec,
            "rmsDb": round(rms_db, 1),
            "energyDb": energy_db,
            "energyDynamicRangeDb": energy_dynamic_range_db,
            "pauseCount": pause_count,
            "silenceRatio": round(silence_ratio, 2),
            "peakClipRatio": peak_clip_ratio,
            **pitch_info,
        }
    except Exception as exc:
        logger.warning("analyze_wav_acoustics decode failure for %s: %s", wav_path, exc)
        return {
            **invalid_base,
            "error": f"WAV decode error: {exc}",
        }


def count_japanese_moras(text: str) -> int:
    """Counts Japanese moras using fugashi readings (combining small kana with preceding mora)."""
    cleaned = (text or "").strip()
    if not cleaned:
        return 0

    tokens = tokenize_sentence(cleaned, "ja")
    total_moras = 0
    for tok in tokens:
        surface = tok.get("surface") or ""
        if PUNCT_TOKEN_RE.match(surface):
            continue
        kana = tok.get("reading") or katakana_to_hiragana(surface)
        # Strip punctuation/spaces inside kana string
        kana = re.sub(r"[\s.,!?;:\"'()「」『』、。！？—\-]+", "", kana)
        if not kana:
            continue
        # Each kana char except small palatal/vowel modifiers (ゃゅょぁぃぅぇぉ) is 1 mora.
        # Geminate っ/ッ, long vowel ー, and nasal ん/ン each count as 1 mora.
        mora_chars = [ch for ch in kana if not SMALL_KANA_RE.match(ch)]
        total_moras += max(1, len(mora_chars)) if kana else 0
    return total_moras


def compute_speech_rate(text: str, language: str, duration_sec: float) -> float:
    """Computes speech rate in WPM (English) or Moras/min (Japanese)."""
    eff_dur = max(0.5, duration_sec)
    if language == "ja":
        units = count_japanese_moras(text)
    else:
        words = [
            t for t in tokenize_sentence(text, "en")
            if not PUNCT_TOKEN_RE.match(t.get("surface", ""))
        ]
        units = len(words)
    return round((units / eff_dur) * 60.0, 1)


def _normalize_token_phonetic(tok: dict[str, Any], language: str) -> str:
    """Normalizes token into lowercase kana/word key for alignment."""
    raw = tok.get("reading") or tok.get("surface") or ""
    if language == "ja":
        return katakana_to_hiragana(raw).strip().lower()
    norm = EN_NORMALIZE_RE.sub("", raw.lower()).strip()
    return norm or raw.strip().lower()


def compute_deterministic_word_diff(
    target_text: str,
    spoken_text: str,
    language: str,
) -> dict[str, Any]:
    """Computes language-aware alignment penalizing substitutions, omissions, AND insertions (R07)."""
    target_tokens = [
        t for t in tokenize_sentence(target_text, language)
        if not PUNCT_TOKEN_RE.match(t["surface"])
    ]
    spoken_tokens = [
        t for t in tokenize_sentence(spoken_text, language)
        if not PUNCT_TOKEN_RE.match(t["surface"])
    ]

    t_norms = [_normalize_token_phonetic(t, language) for t in target_tokens]
    s_norms = [_normalize_token_phonetic(t, language) for t in spoken_tokens]

    matcher = difflib.SequenceMatcher(None, t_norms, s_norms)
    diff_items: list[dict[str, Any]] = []
    word_analysis: list[dict[str, Any]] = []

    exact_matches = 0
    uncertain_matches = 0
    substitutions = 0
    omissions = 0
    insertions = 0
    phonetic_credit_sum = 0.0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for idx in range(i1, i2):
                tok = target_tokens[idx]
                exact_matches += 1
                phonetic_credit_sum += 1.0
                diff_items.append(
                    {
                        "word": tok["surface"],
                        "reading": tok.get("reading"),
                        "status": "correct",
                    }
                )
                word_analysis.append(
                    {
                        "word": tok["surface"],
                        "reading": tok.get("reading"),
                        "status": "correct",
                    }
                )
        elif tag == "delete":
            for idx in range(i1, i2):
                tok = target_tokens[idx]
                omissions += 1
                diff_items.append(
                    {
                        "word": tok["surface"],
                        "reading": tok.get("reading"),
                        "status": "omitted",
                        "explanation": "Not detected in spoken recording.",
                    }
                )
                word_analysis.append(
                    {
                        "word": tok["surface"],
                        "reading": tok.get("reading"),
                        "status": "missing",
                        "explanation": "Not detected in spoken recording.",
                    }
                )
        elif tag == "replace":
            t_slice = target_tokens[i1:i2]
            s_slice = spoken_tokens[j1:j2]
            pair_count = min(len(t_slice), len(s_slice))

            for k in range(pair_count):
                t_tok = t_slice[k]
                s_tok = s_slice[k]
                t_phon = _normalize_token_phonetic(t_tok, language)
                s_phon = _normalize_token_phonetic(s_tok, language)
                sim = difflib.SequenceMatcher(None, t_phon, s_phon).ratio()

                if sim >= 0.65:
                    status = "stt_uncertain"
                    analysis_status = "uncertain"
                    uncertain_matches += 1
                    phonetic_credit_sum += 0.85
                    explanation = "Close phonetic match (possible STT homophone)."
                else:
                    status = "substituted"
                    analysis_status = "substituted"
                    substitutions += 1
                    phonetic_credit_sum += 0.45 * sim
                    explanation = f"Heard '{s_tok['surface']}' instead of '{t_tok['surface']}'."

                diff_items.append(
                    {
                        "word": s_tok["surface"],
                        "expectedWord": t_tok["surface"],
                        "reading": t_tok.get("reading"),
                        "status": status,
                        "explanation": explanation,
                    }
                )
                word_analysis.append(
                    {
                        "word": s_tok["surface"],
                        "expectedWord": t_tok["surface"],
                        "reading": t_tok.get("reading"),
                        "status": analysis_status,
                        "explanation": explanation,
                    }
                )

            # Fix R07: handle unequal replace spans explicitly (extra target = omitted, extra spoken = inserted)
            for t_tok in t_slice[pair_count:]:
                omissions += 1
                diff_items.append(
                    {
                        "word": t_tok["surface"],
                        "reading": t_tok.get("reading"),
                        "status": "omitted",
                        "explanation": "Not detected in spoken recording.",
                    }
                )
                word_analysis.append(
                    {
                        "word": t_tok["surface"],
                        "reading": t_tok.get("reading"),
                        "status": "missing",
                        "explanation": "Not detected in spoken recording.",
                    }
                )

            for s_tok in s_slice[pair_count:]:
                insertions += 1
                diff_items.append(
                    {
                        "word": s_tok["surface"],
                        "status": "inserted",
                        "explanation": "Extra word spoken.",
                    }
                )
                word_analysis.append(
                    {
                        "word": s_tok["surface"],
                        "status": "inserted",
                        "explanation": "Extra word spoken.",
                    }
                )
        elif tag == "insert":
            for idx in range(j1, j2):
                s_tok = spoken_tokens[idx]
                insertions += 1
                diff_items.append(
                    {
                        "word": s_tok["surface"],
                        "status": "inserted",
                        "explanation": "Extra word spoken.",
                    }
                )
                word_analysis.append(
                    {
                        "word": s_tok["surface"],
                        "status": "inserted",
                        "explanation": "Extra word spoken.",
                    }
                )

    total_target = max(1, len(target_tokens))
    # Explicit WER-style penalty including substitutions, omissions, AND insertions (R07)
    error_units = substitutions + omissions + insertions + (0.15 * uncertain_matches)
    accuracy = round(max(0.0, min(100.0, (1.0 - (error_units / total_target)) * 100.0)), 1)
    phonetic_match_score = round(
        max(0.0, min(100.0, (phonetic_credit_sum / total_target) * 100.0)), 1
    )

    return {
        "contentAccuracyEstimate": accuracy,
        "phoneticMatchEstimate": phonetic_match_score,
        "targetTokenCount": len(target_tokens),
        "spokenTokenCount": len(spoken_tokens),
        "omittedCount": omissions,
        "substitutedCount": substitutions,
        "insertedCount": insertions,
        "uncertainSttCount": uncertain_matches,
        "baselineWordDiff": diff_items,
        "wordAnalysis": word_analysis,
        "targetTokens": target_tokens,
    }


async def transcribe_audio_with_whisper(
    wav_path: Path,
    language: str = "en",
) -> dict[str, Any]:
    """Transcribes a 16kHz mono WAV via local whisper-server and extracts word confidences."""
    try:
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
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
        if resp.status_code != 200:
            return {
                "text": "",
                "words": [],
                "meanConfidence": None,
                "whisperOnline": True,
                "error": f"whisper-server returned HTTP {resp.status_code}",
            }

        data = resp.json()
        text = (data.get("text") or "").strip()

        words: list[dict[str, Any]] = []
        confidences: list[float] = []

        if isinstance(data.get("words"), list):
            for w in data["words"]:
                prob = w.get("probability")
                if prob is None and w.get("avg_logprob") is not None:
                    prob = math.exp(float(w["avg_logprob"]))
                if isinstance(prob, (int, float)):
                    prob_clamped = max(0.0, min(1.0, float(prob)))
                    confidences.append(prob_clamped)
                else:
                    prob_clamped = None
                words.append(
                    {
                        "word": w.get("word", ""),
                        "start": w.get("start"),
                        "end": w.get("end"),
                        "probability": prob_clamped,
                    }
                )

        if not confidences and isinstance(data.get("segments"), list):
            for seg in data["segments"]:
                if isinstance(seg.get("words"), list):
                    for w in seg["words"]:
                        prob = w.get("probability")
                        if isinstance(prob, (int, float)):
                            confidences.append(max(0.0, min(1.0, float(prob))))
                elif isinstance(seg.get("avg_logprob"), (int, float)):
                    confidences.append(max(0.0, min(1.0, math.exp(float(seg["avg_logprob"])))))

        mean_conf = round(sum(confidences) / len(confidences), 3) if confidences else None
        return {
            "text": text,
            "words": words,
            "meanConfidence": mean_conf,
            "whisperOnline": True,
        }
    except Exception as exc:
        logger.warning("Whisper server call failed: %s", exc)
        return {
            "text": "",
            "words": [],
            "meanConfidence": None,
            "whisperOnline": False,
            "error": str(exc),
        }


def _resample_contour(values: list[float], target_len: int = 32) -> list[float]:
    """Linearly resamples a numeric contour to target_len points."""
    if not values:
        return []
    if len(values) == 1:
        return [values[0]] * target_len
    if len(values) == target_len:
        return list(values)
    out: list[float] = []
    scale = (len(values) - 1) / float(max(1, target_len - 1))
    for i in range(target_len):
        pos = i * scale
        lo = int(math.floor(pos))
        hi = min(len(values) - 1, lo + 1)
        frac = pos - lo
        out.append(values[lo] * (1.0 - frac) + values[hi] * frac)
    return out


def _pearson_corr(xs: list[float], ys: list[float]) -> float | None:
    """Computes Pearson correlation coefficient between two equal-length series."""
    if len(xs) != len(ys) or len(xs) < 4:
        return None
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx <= 1e-9 or dy <= 1e-9:
        return None
    return max(-1.0, min(1.0, num / (dx * dy)))


def compare_with_reference_wav(
    learner_acoustics: dict[str, Any],
    video_id: str | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> dict[str, Any]:
    """Compares learner pitch/rhythm against a cached YouTube reference clip if available locally."""
    if not video_id or not re.fullmatch(r"[a-zA-Z0-9_-]{11}", video_id.strip()):
        return {"hasReference": False, "referencePitchContour": []}

    clean_id = video_id.strip()
    candidates: list[Path] = []
    for base_dir in (YT_CACHE_DIR, TEMP_AUDIO_DIR):
        if base_dir.is_dir():
            candidates.extend(sorted(base_dir.glob(f"*{clean_id}*.wav")))

    if not candidates:
        return {"hasReference": False, "referencePitchContour": []}

    ref_wav = candidates[0]
    sliced_tmp: Path | None = None
    target_wav = ref_wav

    try:
        if start_sec is not None and end_sec is not None and end_sec > start_sec:
            sliced_tmp = TEMP_AUDIO_DIR / f"ref_slice_{uuid.uuid4().hex[:8]}.wav"
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    f"{max(0.0, start_sec):.3f}",
                    "-to",
                    f"{end_sec:.3f}",
                    "-i",
                    str(ref_wav),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(sliced_tmp),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                timeout=15,
            )
            target_wav = sliced_tmp

        ref_acoustics = analyze_wav_acoustics(target_wav)
        if not ref_acoustics.get("isValidWav") or ref_acoustics.get("isSilent"):
            return {"hasReference": False, "referencePitchContour": []}

        ref_contour = ref_acoustics.get("pitchContour") or []
        learner_contour = learner_acoustics.get("pitchContour") or []
        if len(ref_contour) < 5 or len(learner_contour) < 5:
            return {
                "hasReference": True,
                "referencePitchContour": ref_contour,
                "pitchCorrelation": None,
                "rhythmSimilarity": None,
            }

        res_l = _resample_contour(learner_contour, 32)
        res_r = _resample_contour(ref_contour, 32)
        corr = _pearson_corr(res_l, res_r)

        l_dur = max(0.5, float(learner_acoustics.get("durationSec") or 1.0))
        r_dur = max(0.5, float(ref_acoustics.get("durationSec") or 1.0))
        rhythm_sim = max(0.0, min(1.0, 1.0 - abs(l_dur - r_dur) / max(l_dur, r_dur)))

        return {
            "hasReference": True,
            "referencePitchContour": ref_contour,
            "pitchCorrelation": round(corr, 3) if corr is not None else None,
            "rhythmSimilarity": round(rhythm_sim, 3),
        }
    except Exception as exc:
        logger.debug("Reference WAV comparison skipped: %s", exc)
        return {"hasReference": False, "referencePitchContour": []}
    finally:
        if sliced_tmp is not None:
            sliced_tmp.unlink(missing_ok=True)


def build_hard_gate_result(
    target_text: str,
    recognized_text: str,
    language: str,
    duration_sec: float,
    target_duration_sec: float,
    acoustics: dict[str, Any],
    reason: str,
    status: str = "no_speech",
) -> dict[str, Any]:
    """Constructs a strict 0-score report when audio fails hard gates (R01/R02/R03/R11)."""
    target_tokens = [
        t for t in tokenize_sentence(target_text, language)
        if not PUNCT_TOKEN_RE.match(t["surface"])
    ]
    word_diff = [
        {
            "word": tok["surface"],
            "reading": tok.get("reading"),
            "status": "omitted",
            "explanation": "No valid speech detected in recording.",
        }
        for tok in target_tokens
    ]
    word_analysis = [
        {
            "word": tok["surface"],
            "reading": tok.get("reading"),
            "status": "missing",
            "explanation": "No valid speech detected in recording.",
        }
        for tok in target_tokens
    ]

    target_rate = compute_speech_rate(target_text, language, target_duration_sec)
    if target_rate <= 0:
        target_rate = 300.0 if language == "ja" else 130.0

    return {
        "status": status,
        "hardGateTriggered": True,
        "isValidWav": bool(acoustics.get("isValidWav", False)),
        "isSilent": bool(acoustics.get("isSilent", True)),
        "targetText": target_text,
        "recognizedText": recognized_text,
        "recognizedTranscript": recognized_text,
        "overallScore": 0.0,
        "accuracyScore": 0.0,
        "fluencyScore": 0.0,
        "rhythmScore": 0.0,
        "pronunciationScore": 0.0,
        "prosodyScore": 0.0,
        "intonationScore": 0.0,
        "dimensions": {
            "contentAccuracy": 0.0,
            "pronunciation": 0.0,
            "fluency": 0.0,
            "prosody": 0.0,
        },
        "speechRateValue": 0.0,
        "speechRateWpm": 0.0,
        "targetRateValue": target_rate,
        "metrics": {
            "speechRateValue": 0.0,
            "speechRateUnit": "Moras/min" if language == "ja" else "WPM",
            "targetRateValue": target_rate,
            "durationSec": round(duration_sec, 3),
            "targetDurationSec": round(target_duration_sec, 3),
            "omittedCount": len(target_tokens),
            "substitutedCount": 0,
            "uncertainSttCount": 0,
        },
        "durationSec": round(duration_sec, 3),
        "rmsDb": float(acoustics.get("rmsDb", -90.0)),
        "energyDb": float(acoustics.get("energyDb", -90.0)),
        "pauseCount": int(acoustics.get("pauseCount", 0)),
        "silenceRatio": float(acoustics.get("silenceRatio", 1.0)),
        "voicedFrames": int(acoustics.get("voicedFrames", 0)),
        "f0StdHz": float(acoustics.get("f0StdHz", 0.0)),
        "pitchContour": acoustics.get("pitchContour", []),
        "referencePitchContour": [],
        "wordDiff": word_diff,
        "wordAnalysis": word_analysis,
        "scoreExplanation": reason,
        "feedback": reason,
        "intonationTips": [
            "Ensure your microphone is active and speak clearly near the mic for at least 1 second."
        ],
        "actionableImprovements": [
            "Check your microphone input level and try recording the phrase again."
        ],
        "pronunciationFeedback": [],
        "improvementSuggestions": [
            "Check your microphone input level and try recording the phrase again."
        ],
        "recommendedRetryText": target_text,
    }


def evaluate_acoustics_and_alignment(
    target_text: str,
    recognized_text: str,
    language: str,
    duration_sec: float,
    target_duration_sec: float,
    acoustics: dict[str, Any],
    whisper_info: dict[str, Any] | None = None,
    ref_comparison: dict[str, Any] | None = None,
    simulated_take: bool = False,
) -> dict[str, Any]:
    """Computes deterministic weighted shadowing scores and enforces hard gates (R01-R07, R11)."""
    clean_recognized = (recognized_text or "").strip()
    eff_duration = float(acoustics.get("durationSec") or duration_sec or 0.0)

    if not simulated_take:
        if not acoustics.get("isValidWav", True):
            return build_hard_gate_result(
                target_text=target_text,
                recognized_text="",
                language=language,
                duration_sec=0.0,
                target_duration_sec=target_duration_sec,
                acoustics=acoustics,
                reason=acoustics.get("error") or "Invalid or corrupt WAV audio payload.",
                status="decode_error",
            )
        if acoustics.get("isSilent", True):
            return build_hard_gate_result(
                target_text=target_text,
                recognized_text="",
                language=language,
                duration_sec=eff_duration,
                target_duration_sec=target_duration_sec,
                acoustics=acoustics,
                reason="No clear speech detected in recording (audio is silent or below noise floor).",
                status="no_speech",
            )
        if eff_duration < 0.8:
            return build_hard_gate_result(
                target_text=target_text,
                recognized_text=clean_recognized,
                language=language,
                duration_sec=eff_duration,
                target_duration_sec=target_duration_sec,
                acoustics=acoustics,
                reason=f"Recording too short ({eff_duration:.2f}s < 0.80s minimum) for reliable evaluation.",
                status="no_speech",
            )
        if int(acoustics.get("voicedFrames", 0)) < 5:
            return build_hard_gate_result(
                target_text=target_text,
                recognized_text=clean_recognized,
                language=language,
                duration_sec=eff_duration,
                target_duration_sec=target_duration_sec,
                acoustics=acoustics,
                reason="Insufficient voiced speech frames detected (possible noise-only capture).",
                status="no_speech",
            )

    if not clean_recognized:
        return build_hard_gate_result(
            target_text=target_text,
            recognized_text="",
            language=language,
            duration_sec=eff_duration,
            target_duration_sec=target_duration_sec,
            acoustics=acoustics,
            reason="No spoken words recognized in recording.",
            status="no_speech",
        )

    diff_info = compute_deterministic_word_diff(target_text, clean_recognized, language)
    accuracy_score = float(diff_info["contentAccuracyEstimate"])
    phonetic_est = float(diff_info["phoneticMatchEstimate"])

    # Speech rate vs target rate
    actual_rate = compute_speech_rate(clean_recognized, language, max(0.8, eff_duration))
    target_rate = compute_speech_rate(target_text, language, max(0.8, target_duration_sec))
    if target_rate <= 0:
        target_rate = 300.0 if language == "ja" else 130.0

    # Fluency score: pause continuity, active speech ratio, and pacing stability
    pause_count = int(acoustics.get("pauseCount", 0))
    silence_ratio = float(acoustics.get("silenceRatio", 0.2))
    rate_ratio = actual_rate / max(1.0, target_rate)
    fluency_raw = (
        98.0
        - (pause_count * 10.0)
        - max(0.0, silence_ratio - 0.25) * 60.0
        - abs(rate_ratio - 1.0) * 32.0
    )
    # If almost no target words were matched, cap fluency so unrelated babble isn't scored high
    if accuracy_score < 20.0:
        fluency_raw = min(fluency_raw, 45.0 + accuracy_score)
    fluency_score = round(max(0.0, min(100.0, fluency_raw)), 1)

    # Pronunciation score: phonetic/kana alignment + Whisper acoustic confidence + audio clarity
    mean_conf = (whisper_info or {}).get("meanConfidence")
    clip_ratio = float(acoustics.get("peakClipRatio", 0.0))
    clip_penalty = min(15.0, clip_ratio * 200.0)
    if isinstance(mean_conf, (int, float)) and not simulated_take:
        pron_raw = (0.70 * phonetic_est) + (0.30 * (float(mean_conf) * 100.0)) - clip_penalty
    else:
        pron_raw = (phonetic_est * 0.96) - clip_penalty
    pronunciation_score = round(max(0.0, min(100.0, pron_raw)), 1)

    # Prosody score: pitch contour variation (non-monotone F0), energy dynamics, & optional reference F0 match
    f0_std = float(acoustics.get("f0StdHz", 0.0))
    energy_dyn = float(acoustics.get("energyDynamicRangeDb", 6.0))
    if simulated_take:
        pitch_var_score = 78.0
        energy_score = 78.0
    else:
        if f0_std < 3.0:
            pitch_var_score = 35.0  # Monotone penalty
        elif f0_std < 10.0:
            pitch_var_score = 35.0 + ((f0_std - 3.0) / 7.0) * 40.0
        elif f0_std <= 75.0:
            pitch_var_score = 75.0 + min(18.0, (f0_std - 10.0) * 0.45)
        else:
            pitch_var_score = max(65.0, 93.0 - (f0_std - 75.0) * 0.2)

        energy_score = min(95.0, 45.0 + energy_dyn * 4.0)

    rhythm_score = round(
        max(0.0, min(100.0, 94.0 - abs(rate_ratio - 1.0) * 35.0 - pause_count * 7.0)),
        1,
    )

    prosody_raw = 0.50 * pitch_var_score + 0.25 * energy_score + 0.25 * rhythm_score
    ref_contour: list[float] = []
    if ref_comparison and ref_comparison.get("hasReference"):
        ref_contour = ref_comparison.get("referencePitchContour") or []
        p_corr = ref_comparison.get("pitchCorrelation")
        r_sim = ref_comparison.get("rhythmSimilarity")
        if p_corr is not None:
            corr_score = max(20.0, min(100.0, (p_corr + 1.0) * 50.0))
            prosody_raw = 0.65 * prosody_raw + 0.35 * corr_score
        if r_sim is not None:
            rhythm_score = round(0.6 * rhythm_score + 0.4 * (r_sim * 100.0), 1)

    if accuracy_score < 20.0:
        prosody_raw = min(prosody_raw, 45.0 + accuracy_score)
    prosody_score = round(max(0.0, min(100.0, prosody_raw)), 1)

    # Exact weighted formula specified for EchoLearning R5:
    # 0.35 * accuracyScore + 0.25 * fluencyScore + 0.25 * pronunciationScore + 0.15 * prosodyScore
    overall_score = round(
        0.35 * accuracy_score
        + 0.25 * fluency_score
        + 0.25 * pronunciation_score
        + 0.15 * prosody_score,
        1,
    )

    return {
        "status": "ok",
        "hardGateTriggered": False,
        "isDemo": simulated_take,
        "isValidWav": bool(acoustics.get("isValidWav", True)),
        "isSilent": False,
        "targetText": target_text,
        "recognizedText": clean_recognized,
        "recognizedTranscript": clean_recognized,
        "overallScore": overall_score,
        "accuracyScore": accuracy_score,
        "fluencyScore": fluency_score,
        "rhythmScore": rhythm_score,
        "pronunciationScore": pronunciation_score,
        "prosodyScore": prosody_score,
        "intonationScore": prosody_score,
        "dimensions": {
            "contentAccuracy": accuracy_score,
            "pronunciation": pronunciation_score,
            "fluency": fluency_score,
            "prosody": prosody_score,
        },
        "speechRateValue": actual_rate,
        "speechRateWpm": actual_rate,
        "targetRateValue": target_rate,
        "metrics": {
            "speechRateValue": actual_rate,
            "speechRateUnit": "Moras/min" if language == "ja" else "WPM",
            "targetRateValue": target_rate,
            "durationSec": round(eff_duration, 3),
            "targetDurationSec": round(target_duration_sec, 3),
            "omittedCount": diff_info["omittedCount"],
            "substitutedCount": diff_info["substitutedCount"],
            "uncertainSttCount": diff_info["uncertainSttCount"],
        },
        "durationSec": round(eff_duration, 3),
        "rmsDb": float(acoustics.get("rmsDb", -20.0)),
        "energyDb": float(acoustics.get("energyDb", -20.0)),
        "pauseCount": pause_count,
        "silenceRatio": silence_ratio,
        "voicedFrames": int(acoustics.get("voicedFrames", 0)),
        "f0StdHz": f0_std,
        "pitchContour": acoustics.get("pitchContour", []),
        "referencePitchContour": ref_contour,
        "wordDiff": diff_info["baselineWordDiff"],
        "wordAnalysis": diff_info["wordAnalysis"],
        "contentAccuracyEstimate": accuracy_score,
        "baselineWordDiff": diff_info["baselineWordDiff"],
    }


async def transcribe_and_analyze_audio(
    language: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """ADK FunctionTool: Transcribes audio from session.state and computes acoustic metrics.

    Reads 'audio_base64', 'mime_type', 'target_text', and 'web_speech_transcript'
    directly from tool_context.state so raw audio bytes NEVER enter the LLM context.

    Args:
        language: 'en' for English or 'ja' for Japanese.
    """
    audio_b64: str | None = tool_context.state.get("audio_base64")
    mime_type: str = tool_context.state.get("mime_type", "audio/webm")
    target_text: str = tool_context.state.get("target_text", "")
    web_speech: str = tool_context.state.get("web_speech_transcript", "")

    if not audio_b64:
        diff_info = compute_deterministic_word_diff(target_text, web_speech, language)
        return {
            "verbatimTranscript": web_speech,
            "acoustics": {
                "isSilent": not bool(web_speech.strip()),
                "isValidWav": True,
                "rmsDb": -18.0,
                "pauseCount": 0,
                "silenceRatio": 0.15,
                "voicedFrames": 20 if web_speech.strip() else 0,
                "pitchContour": [],
                "simulatedTake": True,
            },
            **diff_info,
        }

    file_id = uuid.uuid4().hex[:10]
    ext = ".wav" if "wav" in mime_type else (".mp4" if "mp4" in mime_type else ".webm")
    raw_path = TEMP_AUDIO_DIR / f"in_{file_id}{ext}"
    wav_path = TEMP_AUDIO_DIR / f"pcm_{file_id}.wav"

    try:
        raw_path.write_bytes(base64.b64decode(audio_b64))
        hdr = inspect_wav_header(raw_path) if ext == ".wav" else {"isValidWav": False}
        if (
            hdr.get("isValidWav")
            and hdr.get("nchannels") == 1
            and hdr.get("sampwidth") == 2
            and hdr.get("framerate") == 16000
        ):
            acoustics = analyze_wav_acoustics(raw_path)
            eval_wav = raw_path
        else:
            convert_to_16khz_mono_wav(raw_path, wav_path)
            acoustics = analyze_wav_acoustics(wav_path)
            eval_wav = wav_path

        if not acoustics.get("isValidWav", True) or acoustics.get("isSilent", True):
            return {
                "verbatimTranscript": "",
                "acoustics": acoustics,
                "contentAccuracyEstimate": 0.0,
                "baselineWordDiff": [],
            }

        whisper_res = await transcribe_audio_with_whisper(eval_wav, language=language)
        verbatim_text = (whisper_res.get("text") or "").strip() or web_speech.strip()
        diff_info = compute_deterministic_word_diff(target_text, verbatim_text, language)
        return {
            "verbatimTranscript": verbatim_text,
            "acoustics": acoustics,
            "whisperInfo": whisper_res,
            **diff_info,
        }
    except Exception as exc:
        logger.warning("transcribe_and_analyze_audio error: %s", exc)
        return {
            "verbatimTranscript": "",
            "acoustics": {
                "isSilent": True,
                "isValidWav": False,
                "error": str(exc),
                "rmsDb": -90.0,
                "pauseCount": 0,
                "silenceRatio": 1.0,
                "voicedFrames": 0,
                "pitchContour": [],
            },
            "contentAccuracyEstimate": 0.0,
            "baselineWordDiff": [],
        }
    finally:
        raw_path.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)
