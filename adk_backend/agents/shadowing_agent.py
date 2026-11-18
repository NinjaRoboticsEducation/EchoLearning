import asyncio
import json
import logging
from typing import Any

from google.adk.agents import LlmAgent
from pydantic import BaseModel, Field

from ..schemas.shadowing_schemas import PhonemeFeedbackItem
from ..tools.whisper_tools import (
    evaluate_acoustics_and_alignment,
    transcribe_and_analyze_audio,
)
from . import get_local_model
from .runner import execute_adk_agent_json

logger = logging.getLogger(__name__)


class CoachingFeedbackOutput(BaseModel):
    """Schema for LLM qualitative coaching only; numeric scores are never accepted from LLM."""

    scoreExplanation: str = ""
    feedback: str = ""
    pronunciationFeedback: list[PhonemeFeedbackItem] = Field(default_factory=list)
    intonationTips: list[str] = Field(default_factory=list)
    improvementSuggestions: list[str] = Field(default_factory=list)
    actionableImprovements: list[str] = Field(default_factory=list)
    recommendedRetryText: str | None = None


ShadowingCoachingNotes = CoachingFeedbackOutput


SHADOWING_AGENT_INSTRUCTION = """You are an expert English and Japanese speech, phonetics, and shadowing coach.
You will receive deterministic acoustic measurements, speech rate, F0 pitch variation (in Hz and Semitones),
and Top 2-3 priority word-level alignment targets that have ALREADY been computed from the learner's recording.

Your ONLY job is to generate concise, encouraging, actionable qualitative coaching grounded in those exact facts:
- scoreExplanation: 1-2 sentences explaining the measured performance honestly.
- feedback: Concise coaching summary (can match scoreExplanation).
- pronunciationFeedback: 1-3 items pointing ONLY to the Top 2-3 priority omitted/substituted targets:
  { targetWord, readingOrIpa, category, observedIssue, actionableTip, severity: "high"|"medium"|"low" }
  For actionableTip, guide the learner with the 1-1-1 Phrase-Build drill (say the isolated word 1x, then a 2-3 word local phrase chunk 1x, then the full sentence 1x).
- intonationTips: 1-3 specific pitch/rhythm/intonation tips referencing their measured Semitone F0 variation or unplanned pauses.
- improvementSuggestions: 2-3 short actionable practice steps (including 1-1-1 Phrase-Build when helpful).
- actionableImprovements: Same 2-3 short actionable practice steps.
- recommendedRetryText: Specific short phrase to practice next (from target script).

Guardrails:
- Do NOT invent phonetic faults for matched ("correct") words or blame self-repair false starts.
- For any "stt_uncertain" items, hedge with uncertainty (e.g., "The speech recognizer may have misheard...") instead of asserting an articulation error.
- Do NOT invent transcript text or change numeric scores.
Respond ONLY with a single JSON object matching the keys above.
"""


def create_shadowing_agent() -> LlmAgent:
    """Creates the ADK 2.x ShadowingAgent with local LLM for qualitative coaching."""
    return LlmAgent(
        name="shadowing_agent",
        model=get_local_model(temperature=0.2),
        instruction=SHADOWING_AGENT_INSTRUCTION,
        tools=[transcribe_and_analyze_audio],
    )


COACHING_AGENT_INSTRUCTION = """/no_think
You are an expert English and Japanese shadowing coach.
You receive pre-computed deterministic scores, acoustic measurements (including Semitone F0 std and unplanned pauses), and the Top 2-3 priority mismatched words (plus optional stt_uncertain candidates).
Do NOT call any tools. Do NOT output <think> blocks, explanations, or markdown fences.
Guardrails:
- Focus ONLY on the Top 2-3 mismatchedWords; never invent phonetic faults for matched words or self-repairs.
- Hedge any stt_uncertain item with uncertainty (e.g. "The speech recognizer may have misheard...").
- Suggest the 1-1-1 Phrase-Build drill (1x isolated word -> 1x local phrase chunk -> 1x full sentence) in tips.
Respond ONLY with a single raw JSON object containing:
- "scoreExplanation": 1-2 short sentences explaining the measured performance.
- "pronunciationFeedback": 1-3 items {"targetWord", "readingOrIpa", "category", "observedIssue", "actionableTip", "severity": "high"|"medium"|"low"}.
- "intonationTips": 1-2 short tips referencing measured Semitone F0 variation or unplanned pauses.
- "improvementSuggestions": 2-3 short actionable practice steps using 1-1-1 Phrase-Build.
"""


