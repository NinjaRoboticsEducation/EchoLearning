#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$PROJECT_ROOT/models"

mkdir -p "$MODELS_DIR"

echo "================================================================================"
echo "EchoSense Local Model Downloader"
echo "Target directory: $MODELS_DIR"
echo "================================================================================"

# 1. Whisper Large-v3-Turbo (~1.6 GB)
WHISPER_TARGET="$MODELS_DIR/ggml-large-v3-turbo.bin"
if [ -f "$WHISPER_TARGET" ]; then
  echo "✓ Whisper model already exists: $WHISPER_TARGET"
else
  echo "Downloading Whisper Large-v3-Turbo model (approx 1.6 GB)..."
  curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
    -o "$WHISPER_TARGET"
  echo "✓ Whisper model downloaded: $WHISPER_TARGET"
fi

# 2. Qwen3.5-9B Q6_K GGUF (~7.5 GB)
LLM_TARGET="$MODELS_DIR/Qwen3.5-9B-Q6_K.gguf"
if [ -f "$LLM_TARGET" ]; then
  echo "✓ LLM model already exists: $LLM_TARGET"
else
  echo ""
  echo "To download the local LLM model (Qwen3.5-9B-Q6_K or compatible GGUF, ~7.5 GB):"
  echo "Run huggingface-cli or curl, for example:"
  echo "  $PROJECT_ROOT/adk_backend/.venv/bin/hf download Qwen/Qwen2.5-7B-Instruct-GGUF qwen2.5-7b-instruct-q6_k.gguf --local-dir $MODELS_DIR"
  echo "  mv $MODELS_DIR/qwen2.5-7b-instruct-q6_k.gguf $LLM_TARGET"
  echo ""
  echo "Or download directly with curl from your preferred GGUF repository into:"
  echo "  $LLM_TARGET"
fi

echo "================================================================================"
echo "Model verification complete."
echo "================================================================================"
