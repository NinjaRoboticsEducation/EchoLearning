from typing import Any, Literal

from pydantic import BaseModel, Field

LanguageCode = Literal["en", "ja"]
ShadowingMode = Literal["listen_repeat", "simultaneous"]
DiffTokenStatus = Literal[
    "correct",
    "omitted",
    "substituted",
    "inserted",
    "stt_uncertain",
    "missing",
]
SeverityLevel = Literal["high", "medium", "low"]


class DiffToken(BaseModel):
    word: str
    expectedWord: str | None = None
    reading: str | None = None
    status: DiffTokenStatus
    explanation: str | None = None


class PhonemeFeedbackItem(BaseModel):
    targetWord: str
    readingOrIpa: str
    category: str
    observedIssue: str
    actionableTip: str
    severity: SeverityLevel = "medium"


class AssessmentDimensions(BaseModel):
    contentAccuracy: float = 0.0
    pronunciation: float = 0.0
    fluency: float = 0.0
    prosody: float = 0.0


class AssessmentMetrics(BaseModel):
    speechRateValue: float = 120.0
    speechRateUnit: Literal["WPM", "Moras/min"] = "WPM"
    targetRateValue: float = 135.0
    durationSec: float = 6.0
    targetDurationSec: float = 6.0
    omittedCount: int = 0
    substitutedCount: int = 0
    uncertainSttCount: int = 0


class ShadowingAssessmentReport(BaseModel):
    id: str | None = None
    videoId: str | None = None
    videoTitle: str | None = None
    language: LanguageCode = "en"
    segmentIds: list[str] | None = None
    mode: ShadowingMode = "listen_repeat"
    createdAt: str | None = None
    targetText: str
    recognizedTranscript: str = ""
    recognizedText: str | None = None
    webSpeechTranscript: str | None = None
    overallScore: float = 0.0
    accuracyScore: float | None = None
    fluencyScore: float | None = None
    rhythmScore: float | None = None
    intonationScore: float | None = None
    pronunciationScore: float | None = None
    prosodyScore: float | None = None
    pitchContour: list[float] | None = None
    referencePitchContour: list[float] | None = None
    energyDb: float | None = None
    speechRateWpm: float | None = None
    recordingId: str | None = None
    dimensions: AssessmentDimensions = Field(default_factory=AssessmentDimensions)
    metrics: AssessmentMetrics | None = None
    speechRateValue: float = 120.0
    targetRateValue: float = 135.0
    scoreExplanation: str = ""
    feedback: str | None = None
    intonationTips: list[str] | None = None
    actionableImprovements: list[str] | None = None
    wordDiff: list[DiffToken] = Field(default_factory=list)
    wordAnalysis: list[dict[str, Any]] | None = None
    pronunciationFeedback: list[PhonemeFeedbackItem] = Field(default_factory=list)
    improvementSuggestions: list[str] = Field(default_factory=list)
    recommendedRetryText: str | None = None
    audioDataUrl: str | None = None
    isDemo: bool = False
    status: str | None = None


ShadowingScoreResponse = ShadowingAssessmentReport


class ShadowingEvaluateRequest(BaseModel):
    audioBase64: str | None = Field(default=None, max_length=70_000_000)
    mimeType: str | None = None
    targetText: str = Field(min_length=1, max_length=20000)
    language: LanguageCode = "en"
    mode: ShadowingMode = "listen_repeat"
    webSpeechTranscript: str | None = None
    durationSec: float = Field(default=6.0, gt=0, le=600)
    targetDurationSec: float = Field(default=6.0, gt=0, le=3600)
