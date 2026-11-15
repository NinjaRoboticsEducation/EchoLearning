import json
import logging
from typing import Any

from google.adk.agents import LlmAgent
from pydantic import BaseModel, Field

from ..schemas.shadowing_schemas import PhonemeFeedbackItem, ShadowingAssessmentReport
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


SHADOWING_AGENT_INSTRUCTION = """You are an expert English and Japanese speech, phonetics, and shadowing coach.
You will receive deterministic acoustic measurements, speech rate, F0 pitch variation, and word-level alignment
that have ALREADY been computed from the learner's recording.

Your ONLY job is to generate concise, encouraging, actionable qualitative coaching grounded in those exact facts:
- scoreExplanation: 1-2 sentences explaining the measured performance honestly.
- feedback: Concise coaching summary (can match scoreExplanation).
- pronunciationFeedback: 1-4 items pointing to specific omitted/substituted words or articulation/mora issues:
  { targetWord, readingOrIpa, category, observedIssue, actionableTip, severity: "high"|"medium"|"low" }
- intonationTips: 1-3 specific pitch/rhythm/intonation tips referencing their measured F0 variation or pauses.
- improvementSuggestions: 2-3 short actionable practice steps.
- actionableImprovements: Same 2-3 short actionable practice steps.
- recommendedRetryText: Specific short phrase to practice next (from target script).

Do NOT invent transcript text or change numeric scores.
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


def _build_deterministic_coaching(det_report: dict[str, Any], language: str) -> dict[str, Any]:
    """Builds deterministic qualitative coaching when LLM is unavailable or partial."""
    overall = det_report["overallScore"]
    accuracy = det_report["accuracyScore"]
    fluency = det_report["fluencyScore"]
    prosody = det_report["prosodyScore"]
    f0_std = float(det_report.get("f0StdHz", 0.0))
    pause_count = int(det_report.get("pauseCount", 0))
    rate_val = det_report["speechRateValue"]
    target_rate = det_report["targetRateValue"]
    unit = "Moras/min" if language == "ja" else "WPM"

    feedback_items: list[dict[str, Any]] = []
    for item in det_report.get("wordDiff", []):
        if item.get("status") in ("substituted", "omitted"):
            target_w = item.get("expectedWord") or item.get("word", "")
            feedback_items.append(
                {
                    "targetWord": target_w,
                    "readingOrIpa": item.get("reading") or "",
                    "category": "Articulation & Lexical Accuracy",
                    "observedIssue": item.get("explanation") or f"Discrepancy on '{target_w}'.",
                    "actionableTip": f"Practice '{target_w}' slowly in isolation, then blend it back into the phrase.",
                    "severity": "medium",
                }
            )
        if len(feedback_items) >= 3:
            break

    intonation_tips: list[str] = []
    if f0_std > 0 and f0_std < 8.0:
        intonation_tips.append(
            f"Pitch variation was narrow (F0 std {f0_std:.1f} Hz); exaggerate stressed syllables and pitch drops."
        )
    else:
        intonation_tips.append(
            "Match the speaker's phrase-final rise/fall contour and stressed vowel peaks."
        )

    if pause_count >= 2:
        intonation_tips.append(
            f"Detected {pause_count} mid-phrase pauses (>=350ms); aim to link words across each clause."
        )

    improvements: list[str] = []
    if accuracy < 80.0:
        improvements.append("Review omitted or substituted words in the target line before your next take.")
    if fluency < 75.0:
        improvements.append("Reduce mid-sentence hesitations by shadowing one short clause at a time.")
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
        "recommendedRetryText": det_report.get("targetText", ""),
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

    # Safe JSON-escaped inputs in prompt (C10)
    prompt_payload = {
        "language": language,
        "mode": mode,
        "targetText": det_report.get("targetText", ""),
        "recognizedText": det_report.get("recognizedText", ""),
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
            "silenceRatio": det_report.get("silenceRatio"),
            "f0StdHz": det_report.get("f0StdHz"),
            "speechRateValue": det_report.get("speechRateValue"),
            "targetRateValue": det_report.get("targetRateValue"),
        },
        "wordDiff": det_report.get("wordDiff", [])[:40],
    }

    prompt = (
        "Evaluate the following verified shadowing telemetry and return ONLY qualitative coaching JSON.\n"
        f"<shadowing_evidence>\n{json.dumps(prompt_payload, ensure_ascii=False)}\n</shadowing_evidence>"
    )

    try:
        agent = create_shadowing_agent()
        coaching = await execute_adk_agent_json(
            agent=agent,
            prompt=prompt,
            initial_state={},
            schema_model=CoachingFeedbackOutput,
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
    from ..config import TEMP_AUDIO_DIR
    from ..tools.whisper_tools import (
        analyze_wav_acoustics,
        convert_to_16khz_mono_wav,
        inspect_wav_header,
        transcribe_audio_with_whisper,
    )
    import base64
    import uuid

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
