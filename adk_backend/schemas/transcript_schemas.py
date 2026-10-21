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
    channel: str
    language: LanguageCode
    level: str = "Intermediate"
    durationSec: float
    captionSource: CaptionSourceType = "youtube_manual"
    captionNote: str = "Extracted captions"
    description: str | None = None
    segments: list[TranscriptSegment] = Field(default_factory=list)


class RetokenizeRequest(BaseModel):
    text: str
    language: LanguageCode = "ja"


class RetokenizeResponse(BaseModel):
    tokens: list[WordToken]


class FetchTranscriptRequest(BaseModel):
    urlOrId: str
    preferredLanguage: LanguageCode | None = None
    stream: bool = True
