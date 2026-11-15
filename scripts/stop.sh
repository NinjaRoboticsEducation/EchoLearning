#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
owner="$root/.pids/launcher.lock/owner"
if [[ ! -f "$owner" ]]; then
  echo "No managed EchoLearning launcher is running."
  exit 0
fi
{
  read -r pid
  read -r started
} < "$owner"
if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] ||
   [[ -z "$started" || "$(ps -p "$pid" -o lstart=)" != "$started" ]] ||
   [[ "$(ps -ww -p "$pid" -o command=)" != *scripts/start.sh* ]]; then
  echo "Launcher identity could not be verified. Inspect $owner before removing a stale lock." >&2
  exit 1
fi
kill -TERM "$pid"
echo "Requested shutdown of the EchoLearning launcher and its children."
