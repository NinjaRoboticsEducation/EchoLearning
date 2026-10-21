from typing import Any

from google.adk.agents import LlmAgent

from ..schemas.shadowing_schemas import ShadowingAssessmentReport
from ..tools.whisper_tools import (
    compute_deterministic_word_diff,
    transcribe_and_analyze_audio,
)
from . import get_local_model
from .runner import execute_adk_agent_json

SHADOWING_AGENT_INSTRUCTION = """You are an expert English and Japanese speech, phonetics, and shadowing coach.
Your job is to evaluate a learner's spoken shadowing recording against the target script.

To transcribe the audio and inspect acoustic metrics (RMS volume, silence ratio, mid-sentence pauses, and baseline word diff),
you MUST call the tool:
  transcribe_and_analyze_audio(language=...)

Do NOT invent transcript text; use the verbatim transcript and acoustic telemetry returned by the tool.

CRITICAL EVALUATION RULES:
1. If the audio is silent (isSilent=True or empty transcript), set overallScore and all dimensions to 0.
2. Evaluate 4 distinct dimensions (0-100):
   - contentAccuracy: Objective lexical match to the target script.
   - pronunciation: Phoneme/mora clarity, vowel reduction, consonant articulation.
   - fluency: Speech rate consistency, lack of unnatural mid-phrase hesitation pauses.
   - prosody: Natural sentence stress, intonation contours, and rhythm.
3. In wordDiff:
   - status can be: "correct", "omitted", "substituted", "inserted", or "stt_uncertain".
   - Use "stt_uncertain" whenever a slight difference is likely speech-to-text noise or accent rather than a true mistake.
4. Provide 2 to 4 actionable pronunciationFeedback items pinpointing specific words or sounds.
5. Provide overallScore weighted as: 35% Content + 30% Pronunciation + 20% Fluency + 15% Prosody.

Respond ONLY with a single JSON object matching the required keys:
- recognizedTranscript: Spoken text heard
- overallScore: Number (0-100)
- dimensions: { contentAccuracy, pronunciation, fluency, prosody }
- speechRateValue: Number (WPM for English, Moras/min for Japanese)
- targetRateValue: Number (native baseline rate)
- scoreExplanation: Clear explanation of score
- wordDiff: Array of { word, expectedWord?, reading?, status, explanation? }
- pronunciationFeedback: Array of { targetWord, readingOrIpa, category, observedIssue, actionableTip, severity }
- improvementSuggestions: Array of strings
- recommendedRetryText: Optional phrase to retry
"""


def create_shadowing_agent() -> LlmAgent:
    """Creates the ADK 2.x ShadowingAgent with local LLM and whisper tools."""
    return LlmAgent(
        name="shadowing_agent",
        model=get_local_model(temperature=0.2),
        instruction=SHADOWING_AGENT_INSTRUCTION,
        tools=[transcribe_and_analyze_audio],
    )


