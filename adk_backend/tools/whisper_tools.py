import base64
import difflib
import logging
import math
import re
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
BOH_PUNCT_RE = re.compile(r"[.,!?;:\"'()\[\]{}「」『』、。！？—\-…・〜~]+")

BAG_OF_HALLUCINATIONS = frozenset({
    "thank you for watching",
    "thanks for watching",
    "thank you for listening",
    "subtitles by",
    "please subscribe",
    "ご視聴ありがとうございました",
    "チャンネル登録",
    "チャンネル登録よろしくお願いします",
    "字幕",
    "おやすみなさい",
    "お疲れ様でした",
})

EN_FUNCTION_WORDS = frozenset({
    "a", "an", "the", "to", "of", "in", "on", "at", "for", "and", "or", "but",
    "is", "am", "are", "was", "were", "be", "been", "have", "has", "had",
    "do", "does", "did", "will", "would", "can", "could", "should",
    "that", "this", "it", "as", "by", "with", "from",
})


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
    """Extracts F0 pitch contour (Hz & Semitones) using normalized autocorrelation over voiced frames.

    Pure-Python + stdlib implementation (no C-extension crash risk); downsamples >=16kHz audio
    by 2x for fast sub-50ms execution while maintaining 60-450 Hz speech F0 accuracy.
    """
    if not samples or sample_rate <= 0:
        return {
            "pitchContour": [],
            "voicedFrames": 0,
            "f0MeanHz": 0.0,
            "f0MedianHz": 0.0,
            "f0StdHz": 0.0,
            "f0StdSt": 0.0,
            "f0RangeHz": 0.0,
        }

    # Decimate by 2 when sample_rate >= 16000 so autocorrelation lag search is fast and crisp
    decim = 2 if sample_rate >= 16000 else 1
    eff_sr = sample_rate / decim
    if decim > 1:
        sig = [samples[i] / 32768.0 for i in range(0, len(samples), decim)]
    else:
        sig = [s / 32768.0 for s in samples]

    frame_len = max(32, int(eff_sr * 0.035))  # 35ms frame (>= 2 periods down to 60 Hz)
    hop_len = max(16, int(eff_sr * 0.020), max(1, (len(sig) - frame_len) // 200))  # cap ~200 frames
    min_lag = max(2, int(eff_sr / 450.0))     # max 450 Hz
    max_lag = min(frame_len - 2, int(eff_sr / 60.0))  # min 60 Hz

    if len(sig) < frame_len or max_lag <= min_lag:
        return {
            "pitchContour": [],
            "voicedFrames": 0,
            "f0MeanHz": 0.0,
            "f0MedianHz": 0.0,
            "f0StdHz": 0.0,
            "f0StdSt": 0.0,
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
        if 58.0 <= f0_hz <= 480.0:
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
            "f0MedianHz": 0.0,
            "f0StdHz": 0.0,
            "f0StdSt": 0.0,
            "f0RangeHz": 0.0,
        }

    f0_mean = sum(smoothed_voiced) / voiced_count
    sorted_voiced = sorted(smoothed_voiced)
    mid = voiced_count // 2
    f0_median = (
        sorted_voiced[mid]
        if voiced_count % 2 == 1
        else 0.5 * (sorted_voiced[mid - 1] + sorted_voiced[mid])
    )
    f0_std = (
        math.sqrt(sum((v - f0_mean) ** 2 for v in smoothed_voiced) / voiced_count)
        if voiced_count >= 2
        else 0.0
    )
    f0_range = max(smoothed_voiced) - min(smoothed_voiced)

    # Convert voiced F0 into Semitones relative to speaker median (12 * log2(F0 / F0_median))
    st_vals = [
        12.0 * math.log2(f0 / f0_median)
        for f0 in sorted_voiced
        if f0 > 0.0 and f0_median > 0.0
    ]
    if len(st_vals) >= 20:
        trim = max(1, int(len(st_vals) * 0.05))
        trimmed_st = st_vals[trim : len(st_vals) - trim]
    else:
        trimmed_st = st_vals
    if len(trimmed_st) >= 2:
        st_mean = sum(trimmed_st) / len(trimmed_st)
        f0_std_st = math.sqrt(sum((v - st_mean) ** 2 for v in trimmed_st) / len(trimmed_st))
    else:
        f0_std_st = 0.0

    # Downsample contour to at most 120 points for compact JSON payloads
    contour = smoothed_voiced
    if len(contour) > 120:
        step = len(contour) / 120.0
        contour = [contour[min(len(contour) - 1, int(i * step))] for i in range(120)]

    return {
        "pitchContour": contour,
        "voicedFrames": voiced_count,
        "f0MeanHz": round(f0_mean, 1),
        "f0MedianHz": round(f0_median, 1),
        "f0StdHz": round(f0_std, 1),
        "f0StdSt": round(f0_std_st, 2),
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
        "f0MedianHz": 0.0,
        "f0StdHz": 0.0,
        "f0StdSt": 0.0,
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

        # Count mid-utterance pauses (>= 250ms = 5 consecutive 50ms silent windows)
        active_indices = [idx for idx, is_sil in enumerate(silent_windows) if not is_sil]
        pause_count = 0
        if len(active_indices) >= 2:
            interior = silent_windows[active_indices[0] : active_indices[-1] + 1]
            run = 0
            for is_sil in interior:
                if is_sil:
                    run += 1
                else:
                    if run >= 5:
                        pause_count += 1
                    run = 0

        pitch_info = _extract_pitch_contour(samples, sample_rate)
        voiced_frames = pitch_info["voicedFrames"]
        peak_clip_ratio = round(clipped_count / max(1, len(samples)), 4)

        if voiced_frames >= 5 and len(active_rms_db) >= 6 and energy_db >= -46.0:
            is_silent = False
            reported_rms_db = round(max(rms_db, energy_db), 1)
        else:
            is_silent = rms_db < -48.0 or silence_ratio > 0.94 or voiced_frames < 3
            reported_rms_db = round(rms_db, 1)

        return {
            "isSilent": is_silent,
            "isValidWav": True,
            "durationSec": duration_sec,
            "rmsDb": reported_rms_db,
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


def count_english_syllables(text: str) -> int:
    """Estimates English syllable count using vowel-cluster rules with silent-e adjustments."""
    cleaned = (text or "").strip()
    if not cleaned:
        return 0
    tokens = [
        t.get("surface", "")
        for t in tokenize_sentence(cleaned, "en")
        if not PUNCT_TOKEN_RE.match(t.get("surface", ""))
    ]
    total = 0
    for word in tokens:
        w = re.sub(r"[^a-z]", "", word.lower())
        if not w:
            if any(ch.isdigit() for ch in word):
                total += 1
            continue
        if len(w) <= 3:
            total += 1
            continue
        # Strip silent trailing -e / -es / -ed when not forming an extra syllable
        stem = re.sub(r"(?:[^laeiouy]es|ed|[^laeiouy]e)$", "", w)
        stem = re.sub(r"^y", "", stem)
        groups = re.findall(r"[aeiouy]{1,2}", stem)
        total += max(1, len(groups))
    return total


def get_min_duration_sec(target_text: str, language: str) -> float:
    """Computes target-aware minimum recording duration in seconds (0.42s..0.80s)."""
    target_units = (
        count_japanese_moras(target_text)
        if language == "ja"
        else count_english_syllables(target_text)
    )
    return min(0.80, max(0.42, 0.16 * max(1, target_units)))


def _count_internal_punctuation_boundaries(text: str) -> int:
    """Counts internal clause/sentence punctuation boundaries, excluding trailing final punctuation."""
    stripped = (text or "").strip()
    stripped = re.sub(r"[,.;:?!—、。！？…]+$", "", stripped).strip()
    if not stripped:
        return 0
    return len(re.findall(r"[,.;:?!—、。！？]+", stripped))


def _normalize_for_boh(text: str) -> str:
    """Normalizes recognized text for Bag-of-Hallucinations (BoH) lookup."""
    lowered = BOH_PUNCT_RE.sub(" ", (text or "").strip().lower())
    return re.sub(r"\s+", " ", lowered).strip()


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


def _token_weight(
    tok: dict[str, Any],
    norm: str,
    language: str,
    total_target_tokens: int,
) -> float:
    """Assigns 0.5 weight to unstressed EN function words / JA particles when > 2 tokens."""
    if total_target_tokens <= 2:
        return 1.0
    if language == "ja":
        pos = tok.get("pos") or ""
        return 0.5 if pos.startswith(("助詞", "助動詞")) else 1.0
    return 0.5 if norm in EN_FUNCTION_WORDS else 1.0


def _is_self_repair(
    s_norm: str,
    adjacent_target_norms: list[str],
) -> bool:
    """Detects immediate false-start / self-repair repetitions against adjacent target tokens."""
    if not s_norm:
        return False
    for t_norm in adjacent_target_norms:
        if not t_norm:
            continue
        if s_norm == t_norm:
            return True
        if len(s_norm) >= 2 and (t_norm.startswith(s_norm) or s_norm.startswith(t_norm)):
            return True
    return False


_HIGH_FL_EN_PAIRS = frozenset({
    frozenset({"l", "r"}),
    frozenset({"l", "n"}),
    frozenset({"p", "b"}),
    frozenset({"b", "v"}),
    frozenset({"f", "h"}),
    frozenset({"s", "ʃ"}),
    frozenset({"z", "d"}),
})
_LOW_FL_INTERDENTAL_SUBS = frozenset({"t", "d", "s", "z"})


def _detect_phonetic_multipliers(
    t_phon: str,
    s_phon: str,
    language: str,
    is_content_word: bool,
) -> tuple[float, float, str | None, bool]:
    """Computes (onset_mult, fl_mult, fl_tag, onset_mismatch) for intelligibility weighting."""
    onset_mismatch = bool(is_content_word and t_phon and s_phon and t_phon[0] != s_phon[0])
    onset_mult = 1.25 if onset_mismatch else 1.0
    fl_mult = 1.0
    fl_tag: str | None = None

    if language == "ja":
        for special_mora in ("ー", "っ", "ん"):
            if t_phon.count(special_mora) != s_phon.count(special_mora):
                fl_mult = 1.25
                fl_tag = "high_fl_mora"
                break
        return onset_mult, fl_mult, fl_tag, onset_mismatch

    # Map digraphs sh -> ʃ and th -> θ so SequenceMatcher aligns them cleanly
    t_mapped = t_phon.replace("sh", "ʃ").replace("th", "θ")
    s_mapped = s_phon.replace("sh", "ʃ").replace("th", "θ")
    opcodes = difflib.SequenceMatcher(None, t_mapped, s_mapped).get_opcodes()
    saw_low_fl = False
    for tag, a1, a2, b1, b2 in opcodes:
        if tag != "replace":
            continue
        seg_a = t_mapped[a1:a2]
        seg_b = s_mapped[b1:b2]
        pair = frozenset({seg_a, seg_b})
        if pair in _HIGH_FL_EN_PAIRS:
            return onset_mult, 1.25, "high_fl_contrast", onset_mismatch
        if ("θ" in (seg_a, seg_b)) and (
            (seg_a == "θ" and seg_b in _LOW_FL_INTERDENTAL_SUBS)
            or (seg_b == "θ" and seg_a in _LOW_FL_INTERDENTAL_SUBS)
        ):
            saw_low_fl = True

    if saw_low_fl:
        fl_mult = 0.60
        fl_tag = "low_fl_interdental"

    return onset_mult, fl_mult, fl_tag, onset_mismatch


def compute_deterministic_word_diff(
    target_text: str,
    spoken_text: str,
    language: str,
) -> dict[str, Any]:
    """Computes language-aware alignment with function-word weights, self-repairs, and FL multipliers."""
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
    t_weights = [
        _token_weight(t, t_norms[idx], language, len(target_tokens))
        for idx, t in enumerate(target_tokens)
    ]

    matcher = difflib.SequenceMatcher(None, t_norms, s_norms)
    diff_items: list[dict[str, Any]] = []
    word_analysis: list[dict[str, Any]] = []
    priority_candidates: list[dict[str, Any]] = []

    exact_matches = 0
    uncertain_matches = 0
    substitutions = 0
    omissions = 0
    insertions = 0
    repair_count = 0
    unrelated_insertions = 0
    phonetic_credit_sum = 0.0
    weighted_phonetic_credit_sum = 0.0
    error_units = 0.0

    def _add_omitted(t_idx: int, t_tok: dict[str, Any]) -> None:
        nonlocal omissions, error_units
        w_i = t_weights[t_idx]
        is_content = w_i >= 1.0
        omissions += 1
        error_units += 1.0 * w_i
        item = {
            "word": t_tok["surface"],
            "reading": t_tok.get("reading"),
            "status": "omitted",
            "explanation": "Not detected in spoken recording.",
        }
        diff_items.append(item)
        word_analysis.append(
            {
                "word": t_tok["surface"],
                "reading": t_tok.get("reading"),
                "status": "missing",
                "explanation": "Not detected in spoken recording.",
            }
        )
        priority_candidates.append(
            {
                "word": t_tok["surface"],
                "expectedWord": t_tok["surface"],
                "reading": t_tok.get("reading"),
                "status": "omitted",
                "explanation": "Not detected in spoken recording.",
                "priority": round(w_i * (1.25 if is_content else 1.0), 3),
                "isContentWord": is_content,
                "onsetMismatch": False,
                "flCategory": None,
                "index": t_idx,
            }
        )

    def _add_extra_spoken(s_tok: dict[str, Any], s_norm: str, adj_norms: list[str]) -> None:
        nonlocal insertions, repair_count, unrelated_insertions, error_units
        insertions += 1
        if _is_self_repair(s_norm, adj_norms):
            repair_count += 1
            diff_items.append(
                {
                    "word": s_tok["surface"],
                    "status": "self_repair",
                    "explanation": "Self-correction / false start (no accuracy penalty).",
                }
            )
            word_analysis.append(
                {
                    "word": s_tok["surface"],
                    "status": "self_repair",
                    "explanation": "Self-correction / false start (no accuracy penalty).",
                }
            )
        else:
            unrelated_insertions += 1
            error_units += 0.5
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

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for idx in range(i1, i2):
                tok = target_tokens[idx]
                exact_matches += 1
                phonetic_credit_sum += 1.0
                weighted_phonetic_credit_sum += 1.0
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
                _add_omitted(idx, target_tokens[idx])
        elif tag == "replace":
            t_slice = target_tokens[i1:i2]
            s_slice = spoken_tokens[j1:j2]
            pair_count = min(len(t_slice), len(s_slice))

            for k in range(pair_count):
                t_idx = i1 + k
                t_tok = t_slice[k]
                s_tok = s_slice[k]
                t_phon = t_norms[t_idx]
                s_phon = s_norms[j1 + k]
                w_i = t_weights[t_idx]
                is_content = w_i >= 1.0
                sim = difflib.SequenceMatcher(None, t_phon, s_phon).ratio()

                onset_mult, fl_mult, fl_tag, onset_mismatch = _detect_phonetic_multipliers(
                    t_phon,
                    s_phon,
                    language,
                    is_content_word=is_content,
                )
                intel_mult = onset_mult * fl_mult

                if sim >= 0.65:
                    status = "stt_uncertain"
                    analysis_status = "uncertain"
                    uncertain_matches += 1
                    phonetic_credit_sum += 0.85
                    weighted_penalty = min(1.0, 0.15 * intel_mult)
                    weighted_phonetic_credit_sum += max(0.0, 1.0 - weighted_penalty)
                    error_units += 0.15 * w_i
                    explanation = "Close phonetic match (possible STT homophone)."
                    priority_val = round(0.2 * w_i * intel_mult, 3)
                else:
                    status = "substituted"
                    analysis_status = "substituted"
                    substitutions += 1
                    base_credit = 0.45 * sim
                    phonetic_credit_sum += base_credit
                    weighted_penalty = min(1.0, (1.0 - base_credit) * intel_mult)
                    weighted_phonetic_credit_sum += max(0.0, 1.0 - weighted_penalty)
                    error_units += (1.0 - 0.45 * sim) * w_i
                    explanation = f"Heard '{s_tok['surface']}' instead of '{t_tok['surface']}'."
                    priority_val = round(w_i * intel_mult * max(0.35, 1.0 - sim), 3)

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
                priority_candidates.append(
                    {
                        "word": s_tok["surface"],
                        "expectedWord": t_tok["surface"],
                        "reading": t_tok.get("reading"),
                        "status": status,
                        "explanation": explanation,
                        "priority": priority_val,
                        "isContentWord": is_content,
                        "onsetMismatch": onset_mismatch,
                        "flCategory": fl_tag,
                        "index": t_idx,
                    }
                )

            # Fix R07: handle unequal replace spans explicitly (extra target = omitted, extra spoken = inserted)
            for k_rem, t_tok in enumerate(t_slice[pair_count:]):
                _add_omitted(i1 + pair_count + k_rem, t_tok)

            adj_norms_rep = [
                t_norms[idx]
                for idx in range(max(0, i1 - 1), min(len(t_norms), i2 + 1))
            ]
            for k_rem, s_tok in enumerate(s_slice[pair_count:]):
                _add_extra_spoken(s_tok, s_norms[j1 + pair_count + k_rem], adj_norms_rep)
        elif tag == "insert":
            adj_norms_ins = [
                t_norms[idx]
                for idx in (i1 - 1, i1)
                if 0 <= idx < len(t_norms)
            ]
            for idx in range(j1, j2):
                _add_extra_spoken(spoken_tokens[idx], s_norms[idx], adj_norms_ins)

    total_target = max(1, len(target_tokens))
    total_weight = max(1.0, sum(t_weights))
    accuracy = round(max(0.0, min(100.0, (1.0 - (error_units / total_weight)) * 100.0)), 1)
    phonetic_match_score = round(
        max(0.0, min(100.0, (phonetic_credit_sum / total_target) * 100.0)), 1
    )
    weighted_phonetic_match_score = round(
        max(0.0, min(100.0, (weighted_phonetic_credit_sum / total_target) * 100.0)), 1
    )
    priority_candidates.sort(key=lambda item: item["priority"], reverse=True)

    return {
        "contentAccuracyEstimate": accuracy,
        "phoneticMatchEstimate": phonetic_match_score,
        "weightedPhoneticMatchEstimate": weighted_phonetic_match_score,
        "targetTokenCount": len(target_tokens),
        "spokenTokenCount": len(spoken_tokens),
        "matchedCount": exact_matches + uncertain_matches,
        "omittedCount": omissions,
        "substitutedCount": substitutions,
        "insertedCount": insertions,
        "repairCount": repair_count,
        "unrelatedInsertedCount": unrelated_insertions,
        "uncertainSttCount": uncertain_matches,
        "baselineWordDiff": diff_items,
        "wordAnalysis": word_analysis,
        "targetTokens": target_tokens,
        "priorityTokens": priority_candidates,
    }


def clean_whisper_repetitions(text: str) -> str:
    """Removes autoregressive repetition loops (e.g. '最大で最大で最大で...') from Whisper output."""
    if not text:
        return ""
    s = text.strip()
    # Remove spaces inserted between CJK characters across Whisper internal segments
    s = re.sub(r"(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])", "", s)
    # Collapse any 1..25 char phrase repeated >= 3 times consecutively (with optional punctuation/spaces)
    for _ in range(5):
        s = re.sub(r"(.{1,25}?)(?:[、,・\s]*\1){2,}", r"\1", s)
    return s.strip()


async def transcribe_audio_with_whisper(
    wav_path: Path,
    language: str = "en",
) -> dict[str, Any]:
    """Transcribes a 16kHz mono WAV via local whisper-server and extracts word confidences."""
    try:
        async with httpx.AsyncClient(timeout=180.0, trust_env=False) as client:
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
        text = clean_whisper_repetitions(data.get("text") or "")

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
        err_msg = f"{type(exc).__name__}: {exc}".strip(": ")
        logger.warning("Whisper server call failed: %s", err_msg)
        return {
            "text": "",
            "words": [],
            "meanConfidence": None,
            "whisperOnline": False,
            "error": err_msg,
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


def _contour_to_semitones(contour: list[float]) -> list[float]:
    """Converts a positive Hz contour into median-centered Semitones."""
    valid = sorted(v for v in contour if v > 0.0)
    if not valid:
        return []
    mid = len(valid) // 2
    med = valid[mid] if len(valid) % 2 == 1 else 0.5 * (valid[mid - 1] + valid[mid])
    if med <= 0.0:
        return []
    return [12.0 * math.log2(v / med) for v in contour if v > 0.0]


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
        ref_pause_count = int(ref_acoustics.get("pauseCount", 0))
        ref_silence_ratio = float(ref_acoustics.get("silenceRatio", 0.2))

        if len(ref_contour) < 5 or len(learner_contour) < 5:
            return {
                "hasReference": True,
                "referencePitchContour": ref_contour,
                "referencePauseCount": ref_pause_count,
                "referenceSilenceRatio": ref_silence_ratio,
                "pitchCorrelation": None,
                "rhythmSimilarity": None,
            }

        learner_st = _contour_to_semitones(learner_contour)
        ref_st = _contour_to_semitones(ref_contour)
        if len(learner_st) < 5 or len(ref_st) < 5:
            corr = None
        else:
            res_l = _resample_contour(learner_st, 32)
            res_r = _resample_contour(ref_st, 32)
            corr = _pearson_corr(res_l, res_r)

        l_dur = max(0.5, float(learner_acoustics.get("durationSec") or 1.0))
        r_dur = max(0.5, float(ref_acoustics.get("durationSec") or 1.0))
        rhythm_sim = max(0.0, min(1.0, 1.0 - abs(l_dur - r_dur) / max(l_dur, r_dur)))

        return {
            "hasReference": True,
            "referencePitchContour": ref_contour,
            "referencePauseCount": ref_pause_count,
            "referenceSilenceRatio": ref_silence_ratio,
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

    f0_std_st = float(acoustics.get("f0StdSt", 0.0))

    return {
        "status": status,
        "assessmentStatus": status,
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
            "f0StdSt": f0_std_st,
            "unplannedPauseCount": 0,
            "repairCount": 0,
            "isClipped": False,
            "durationLatencySec": 0.0,
            "articulationRateValue": 0.0,
        },
        "durationSec": round(duration_sec, 3),
        "rmsDb": float(acoustics.get("rmsDb", -90.0)),
        "energyDb": float(acoustics.get("energyDb", -90.0)),
        "pauseCount": int(acoustics.get("pauseCount", 0)),
        "unplannedPauseCount": 0,
        "silenceRatio": float(acoustics.get("silenceRatio", 1.0)),
        "voicedFrames": int(acoustics.get("voicedFrames", 0)),
        "f0StdHz": float(acoustics.get("f0StdHz", 0.0)),
        "f0StdSt": f0_std_st,
        "durationLatencySec": 0.0,
        "isClipped": False,
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
    mode: str | None = None,
) -> dict[str, Any]:
    """Computes deterministic weighted shadowing scores and enforces hard gates (R01-R07, R11)."""
    clean_recognized = (recognized_text or "").strip()
    eff_duration = float(acoustics.get("durationSec") or duration_sec or 0.0)
    min_duration_sec = get_min_duration_sec(target_text, language)

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
        if eff_duration < min_duration_sec:
            return build_hard_gate_result(
                target_text=target_text,
                recognized_text=clean_recognized,
                language=language,
                duration_sec=eff_duration,
                target_duration_sec=target_duration_sec,
                acoustics=acoustics,
                reason=(
                    f"Recording too short ({eff_duration:.2f}s < {min_duration_sec:.2f}s minimum) "
                    "for reliable evaluation."
                ),
                status="too_short",
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

    # Whisper Bag-of-Hallucinations (BoH) filter
    norm_rec = _normalize_for_boh(clean_recognized)
    is_boh_phrase = norm_rec in BAG_OF_HALLUCINATIONS or any(
        norm_rec.startswith(prefix + " ") for prefix in ("subtitles by", "字幕")
    )
    if is_boh_phrase:
        t_toks = [
            t for t in tokenize_sentence(target_text, language)
            if not PUNCT_TOKEN_RE.match(t["surface"])
        ]
        s_toks = [
            t for t in tokenize_sentence(clean_recognized, language)
            if not PUNCT_TOKEN_RE.match(t["surface"])
        ]
        t_norm_set = {_normalize_token_phonetic(t, language) for t in t_toks} - {""}
        s_norm_set = {_normalize_token_phonetic(t, language) for t in s_toks} - {""}
        if not (t_norm_set & s_norm_set):
            return build_hard_gate_result(
                target_text=target_text,
                recognized_text=clean_recognized,
                language=language,
                duration_sec=eff_duration,
                target_duration_sec=target_duration_sec,
                acoustics=acoustics,
                reason=(
                    f"Filtered likely ASR non-speech hallucination ('{clean_recognized}') "
                    "with zero target word overlap."
                ),
                status="hallucination_filtered",
            )

    diff_info = compute_deterministic_word_diff(target_text, clean_recognized, language)
    silence_ratio = float(acoustics.get("silenceRatio", 0.2))
    if (
        not simulated_take
        and silence_ratio > 0.85
        and float(diff_info["phoneticMatchEstimate"]) < 12.0
        and int(diff_info.get("matchedCount", 0)) == 0
    ):
        return build_hard_gate_result(
            target_text=target_text,
            recognized_text=clean_recognized,
            language=language,
            duration_sec=eff_duration,
            target_duration_sec=target_duration_sec,
            acoustics=acoustics,
            reason="Filtered low-overlap speech transcript over mostly silent recording.",
            status="hallucination_filtered",
        )

    accuracy_score = float(diff_info["contentAccuracyEstimate"])
    weighted_phonetic_est = float(diff_info["weightedPhoneticMatchEstimate"])

    # Speech rate (UI continuity: WPM or Moras/min) & Pure Articulation Rate (syllables/moras per active sec)
    actual_rate = compute_speech_rate(clean_recognized, language, max(0.8, eff_duration))
    target_rate = compute_speech_rate(target_text, language, max(0.8, target_duration_sec))
    if target_rate <= 0:
        target_rate = 300.0 if language == "ja" else 130.0

    target_units = (
        count_japanese_moras(target_text)
        if language == "ja"
        else count_english_syllables(target_text)
    )
    spoken_units = (
        count_japanese_moras(clean_recognized)
        if language == "ja"
        else count_english_syllables(clean_recognized)
    )
    active_sec = max(0.35, eff_duration * (1.0 - min(0.85, silence_ratio)))
    target_active_sec = max(0.35, target_duration_sec * 0.85)
    ar_learner = round((spoken_units / active_sec) * 60.0, 1)
    ar_target = round((max(1, target_units) / target_active_sec) * 60.0, 1)

    # Fluency score: normalized unplanned pauses, mode-aware silence, pure articulation rate, latency, repairs
    pause_count = int(acoustics.get("pauseCount", 0))
    ref_pauses = int((ref_comparison or {}).get("referencePauseCount", 0) or 0)
    exempt_pauses = _count_internal_punctuation_boundaries(target_text) + ref_pauses
    unplanned_pauses = max(0, pause_count - exempt_pauses)

    mcp_rate = (unplanned_pauses / max(1, target_units)) * 100.0
    pause_penalty = min(40.0, 4.5 * mcp_rate)
    speed_penalty = min(25.0, 32.0 * max(0.0, abs(ar_learner / max(1.0, ar_target) - 1.0) - 0.08))

    free_silence = 0.32 if mode == "simultaneous" else 0.25
    ref_sil = (ref_comparison or {}).get("referenceSilenceRatio")
    if isinstance(ref_sil, (int, float)):
        free_silence = max(free_silence, float(ref_sil) + 0.08)
    silence_penalty = min(20.0, max(0.0, silence_ratio - free_silence) * 50.0)

    grace_sec = min(4.0, 1.5 + 0.05 * target_duration_sec)
    if not simulated_take and eff_duration > target_duration_sec:
        duration_latency_sec = round(max(0.0, eff_duration - (target_duration_sec + grace_sec)), 2)
    else:
        duration_latency_sec = 0.0
    latency_penalty = min(20.0, 25.0 * (duration_latency_sec / max(2.0, target_duration_sec)))

    repair_count = int(diff_info.get("repairCount", 0))
    repair_penalty = min(10.0, (repair_count / max(1, target_units)) * 100.0 * 2.5)

    fluency_raw = (
        98.0
        - pause_penalty
        - silence_penalty
        - speed_penalty
        - latency_penalty
        - repair_penalty
    )
    # If almost no target words were matched, cap fluency so unrelated babble isn't scored high
    if accuracy_score < 20.0:
        fluency_raw = min(fluency_raw, 45.0 + accuracy_score)
    fluency_score = round(max(0.0, min(100.0, fluency_raw)), 1)

    # Pronunciation score: FL/onset-weighted phonetic alignment + Whisper confidence + capped clipping
    mean_conf = (whisper_info or {}).get("meanConfidence")
    clip_ratio = float(acoustics.get("peakClipRatio", 0.0))
    clip_penalty = min(5.0, clip_ratio * 100.0)
    is_clipped = bool(clip_ratio > 0.01 and not simulated_take)
    if isinstance(mean_conf, (int, float)) and not simulated_take:
        pron_raw = (0.70 * weighted_phonetic_est) + (0.30 * (float(mean_conf) * 100.0)) - clip_penalty
    else:
        pron_raw = weighted_phonetic_est - clip_penalty
    pronunciation_score = round(max(0.0, min(100.0, pron_raw)), 1)

    # Prosody score: median-centered Semitone F0 variation, energy dynamics, & Semitone reference match
    f0_std = float(acoustics.get("f0StdHz", 0.0))
    raw_f0_std_st = acoustics.get("f0StdSt")
    if isinstance(raw_f0_std_st, (int, float)):
        f0_std_st = float(raw_f0_std_st)
    elif f0_std > 0.0:
        f0_std_st = round(12.0 * math.log2((150.0 + f0_std) / 150.0), 2)
    else:
        f0_std_st = 0.0

    energy_dyn = float(acoustics.get("energyDynamicRangeDb", 6.0))
    if simulated_take:
        pitch_var_score = 78.0
        energy_score = 78.0
    else:
        if f0_std_st < 0.85:
            pitch_var_score = 35.0
        elif f0_std_st < 1.80:
            pitch_var_score = 35.0 + ((f0_std_st - 0.85) / 0.95) * 40.0
        elif f0_std_st <= 4.20:
            pitch_var_score = 75.0 + ((f0_std_st - 1.80) / 2.40) * 18.0
        else:
            pitch_var_score = max(75.0, 93.0 - (f0_std_st - 4.20) * 3.0)

        energy_score = min(95.0, 45.0 + energy_dyn * 4.0)

    rhythm_score = round(
        max(0.0, min(100.0, 94.0 - speed_penalty - pause_penalty * 0.6)),
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

    # Mode-adaptive overall weights (preserving legacy 35/25/25/15 when mode is None)
    if mode == "listen_repeat":
        overall_score = round(
            0.30 * accuracy_score
            + 0.30 * pronunciation_score
            + 0.20 * fluency_score
            + 0.20 * prosody_score,
            1,
        )
    elif mode == "simultaneous":
        overall_score = round(
            0.25 * accuracy_score
            + 0.20 * pronunciation_score
            + 0.30 * fluency_score
            + 0.25 * prosody_score,
            1,
        )
    else:
        overall_score = round(
            0.35 * accuracy_score
            + 0.25 * fluency_score
            + 0.25 * pronunciation_score
            + 0.15 * prosody_score,
            1,
        )

    return {
        "status": "ok",
        "assessmentStatus": "scored",
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
            "f0StdSt": round(f0_std_st, 2),
            "unplannedPauseCount": unplanned_pauses,
            "repairCount": repair_count,
            "isClipped": is_clipped,
            "durationLatencySec": duration_latency_sec,
            "articulationRateValue": ar_learner,
        },
        "durationSec": round(eff_duration, 3),
        "rmsDb": float(acoustics.get("rmsDb", -20.0)),
        "energyDb": float(acoustics.get("energyDb", -20.0)),
        "pauseCount": pause_count,
        "unplannedPauseCount": unplanned_pauses,
        "repairCount": repair_count,
        "silenceRatio": silence_ratio,
        "voicedFrames": int(acoustics.get("voicedFrames", 0)),
        "f0StdHz": f0_std,
        "f0StdSt": round(f0_std_st, 2),
        "f0MedianHz": float(acoustics.get("f0MedianHz", 0.0)),
        "durationLatencySec": duration_latency_sec,
        "isClipped": is_clipped,
        "pitchContour": acoustics.get("pitchContour", []),
        "referencePitchContour": ref_contour,
        "wordDiff": diff_info["baselineWordDiff"],
        "wordAnalysis": diff_info["wordAnalysis"],
        "priorityTokens": diff_info["priorityTokens"],
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
