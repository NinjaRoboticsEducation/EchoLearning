import httpx
from fastapi import APIRouter

from ..config import LLAMA_SERVER_URL, WHISPER_SERVER_URL

router = APIRouter()


@router.get("/health")
async def health_check():
    """Checks the health of FastAPI, llama-server, and whisper-server."""
    services = {
        "fastapi": "ok",
        "llamaServer": "offline",
        "whisperServer": "offline",
    }

    async with httpx.AsyncClient(timeout=2.0) as client:
        # Check llama-server
        try:
            r = await client.get(f"{LLAMA_SERVER_URL}/models")
            if r.status_code == 200:
                services["llamaServer"] = "online"
        except Exception:
            pass

        # Check whisper-server
        try:
            r = await client.get(f"{WHISPER_SERVER_URL}/")
            if r.status_code in (200, 404, 405):
                services["whisperServer"] = "online"
        except Exception:
            pass

    ready = services["llamaServer"] == "online" and services["whisperServer"] == "online"
    return {
        "status": "ok",
        "ready": ready,
        "framework": "Google ADK 2.x",
        "services": services,
    }
