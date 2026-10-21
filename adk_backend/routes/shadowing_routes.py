from fastapi import APIRouter, HTTPException

from ..agents.shadowing_agent import evaluate_shadowing_with_agent
from ..schemas.shadowing_schemas import ShadowingEvaluateRequest

router = APIRouter()


@router.post("/shadowing/evaluate")
async def evaluate_shadowing(req: ShadowingEvaluateRequest):
    """Evaluates shadowing attempt using Google ADK 2.x ShadowingAgent.

    Receives audioBase64 (or handles simulated take when audioBase64 is None),
    computes objective word-by-word diff, acoustic pauses/volume, and scores
    across 4 dimensions: Content Accuracy, Pronunciation, Fluency, and Prosody.
    """
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

        word_diff = report.get("wordDiff", [])
        omitted = sum(1 for t in word_diff if t.get("status") == "omitted")
        substituted = sum(1 for t in word_diff if t.get("status") == "substituted")
        uncertain = sum(1 for t in word_diff if t.get("status") == "stt_uncertain")

        report["metrics"] = {
            "speechRateValue": report.get("speechRateValue", 120.0),
            "speechRateUnit": "Moras/min" if req.language == "ja" else "WPM",
            "targetRateValue": report.get("targetRateValue", 135.0),
            "durationSec": req.durationSec,
            "targetDurationSec": req.targetDurationSec,
            "omittedCount": omitted,
            "substitutedCount": substituted,
            "uncertainSttCount": uncertain,
        }

        return report
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to evaluate shadowing session: {exc!s}",
        )
