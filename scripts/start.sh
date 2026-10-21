#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDS_DIR="$PROJECT_ROOT/.pids"
LOGS_DIR="$PROJECT_ROOT/logs"
VENV_DIR="$PROJECT_ROOT/adk_backend/.venv"

mkdir -p "$PIDS_DIR" "$LOGS_DIR"

cleanup() {
  echo ""
  echo "================================================================================"
  echo "Stopping all Echo Language Learning servers..."
  echo "================================================================================"

  for pid_file in "$PIDS_DIR"/*.pid; do
    if [ -f "$pid_file" ]; then
      pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "Stopping process $pid ($(basename "$pid_file" .pid))..."
        kill -TERM "$pid" 2>/dev/null || true
      fi
      rm -f "$pid_file"
    fi
  done

  # Double-check ports and clean up residual listeners
  for port in 8080 8081 3000 5173; do
    port_pids="$(lsof -ti :$port 2>/dev/null || true)"
    if [ -n "$port_pids" ]; then
      for p in $port_pids; do
        kill -TERM "$p" 2>/dev/null || true
      done
    fi
  done

  echo "✓ All local servers stopped. System RAM and resources released."
  exit 0
}

trap cleanup INT TERM EXIT

echo "================================================================================"
echo "  Starting Echo Language Learning (Google ADK 2.x Local AI Edition)"
echo "================================================================================"

# Verify Virtual Environment
if [ ! -d "$VENV_DIR" ]; then
  echo "Virtual environment missing. Running setup script..."
  "$PROJECT_ROOT/scripts/setup.sh"
fi

# 1. Start Local LLM Server (Port 8080)
if lsof -i :8080 -P -n >/dev/null 2>&1; then
  echo "✓ Local LLM server is already running on port 8080."
else
  echo "Starting Local LLM Server (llama-server Qwen3.5-9B on port 8080)..."
  "$PROJECT_ROOT/scripts/start_llama.sh" > "$LOGS_DIR/llama.log" 2>&1 &
  echo $! > "$PIDS_DIR/llama.pid"
fi

# 2. Start Local Whisper STT Server (Port 8081)
if lsof -i :8081 -P -n >/dev/null 2>&1; then
  echo "✓ Local Whisper server is already running on port 8081."
else
  echo "Starting Local Whisper STT Server (whisper-server on port 8081)..."
  "$PROJECT_ROOT/scripts/start_whisper.sh" > "$LOGS_DIR/whisper.log" 2>&1 &
  echo $! > "$PIDS_DIR/whisper.pid"
fi

# 3. Start Python Google ADK Backend (Port 3000)
if lsof -i :3000 -P -n >/dev/null 2>&1; then
  echo "✓ Python ADK Backend is already running on port 3000."
else
  echo "Starting Python Google ADK Backend (port 3000)..."
  (
    cd "$PROJECT_ROOT"
    "$VENV_DIR/bin/python" -m uvicorn adk_backend.main:app --host 127.0.0.1 --port 3000
  ) > "$LOGS_DIR/backend.log" 2>&1 &
  echo $! > "$PIDS_DIR/backend.pid"
fi

# 4. Start React Frontend Server (Port 5173)
if lsof -i :5173 -P -n >/dev/null 2>&1; then
  echo "✓ React Frontend Dev Server is already running on port 5173."
else
  echo "Starting React Frontend Dev Server (port 5173)..."
  (
    cd "$PROJECT_ROOT"
    npm run dev
  ) > "$LOGS_DIR/frontend.log" 2>&1 &
  echo $! > "$PIDS_DIR/frontend.pid"
fi

# 5. Wait for Backend Health Check
echo "Waiting for services to become healthy..."
MAX_ATTEMPTS=30
ATTEMPT=0
HEALTHY=false

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  if "$VENV_DIR/bin/python" -c "
import httpx, sys
try:
    r = httpx.get('http://127.0.0.1:3000/api/health', timeout=1.0)
    sys.exit(0 if r.status_code == 200 else 1)
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
echo "  To stop:              Press Ctrl+C or click 'Shut Down' in the Web UI"
echo "================================================================================"

# Open in default browser
if command -v open >/dev/null 2>&1; then
  open "http://localhost:5173"
fi

# Keep script running to monitor until Ctrl+C
while true; do
  # Check if backend or frontend died
  if [ -f "$PIDS_DIR/backend.pid" ]; then
    bpid="$(cat "$PIDS_DIR/backend.pid" 2>/dev/null || true)"
    if [ -n "$bpid" ] && ! kill -0 "$bpid" 2>/dev/null; then
      echo "Backend stopped. Exiting..."
      break
    fi
  fi
  sleep 2
done
