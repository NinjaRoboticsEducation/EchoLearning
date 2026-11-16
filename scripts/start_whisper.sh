#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_PATH="${WHISPER_MODEL_PATH:-$PROJECT_ROOT/models/ggml-large-v3-turbo.bin}"

if [ ! -f "$MODEL_PATH" ]; then
  echo "================================================================================"
  echo "Error: Local Whisper model not found at:"
  echo "  $MODEL_PATH"
  echo ""
  echo "You can download it using:"
  echo "  ./scripts/download_models.sh"
  echo "================================================================================"
  exit 1
fi

# Locate whisper-server binary across PATH and Homebrew locations
WHISPER_BIN="${WHISPER_SERVER_BIN:-}"
if [[ -z "$WHISPER_BIN" ]]; then
  WHISPER_BIN="$(command -v whisper-server 2>/dev/null || true)"
fi
if [[ -z "$WHISPER_BIN" && -x "/opt/homebrew/bin/whisper-server" ]]; then
  WHISPER_BIN="/opt/homebrew/bin/whisper-server"
fi
if [[ -z "$WHISPER_BIN" && -x "/usr/local/bin/whisper-server" ]]; then
  WHISPER_BIN="/usr/local/bin/whisper-server"
fi

if [[ -z "$WHISPER_BIN" || ! -x "$WHISPER_BIN" ]]; then
  echo "Error: whisper-server executable not found."
  exit 1
fi

THREADS="$(sysctl -n hw.physicalcpu 2>/dev/null || echo 6)"
if [[ -z "$THREADS" || "$THREADS" -lt 1 ]]; then
  THREADS=6
fi

echo "Starting local whisper-server on http://127.0.0.1:8081..."
echo "Model: $MODEL_PATH"
echo "Threads: $THREADS (physical cores)"

exec "$WHISPER_BIN" \
  --model "$MODEL_PATH" \
  --host 127.0.0.1 \
  --port 8081 \
  --inference-path "/v1/audio/transcriptions" \
  --threads "$THREADS" \
  --max-context 0 \
  --entropy-thold 2.20 \
  --suppress-nst
