#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec ./adk_backend/.venv/bin/python -m adk_backend.mcp_server
