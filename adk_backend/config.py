import os
from pathlib import Path

from dotenv import load_dotenv

# Resolve project root relatively from adk_backend/config.py
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent

# Load .env files if present (backend directory first, then project root)
load_dotenv(BACKEND_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")


def resolve_project_path(raw_path: str | Path, default_base: Path = PROJECT_ROOT) -> Path:
    """Resolves a relative path against PROJECT_ROOT so external CWDs work reliably."""
    p = Path(raw_path)
    return p if p.is_absolute() else (default_base / p).resolve()


# Local AI Server Endpoints
LLAMA_SERVER_URL = os.getenv("LLAMA_SERVER_URL", "http://127.0.0.1:8080/v1")
WHISPER_SERVER_URL = os.getenv("WHISPER_SERVER_URL", "http://127.0.0.1:8081")
LLAMA_MODEL_NAME = os.getenv("LLAMA_MODEL_NAME", "qwen3.5-9b")

# HTTP Ports
API_PORT = int(os.getenv("API_PORT", "3000"))
FRONTEND_DEV_PORT = int(os.getenv("FRONTEND_DEV_PORT", "5173"))

# Relative Model Paths
MODELS_DIR = resolve_project_path(os.getenv("ECHOLEARNING_MODELS_DIR", str(PROJECT_ROOT / "models")))
MODEL_MANIFEST_PATH = MODELS_DIR / "manifest.json"
LLAMA_MODEL_PATH = resolve_project_path(
    os.getenv("LLAMA_MODEL_PATH", str(MODELS_DIR / "Qwen3.5-9B-Q6_K.gguf"))
)
WHISPER_MODEL_PATH = resolve_project_path(
    os.getenv("WHISPER_MODEL_PATH", str(MODELS_DIR / "ggml-large-v3-turbo.bin"))
)

# Runtime & Durable Storage Paths
PIDS_DIR = PROJECT_ROOT / ".pids"
LOGS_DIR = PROJECT_ROOT / "logs"
TEMP_AUDIO_DIR = BACKEND_DIR / ".tmp_audio"
TEMP_AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def get_data_dir() -> Path:
    """Returns the durable data directory (overrideable via ECHOLEARNING_DATA_DIR)."""
    raw = os.getenv("ECHOLEARNING_DATA_DIR")
    if raw:
        return resolve_project_path(raw)
    return PROJECT_ROOT / "data"


def get_db_path() -> Path:
    """Returns the SQLite database path (overrideable via ECHOLEARNING_DB_PATH for tests)."""
    raw = os.getenv("ECHOLEARNING_DB_PATH")
    if raw:
        return resolve_project_path(raw)
    return get_data_dir() / "echolearning.sqlite3"


def get_audio_dir() -> Path:
    """Returns the durable local audio directory (overrideable via ECHOLEARNING_AUDIO_DIR)."""
    raw = os.getenv("ECHOLEARNING_AUDIO_DIR")
    if raw:
        return resolve_project_path(raw)
    return get_data_dir() / "audio"
