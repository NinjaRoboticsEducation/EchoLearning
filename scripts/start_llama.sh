#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL_PATH="${LLAMA_MODEL_PATH:-$PROJECT_ROOT/models/Qwen3.5-9B-Q6_K.gguf}"

if [ ! -f "$MODEL_PATH" ]; then
  echo "================================================================================"
  echo "Error: Local LLM model not found at:"
  echo "  $MODEL_PATH"
  echo ""
  echo "To run Qwen3.5-9B locally, please place 'Qwen3.5-9B-Q6_K.gguf' inside:"
  echo "  $PROJECT_ROOT/models/"
  echo "or set LLAMA_MODEL_PATH in your environment or .env file."
  echo ""
  echo "You can download it using huggingface-cli or curl, for example:"
  echo "  ./scripts/download_models.sh"
  echo "================================================================================"
  exit 1
fi

# Locate llama-server binary
LLAMA_BIN="${LLAMA_SERVER_BIN:-$(which llama-server || echo "/usr/local/bin/llama-server")}"
if [ ! -x "$LLAMA_BIN" ]; then
  echo "Error: llama-server executable not found at $LLAMA_BIN"
  exit 1
fi

echo "Starting local llama-server on http://127.0.0.1:8080..."
echo "Model: $MODEL_PATH"
echo "Threads: 6 (Intel i5-8500B AVX2 / Apple Accelerate optimized)"

# --ctx-size 8192 is optimal for EchoSense (<4k tokens/request) and keeps RAM under ~8 GB
# --jinja enables native tool-calling chat templates
# -ngl 0 avoids Intel UHD 630 iGPU memory thrashing
exec "$LLAMA_BIN" \
  --model "$MODEL_PATH" \
  --alias "qwen3.5-9b" \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 8192 \
  --threads 6 \
  --threads-batch 6 \
  --jinja \
  --flash-attn \
  -ngl 0
