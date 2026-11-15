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
  echo "Setup currently supports macOS." >&2
  exit 1
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
  brew install llama.cpp
fi

if command -v whisper-server >/dev/null 2>&1 || [ -x "/usr/local/bin/whisper-server" ] || [ -x "/opt/homebrew/bin/whisper-server" ]; then
  echo "✓ whisper-server executable located"
else
  echo "whisper-server not found in standard path. Attempting brew install whisper-cpp..."
  brew install whisper-cpp
fi

# 5. Setup Python Virtual Environment
VENV_DIR="$PROJECT_ROOT/adk_backend/.venv"
echo ""
echo "Configuring Python virtual environment at $VENV_DIR..."
if [[ ! -x "$VENV_DIR/bin/python" || "$(cat "$VENV_DIR/.echo-location" 2>/dev/null || true)" != "$PROJECT_ROOT" ]]; then
  rm -rf "$VENV_DIR"
  python3 -m venv "$VENV_DIR"
  echo "✓ Virtual environment created."
fi

echo "Updating pip and installing certifi Root CA certificates..."
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel certifi

# Fix macOS Python SSL certificate verify issue
CERT_PATH="$("$VENV_DIR/bin/python" -m certifi)"
echo "✓ CA Certificates verified at: $CERT_PATH"

echo "Installing backend requirements..."
"$VENV_DIR/bin/python" -m pip install -r "$PROJECT_ROOT/adk_backend/requirements.txt"
echo "✓ Python backend dependencies installed."

# 6. Setup Frontend Dependencies
echo ""
echo "Installing Node.js frontend dependencies..."
cd "$PROJECT_ROOT"
npm ci
npm run build
echo "✓ Frontend packages installed."

# 7. Model Verification & Downloads
echo ""
echo "Verifying local AI models..."
mkdir -p "$PROJECT_ROOT/models"
chmod +x "$PROJECT_ROOT/scripts/"*.sh

if [[ "${ECHO_SETUP_RUNTIME_ONLY:-0}" != 1 ]]; then
  "$SCRIPT_DIR/download_models.sh"
fi
printf '%s\n' "$PROJECT_ROOT" > "$VENV_DIR/.echo-location"

# 8. Setup runtime directories
mkdir -p "$PROJECT_ROOT/.pids" "$PROJECT_ROOT/logs"

echo ""
echo "================================================================================"
echo "🎉 Setup Complete! You are ready to launch Echo Language Learning."
echo ""
echo "To launch the entire application with one command:"
echo "  ./scripts/start.sh"
echo "================================================================================"