def create_coaching_agent() -> LlmAgent:
    """Creates a lightweight, tool-free ADK 2.x LlmAgent for fast qualitative coaching."""
    return LlmAgent(
        name="shadowing_coaching_agent",
        model=get_local_model(temperature=0.2),
        instruction=COACHING_AGENT_INSTRUCTION,
        tools=[],
    )


def _build_phrase_chunk(target_text: str, target_word: str, language: str, token_index: int | None = None) -> str:
    """Extracts a compact 2-3 word local phrase chunk around target_word for 1-1-1 Phrase-Build."""
    if not target_text:
        return target_word
    if language == "ja":
        idx = target_text.find(target_word)
        if idx >= 0:
            start = max(0, idx - 3)
            end = min(len(target_text), idx + len(target_word) + 3)
            return target_text[start:end].strip()
        return target_word
    words = target_text.split()
    if not words:
        return target_word
    pos = token_index if (token_index is not None and 0 <= token_index < len(words)) else None
    if pos is None:
        lower_w = target_word.lower()
        for i, w in enumerate(words):
            if lower_w in w.lower():
                pos = i
                break
    if pos is None:
        return target_word
    lo = max(0, pos - 1)
    hi = min(len(words), pos + 2)
    return " ".join(words[lo:hi])


def _select_priority_errors(det_report: dict[str, Any], limit: int = 3) -> list[dict[str, Any]]:
    """Selects Top 2-3 priority omitted/substituted errors, excluding stt_uncertain and self_repair."""
    priority_tokens = det_report.get("priorityTokens") or []
    ranked = [
        t for t in priority_tokens
        if t.get("status") in ("omitted", "substituted")
    ]
    if ranked:
        return ranked[:limit]
    return [
        w for w in (det_report.get("wordDiff") or [])
        if w.get("status") in ("omitted", "substituted")
    ][:limit]


