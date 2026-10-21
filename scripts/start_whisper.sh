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
  echo "To run local speech-to-text, please place 'ggml-large-v3-turbo.bin' inside:"
  echo "  $PROJECT_ROOT/models/"
  echo "or set WHISPER_MODEL_PATH in your environment or .env file."
  echo ""
  echo "You can download it using:"
  echo "  ./scripts/download_models.sh"
  echo "================================================================================"
  exit 1
fi

# Locate whisper-server binary
WHISPER_BIN="${WHISPER_SERVER_BIN:-$(which whisper-server || echo "/usr/local/bin/whisper-server")}"
if [ ! -x "$WHISPER_BIN" ]; then
  echo "Error: whisper-server executable not found at $WHISPER_BIN"
  exit 1
fi

echo "Starting local whisper-server on http://127.0.0.1:8081..."
echo "Model: $MODEL_PATH"
echo "Threads: 6 (AVX2 / Apple Accelerate optimized)"

exec "$WHISPER_BIN" \
  --model "$MODEL_PATH" \
  --host 127.0.0.1 \
  --port 8081 \
  --inference-path "/v1/audio/transcriptions" \
  --threads 6
