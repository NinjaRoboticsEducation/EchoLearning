#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDS_DIR="$PROJECT_ROOT/.pids"
LOGS_DIR="$PROJECT_ROOT/logs"
VENV_DIR="$PROJECT_ROOT/adk_backend/.venv"

mkdir -p "$PIDS_DIR" "$LOGS_DIR" "$PROJECT_ROOT/data/audio"
LOCK="$PIDS_DIR/launcher.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  owner_pid="$(head -n 1 "$LOCK/owner" 2>/dev/null | tr -d '[:space:]' || true)"
  owner_start="$(sed -n '2p' "$LOCK/owner" 2>/dev/null || true)"
  current_start=""
  if [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    current_start="$(ps -p "$owner_pid" -o lstart= 2>/dev/null || true)"
  fi
  if [[ -n "$current_start" && ( -z "$owner_start" || "$current_start" == "$owner_start" ) ]]; then
    echo "EchoLearning is already running (PID $owner_pid, lock at $LOCK)." >&2
    exit 1
  else
    echo "Removing stale launcher lock at $LOCK (previous PID ${owner_pid:-unknown} is not running)..."
    rm -rf "$LOCK"
    mkdir "$LOCK"
  fi
fi
rm -f "$PIDS_DIR/shutdown.requested"

children=()
service_names=()
service_logs=()
service_pidfiles=()

cleanup() {
  status=$?
  trap '' INT TERM
  trap - EXIT

  local tracked_pids=()
  local pid
  for pid in "${children[@]}"; do
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && (jobs -pr | grep -Fxq "$pid" || kill -0 "$pid" 2>/dev/null); then
      tracked_pids+=("$pid")
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  local i
  for i in "${!service_pidfiles[@]}"; do
    local pf="${service_pidfiles[$i]}"
    local name="${service_names[$i]}"
    if [[ -f "$pf" ]]; then
      local fpid
      fpid="$(head -n 1 "$pf" 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ "$fpid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$fpid" 2>/dev/null; then
        local cmd
        cmd="$(ps -ww -p "$fpid" -o command= 2>/dev/null || true)"
        if [[ "$name" != "llama-server" || "$cmd" == *llama-server* || "$cmd" == *start_llama.sh* ]]; then
          tracked_pids+=("$fpid")
          kill -TERM "$fpid" 2>/dev/null || true
        fi
      fi
    fi
  done

  local _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    local any_alive=false
    for pid in "${tracked_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        any_alive=true
        break
      fi
    done
    if [[ "$any_alive" = false ]]; then
      break
    fi
    sleep 0.13
  done

  for pid in "${tracked_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  for pid in "${children[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  local pf
  for pf in "${service_pidfiles[@]}"; do
    rm -f "$pf"
  done
  rm -f "$PIDS_DIR/shutdown.requested" "$LOCK/owner"
  rmdir "$LOCK" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n%s\n' "$$" "$(ps -p "$$" -o lstart=)" > "$LOCK/owner"

# Auto-clean stale EchoLearning PIDs before port checks
for stale_pf in "$PIDS_DIR/llama.pid" "$PIDS_DIR/whisper.pid" "$PIDS_DIR/backend.pid" "$PIDS_DIR/frontend.pid"; do
  if [[ -f "$stale_pf" ]]; then
    stale_pid="$(head -n 1 "$stale_pf" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$stale_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$stale_pid" 2>/dev/null; then
      stale_cmd="$(ps -ww -p "$stale_pid" -o command= 2>/dev/null || true)"
      if [[ "$stale_cmd" == *llama-server* || "$stale_cmd" == *whisper-server* || "$stale_cmd" == *uvicorn* || "$stale_cmd" == *vite* ]]; then
        echo "Cleaning up stale EchoLearning process (PID $stale_pid from $(basename "$stale_pf"))..."
        kill -TERM "$stale_pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          kill -0 "$stale_pid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$stale_pid" 2>/dev/null; then
          kill -KILL "$stale_pid" 2>/dev/null || true
        fi
      fi
    fi
    rm -f "$stale_pf"
  fi
done

for port in 8080 8081 3000 5173; do
  lpids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$lpids" ]]; then
    for lpid in $lpids; do
      lcmd="$(ps -ww -p "$lpid" -o command= 2>/dev/null || true)"
      if [[ "$lcmd" == *"$PROJECT_ROOT"* || "$lcmd" == *adk_backend.main:app* || "$lcmd" == *llama-server* || "$lcmd" == *whisper-server* ]]; then
        echo "Stopping orphaned EchoLearning process on port $port (PID $lpid)..."
        kill -TERM "$lpid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          kill -0 "$lpid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$lpid" 2>/dev/null; then
          kill -KILL "$lpid" 2>/dev/null || true
        fi
      fi
    done
  fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop the other instance or service first." >&2
    exit 1
  fi
done

echo "================================================================================"
echo "  Starting Echo Language Learning (Google ADK 2.x Local AI Edition)"
echo "================================================================================"

has_gguf=false
if compgen -G "$PROJECT_ROOT/models/*.gguf" >/dev/null 2>&1; then
  has_gguf=true
fi

# Verify Virtual Environment & Frontend deps
if [[ ! -x "$VENV_DIR/bin/python" || "$(cat "$VENV_DIR/.echo-location" 2>/dev/null || true)" != "$PROJECT_ROOT" || ! -f "$PROJECT_ROOT/node_modules/vite/bin/vite.js" ]]; then
  echo "Local runtime needs setup or repair."
  if [[ "$has_gguf" = true && -s "$PROJECT_ROOT/models/ggml-large-v3-turbo.bin" ]]; then
    ECHO_SETUP_RUNTIME_ONLY=1 "$PROJECT_ROOT/scripts/setup.sh"
  else
    "$PROJECT_ROOT/scripts/setup.sh"
  fi
fi

cd "$PROJECT_ROOT"

start_service() {
  local name="$1" logfile="$2" pidfile="$3"
  shift 3
  "$@" > "$logfile" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$pidfile"
  children+=("$pid")
  service_names+=("$name")
  service_logs+=("$logfile")
  service_pidfiles+=("$pidfile")
}

start_service "llama-server" "$LOGS_DIR/llama.log" "$PIDS_DIR/llama.pid" \
  "$PROJECT_ROOT/scripts/start_llama.sh"

start_service "whisper-server" "$LOGS_DIR/whisper.log" "$PIDS_DIR/whisper.pid" \
  "$PROJECT_ROOT/scripts/start_whisper.sh"

start_service "adk-backend" "$LOGS_DIR/backend.log" "$PIDS_DIR/backend.pid" \
  "$VENV_DIR/bin/python" -m uvicorn adk_backend.main:app --host 0.0.0.0 --port 3000

start_service "vite-frontend" "$LOGS_DIR/frontend.log" "$PIDS_DIR/frontend.pid" \
  node "$PROJECT_ROOT/node_modules/vite/bin/vite.js" --host 0.0.0.0 --strictPort

check_children() {
  local i
  for i in "${!children[@]}"; do
    local pid="${children[$i]}"
    local name="${service_names[$i]}"
    local pidfile="${service_pidfiles[$i]}"
    if jobs -pr | grep -Fxq "$pid" || kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    # Check if service was hot-swapped (e.g. POST /api/models/activate wrote a new PID)
    if [[ -f "$pidfile" ]]; then
      local new_pid
      new_pid="$(head -n 1 "$pidfile" 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ "$new_pid" =~ ^[1-9][0-9]*$ && "$new_pid" != "$pid" ]] && kill -0 "$new_pid" 2>/dev/null; then
        children[$i]="$new_pid"
        continue
      fi
    fi
    if [[ -f "$PIDS_DIR/shutdown.requested" ]]; then
      echo "🛑 Shutting down EchoLearning services..."
      exit 0
    fi
    local logfile="${service_logs[$i]}"
    echo "❌ Managed service '$name' (PID $pid) stopped unexpectedly." >&2
    if [[ -f "$logfile" ]]; then
      echo "--- Last 20 lines of $logfile ---" >&2
      tail -n 20 "$logfile" >&2 || true
    fi
    exit 1
  done
}

# Wait for Backend & Frontend Health Check (A01 fix: single-quoted heredoc)
echo "Waiting for services to become healthy..."
MAX_ATTEMPTS=60
ATTEMPT=0
HEALTHY=false

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  check_children
  if "$VENV_DIR/bin/python" - <<'PY' >/dev/null 2>&1
import httpx, sys
try:
    b = httpx.get("http://127.0.0.1:3000/api/health", timeout=3.0)
    f = httpx.get("http://127.0.0.1:5173/", timeout=3.0)
    ok = (
        b.status_code == 200
        and b.json().get("ready") is True
        and f.status_code == 200
    )
    sys.exit(0 if ok else 1)
except Exception:
    sys.exit(1)
PY
  then
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
  echo "⚠️  Services started, but health check is still warming up (check $LOGS_DIR)."
fi
echo ""
echo "  • React Frontend:     http://localhost:5173"
echo "  • Google ADK Backend: http://127.0.0.1:3000/api/health"
echo "  • Local LLM Server:   http://127.0.0.1:8080"
echo "  • Local Whisper STT:  http://127.0.0.1:8081 (Large-v3-Turbo)"
echo ""
echo "  Logs Directory:       $LOGS_DIR/"
echo "  To stop:              Press Ctrl+C or run ./scripts/stop.sh"
echo "================================================================================"

if [ "$HEALTHY" = true ] && command -v open >/dev/null 2>&1; then
  open "http://localhost:5173"
fi

while true; do
  check_children
  sleep 2
done
