from typing import Any

from google.adk.agents import LlmAgent

from ..schemas.dictionary_schemas import DictionaryLookupResult
from ..tools.dictionary_tools import (
    analyze_japanese_morpheme,
    hiragana_to_romaji,
    lookup_free_dictionary,
)
from . import get_local_model
from .runner import execute_adk_agent_json

DICTIONARY_AGENT_INSTRUCTION = """You are an authoritative bilingual English-Japanese lexicographer and phonetics coach.
Your job is to provide a precise contextual dictionary entry tailored to how the target word is used in the given sentence.

Tools available:
- For English ("en"): call lookup_free_dictionary(word) to get official IPA phonetic and standard definitions.
- For Japanese ("ja"): call analyze_japanese_morpheme(word, sentence) to get base lemma, reading, Romaji, and part of speech.

Respond ONLY with a single JSON object containing EXACTLY these keys:
- word: Target word
- lemma: Base dictionary form
- language: "en" or "ja"
- reading: For Japanese, full Hiragana reading (Furigana). For English, syllable breakdown with capitalized stress (e.g., "uh-PROHCH").
- romaji: For Japanese, standard Hepburn Romaji. For English, null or empty.
- ipa: Standard narrow IPA transcription (e.g. "/əˈproʊtʃ/" or "/ko.to.ba/").
- pitchAccent: For Japanese, Tokyo pitch accent pattern (e.g., "Heiban [0] (平板型)" or "Atamadaka [1] (頭高型)"). For English, stress pattern (e.g., "da-DUM (2nd syllable stress)").
- partOfSpeech: e.g. "Noun", "Verb (Ichidan)", "Adjective", etc.
- contextualMeaning: Clear, concise explanation of what this word means specifically in this sentence.
- dictionaryDefinitions: Array of 1 to 3 general dictionary definitions.
- usageExample: A natural bilingual example sentence using this word.
- usageExampleTranslation: English translation of the usage example.
- pronunciationTip: Actionable phonetic advice on tongue placement, stress, or pitch.
"""


def create_dictionary_agent() -> LlmAgent:
    """Creates the ADK 2.x DictionaryAgent with local LLM and tools."""
    return LlmAgent(
        name="dictionary_agent",
        model=get_local_model(temperature=0.2),
        instruction=DICTIONARY_AGENT_INSTRUCTION,
        tools=[lookup_free_dictionary, analyze_japanese_morpheme],
    )


def create_deterministic_dictionary_fallback(
    word: str,
    sentence: str,
    language: str,
) -> dict[str, Any]:
    """Generates a reliable deterministic dictionary entry if the local LLM server is unreachable."""
    clean_word = word.strip()
    if language == "ja":
        ja_info = analyze_japanese_morpheme(clean_word, sentence)
        reading = ja_info.get("reading") or clean_word
        romaji = ja_info.get("romaji") or hiragana_to_romaji(reading)
        return {
            "word": clean_word,
            "lemma": ja_info.get("lemma") or clean_word,
            "language": "ja",
            "reading": reading,
            "romaji": romaji,
            "ipa": f"/{reading}/",
            "pitchAccent": "Standard Accent",
            "partOfSpeech": ja_info.get("pos") or "名詞",
            "contextualMeaning": f"Contextual meaning of '{clean_word}' in: {sentence[:40]}...",
            "dictionaryDefinitions": [f"Japanese term: {clean_word}"],
            "usageExample": sentence or f"{clean_word}を使う。",
            "usageExampleTranslation": "Example usage from sentence.",
            "pronunciationTip": "Keep mora timing consistent; avoid elongating short vowels.",
        }

    return {
        "word": clean_word,
        "lemma": clean_word.lower(),
        "language": "en",
        "reading": clean_word.upper(),
        "romaji": None,
        "ipa": f"/{clean_word.lower()}/",
        "pitchAccent": "Primary Stress",
        "partOfSpeech": "Word",
        "contextualMeaning": f"Contextual usage in: {sentence[:40]}...",
        "dictionaryDefinitions": [f"English word: {clean_word}"],
        "usageExample": sentence or f"This is an example of {clean_word}.",
        "usageExampleTranslation": "Usage example.",
        "pronunciationTip": "Articulate consonants cleanly and emphasize the primary stressed syllable.",
    }


async def lookup_word_with_agent(
    word: str,
    sentence: str,
    language: str,
) -> dict[str, Any]:
    """Executes the DictionaryAgent to obtain a contextual definition, falling back gracefully."""
    agent = create_dictionary_agent()
    prompt = (
        f"Target Word: '{word}'\n"
        f"Context Sentence: '{sentence}'\n"
        f"Language: '{language}'\n"
        "Please provide the contextual dictionary entry as valid JSON."
    )

    try:
        return await execute_adk_agent_json(
            agent=agent,
            prompt=prompt,
            schema_model=DictionaryLookupResult,
        )
    except Exception as exc:
        print(f"DictionaryAgent fallback triggered: {exc}")
        return create_deterministic_dictionary_fallback(word, sentence, language)
