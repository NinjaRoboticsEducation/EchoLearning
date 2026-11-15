import hashlib
import re
from typing import Any

from fastapi import APIRouter, HTTPException

from ..agents.dictionary_agent import lookup_word_with_agent
from ..schemas.dictionary_schemas import DictionaryRequest

router = APIRouter()

# In-memory LRU cache for instant repeat lookups (< 5ms)
_dictionary_cache: dict[str, dict[str, Any]] = {}
PUNCT_STRIP_REGEX = re.compile(r"[.,!?;:\"'()「」『』、。！？—\-/?#%&\\]+")


@router.post("/dictionary/lookup")
async def dictionary_lookup(req: DictionaryRequest):
    """Contextual Dictionary Lookup powered by Google ADK 2.x DictionaryAgent.

    Extracts word lemma, contextual meaning, IPA / Furigana, pitch accent notes,
    and definitions. Caches non-degraded lookups in memory for ultra-fast response.
    """
    raw_word = req.word.strip()
    if not raw_word:
        raise HTTPException(status_code=400, detail="Word is required for lookup.")

    clean_word = PUNCT_STRIP_REGEX.sub("", raw_word).strip()
    if not clean_word:
        raise HTTPException(status_code=400, detail="Word contains only punctuation or unsafe characters.")

    context = hashlib.sha256(req.sentence.strip().encode()).hexdigest()
    cache_key = f"{req.language}:{clean_word.lower()}:{context}"

    cached = _dictionary_cache.get(cache_key)
    if cached and not cached.get("isDegraded", False):
        return cached

    try:
        result = await lookup_word_with_agent(
            word=clean_word,
            sentence=req.sentence,
            language=req.language,
        )
        # C11: NEVER cache degraded entries when llama-server fell back or failed
        if not result.get("isDegraded", False) and result.get("source") != "offline_fallback":
            if len(_dictionary_cache) >= 500:
                _dictionary_cache.pop(next(iter(_dictionary_cache)))
            _dictionary_cache[cache_key] = result
        return result
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Dictionary lookup failed: {exc!s}",
        )
