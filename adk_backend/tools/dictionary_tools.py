from typing import Any

import httpx

from .tokenizer_tools import (
    get_tagger,
    has_kanji,
    katakana_to_hiragana,
)

# Standard Hepburn Romaji mapping for Hiragana characters
HIRAGANA_ROMAJI_MAP = {
    "あ": "a",
    "い": "i",
    "う": "u",
    "え": "e",
    "お": "o",
    "か": "ka",
    "き": "ki",
    "く": "ku",
    "け": "ke",
    "こ": "ko",
    "さ": "sa",
    "し": "shi",
    "す": "su",
    "せ": "se",
    "そ": "so",
    "た": "ta",
    "ち": "chi",
    "つ": "tsu",
    "て": "te",
    "と": "to",
    "な": "na",
    "に": "ni",
    "ぬ": "nu",
    "ね": "ne",
    "の": "no",
    "は": "ha",
    "ひ": "hi",
    "ふ": "fu",
    "へ": "he",
    "ほ": "ho",
    "ま": "ma",
    "み": "mi",
    "む": "mu",
    "め": "me",
    "も": "mo",
    "や": "ya",
    "ゆ": "yu",
    "よ": "yo",
    "ら": "ra",
    "り": "ri",
    "る": "ru",
    "れ": "re",
    "ろ": "ro",
    "わ": "wa",
    "を": "o",
    "ん": "n",
    "が": "ga",
    "ぎ": "gi",
    "ぐ": "gu",
    "げ": "ge",
    "ご": "go",
    "ざ": "za",
    "じ": "ji",
    "ず": "zu",
    "ぜ": "ze",
    "ぞ": "zo",
    "だ": "da",
    "ぢ": "ji",
    "づ": "zu",
    "で": "de",
    "ど": "do",
    "ば": "ba",
    "び": "bi",
    "ぶ": "bu",
    "べ": "be",
    "ぼ": "bo",
    "ぱ": "pa",
    "ぴ": "pi",
    "ぷ": "pu",
    "ぺ": "pe",
    "ぽ": "po",
    "きゃ": "kya",
    "きゅ": "kyu",
    "きょ": "kyo",
    "しゃ": "sha",
    "しゅ": "shu",
    "しょ": "sho",
    "ちゃ": "cha",
    "ちゅ": "chu",
    "ちょ": "cho",
    "にゃ": "nya",
    "にゅ": "nyu",
    "にょ": "nyo",
    "ひゃ": "hya",
    "ひゅ": "hyu",
    "ひょ": "hyo",
    "みゃ": "mya",
    "みゅ": "myu",
    "みょ": "myo",
    "りゃ": "rya",
    "りゅ": "ryu",
    "りょ": "ryo",
    "ぎゃ": "gya",
    "ぎゅ": "gyu",
    "ぎょ": "gyo",
    "じゃ": "ja",
    "じゅ": "ju",
    "じょ": "jo",
    "びゃ": "bya",
    "びゅ": "byu",
    "びょ": "byo",
    "ぴゃ": "pya",
    "ぴゅ": "pyu",
    "ぴょ": "pyo",
    "っ": "",
}


def hiragana_to_romaji(text: str) -> str:
    """Simple greedy Hiragana to Hepburn Romaji converter."""
    result: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if i + 1 < n and text[i : i + 2] in HIRAGANA_ROMAJI_MAP:
            result.append(HIRAGANA_ROMAJI_MAP[text[i : i + 2]])
            i += 2
        elif text[i] == "っ" and i + 1 < n:
            next_rom = hiragana_to_romaji(text[i + 1])
            if next_rom:
                result.append(next_rom[0])
            i += 1
        elif text[i] in HIRAGANA_ROMAJI_MAP:
            result.append(HIRAGANA_ROMAJI_MAP[text[i]])
            i += 1
        else:
            result.append(text[i])
            i += 1
    return "".join(result)


async def lookup_free_dictionary(word: str) -> dict[str, Any]:
    """ADK FunctionTool: Queries FreeDictionary API for English IPA phonetic and definitions."""
    clean_word = word.strip().lower()
    if not clean_word:
        return {"found": False, "word": word}

    try:
        url = f"https://api.dictionaryapi.dev/api/v2/entries/en/{clean_word}"
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                if data and isinstance(data, list) and len(data) > 0:
                    entry = data[0]
                    ipa = entry.get("phonetic", "")
                    if not ipa:
                        for ph in entry.get("phonetics", []):
                            if ph.get("text"):
                                ipa = ph["text"]
                                break
                    definitions: list[str] = []
                    pos_list: list[str] = []
                    for m in entry.get("meanings", []):
                        p = m.get("partOfSpeech", "")
                        if p and p not in pos_list:
                            pos_list.append(p)
                        for d in m.get("definitions", [])[:2]:
                            if d.get("definition"):
                                definitions.append(f"{p}: {d['definition']}")
                    return {
                        "found": True,
                        "word": clean_word,
                        "ipa": ipa,
                        "partOfSpeech": ", ".join(pos_list) if pos_list else "Word",
                        "definitions": definitions[:3],
                    }
    except Exception as exc:
        print(f"FreeDictionary API notice: {exc}")

    return {"found": False, "word": word}


def analyze_japanese_morpheme(word: str, sentence: str = "") -> dict[str, Any]:
    """ADK FunctionTool: Analyzes a Japanese word to extract lemma, reading, Romaji, and POS."""
    clean = word.strip()
    if not clean:
        return {"word": word, "lemma": word, "reading": "", "romaji": "", "pos": "名詞"}

    try:
        tagger = get_tagger()
        tokens = list(tagger(clean))
        if tokens:
            t = tokens[0]
            raw_kana = getattr(t.feature, "kana", "") or ""
            reading = katakana_to_hiragana(raw_kana) if raw_kana and raw_kana != "*" else clean
            raw_lemma = getattr(t.feature, "lemma", "") or ""
            lemma = raw_lemma.split("-")[0] if raw_lemma and raw_lemma != "*" else clean
            pos = getattr(t.feature, "pos1", "") or "名詞"
            romaji = hiragana_to_romaji(reading)
            return {
                "word": clean,
                "lemma": lemma,
                "reading": reading,
                "romaji": romaji,
                "pos": pos,
                "hasKanji": has_kanji(clean),
            }
    except Exception as exc:
        print(f"analyze_japanese_morpheme warning: {exc}")

    return {
        "word": clean,
        "lemma": clean,
        "reading": clean,
        "romaji": clean,
        "pos": "名詞",
        "hasKanji": has_kanji(clean),
    }