def _build_deterministic_coaching(det_report: dict[str, Any], language: str) -> dict[str, Any]:
    """Builds deterministic qualitative coaching when LLM is unavailable or partial."""
    overall = det_report["overallScore"]
    accuracy = det_report["accuracyScore"]
    fluency = det_report["fluencyScore"]
    prosody = det_report["prosodyScore"]
    f0_std = float(det_report.get("f0StdHz", 0.0))
    f0_std_st = float(det_report.get("f0StdSt", 0.0))
    pause_count = int(det_report.get("pauseCount", 0))
    unplanned_pauses = int(det_report.get("unplannedPauseCount", pause_count))
    is_clipped = bool(det_report.get("isClipped", False))
    rate_val = det_report["speechRateValue"]
    target_rate = det_report["targetRateValue"]
    target_text = str(det_report.get("targetText") or "")
    unit = "Moras/min" if language == "ja" else "WPM"

    priority_errors = _select_priority_errors(det_report, limit=3)
    feedback_items: list[dict[str, Any]] = []
    for item in priority_errors:
        target_w = item.get("expectedWord") or item.get("word", "")
        chunk = _build_phrase_chunk(target_text, target_w, language, item.get("index"))
        severity = "high" if item.get("isContentWord", True) and item.get("flCategory") else "medium"
        feedback_items.append(
            {
                "targetWord": target_w,
                "readingOrIpa": item.get("reading") or "",
                "category": "Articulation & Lexical Accuracy",
                "observedIssue": item.get("explanation") or f"Discrepancy on '{target_w}'.",
                "actionableTip": (
                    f"1-1-1 Phrase-Build drill: say '{target_w}' 1x clearly, "
                    f"then the chunk '{chunk}' 1x, then the full sentence 1x."
                ),
                "severity": severity,
            }
        )

    uncertain_items = [
        w for w in (det_report.get("wordDiff") or [])
        if w.get("status") == "stt_uncertain"
    ]

    intonation_tips: list[str] = []
    if f0_std_st > 0.0 and f0_std_st < 0.85:
        intonation_tips.append(
            f"Pitch range was narrow ({f0_std_st:.2f} ST / {f0_std:.1f} Hz); exaggerate stressed syllables and phrase-final pitch drops."
        )
    elif f0_std_st == 0.0 and f0_std > 0.0 and f0_std < 8.0:
        intonation_tips.append(
            f"Pitch variation was narrow (F0 std {f0_std:.1f} Hz); exaggerate stressed syllables and pitch drops."
        )
    else:
        intonation_tips.append(
            "Match the speaker's phrase-final rise/fall contour and stressed vowel peaks."
        )

    if unplanned_pauses >= 2:
        intonation_tips.append(
            f"Detected {unplanned_pauses} unplanned mid-clause pauses (>=250ms); aim to link words smoothly across each clause."
        )
    if is_clipped:
        intonation_tips.append(
            "Microphone clipping was detected; lower input gain or step back 15-25 cm for cleaner clarity."
        )

    improvements: list[str] = []
    if feedback_items:
        focus_words = ", ".join(f"'{it['targetWord']}'" for it in feedback_items[:2])
        improvements.append(
            f"Use the 1-1-1 Phrase-Build drill on {focus_words}: 1x isolated word, 1x local phrase chunk, 1x full sentence."
        )
    elif accuracy < 80.0:
        improvements.append("Review omitted or substituted words using 1-1-1 Phrase-Build before your next take.")
    if uncertain_items and not feedback_items:
        unc_w = uncertain_items[0].get("expectedWord") or uncertain_items[0].get("word", "")
        improvements.append(
            f"The speech recognizer may have misheard '{unc_w}'; try articulating that chunk slightly more crisply."
        )
    if fluency < 75.0:
        improvements.append("Reduce unplanned mid-clause hesitations by shadowing one short clause at a time.")
    if prosody < 75.0:
        improvements.append("Listen with headphones and mirror the speaker's pitch contour and rhythm.")
    if not improvements:
        improvements.append("Maintain this clear articulation while increasing shadowing speed slightly.")

    explanation = (
        f"Measured {overall:.1f}% overall: {accuracy:.1f}% accuracy, {fluency:.1f}% fluency, "
        f"{det_report['pronunciationScore']:.1f}% pronunciation, {prosody:.1f}% prosody. "
        f"Speech rate was {rate_val:.1f} {unit} (target {target_rate:.1f} {unit})."
    )

    return {
        "scoreExplanation": explanation,
        "feedback": explanation,
        "pronunciationFeedback": feedback_items,
        "intonationTips": intonation_tips,
        "improvementSuggestions": improvements,
        "actionableImprovements": improvements,
        "recommendedRetryText": target_text,
    }


def create_deterministic_shadowing_report(
    target_text: str,
    spoken_text: str,
    language: str,
    mode: str,
    duration_sec: float,
    target_duration_sec: float,
    acoustics: dict[str, Any] | None = None,
    whisper_info: dict[str, Any] | None = None,
    ref_comparison: dict[str, Any] | None = None,
    simulated_take: bool = False,
) -> dict[str, Any]:
    """Generates a deterministic, hard-gated assessment report with acoustic & alignment evidence."""
    eff_acoustics = acoustics or {
        "isSilent": not bool((spoken_text or "").strip()),
        "isValidWav": True,
        "durationSec": duration_sec,
        "rmsDb": -18.0 if (spoken_text or "").strip() else -90.0,
        "energyDb": -18.0 if (spoken_text or "").strip() else -90.0,
        "energyDynamicRangeDb": 8.0,
        "pauseCount": 0,
        "silenceRatio": 0.15 if (spoken_text or "").strip() else 1.0,
        "voicedFrames": 25 if (spoken_text or "").strip() else 0,
        "f0StdHz": 18.0 if (spoken_text or "").strip() else 0.0,
        "f0StdSt": 2.4 if (spoken_text or "").strip() else 0.0,
        "pitchContour": [],
    }

    det = evaluate_acoustics_and_alignment(
        target_text=target_text,
        recognized_text=spoken_text,
        language=language,
        duration_sec=duration_sec,
        target_duration_sec=target_duration_sec,
        acoustics=eff_acoustics,
        whisper_info=whisper_info,
        ref_comparison=ref_comparison,
        simulated_take=simulated_take,
        mode=mode,
    )
    det["mode"] = mode
    det["language"] = language

    if not det.get("hardGateTriggered"):
        coaching = _build_deterministic_coaching(det, language)
        det.update(coaching)

    return det


