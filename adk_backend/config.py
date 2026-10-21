import os
from pathlib import Path

from dotenv import load_dotenv

# Resolve project root relatively from adk_backend/config.py
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent

# Load .env files if present (backend directory first, then project root)
load_dotenv(BACKEND_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

# Local AI Server Endpoints
LLAMA_SERVER_URL = os.getenv("LLAMA_SERVER_URL", "http://127.0.0.1:8080/v1")
WHISPER_SERVER_URL = os.getenv("WHISPER_SERVER_URL", "http://127.0.0.1:8081")
LLAMA_MODEL_NAME = os.getenv("LLAMA_MODEL_NAME", "qwen3.5-9b")

# HTTP Ports
API_PORT = int(os.getenv("API_PORT", "3000"))
FRONTEND_DEV_PORT = int(os.getenv("FRONTEND_DEV_PORT", "5173"))

# Relative Model Paths
MODELS_DIR = PROJECT_ROOT / "models"
LLAMA_MODEL_PATH = Path(os.getenv("LLAMA_MODEL_PATH", str(MODELS_DIR / "Qwen3.5-9B-Q6_K.gguf")))
WHISPER_MODEL_PATH = Path(
    os.getenv("WHISPER_MODEL_PATH", str(MODELS_DIR / "ggml-large-v3-turbo.bin"))
)
TEMP_AUDIO_DIR = BACKEND_DIR / ".tmp_audio"
TEMP_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
