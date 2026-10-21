import re
from typing import Any

import fugashi

_tagger: fugashi.Tagger | None = None

KANJI_REGEX = re.compile(r"[\u4e00-\u9faf]")
JA_DETECT_REGEX = re.compile(r"[\u3040-\u30ff\u4e00-\u9faf]")
EN_TOKEN_REGEX = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?|[^\sA-Za-z0-9]+")


def get_tagger() -> fugashi.Tagger:
    """Lazy-initializes the singleton fugashi (MeCab + unidic-lite) tagger."""
    global _tagger
    if _tagger is None:
        _tagger = fugashi.Tagger()
    return _tagger


def katakana_to_hiragana(text: str) -> str:
    """Converts Katakana characters to Hiragana cleanly."""
    return "".join(chr(ord(ch) - 0x60) if "\u30a1" <= ch <= "\u30f6" else ch for ch in text)


def has_kanji(text: str) -> bool:
    """Returns True if the string contains at least one CJK Kanji character."""
    return bool(KANJI_REGEX.search(text))


def detect_japanese_characters(text: str) -> bool:
    """Returns True if the text contains Hiragana, Katakana, or Kanji."""
    return bool(JA_DETECT_REGEX.search(text))


def tokenize_sentence(text: str, language: str = "ja") -> list[dict[str, Any]]:
    """Tokenizes a Japanese or English sentence into EchoSense WordToken dicts.

    Matches the exact ServerWordToken schema expected by TranscriptReader.tsx:
    { surface, reading?, lemma?, pos?, isKanji? }

    Fixes:
    - Strips '*' returned by unidic-lite on non-Kanji/symbols.
    - Preserves contractions and punctuation in English sentences.
    - Safe against empty strings or whitespace.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    # If language is Japanese or contains Japanese characters
    if language == "ja" or (language != "en" and detect_japanese_characters(cleaned)):
        try:
            tagger = get_tagger()
            tokens: list[dict[str, Any]] = []
            for word in tagger(cleaned):
                surface = word.surface
                if not surface or surface.isspace():
                    continue
                is_k = has_kanji(surface)
                raw_kana = getattr(word.feature, "kana", None)
                reading = None
                if is_k and raw_kana and raw_kana != "*":
                    hira = katakana_to_hiragana(raw_kana)
                    if hira and hira != surface:
                        reading = hira

                raw_lemma = getattr(word.feature, "lemma", None)
                lemma = raw_lemma.split("-")[0] if raw_lemma and raw_lemma != "*" else surface
                pos = getattr(word.feature, "pos1", None)
                tokens.append(
                    {
                        "surface": surface,
                        "reading": reading,
                        "lemma": lemma,
                        "pos": pos if pos and pos != "*" else None,
                        "isKanji": is_k,
                    }
                )
            return tokens
        except Exception as exc:
            print(f"fugashi tokenization warning: {exc}")

    # English or fallback tokenization (preserves punctuation tokens for reader)
    return [
        {
            "surface": match.group(0),
            "isKanji": has_kanji(match.group(0)),
        }
        for match in EN_TOKEN_REGEX.finditer(cleaned)
    ]
