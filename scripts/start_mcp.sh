#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -x "./adk_backend/.venv/bin/python" ]]; then
  exec ./adk_backend/.venv/bin/python -m adk_backend.mcp_server "$@"
elif [[ -x "./.venv/bin/python" ]]; then
  exec ./.venv/bin/python -m adk_backend.mcp_server "$@"
else
  exec python3 -m adk_backend.mcp_server "$@"
fi
