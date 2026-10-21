from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import API_PORT, PROJECT_ROOT, TEMP_AUDIO_DIR
from .routes.dictionary_routes import router as dictionary_router
from .routes.health_routes import router as health_router
from .routes.shadowing_routes import router as shadowing_router
from .routes.system_routes import router as system_router
from .routes.transcript_routes import router as transcript_router
from .routes.tts_routes import router as tts_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Ensures temp directory is initialized on startup and cleaned up if needed."""
    TEMP_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    print(f"EchoSense ADK 2.x Backend initialized on http://127.0.0.1:{API_PORT}")
    yield


app = FastAPI(
    title="EchoSense Local Google ADK 2.x Application",
    description="100% Local AI Backend running Google ADK 2.x + Qwen3.5-9B + whisper.cpp + offline macOS TTS",
    version="2.0.0",
    lifespan=lifespan,
)

# Enable CORS for local development across Vite (port 5173) and FastAPI (port 3000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routes under /api
app.include_router(health_router, prefix="/api", tags=["Health"])
app.include_router(system_router, prefix="/api", tags=["System"])
app.include_router(transcript_router, prefix="/api", tags=["Transcript"])
app.include_router(dictionary_router, prefix="/api", tags=["Dictionary"])
app.include_router(shadowing_router, prefix="/api", tags=["Shadowing"])
app.include_router(tts_router, prefix="/api", tags=["TTS"])

# Serve built frontend assets if dist/ exists
dist_dir = PROJECT_ROOT / "dist"
if dist_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "adk_backend.main:app",
        host="127.0.0.1",
        port=API_PORT,
        reload=True,
    )
