import sys
from typing import Any
from urllib.parse import quote

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


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


async def lookup_free_dictionary(word: str) -> dict[str, Any]:
    """ADK FunctionTool: Queries FreeDictionary and Datamuse APIs for English IPA phonetics and definitions."""
    clean_word = word.strip().lower()
    if not clean_word:
        return {"found": False, "word": word, "definitions": []}

    headers = {"User-Agent": DEFAULT_USER_AGENT}
    definitions: list[str] = []
    examples: list[str] = []
    ipa = ""
    pos_list: list[str] = []

    # 1. Primary: FreeDictionary API (C10: URL-encode path segment safely)
    try:
        encoded_word = quote(clean_word, safe="")
        url = f"https://api.dictionaryapi.dev/api/v2/entries/en/{encoded_word}"
        async with httpx.AsyncClient(headers=headers, timeout=2.5) as client:
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
                    for m in entry.get("meanings", []):
                        p = m.get("partOfSpeech", "")
                        if p and p not in pos_list:
                            pos_list.append(p)
                        for d in m.get("definitions", [])[:2]:
                            if d.get("definition"):
                                definitions.append(f"{p}: {d['definition']}" if p else d["definition"])
                            if d.get("example") and len(examples) < 3:
                                examples.append(str(d["example"]).strip())
    except Exception as exc:
        print(f"FreeDictionary API notice: {exc}", file=sys.stderr)

    # 2. Fallback: Datamuse API (fast lexical definitions + IPA)
    if not definitions or not ipa:
        try:
            dm_url = "https://api.datamuse.com/words"
            async with httpx.AsyncClient(headers=headers, timeout=2.5) as client:
                resp = await client.get(dm_url, params={"sp": clean_word, "md": "dpfr", "max": 1})
                if resp.status_code == 200:
                    dm_data = resp.json()
                    if dm_data and len(dm_data) > 0:
                        if not ipa:
                            for tag in dm_data[0].get("tags", []):
                                if isinstance(tag, str) and tag.startswith("ipa_pron:"):
                                    raw_ipa = tag.split("ipa_pron:", 1)[1].strip()
                                    if raw_ipa:
                                        ipa = f"/{raw_ipa}/"
                                        break
                        if not definitions:
                            raw_defs = dm_data[0].get("defs", [])
                            for rd in raw_defs[:3]:
                                parts = rd.split("\t", 1)
                                if len(parts) == 2:
                                    pos_code, def_text = parts
                                    definitions.append(f"({pos_code}) {def_text.strip()}")
                                    if pos_code not in pos_list:
                                        pos_list.append(pos_code)
                                else:
                                    definitions.append(rd.strip())
        except Exception as exc:
            print(f"Datamuse API notice: {exc}", file=sys.stderr)

    if definitions:
        return {
            "found": True,
            "word": clean_word,
            "ipa": ipa or f"/{clean_word}/",
            "partOfSpeech": ", ".join(pos_list) if pos_list else "Word",
            "definitions": definitions[:4],
            "examples": examples[:3],
        }

    return {"found": False, "word": word, "definitions": [], "examples": []}


async def lookup_jisho_dictionary(word: str) -> dict[str, Any]:
    """ADK FunctionTool: Queries Jisho.org free REST API for authentic Japanese-English dictionary definitions and readings."""
    clean_word = word.strip()
    if not clean_word:
        return {"found": False, "word": word, "definitions": []}

    headers = {"User-Agent": DEFAULT_USER_AGENT}
    try:
        url = "https://jisho.org/api/v1/search/words"
        async with httpx.AsyncClient(headers=headers, timeout=2.8) as client:
            resp = await client.get(url, params={"keyword": clean_word})
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if data and len(data) > 0:
                    first = data[0]
                    jp_list = first.get("japanese", [{}])
                    jp_info = jp_list[0] if jp_list else {}
                    reading = jp_info.get("reading") or clean_word
                    headword = jp_info.get("word") or clean_word

                    senses = first.get("senses", [])
                    definitions: list[str] = []
                    pos_list: list[str] = []
                    ja_glosses: list[str] = []

                    for jp_item in jp_list[:3]:
                        w_j = jp_item.get("word")
                        r_j = jp_item.get("reading")
                        if w_j and r_j and w_j != r_j:
                            ja_glosses.append(f"{w_j} 【{r_j}】")
                        elif w_j or r_j:
                            ja_glosses.append(w_j or r_j)

                    for s in senses[:4]:
                        defs = s.get("english_definitions", [])
                        pos_tags = s.get("parts_of_speech", [])
                        for p in pos_tags:
                            if p and p not in pos_list and "Wikipedia" not in p:
                                pos_list.append(p)
                        if defs:
                            definitions.append("; ".join(defs[:4]))

                    romaji = hiragana_to_romaji(reading)
                    jlpt_list = first.get("jlpt", [])
                    return {
                        "found": True,
                        "word": headword,
                        "reading": reading,
                        "romaji": romaji,
                        "partOfSpeech": ", ".join(pos_list[:2]) if pos_list else "名詞",
                        "definitions": definitions[:4],
                        "jaGlosses": ja_glosses[:3],
                        "jlpt": jlpt_list[0].upper() if jlpt_list else None,
                        "isCommon": first.get("is_common", False),
                    }
    except Exception as exc:
        print(f"Jisho API notice: {exc}", file=sys.stderr)

    return {"found": False, "word": word, "definitions": []}


async def lookup_tatoeba_examples(
    word: str,
    language: str = "ja",
    limit: int = 3,
) -> list[dict[str, str]]:
    """ADK FunctionTool: Queries Tatoeba.org free open corpus for natural bilingual conversation examples."""
    clean_word = word.strip()
    if not clean_word:
        return []

    from_lang = "jpn" if language == "ja" else "eng"
    to_lang = "eng" if language == "ja" else "jpn"
    headers = {"User-Agent": DEFAULT_USER_AGENT}

    examples: list[dict[str, str]] = []
    try:
        url = "https://tatoeba.org/en/api_v0/search"
        async with httpx.AsyncClient(headers=headers, timeout=2.2) as client:
            resp = await client.get(
                url,
                params={"from": from_lang, "to": to_lang, "query": clean_word},
            )
            if resp.status_code == 200:
                results = resp.json().get("results", [])
                for r in results:
                    main_text = r.get("text", "").strip()
                    trans_list = [
                        t.get("text", "").strip()
                        for trans in r.get("translations", [])
                        for t in trans
                        if t.get("lang") == to_lang and t.get("text")
                    ]
                    if main_text and trans_list:
                        examples.append({
                            "sentence": main_text,
                            "translation": trans_list[0],
                        })
                    if len(examples) >= limit:
                        break
    except Exception as exc:
        print(f"Tatoeba API notice: {exc}", file=sys.stderr)

    return examples


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
        print(f"analyze_japanese_morpheme warning: {exc}", file=sys.stderr)

    return {
        "word": clean,
        "lemma": clean,
        "reading": clean,
        "romaji": clean,
        "pos": "名詞",
        "hasKanji": has_kanji(clean),
    }

