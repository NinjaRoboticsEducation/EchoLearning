#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pids_dir="$root/.pids"
lock_dir="$pids_dir/launcher.lock"
owner="$lock_dir/owner"

mkdir -p "$pids_dir"
printf '1\n' > "$pids_dir/shutdown.requested"

terminate_pid() {
  local pid="$1"
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.15
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

stopped_any=false

if [[ -f "$owner" ]]; then
  {
    read -r pid || true
    read -r started || true
  } < "$owner"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
    cur_start="$(ps -p "$pid" -o lstart= 2>/dev/null || true)"
    cur_cmd="$(ps -ww -p "$pid" -o command= 2>/dev/null || true)"
    if [[ ( -z "$started" || "$cur_start" == "$started" ) && "$cur_cmd" == *scripts/start.sh* ]]; then
      terminate_pid "$pid"
      stopped_any=true
    fi
  fi
fi

for pf in "$pids_dir/llama.pid" "$pids_dir/whisper.pid" "$pids_dir/backend.pid" "$pids_dir/frontend.pid"; do
  if [[ -f "$pf" ]]; then
    fpid="$(head -n 1 "$pf" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$fpid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$fpid" 2>/dev/null; then
      fcmd="$(ps -ww -p "$fpid" -o command= 2>/dev/null || true)"
      if [[ "$fcmd" == *"$root"* || "$fcmd" == *llama-server* || "$fcmd" == *whisper-server* || "$fcmd" == *adk_backend.main:app* || "$fcmd" == *vite* ]]; then
        terminate_pid "$fpid"
        stopped_any=true
      fi
    fi
    rm -f "$pf"
  fi
done

for port in 8080 8081 3000 5173; do
  lpids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$lpids" ]]; then
    for lpid in $lpids; do
      lcmd="$(ps -ww -p "$lpid" -o command= 2>/dev/null || true)"
      if [[ "$lcmd" == *"$root"* || "$lcmd" == *llama-server* || "$lcmd" == *whisper-server* || "$lcmd" == *adk_backend.main:app* ]]; then
        terminate_pid "$lpid"
        stopped_any=true
      fi
    done
  fi
done

rm -f "$owner"
rmdir "$lock_dir" 2>/dev/null || true
rm -f "$pids_dir/shutdown.requested"

if [[ "$stopped_any" = true ]]; then
  echo "Stopped EchoLearning services and cleaned up launcher state."
else
  echo "No managed EchoLearning processes were running; cleaned up stale state."
fi
