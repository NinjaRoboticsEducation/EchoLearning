from typing import Literal

from pydantic import BaseModel, Field

LanguageCode = Literal["en", "ja"]


class DictionaryRequest(BaseModel):
    word: str = Field(min_length=1, max_length=256)
    sentence: str = Field(default="", max_length=2000)
    language: LanguageCode = "en"


class ConversationExample(BaseModel):
    sentence: str
    translation: str


class DictionaryLookupResult(BaseModel):
    word: str
    lemma: str
    language: LanguageCode
    reading: str
    romaji: str | None = None
    ipa: str | None = None
    pitchAccent: str | None = None
    partOfSpeech: str
    contextualMeaning: str
    dictionaryDefinitions: list[str] = Field(default_factory=list)
    usageExample: str = ""
    usageExampleTranslation: str = ""
    pronunciationTip: str = ""
    conversationExamples: list[ConversationExample] = Field(default_factory=list)
    isDegraded: bool = False
    source: str | None = None
    modelProfileId: str | None = None


DictionaryEntry = DictionaryLookupResult
