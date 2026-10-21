import asyncio
from typing import Any

from google.adk.agents import LlmAgent

from ..schemas.dictionary_schemas import DictionaryLookupResult
from ..tools.dictionary_tools import (
    analyze_japanese_morpheme,
    hiragana_to_romaji,
    lookup_free_dictionary,
    lookup_jisho_dictionary,
    lookup_tatoeba_examples,
)
from . import get_local_model
from .runner import execute_adk_agent_json

DICTIONARY_AGENT_INSTRUCTION = """You are an authoritative bilingual English-Japanese lexicographer and phonetics coach.
Your job is to provide a precise contextual dictionary entry tailored to how the target word is used in the given sentence.

Tools available:
- For English ("en"): call lookup_free_dictionary(word) to get official IPA phonetic and standard definitions, and lookup_tatoeba_examples(word, "en") for real conversation examples.
- For Japanese ("ja"): call lookup_jisho_dictionary(word) to get official English-Japanese dictionary definitions and readings, and lookup_tatoeba_examples(word, "ja") for real conversational usage examples.
- For Japanese morphological analysis: call analyze_japanese_morpheme(word, sentence).

Respond ONLY with a single JSON object containing EXACTLY these keys:
- word: Target word
- lemma: Base dictionary form
- language: "en" or "ja"
- reading: For Japanese, full Hiragana reading (Furigana). For English, syllable breakdown with capitalized stress (e.g., "uh-PROHCH").
- romaji: For Japanese, standard Hepburn Romaji. For English, null or empty.
- ipa: Standard narrow IPA transcription (e.g. "/əˈproʊtʃ/" or "/ko.to.ba/").
- pitchAccent: Tokyo pitch accent pattern (e.g. "Heiban [0] (平板型)" or "Atamadaka [1] (頭高型)") if known, or null if uncertain. NEVER output generic placeholder text like "Standard Accent".
- partOfSpeech: e.g. "Noun", "Verb (Ichidan)", "Adjective", etc.
- contextualMeaning: Clear, concise explanation of what this word means specifically in this sentence.
- dictionaryDefinitions: Array of 1 to 3 general dictionary definitions.
- usageExample: A natural bilingual example sentence using this word.
- usageExampleTranslation: English/Japanese translation of the usage example.
- conversationExamples: Array of 1 to 3 objects with { "sentence": string, "translation": string } demonstrating practical daily conversational usage.
- pronunciationTip: Actionable phonetic advice on articulation, vowel duration, or stress.
"""


def create_dictionary_agent() -> LlmAgent:
    """Creates the ADK 2.x DictionaryAgent with local LLM and tools."""
    return LlmAgent(
        name="dictionary_agent",
        model=get_local_model(temperature=0.2),
        instruction=DICTIONARY_AGENT_INSTRUCTION,
        tools=[
            lookup_free_dictionary,
            lookup_jisho_dictionary,
            lookup_tatoeba_examples,
            analyze_japanese_morpheme,
        ],
    )


async def create_deterministic_dictionary_fallback(
    word: str,
    sentence: str,
    language: str,
) -> dict[str, Any]:
    """Generates an authentic online dictionary entry using Jisho, FreeDictionary, and Tatoeba APIs."""
    clean_word = word.strip()
    if language == "ja":
        jisho_task = lookup_jisho_dictionary(clean_word)
        tatoeba_task = lookup_tatoeba_examples(clean_word, "ja", limit=3)
        jisho_res, tatoeba_examples = await asyncio.gather(
            jisho_task, tatoeba_task, return_exceptions=True
        )

        jisho_info = jisho_res if isinstance(jisho_res, dict) else {}
        examples = tatoeba_examples if isinstance(tatoeba_examples, list) else []

        ja_info = analyze_japanese_morpheme(clean_word, sentence)
        reading = jisho_info.get("reading") or ja_info.get("reading") or clean_word
        romaji = jisho_info.get("romaji") or ja_info.get("romaji") or hiragana_to_romaji(reading)
        defs = jisho_info.get("definitions") or [f"Japanese term: {clean_word}"]
        pos = jisho_info.get("partOfSpeech") or ja_info.get("pos") or "名詞"

        primary_example = examples[0]["sentence"] if examples else (sentence or f"{clean_word}を使う。")
        primary_trans = examples[0]["translation"] if examples else "Example sentence usage."

        return {
            "word": clean_word,
            "lemma": ja_info.get("lemma") or jisho_info.get("word") or clean_word,
            "language": "ja",
            "reading": reading,
            "romaji": romaji,
            "ipa": f"/{reading}/",
            "pitchAccent": None,
            "partOfSpeech": pos,
            "contextualMeaning": defs[0] if defs else f"Meaning of '{clean_word}'",
            "dictionaryDefinitions": defs[:3],
            "usageExample": primary_example,
            "usageExampleTranslation": primary_trans,
            "conversationExamples": examples,
            "pronunciationTip": "Keep mora timing consistent; articulate each mora with even duration.",
        }

    # English word lookup
    en_dict_task = lookup_free_dictionary(clean_word)
    en_tat_task = lookup_tatoeba_examples(clean_word, "en", limit=3)
    en_res, tatoeba_examples = await asyncio.gather(
        en_dict_task, en_tat_task, return_exceptions=True
    )

    en_info = en_res if isinstance(en_res, dict) else {}
    examples = tatoeba_examples if isinstance(tatoeba_examples, list) else []

    defs = en_info.get("definitions") or [f"English word: {clean_word}"]
    ipa = en_info.get("ipa") or f"/{clean_word.lower()}/"
    pos = en_info.get("partOfSpeech") or "Word"

    primary_example = examples[0]["sentence"] if examples else (sentence or f"This is an example with {clean_word}.")
    primary_trans = examples[0]["translation"] if examples else "Usage example."

    return {
        "word": clean_word,
        "lemma": clean_word.lower(),
        "language": "en",
        "reading": clean_word.upper(),
        "romaji": None,
        "ipa": ipa,
        "pitchAccent": None,
        "partOfSpeech": pos,
        "contextualMeaning": defs[0] if defs else f"Meaning of '{clean_word}'",
        "dictionaryDefinitions": defs[:3],
        "usageExample": primary_example,
        "usageExampleTranslation": primary_trans,
        "conversationExamples": examples,
        "pronunciationTip": "Emphasize stressed vowel nuclei and articulate final consonant clusters cleanly.",
    }


async def lookup_word_with_agent(
    word: str,
    sentence: str,
    language: str,
) -> dict[str, Any]:
    """Executes the DictionaryAgent to obtain a contextual definition, falling back gracefully to live online dictionary."""
    try:
        agent = create_dictionary_agent()
        prompt = (
            f"Target Word: '{word}'\n"
            f"Context Sentence: '{sentence}'\n"
            f"Language: '{language}'\n"
            "Please provide the contextual dictionary entry as valid JSON."
        )

        return await execute_adk_agent_json(
            agent=agent,
            prompt=prompt,
            schema_model=DictionaryLookupResult,
        )
    except Exception as exc:
        print(f"DictionaryAgent fallback to live dictionary triggered: {exc}")
        return await create_deterministic_dictionary_fallback(word, sentence, language)
