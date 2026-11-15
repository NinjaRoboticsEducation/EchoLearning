import base64
import os
import platform
import re
import subprocess
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import TEMP_AUDIO_DIR

router = APIRouter()

CONTROL_CHAR_REGEX = re.compile(r"[\x00-\x1f\x7f]+")


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    language: Literal["en", "ja"] = "en"


@router.post("/tts/pronounce")
async def pronounce_text(req: TtsRequest):
    """Local offline TTS endpoint.

    Uses macOS /usr/bin/say with `-f -` (stdin input, preventing C09 argument injection)
    plus ffmpeg to synthesize crisp offline Japanese ('Kyoko') or English ('Samantha')
    16-bit mono PCM WAV audio.
    """
    clean_text = CONTROL_CHAR_REGEX.sub(" ", req.text or "").strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Text is required.")

    if platform.system() != "Darwin" or not os.path.exists("/usr/bin/say"):
        raise HTTPException(
            status_code=503,
            detail="Offline macOS TTS synthesizer (/usr/bin/say) is unavailable on this host.",
        )

    file_id = uuid.uuid4().hex[:10]
    aiff_path = TEMP_AUDIO_DIR / f"tts_{file_id}.aiff"
    wav_path = TEMP_AUDIO_DIR / f"tts_{file_id}.wav"
    voice = "Kyoko" if req.language == "ja" else "Samantha"

    try:
        subprocess.run(
            ["/usr/bin/say", "-v", voice, "-o", str(aiff_path), "-f", "-"],
            input=clean_text.encode("utf-8"),
            check=True,
            timeout=15,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(aiff_path),
                "-ar",
                "22050",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            timeout=15,
        )
        wav_bytes = wav_path.read_bytes()
        if len(wav_bytes) <= 44:
            raise RuntimeError("Synthesized WAV audio was empty.")
        audio_b64 = base64.b64encode(wav_bytes).decode("ascii")
        return {"audioBase64": audio_b64, "mimeType": "audio/wav"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Offline TTS synthesis failed: {exc!s}",
        )
    finally:
        aiff_path.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)
