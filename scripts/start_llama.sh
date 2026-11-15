#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$PROJECT_ROOT/models"

CLI_MODEL=""
CLI_ALIAS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      CLI_MODEL="${2:-}"
      shift 2
      ;;
    --alias)
      CLI_ALIAS="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

resolve_model_from_id() {
  case "$1" in
    qwen3.5-4b-q6_k) echo "$MODELS_DIR/Qwen3.5-4B-Q6_K.gguf" ;;
    qwen3.5-9b-q4_k_m) echo "$MODELS_DIR/Qwen3.5-9B-Q4_K_M.gguf" ;;
    qwen3.5-9b-q6_k) echo "$MODELS_DIR/Qwen3.5-9B-Q6_K.gguf" ;;
    qwen3.5-27b-q4_k_m) echo "$MODELS_DIR/Qwen3.5-27B-Q4_K_M.gguf" ;;
    qwen3.5-35b-a3b-q4_k_m) echo "$MODELS_DIR/Qwen3.5-35B-A3B-Q4_K_M.gguf" ;;
    *) echo "" ;;
  esac
}

MODEL_PATH=""
MODEL_ALIAS="${CLI_ALIAS:-${LLAMA_MODEL_NAME:-qwen3.5-9b}}"

if [[ -n "$CLI_MODEL" ]]; then
  mapped="$(resolve_model_from_id "$CLI_MODEL")"
  if [[ -n "$mapped" ]]; then
    MODEL_PATH="$mapped"
    MODEL_ALIAS="${CLI_ALIAS:-$CLI_MODEL}"
  else
    MODEL_PATH="$CLI_MODEL"
  fi
elif [[ -n "${LLAMA_MODEL_PATH:-}" ]]; then
  MODEL_PATH="$LLAMA_MODEL_PATH"
elif [[ -f "$MODELS_DIR/manifest.json" ]] && command -v python3 >/dev/null 2>&1; then
  MANIFEST_INFO="$(python3 - "$MODELS_DIR" <<'PY'
import json, sys
from pathlib import Path

models_dir = Path(sys.argv[1])
manifest_path = models_dir / "manifest.json"
mapping = {
    "qwen3.5-4b-q6_k": "Qwen3.5-4B-Q6_K.gguf",
    "qwen3.5-9b-q4_k_m": "Qwen3.5-9B-Q4_K_M.gguf",
    "qwen3.5-9b-q6_k": "Qwen3.5-9B-Q6_K.gguf",
    "qwen3.5-27b-q4_k_m": "Qwen3.5-27B-Q4_K_M.gguf",
    "qwen3.5-35b-a3b-q4_k_m": "Qwen3.5-35B-A3B-Q4_K_M.gguf",
}
try:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    active_id = data.get("active_model") or data.get("activeProfileId") or ""
    fname = mapping.get(active_id, "")
    if fname and (models_dir / fname).is_file():
        print(f"{models_dir / fname}|{active_id}")
except Exception:
    pass
PY
)"
  if [[ -n "$MANIFEST_INFO" ]]; then
    MODEL_PATH="${MANIFEST_INFO%%|*}"
    MODEL_ALIAS="${MANIFEST_INFO#*|}"
  fi
fi

if [[ -z "$MODEL_PATH" || ! -f "$MODEL_PATH" ]]; then
  if [[ -f "$MODELS_DIR/Qwen3.5-9B-Q6_K.gguf" ]]; then
    MODEL_PATH="$MODELS_DIR/Qwen3.5-9B-Q6_K.gguf"
  else
    first_gguf="$(find "$MODELS_DIR" -maxdepth 1 -name 'Qwen3.5-*.gguf' -type f 2>/dev/null | head -n 1 || true)"
    if [[ -n "$first_gguf" ]]; then
      MODEL_PATH="$first_gguf"
    else
      MODEL_PATH="$MODELS_DIR/Qwen3.5-9B-Q6_K.gguf"
    fi
  fi
fi

if [ ! -f "$MODEL_PATH" ]; then
  echo "================================================================================"
  echo "Error: Local LLM model not found at:"
  echo "  $MODEL_PATH"
  echo ""
  echo "Download a model with:"
  echo "  ./scripts/download_models.sh"
  echo "================================================================================"
  exit 1
fi

# Locate llama-server binary across standard Homebrew & PATH locations
LLAMA_BIN="${LLAMA_SERVER_BIN:-}"
if [[ -z "$LLAMA_BIN" ]]; then
  LLAMA_BIN="$(command -v llama-server 2>/dev/null || true)"
fi
if [[ -z "$LLAMA_BIN" && -x "/opt/homebrew/bin/llama-server" ]]; then
  LLAMA_BIN="/opt/homebrew/bin/llama-server"
fi
if [[ -z "$LLAMA_BIN" && -x "/usr/local/bin/llama-server" ]]; then
  LLAMA_BIN="/usr/local/bin/llama-server"
fi

if [[ -z "$LLAMA_BIN" || ! -x "$LLAMA_BIN" ]]; then
  echo "Error: llama-server executable not found."
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  NGL=99
  ACCEL_NOTE="Apple Silicon Metal GPU offload (-ngl 99)"
else
  NGL=0
  ACCEL_NOTE="Intel x86_64 CPU-only (-ngl 0, prevents iGPU thrashing)"
fi

THREADS="$(sysctl -n hw.physicalcpu 2>/dev/null || echo 6)"
if [[ -z "$THREADS" || "$THREADS" -lt 1 ]]; then
  THREADS=6
fi

echo "Starting local llama-server on http://127.0.0.1:8080..."
echo "Model: $MODEL_PATH (alias: $MODEL_ALIAS)"
echo "Hardware: $ARCH · Threads: $THREADS · $ACCEL_NOTE"

exec "$LLAMA_BIN" \
  --model "$MODEL_PATH" \
  --alias "$MODEL_ALIAS" \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 8192 \
  --threads "$THREADS" \
  --threads-batch "$THREADS" \
  --jinja \
  -ngl "$NGL"