async def generate_coaching_and_merge(
    det_report: dict[str, Any],
    language: str,
    mode: str,
) -> dict[str, Any]:
    """Runs ShadowingAgent for qualitative coaching ONLY, then strictly overrides all numeric scores.

    If hardGateTriggered is True, LLM is bypassed completely (R01/R02/R03).
    """
    if det_report.get("hardGateTriggered"):
        return det_report

    # Safe JSON-escaped inputs in prompt (C10); pass ONLY Top 2-3 priority errors to Qwen3.5
    mismatched_words = _select_priority_errors(det_report, limit=3)
    uncertain_words = [
        t for t in (det_report.get("priorityTokens") or [])
        if t.get("status") == "stt_uncertain"
    ][:2]
    prompt_payload = {
        "language": language,
        "mode": mode,
        "targetText": str(det_report.get("targetText") or "")[:240],
        "recognizedText": str(det_report.get("recognizedText") or "")[:240],
        "deterministicScores": {
            "overallScore": det_report["overallScore"],
            "accuracyScore": det_report["accuracyScore"],
            "fluencyScore": det_report["fluencyScore"],
            "pronunciationScore": det_report["pronunciationScore"],
            "prosodyScore": det_report["prosodyScore"],
        },
        "acoustics": {
            "durationSec": det_report.get("durationSec"),
            "rmsDb": det_report.get("rmsDb"),
            "pauseCount": det_report.get("pauseCount"),
            "unplannedPauseCount": det_report.get("unplannedPauseCount"),
            "silenceRatio": det_report.get("silenceRatio"),
            "f0StdHz": det_report.get("f0StdHz"),
            "f0StdSt": det_report.get("f0StdSt"),
            "isClipped": det_report.get("isClipped"),
            "durationLatencySec": det_report.get("durationLatencySec"),
            "speechRateValue": det_report.get("speechRateValue"),
            "targetRateValue": det_report.get("targetRateValue"),
        },
        "mismatchedWords": mismatched_words,
        "uncertainWords": uncertain_words,
    }

    prompt = (
        "Evaluate the following verified shadowing telemetry and return ONLY qualitative coaching JSON.\n"
        f"<shadowing_evidence>\n{json.dumps(prompt_payload, ensure_ascii=False)}\n</shadowing_evidence>"
    )

    try:
        agent = create_coaching_agent()
        coaching = await asyncio.wait_for(
            execute_adk_agent_json(
                agent=agent,
                prompt=prompt,
                initial_state={},
                schema_model=ShadowingCoachingNotes,
            ),
            timeout=6.0,
        )
        # Preserve all deterministic numeric scores, diffs, and telemetry; merge only qualitative text
        merged = dict(det_report)
        if coaching.get("scoreExplanation"):
            merged["scoreExplanation"] = coaching["scoreExplanation"]
        if coaching.get("feedback"):
            merged["feedback"] = coaching["feedback"]
        elif coaching.get("scoreExplanation"):
            merged["feedback"] = coaching["scoreExplanation"]
        if coaching.get("pronunciationFeedback"):
            merged["pronunciationFeedback"] = coaching["pronunciationFeedback"]
        if coaching.get("intonationTips"):
            merged["intonationTips"] = coaching["intonationTips"]
        if coaching.get("improvementSuggestions"):
            merged["improvementSuggestions"] = coaching["improvementSuggestions"]
        if coaching.get("actionableImprovements"):
            merged["actionableImprovements"] = coaching["actionableImprovements"]
        elif coaching.get("improvementSuggestions"):
            merged["actionableImprovements"] = coaching["improvementSuggestions"]
        if coaching.get("recommendedRetryText"):
            merged["recommendedRetryText"] = coaching["recommendedRetryText"]
        merged["coachingSource"] = "adk_agent"
        return merged
    except Exception as exc:
        logger.info("ShadowingAgent qualitative coaching fallback triggered: %s", exc)
        merged = dict(det_report)
        merged["coachingSource"] = "deterministic_fallback"
        merged["status"] = "partial_coaching"
        return merged


