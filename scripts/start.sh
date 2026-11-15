#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDS_DIR="$PROJECT_ROOT/.pids"
LOGS_DIR="$PROJECT_ROOT/logs"
VENV_DIR="$PROJECT_ROOT/adk_backend/.venv"

mkdir -p "$PIDS_DIR" "$LOGS_DIR"
LOCK="$PIDS_DIR/launcher.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "EchoLearning already has a launcher lock at $LOCK." >&2
  exit 1
fi
children=()
cleanup() {
  status=$?
  trap - EXIT INT TERM
  for pid in "${children[@]}"; do
    # Bash jobs are scoped to this launcher, unlike PIDs read from disk.
    if jobs -pr | grep -Fxq "$pid"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
  rm -f "$LOCK/owner"
  rmdir "$LOCK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n%s\n' "$$" "$(ps -p "$$" -o lstart=)" > "$LOCK/owner"

for port in 8080 8081 3000 5173; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop the other instance or service first." >&2
    exit 1
  fi
done

echo "================================================================================"
echo "  Starting Echo Language Learning (Google ADK 2.x Local AI Edition)"
echo "================================================================================"

# Verify Virtual Environment
if [[ ! -x "$VENV_DIR/bin/python" || "$(cat "$VENV_DIR/.echo-location" 2>/dev/null || true)" != "$PROJECT_ROOT" || ! -f "$PROJECT_ROOT/node_modules/vite/bin/vite.js" ]]; then
  echo "Local runtime needs setup or repair."
  if [[ -s "$PROJECT_ROOT/models/Qwen3.5-9B-Q6_K.gguf" && -s "$PROJECT_ROOT/models/ggml-large-v3-turbo.bin" ]]; then
    ECHO_SETUP_RUNTIME_ONLY=1 "$PROJECT_ROOT/scripts/setup.sh"
  else
    "$PROJECT_ROOT/scripts/setup.sh"
  fi
fi

cd "$PROJECT_ROOT"
"$PROJECT_ROOT/scripts/start_llama.sh" > "$LOGS_DIR/llama.log" 2>&1 &
children+=("$!")
"$PROJECT_ROOT/scripts/start_whisper.sh" > "$LOGS_DIR/whisper.log" 2>&1 &
children+=("$!")
"$VENV_DIR/bin/python" -m uvicorn adk_backend.main:app --host 127.0.0.1 --port 3000 > "$LOGS_DIR/backend.log" 2>&1 &
children+=("$!")
node "$PROJECT_ROOT/node_modules/vite/bin/vite.js" --host 127.0.0.1 --strictPort > "$LOGS_DIR/frontend.log" 2>&1 &
children+=("$!")

check_children() {
  for pid in "${children[@]}"; do
    if ! jobs -pr | grep -Fxq "$pid"; then
      echo "A managed process stopped. See $LOGS_DIR." >&2
      exit 1
    fi
  done
}

# 5. Wait for Backend Health Check
echo "Waiting for services to become healthy..."
MAX_ATTEMPTS=30
ATTEMPT=0
HEALTHY=false

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  check_children
  if "$VENV_DIR/bin/python" -c "
import httpx, sys
try:
    r = httpx.get('http://127.0.0.1:3000/api/health', timeout=5.0)
    sys.exit(0 if r.status_code == 200 and r.json().get("ready") is True else 1)
except Exception:
    sys.exit(1)
" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 1
  ATTEMPT=$((ATTEMPT + 1))
done

echo ""
echo "================================================================================"
if [ "$HEALTHY" = true ]; then
  echo "🚀 Echo Language Learning is READY!"
else
  echo "⚠️ Services started, but health check is still warming up."
fi
echo ""
echo "  • React Frontend:     http://localhost:5173"
echo "  • Google ADK Backend: http://127.0.0.1:3000/api/health"
echo "  • Local LLM Server:   http://127.0.0.1:8080 (Qwen3.5-9B)"
echo "  • Local Whisper STT:  http://127.0.0.1:8081 (Large-v3-Turbo)"
echo ""
echo "  Logs Directory:       $LOGS_DIR/"
echo "  To stop:              Press Ctrl+C or run ./scripts/stop.sh"
echo "================================================================================"

# Open in default browser
if command -v open >/dev/null 2>&1; then
  open "http://localhost:5173"
fi

while true; do
  check_children
  sleep 2
done
