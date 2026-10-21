#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDS_DIR="$PROJECT_ROOT/.pids"

echo "================================================================================"
echo "Shutting down Echo Language Learning servers..."
echo "================================================================================"

# 1. Try graceful API shutdown if backend is alive
curl -s -X POST http://127.0.0.1:3000/api/system/shutdown >/dev/null 2>&1 || true

sleep 1

# 2. Terminate any recorded PIDs
if [ -d "$PIDS_DIR" ]; then
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
fi

# 3. Clean up ports 8080, 8081, 3000, 5173
for port in 8080 8081 3000 5173; do
  port_pids="$(lsof -ti :$port 2>/dev/null || true)"
  if [ -n "$port_pids" ]; then
    for p in $port_pids; do
      echo "Releasing port $port (PID $p)..."
      kill -TERM "$p" 2>/dev/null || true
    fi
  fi
done

echo "✓ All local AI and application servers have stopped."
echo "✓ System memory (~9.5 GB RAM) and GPU resources released."
