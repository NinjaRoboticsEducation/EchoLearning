#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "================================================================================"
echo "  Echo Language Learning — Automated Environment Setup"
echo "  Google ADK 2.x + Local AI Architecture (macOS)"
echo "================================================================================"

# 1. Verify macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "⚠️ Warning: This setup script is optimized for macOS (Intel or Apple Silicon)."
fi

ARCH="$(uname -m)"
echo "✓ System Architecture: $ARCH"

# 2. Check Package Manager (Homebrew)
if command -v brew >/dev/null 2>&1; then
  echo "✓ Homebrew is installed"
else
  echo "❌ Homebrew is not installed. Please install Homebrew from https://brew.sh/"
  exit 1
fi

# 3. Check System Dependencies (ffmpeg, python3, node)
echo "Checking required system dependencies..."

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Installing ffmpeg via brew..."
  brew install ffmpeg
else
  echo "✓ ffmpeg is installed"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing python3 via brew..."
  brew install python@3.12
else
  PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  echo "✓ Python $PY_VER is installed"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Installing node via brew..."
  brew install node
else
  NODE_VER="$(node -v)"
  echo "✓ Node $NODE_VER is installed"
fi

# 4. Check llama.cpp and whisper.cpp binaries
if command -v llama-server >/dev/null 2>&1 || [ -x "/usr/local/bin/llama-server" ] || [ -x "/opt/homebrew/bin/llama-server" ]; then
  echo "✓ llama-server executable located"
else
  echo "Installing llama.cpp via brew..."
  brew install llama.cpp || echo "Please install llama.cpp via Homebrew or build from source."
fi

if command -v whisper-server >/dev/null 2>&1 || [ -x "/usr/local/bin/whisper-server" ] || [ -x "/opt/homebrew/bin/whisper-server" ]; then
  echo "✓ whisper-server executable located"
else
  echo "whisper-server not found in standard path. Attempting brew install whisper-cpp..."
  brew install whisper-cpp || echo "Please ensure whisper-server is compiled or in PATH."
fi

# 5. Setup Python Virtual Environment
VENV_DIR="$PROJECT_ROOT/adk_backend/.venv"
echo ""
echo "Configuring Python virtual environment at $VENV_DIR..."
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
  echo "✓ Virtual environment created."
fi

echo "Updating pip and installing certifi Root CA certificates..."
"$VENV_DIR/bin/pip" install --upgrade pip setuptools wheel certifi

# Fix macOS Python SSL certificate verify issue
CERT_PATH="$("$VENV_DIR/bin/python" -m certifi)"
echo "✓ CA Certificates verified at: $CERT_PATH"

echo "Installing backend requirements..."
"$VENV_DIR/bin/pip" install -r "$PROJECT_ROOT/adk_backend/requirements.txt"
echo "✓ Python backend dependencies installed."

# 6. Setup Frontend Dependencies
echo ""
echo "Installing Node.js frontend dependencies..."
cd "$PROJECT_ROOT"
npm install --legacy-peer-deps
echo "✓ Frontend packages installed."

# 7. Model Verification & Downloads
echo ""
echo "Verifying local AI models..."
mkdir -p "$PROJECT_ROOT/models"
chmod +x "$PROJECT_ROOT/scripts/"*.sh

WHISPER_MODEL="$PROJECT_ROOT/models/ggml-large-v3-turbo.bin"
LLM_MODEL="$PROJECT_ROOT/models/Qwen3.5-9B-Q6_K.gguf"

if [ -f "$WHISPER_MODEL" ]; then
  echo "✓ Whisper STT model found: $WHISPER_MODEL"
else
  echo "Downloading Whisper Large-v3-Turbo (~1.6 GB)..."
  curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" -o "$WHISPER_MODEL"
  echo "✓ Whisper STT model downloaded."
fi

if [ -f "$LLM_MODEL" ]; then
  echo "✓ Qwen3.5-9B LLM model found: $LLM_MODEL"
else
  echo ""
  echo "Notice: $LLM_MODEL not detected."
  echo "Please run './scripts/download_models.sh' to download the Qwen3.5 GGUF model (~7.5 GB)."
fi

# 8. Setup runtime directories
mkdir -p "$PROJECT_ROOT/.pids" "$PROJECT_ROOT/logs"

echo ""
echo "================================================================================"
echo "🎉 Setup Complete! You are ready to launch Echo Language Learning."
echo ""
echo "To launch the entire application with one command:"
echo "  ./scripts/start.sh"
echo "================================================================================"