async def evaluate_shadowing_with_agent(
    target_text: str,
    language: str,
    mode: str,
    duration_sec: float,
    target_duration_sec: float,
    audio_base64: str | None = None,
    mime_type: str | None = None,
    web_speech_transcript: str | None = None,
) -> dict[str, Any]:
    """Evaluates shadowing attempt: deterministic acoustics + alignment FIRST, then ADK coaching."""
    import base64
    import uuid

    from ..config import TEMP_AUDIO_DIR
    from ..tools.whisper_tools import (
        analyze_wav_acoustics,
        convert_to_16khz_mono_wav,
        inspect_wav_header,
        transcribe_audio_with_whisper,
    )

    # Simulated demo take (no audio bytes)
    if not audio_base64:
        spoken = (web_speech_transcript or "").strip()
        det = create_deterministic_shadowing_report(
            target_text=target_text,
            spoken_text=spoken,
            language=language,
            mode=mode,
            duration_sec=duration_sec,
            target_duration_sec=target_duration_sec,
            simulated_take=True,
        )
        return await generate_coaching_and_merge(det, language=language, mode=mode)

    file_id = uuid.uuid4().hex[:10]
    ext = ".wav" if mime_type and "wav" in mime_type else (".mp4" if mime_type and "mp4" in mime_type else ".webm")
    raw_path = TEMP_AUDIO_DIR / f"eval_{file_id}{ext}"
    wav_path = TEMP_AUDIO_DIR / f"eval_{file_id}_16k.wav"

    try:
        raw_path.write_bytes(base64.b64decode(audio_base64))
        hdr = inspect_wav_header(raw_path) if ext == ".wav" else {"isValidWav": False}
        if (
            hdr.get("isValidWav")
            and hdr.get("nchannels") == 1
            and hdr.get("sampwidth") == 2
            and hdr.get("framerate") == 16000
        ):
            acoustics = analyze_wav_acoustics(raw_path)
        elif ext == ".wav" and hdr.get("isValidWav") and (hdr.get("nchannels") != 1 or hdr.get("sampwidth") != 2):
            # Enforce R11: reject non-mono / non-16bit WAV directly via analyze_wav_acoustics
            acoustics = analyze_wav_acoustics(raw_path)
        else:
            try:
                convert_to_16khz_mono_wav(raw_path, wav_path)
                acoustics = analyze_wav_acoustics(wav_path)
            except Exception as conv_exc:
                acoustics = {
                    "isSilent": True,
                    "isValidWav": False,
                    "error": f"Audio decode/conversion error: {conv_exc}",
                    "durationSec": 0.0,
                    "rmsDb": -90.0,
                    "energyDb": -90.0,
                    "pauseCount": 0,
                    "silenceRatio": 1.0,
                    "voicedFrames": 0,
                    "pitchContour": [],
                    "f0StdHz": 0.0,
                }
        eval_wav = wav_path if wav_path.exists() else raw_path
        whisper_info: dict[str, Any] = {"text": "", "words": [], "meanConfidence": None}
        spoken = (web_speech_transcript or "").strip()

        if acoustics.get("isValidWav", False) and not acoustics.get("isSilent", True):
            whisper_info = await transcribe_audio_with_whisper(eval_wav, language=language)
            if (whisper_info.get("text") or "").strip():
                spoken = whisper_info["text"].strip()

        det = create_deterministic_shadowing_report(
            target_text=target_text,
            spoken_text=spoken,
            language=language,
            mode=mode,
            duration_sec=float(acoustics.get("durationSec") or duration_sec),
            target_duration_sec=target_duration_sec,
            acoustics=acoustics,
            whisper_info=whisper_info,
            simulated_take=False,
        )
        return await generate_coaching_and_merge(det, language=language, mode=mode)
    finally:
        raw_path.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)
