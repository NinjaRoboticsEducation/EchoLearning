#!/usr/bin/env bash
set -euo pipefail
trap 'echo "❌ EchoLearning setup failed at line $LINENO (command: $BASH_COMMAND)." >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NON_INTERACTIVE_FLAG=""
MODELS_ARGS=()

usage() {
  cat <<'EOF'
EchoLearning Automated Environment Setup (macOS)

Usage:
  ./setup.sh [OPTIONS]
  ./scripts/setup.sh [OPTIONS]

Options:
  --non-interactive, --default  Use default/recommended model (Qwen3.5-9B-Q6_K) without prompting
  --models <list>               Comma-separated model IDs or menu numbers (e.g. "1,3" or "qwen3.5-4b-q6_k")
  -h, --help                    Show this help message and exit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --non-interactive|--default)
      NON_INTERACTIVE_FLAG="--non-interactive"
      shift
      ;;
    --models)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --models requires a value." >&2
        exit 1
      fi
      MODELS_ARGS=("--models" "$2")
      shift 2
      ;;
    *)
      echo "Error: Unknown option '$1'. Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

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

# Verify Node >= 20.19.0 for Vite
if ! node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 20 || (maj === 20 && min < 19)) process.exit(1);
'; then
  echo "❌ Node.js $(node -v) is too old. Vite requires Node >= 20.19.0." >&2
  exit 1
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
  echo "Installing whisper-cpp via brew..."
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

CERT_PATH="$("$VENV_DIR/bin/python" -m certifi)"
echo "✓ CA Certificates verified at: $CERT_PATH"

echo "Installing backend requirements..."
"$VENV_DIR/bin/python" -m pip install -r "$PROJECT_ROOT/adk_backend/requirements.txt"
printf '%s\n' "$PROJECT_ROOT" > "$VENV_DIR/.echo-location"
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
  dl_args=()
  if [[ -n "${NON_INTERACTIVE_FLAG:-}" ]]; then
    dl_args+=("$NON_INTERACTIVE_FLAG")
  fi
  if [[ ${#MODELS_ARGS[@]} -gt 0 ]]; then
    dl_args+=("${MODELS_ARGS[@]}")
  fi
  if [[ ${#dl_args[@]} -gt 0 ]]; then
    "$SCRIPT_DIR/download_models.sh" "${dl_args[@]}"
  else
    "$SCRIPT_DIR/download_models.sh"
  fi
fi
printf '%s\n' "$PROJECT_ROOT" > "$VENV_DIR/.echo-location"

# 8. Setup runtime & durable data directories
mkdir -p "$PROJECT_ROOT/.pids" "$PROJECT_ROOT/logs" "$PROJECT_ROOT/data/audio"

echo ""
echo "================================================================================"
echo "🎉 Setup Complete! You are ready to launch Echo Language Learning."
echo ""
echo "To launch the entire application with one command:"
echo "  ./scripts/start_all.sh"
echo "================================================================================"
