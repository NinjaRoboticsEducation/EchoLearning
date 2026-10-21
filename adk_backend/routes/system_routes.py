import asyncio
import os
import signal
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from ..config import PROJECT_ROOT

router = APIRouter()

PIDS_DIR = PROJECT_ROOT / ".pids"


def terminate_pid_or_port(pid_path: Path | None, port: int, name: str) -> dict[str, Any]:
    """Gracefully terminates a process by PID file or listening port."""
    killed_pids: list[int] = []

    # 1. Check PID file
    if pid_path and pid_path.exists():
        try:
            pid = int(pid_path.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            killed_pids.append(pid)
        except Exception:
            pass
        pid_path.unlink(missing_ok=True)

    # 2. Check port with lsof if no PID or to ensure clean termination
    try:
        res = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if res.returncode == 0 and res.stdout.strip():
            for line in res.stdout.strip().split():
                try:
                    p = int(line)
                    if p != os.getpid() and p not in killed_pids:
                        os.kill(p, signal.SIGTERM)
                        killed_pids.append(p)
                except Exception:
                    pass
    except Exception:
        pass

    return {"service": name, "port": port, "terminatedPids": killed_pids}


async def delayed_exit():
    """Waits 0.5s for HTTP response to flush, then terminates backend and any residual frontend."""
    await asyncio.sleep(0.5)

    # Clean frontend PID if present
    frontend_pid_file = PIDS_DIR / "frontend.pid"
    if frontend_pid_file.exists():
        try:
            f_pid = int(frontend_pid_file.read_text().strip())
            os.kill(f_pid, signal.SIGTERM)
        except Exception:
            pass
        frontend_pid_file.unlink(missing_ok=True)

    # Exit backend process
    os.kill(os.getpid(), signal.SIGTERM)


@router.post("/system/shutdown")
async def shutdown_system():
    """Shuts down all local EchoSense servers (LLM, Whisper, Frontend, Backend) and releases RAM."""
    results = []

    # 1. Terminate Local LLM Server (llama-server: 8080)
    results.append(
        terminate_pid_or_port(PIDS_DIR / "llama.pid", 8080, "llama-server")
    )

    # 2. Terminate Local Whisper STT Server (whisper-server: 8081)
    results.append(
        terminate_pid_or_port(PIDS_DIR / "whisper.pid", 8081, "whisper-server")
    )

    # 3. Terminate Frontend Dev Server (vite: 5173)
    results.append(
        terminate_pid_or_port(PIDS_DIR / "frontend.pid", 5173, "vite-frontend")
    )

    # 4. Schedule backend self-termination after sending this response
    asyncio.create_task(delayed_exit())

    return {
        "status": "shutting_down",
        "message": "All local servers are terminating. System RAM and GPU resources released.",
        "services": results,
    }
