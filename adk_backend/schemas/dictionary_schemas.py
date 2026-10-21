from typing import Literal

from pydantic import BaseModel, Field

LanguageCode = Literal["en", "ja"]


class DictionaryRequest(BaseModel):
    word: str
    sentence: str = ""
    language: LanguageCode = "en"


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