def create_deterministic_shadowing_report(
    target_text: str,
    spoken_text: str,
    language: str,
    mode: str,
    duration_sec: float,
    target_duration_sec: float,
    acoustics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generates an accurate, deterministic assessment report based on SequenceMatcher diff & acoustics."""
    acoustics = acoustics or {
        "isSilent": False,
        "rmsDb": -20.0,
        "pauseCount": 0,
        "silenceRatio": 0.2,
    }
    diff_info = compute_deterministic_word_diff(target_text, spoken_text, language)

    accuracy = float(diff_info.get("contentAccuracyEstimate", 85.0))
    if acoustics.get("isSilent", False) and not spoken_text.strip():
        return {
            "targetText": target_text,
            "recognizedTranscript": "",
            "overallScore": 0.0,
            "dimensions": {
                "contentAccuracy": 0.0,
                "pronunciation": 0.0,
                "fluency": 0.0,
                "prosody": 0.0,
            },
            "speechRateValue": 0.0,
            "targetRateValue": 130.0 if language == "en" else 320.0,
            "scoreExplanation": "No clear speech detected in recording. Please check your microphone.",
            "wordDiff": diff_info.get("baselineWordDiff", []),
            "pronunciationFeedback": [],
            "improvementSuggestions": ["Ensure your microphone is close and speak aloud clearly."],
            "recommendedRetryText": target_text,
        }

    # Compute fluency & pacing penalty based on pause count and duration ratio
    dur_ratio = duration_sec / max(1.0, target_duration_sec)
    fluency = max(
        30.0, min(95.0, 90.0 - (acoustics.get("pauseCount", 0) * 8.0) - abs(dur_ratio - 1.0) * 20.0)
    )
    pronunciation = max(35.0, min(95.0, accuracy * 0.95))
    prosody = max(35.0, min(95.0, 85.0 - abs(dur_ratio - 1.0) * 15.0))

    overall = round(
        0.35 * accuracy + 0.30 * pronunciation + 0.20 * fluency + 0.15 * prosody,
        1,
    )

    # Word/Mora rate calculation
    words_or_moras = len(spoken_text.split()) if language == "en" else len(spoken_text)
    rate_val = round((words_or_moras / max(1.0, duration_sec)) * 60.0, 1)
    target_rate_val = round(
        (
            max(1, len(target_text.split()) if language == "en" else len(target_text))
            / max(1.0, target_duration_sec)
        )
        * 60.0,
        1,
    )

    feedback: list[dict[str, Any]] = []
    for d in diff_info.get("baselineWordDiff", []):
        if d.get("status") in ("substituted", "omitted"):
            feedback.append(
                {
                    "targetWord": d.get("expectedWord") or d.get("word", ""),
                    "readingOrIpa": d.get("reading") or "",
                    "category": "Articulation & Pacing",
                    "observedIssue": f"Discrepancy observed on '{d.get('word', '')}'.",
                    "actionableTip": f"Practice saying '{d.get('expectedWord') or d.get('word')}' in isolation before shadowing.",
                    "severity": "medium",
                }
            )
        if len(feedback) >= 3:
            break

    return {
        "targetText": target_text,
        "recognizedTranscript": spoken_text,
        "overallScore": overall,
        "dimensions": {
            "contentAccuracy": round(accuracy, 1),
            "pronunciation": round(pronunciation, 1),
            "fluency": round(fluency, 1),
            "prosody": round(prosody, 1),
        },
        "speechRateValue": rate_val,
        "targetRateValue": target_rate_val,
        "scoreExplanation": (
            f"Solid performance ({overall}% overall) with {round(accuracy, 1)}% lexical match. "
            f"Speech rate was {rate_val} vs native target {target_rate_val}."
        ),
        "wordDiff": diff_info.get("baselineWordDiff", []),
        "pronunciationFeedback": feedback,
        "improvementSuggestions": [
            "Maintain smooth breath support between phrases.",
            "Shadow with headphones to match the speaker's natural rhythm.",
        ],
        "recommendedRetryText": target_text,
    }


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
    """Evaluates shadowing attempt using ShadowingAgent with ToolContext state injection."""
    initial_state = {
        "audio_base64": audio_base64,
        "mime_type": mime_type or "audio/webm",
        "target_text": target_text,
        "web_speech_transcript": web_speech_transcript or "",
    }

    agent = create_shadowing_agent()
    prompt = (
        f"Target Script: '{target_text}'\n"
        f"Language: '{language}'\n"
        f"Shadowing Mode: '{mode}'\n"
        f"Target Native Duration: {target_duration_sec:.1f}s\n"
        f"Learner Recording Duration: {duration_sec:.1f}s\n"
        "Call transcribe_and_analyze_audio(language=...) to inspect the learner's audio and evaluate."
    )

    try:
        report = await execute_adk_agent_json(
            agent=agent,
            prompt=prompt,
            initial_state=initial_state,
            schema_model=ShadowingAssessmentReport,
        )
        report["targetText"] = target_text
        return report
    except Exception as exc:
        print(f"ShadowingAgent fallback triggered: {exc}")
        spoken = web_speech_transcript or ""
        return create_deterministic_shadowing_report(
            target_text=target_text,
            spoken_text=spoken,
            language=language,
            mode=mode,
            duration_sec=duration_sec,
            target_duration_sec=target_duration_sec,
        )
