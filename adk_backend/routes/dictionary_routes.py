import re
from typing import Any

from fastapi import APIRouter, HTTPException

from ..agents.dictionary_agent import lookup_word_with_agent
from ..schemas.dictionary_schemas import DictionaryRequest

router = APIRouter()

# In-memory LRU cache for instant repeat lookups (< 5ms)
_dictionary_cache: dict[str, dict[str, Any]] = {}
PUNCT_STRIP_REGEX = re.compile(r"[.,!?;:\"'()「」『』、。！？—\-]+")


@router.post("/dictionary/lookup")
async def dictionary_lookup(req: DictionaryRequest):
    """Contextual Dictionary Lookup powered by Google ADK 2.x DictionaryAgent.

    Extracts word lemma, contextual meaning, IPA / Furigana, pitch accent notes,
    and definitions. Caches lookups in memory for ultra-fast response.
    """
    raw_word = req.word.strip()
    if not raw_word:
        raise HTTPException(status_code=400, detail="Word is required for lookup.")

    clean_word = PUNCT_STRIP_REGEX.sub("", raw_word).strip() or raw_word
    cache_key = f"{req.language}:{clean_word.lower()}:{req.sentence[:32].strip()}"

    if cache_key in _dictionary_cache:
        return _dictionary_cache[cache_key]

    try:
        result = await lookup_word_with_agent(
            word=clean_word,
            sentence=req.sentence,
            language=req.language,
        )
        # Store in cache (cap at 500 items to prevent memory bloat)
        if len(_dictionary_cache) > 500:
            _dictionary_cache.pop(next(iter(_dictionary_cache)))
        _dictionary_cache[cache_key] = result
        return result
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Dictionary lookup failed: {exc!s}",
        )
