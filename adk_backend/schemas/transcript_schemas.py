from typing import Literal

from pydantic import BaseModel, Field

LanguageCode = Literal["en", "ja"]
CaptionSourceType = Literal[
    "curated_verified",
    "youtube_manual",
    "youtube_asr",
    "ai_generated",
    "user_aligned",
]


class WordToken(BaseModel):
    surface: str
    reading: str | None = None
    romaji: str | None = None
    ipa: str | None = None
    lemma: str | None = None
    pos: str | None = None
    isKanji: bool | None = None
    meaningHint: str | None = None


class TranscriptSegment(BaseModel):
    id: str
    index: int
    startTime: float
    endTime: float
    text: str
    translation: str | None = None
    tokens: list[WordToken] | None = None


class VideoMaterial(BaseModel):
    videoId: str
    title: str
    channel: str = ""
    language: LanguageCode
    level: str = "Intermediate"
    durationSec: float = 0.0
    captionSource: CaptionSourceType = "youtube_manual"
    captionNote: str = "Extracted captions"
    description: str | None = None
    source: str | None = None
    updatedAt: str | None = None
    segments: list[TranscriptSegment] = Field(default_factory=list)


class SegmentUpdateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10000)
    tokens: list[WordToken] | None = None


class RetokenizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    language: LanguageCode = "ja"
    videoId: str | None = None
    segmentId: str | None = None


class RetokenizeResponse(BaseModel):
    tokens: list[WordToken]


class FetchTranscriptRequest(BaseModel):
    urlOrId: str = Field(min_length=1, max_length=512)
    preferredLanguage: LanguageCode | None = None
    stream: bool = True
