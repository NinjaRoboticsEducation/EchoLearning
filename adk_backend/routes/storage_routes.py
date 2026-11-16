"""Durable SQLite storage, model management, Tailscale/MCP status, and shutdown routes."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import mimetypes
import os
import platform
import shutil
import signal
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import db
from ..config import (
    API_PORT,
    LLAMA_SERVER_URL,
    LOGS_DIR,
    MODEL_MANIFEST_PATH,
    MODELS_DIR,
    PIDS_DIR,
    PROJECT_ROOT,
    WHISPER_SERVER_URL,
    get_data_dir,
)
from ..schemas.transcript_schemas import SegmentUpdateRequest
from ..tools.tokenizer_tools import tokenize_sentence

router = APIRouter(prefix="/api", tags=["Storage & System"])

MODEL_CATALOG: list[dict[str, Any]] = [
    {
        "id": "qwen3.5-4b-q6_k",
        "profileId": "qwen3.5-4b-q6_k",
        "name": "Qwen3.5-4B-GGUF:Q6_K (Fast / Lightweight)",
        "displayName": "Qwen3.5-4B-GGUF:Q6_K",
        "filename": "Qwen3.5-4B-Q6_K.gguf",
        "sizeGb": 3.28,
        "sizeBytes": 3521873183,
        "minRamGb": 8,
        "tier": "Tier 1: Entry & Minimum Baseline",
        "sha256": "fdedd781c9ce676ab66b018ca247ff78e8a33c98098a822c1e2d5075e7718f66",
    },
    {
        "id": "qwen3.5-9b-q4_k_m",
        "profileId": "qwen3.5-9b-q4_k_m",
        "name": "Qwen3.5-9B-GGUF:Q4_K_M (Balanced 16 GB)",
        "displayName": "Qwen3.5-9B-GGUF:Q4_K_M",
        "filename": "Qwen3.5-9B-Q4_K_M.gguf",
        "sizeGb": 5.29,
        "sizeBytes": 5680094085,
        "minRamGb": 16,
        "tier": "Tier 1+: Balanced 16 GB Baseline",
        "sha256": "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    },
    {
        "id": "qwen3.5-9b-q6_k",
        "profileId": "qwen3.5-9b-q6_k",
        "name": "Qwen3.5-9B-GGUF:Q6_K (Standard High-Precision)",
        "displayName": "Qwen3.5-9B-GGUF:Q6_K",
        "filename": "Qwen3.5-9B-Q6_K.gguf",
        "sizeGb": 6.95,
        "sizeBytes": 7458301152,
        "minRamGb": 16,
        "tier": "Tier 2: Standard Recommended",
        "sha256": "91898433cf5ce0a8f45516a4cc3e9343b6e01d052d01f684309098c66a326c59",
    },
    {
        "id": "qwen3.5-27b-q4_k_m",
        "profileId": "qwen3.5-27b-q4_k_m",
        "name": "Qwen3.5-27B-GGUF:Q4_K_M (Pro Dense)",
        "displayName": "Qwen3.5-27B-GGUF:Q4_K_M",
        "filename": "Qwen3.5-27B-Q4_K_M.gguf",
        "sizeGb": 15.59,
        "sizeBytes": 16739634381,
        "minRamGb": 32,
        "tier": "Tier 3: High-Memory Pro",
        "sha256": "84b5f7f112156d63836a01a69dc3f11a6ba63b10a23b8ca7a7efaf52d5a2d806",
    },
    {
        "id": "qwen3.5-35b-a3b-q4_k_m",
        "profileId": "qwen3.5-35b-a3b-q4_k_m",
        "name": "Qwen3.5-35B-A3B-GGUF:Q4_K_M (Ultra MoE)",
        "displayName": "Qwen3.5-35B-A3B-GGUF:Q4_K_M",
        "filename": "Qwen3.5-35B-A3B-Q4_K_M.gguf",
        "sizeGb": 20.50,
        "sizeBytes": 22011707392,
        "minRamGb": 32,
        "tier": "Tier 4: Workstation MoE",
        "sha256": "3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375",
    },
]

_model_switch_lock = asyncio.Lock()


class ModelActivateRequest(BaseModel):
    modelId: str | None = None
    profileId: str | None = None


class SystemSettingsPatch(BaseModel):
    tailscale_enabled: bool | None = None
    tailscaleEnabled: bool | None = None
    mcp_http_enabled: bool | None = None
    mcpHttpEnabled: bool | None = None
    mcp_stdio_enabled: bool | None = None
    mcpStdioEnabled: bool | None = None
    active_model_id: str | None = None
    activeModelId: str | None = None


def _detect_hardware() -> dict[str, Any]:
    arch = platform.machine() or "x86_64"
    ram_gb = 16
    if platform.system() == "Darwin":
        try:
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True, timeout=2.0).strip()
            ram_gb = max(1, int(int(out) / (1024**3)))
        except Exception:
            pass
    return {
        "arch": arch,
        "ramGb": ram_gb,
        "gpuOffload": arch == "arm64",
    }


def _read_manifest() -> dict[str, Any]:
    if MODEL_MANIFEST_PATH.is_file():
        try:
            data = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def _write_manifest(active_model_id: str, models_list: list[dict[str, Any]]) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    installed = [m["id"] for m in models_list if m.get("installed")]
    manifest = {
        "active_model": active_model_id,
        "activeProfileId": active_model_id,
        "installed_models": installed,
        "whisper_model": "ggml-large-v3-turbo.bin",
        "updated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    tmp = MODEL_MANIFEST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, MODEL_MANIFEST_PATH)


def get_model_catalog_state() -> dict[str, Any]:
    """Builds the combined model catalog + installed/active status."""
    hw = _detect_hardware()
    ram_gb = hw["ramGb"]
    manifest = _read_manifest()
    settings = db.get_settings()

    preferred_active = (
        settings.get("active_model_id")
        or manifest.get("active_model")
        or manifest.get("activeProfileId")
        or "qwen3.5-9b-q6_k"
    )

    known_filenames: set[str] = set()
    items: list[dict[str, Any]] = []
    for entry in MODEL_CATALOG:
        known_filenames.add(entry["filename"])
        model_path = MODELS_DIR / entry["filename"]
        installed = model_path.is_file() and model_path.stat().st_size > 0
        actual_size_bytes = model_path.stat().st_size if installed else entry["sizeBytes"]
        recommended = (
            (entry["id"] == "qwen3.5-9b-q6_k")
            or (ram_gb <= 16 and entry["id"] in ("qwen3.5-4b-q6_k", "qwen3.5-9b-q4_k_m"))
            or (ram_gb >= 32 and hw["arch"] == "arm64" and entry["id"] in ("qwen3.5-27b-q4_k_m", "qwen3.5-35b-a3b-q4_k_m"))
        )
        items.append(
            {
                "id": entry["id"],
                "profileId": entry["profileId"],
                "name": entry["name"],
                "displayName": entry["displayName"],
                "filename": entry["filename"],
                "sizeGb": round(actual_size_bytes / (1024**3), 2) if installed else entry["sizeGb"],
                "sizeBytes": actual_size_bytes,
                "minRamGb": entry["minRamGb"],
                "tier": entry["tier"],
                "installed": installed,
                "active": False,
                "recommended": recommended,
            }
        )

    # Auto-discover custom GGUF files placed in models/
    if MODELS_DIR.is_dir():
        for gguf in sorted(MODELS_DIR.glob("*.gguf")):
            if gguf.name in known_filenames or gguf.name.startswith("."):
                continue
            stat = gguf.stat()
            custom_id = gguf.stem.lower()
            items.append(
                {
                    "id": custom_id,
                    "profileId": custom_id,
                    "name": gguf.stem,
                    "displayName": gguf.stem,
                    "filename": gguf.name,
                    "sizeGb": round(stat.st_size / (1024**3), 2),
                    "sizeBytes": stat.st_size,
                    "minRamGb": 16,
                    "tier": "Custom Local GGUF",
                    "installed": True,
                    "active": False,
                    "recommended": False,
                }
            )

    active_id = preferred_active
    installed_ids = [m["id"] for m in items if m["installed"]]
    if installed_ids and active_id not in installed_ids:
        active_id = installed_ids[0]

    for m in items:
        m["active"] = m["id"] == active_id

    return {
        "activeModelId": active_id,
        "activeProfileId": active_id,
        "status": "ready",
        "hardware": hw,
        "models": items,
    }


async def _is_llama_online() -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"{LLAMA_SERVER_URL}/models")
            return r.status_code == 200
    except Exception:
        return False


async def _is_whisper_online() -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"{WHISPER_SERVER_URL}/")
            return r.status_code in (200, 404, 405)
    except Exception:
        return False


def _stop_pid_file(pid_path: Path, *expected_cmd_substrs: str) -> bool:
    if not pid_path.is_file():
        return False
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip().splitlines()[0])
    except Exception:
        return False
    try:
        cmd = subprocess.check_output(["ps", "-ww", "-p", str(pid), "-o", "command="], text=True).strip()
        if expected_cmd_substrs and not any(sub in cmd for sub in expected_cmd_substrs):
            return False
        os.kill(pid, signal.SIGTERM)
        for _ in range(20):
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except OSError:
                break
        else:
            os.kill(pid, signal.SIGKILL)
        pid_path.unlink(missing_ok=True)
        return True
    except Exception:
        pid_path.unlink(missing_ok=True)
        return False


async def _restart_llama_server(model_filename: str, model_id: str) -> tuple[bool, str]:
    """Stops owned llama-server if running and starts the selected model."""
    start_script = PROJECT_ROOT / "scripts" / "start_llama.sh"
    model_path = MODELS_DIR / model_filename
    if not start_script.is_file() or not model_path.is_file():
        return False, "start_llama.sh or model file not found."

    llama_pid_file = PIDS_DIR / "llama.pid"
    _stop_pid_file(llama_pid_file, "llama-server", "start_llama.sh")

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    PIDS_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = open(LOGS_DIR / "llama.log", "ab")
    try:
        proc = subprocess.Popen(
            ["bash", str(start_script), "--model", str(model_path), "--alias", model_id],
            cwd=str(PROJECT_ROOT),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        llama_pid_file.write_text(f"{proc.pid}\n", encoding="utf-8")
    finally:
        log_handle.close()

    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False, f"llama-server exited early with code {proc.returncode}"
        if await _is_llama_online():
            return True, "llama-server restarted and ready."
        await asyncio.sleep(1.0)
    return False, "Timed out waiting for llama-server /v1/models readiness."


def _detect_tailscale_status() -> dict[str, Any]:
    ts_bin = shutil.which("tailscale")
    if not ts_bin:
        mac_app_bin = Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
        if mac_app_bin.is_file():
            ts_bin = str(mac_app_bin)

    settings = db.get_settings()
    enabled = bool(settings.get("tailscale_enabled", False))
    if not ts_bin:
        return {
            "installed": False,
            "running": False,
            "ip": "",
            "hostname": "",
            "enabled": enabled,
        }

    try:
        out = subprocess.check_output(
            [ts_bin, "status", "--json"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
        )
        data = json.loads(out)
        backend_state = data.get("BackendState", "")
        self_node = data.get("Self") or {}
        ips = self_node.get("TailscaleIPs") or []
        ipv4 = next((ip for ip in ips if "." in ip), ips[0] if ips else "")
        dns_name = str(self_node.get("DNSName") or "").rstrip(".")
        return {
            "installed": True,
            "running": backend_state == "Running",
            "ip": ipv4,
            "hostname": dns_name,
            "enabled": enabled,
        }
    except Exception:
        return {
            "installed": True,
            "running": False,
            "ip": "",
            "hostname": "",
            "enabled": enabled,
        }


def _build_uninstall_info() -> dict[str, Any]:
    """Builds non-blocking component detection and CLI uninstaller commands."""
    data_dir = get_data_dir()
    models_present = MODELS_DIR.is_dir() and (
        any(MODELS_DIR.glob("*.gguf")) or any(MODELS_DIR.glob("*.bin"))
    )
    return {
        "scriptPath": "./uninstall.sh",
        "components": {
            "modelsPresent": models_present,
            "venvPresent": (PROJECT_ROOT / "adk_backend" / ".venv").is_dir(),
            "nodeModulesPresent": (PROJECT_ROOT / "node_modules").is_dir(),
            "dataPresent": (data_dir / "echolearning.sqlite3").is_file(),
        },
        "commands": {
            "interactive": "./uninstall.sh",
            "dryRun": "./uninstall.sh --dry-run --all",
            "keepData": "./uninstall.sh --all --keep-data",
            "fullReset": "./uninstall.sh --all",
            "completeWithBrew": "./uninstall.sh --all --brew --remove-app-dir",
        },
    }


async def build_system_status() -> dict[str, Any]:
    llama_ready, whisper_ready = await asyncio.gather(_is_llama_online(), _is_whisper_online())
    settings = db.get_settings()
    catalog = get_model_catalog_state()
    ts = _detect_tailscale_status()
    counts = db.get_counts()
    active_id = catalog["activeModelId"]
    active_entry = next((m for m in catalog["models"] if m["id"] == active_id), None)
    active_label = active_entry["displayName"] if active_entry else active_id

    ts_host = (
        ts["ip"]
        if ts.get("running") and ts.get("ip") and ts.get("enabled")
        else "127.0.0.1"
    )

    return {
        "llamaReady": llama_ready,
        "whisperReady": whisper_ready,
        "sqliteReady": True,
        "activeModel": active_label,
        "activeModelId": active_id,
        "tailscale": ts,
        "mcp": {
            "stdioEnabled": bool(settings.get("mcp_stdio_enabled", True)),
            "httpEnabled": bool(settings.get("mcp_http_enabled", True)),
            "stdioCommand": "./scripts/start_mcp.sh",
            "httpEndpoint": f"http://{ts_host}:{API_PORT}/mcp",
        },
        "counts": counts,
        "settings": settings,
        "uninstall": _build_uninstall_info(),
    }


def _schedule_shutdown_exit() -> None:
    """Terminates child services and schedules process shutdown."""
    try:
        PIDS_DIR.mkdir(parents=True, exist_ok=True)
        (PIDS_DIR / "shutdown.requested").write_text("1\n", encoding="utf-8")
    except OSError:
        pass

    def _stop_services_and_launcher() -> None:
        _stop_pid_file(PIDS_DIR / "llama.pid", "llama-server")
        _stop_pid_file(PIDS_DIR / "whisper.pid", "whisper-server")
        _stop_pid_file(PIDS_DIR / "frontend.pid", "vite")
        owner_file = PIDS_DIR / "launcher.lock" / "owner"
        if owner_file.is_file():
            try:
                lines = owner_file.read_text(encoding="utf-8").splitlines()
                if lines:
                    pid = int(lines[0])
                    cmd = subprocess.check_output(
                        ["ps", "-ww", "-p", str(pid), "-o", "command="],
                        text=True,
                    ).strip()
                    if "scripts/start.sh" in cmd:
                        os.kill(pid, signal.SIGTERM)
            except Exception:
                pass

    if not os.getenv("PYTEST_CURRENT_TEST"):
        def _exit_soon() -> None:
            # Allow HTTP 200 OK to flush through Vite (:5173) to the browser first
            time.sleep(0.35)
            _stop_services_and_launcher()
            os.kill(os.getpid(), signal.SIGTERM)

        threading.Thread(target=_exit_soon, daemon=True).start()
    else:
        _stop_services_and_launcher()


# ---------------------------------------------------------------------------
# Materials Endpoints
# ---------------------------------------------------------------------------


@router.get("/materials")
async def api_list_materials():
    return {"materials": db.list_materials()}


@router.get("/materials/{video_id}")
async def api_get_material(video_id: str):
    mat = db.get_material(video_id)
    if not mat:
        raise HTTPException(status_code=404, detail="Material not found.")
    return mat


@router.post("/materials")
async def api_save_material(payload: dict[str, Any]):
    try:
        saved = db.save_material(payload)
        return saved
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/materials/{video_id}/segments/{segment_id}")
async def api_update_material_segment(
    video_id: str,
    segment_id: str,
    req: SegmentUpdateRequest,
):
    mat = db.get_material(video_id)
    if not mat:
        raise HTTPException(status_code=404, detail="Material not found.")
    clean_text = req.text.strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Segment text is required.")

    tokens_list: list[dict[str, Any]] | None
    if req.tokens is not None:
        tokens_list = [t.model_dump() for t in req.tokens]
    else:
        tokens_list = tokenize_sentence(clean_text, mat.get("language", "en"))

    updated = db.update_material_segment(video_id, segment_id, clean_text, tokens_list)
    if not updated:
        raise HTTPException(status_code=404, detail="Segment not found.")
    return updated


@router.delete("/materials/{video_id}")
async def api_delete_material(video_id: str):
    if not db.delete_material(video_id):
        raise HTTPException(status_code=404, detail="Material not found.")
    return {"status": "deleted", "videoId": video_id}


# ---------------------------------------------------------------------------
# Vocabulary Endpoints
# ---------------------------------------------------------------------------


@router.get("/vocabulary")
async def api_list_vocabulary(language: str = Query(default="")):
    return {"vocabulary": db.list_vocab_items(language)}


@router.post("/vocabulary")
async def api_save_vocabulary(payload: dict[str, Any]):
    try:
        return db.save_vocab_item(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/vocabulary/{item_id}")
async def api_delete_vocabulary_item(item_id: str):
    if not db.delete_vocab_item(item_id):
        raise HTTPException(status_code=404, detail="Vocabulary item not found.")
    return {"status": "deleted", "id": item_id}


@router.delete("/vocabulary")
async def api_clear_vocabulary():
    count = db.clear_vocab_items()
    return {"status": "cleared", "deletedCount": count}


# ---------------------------------------------------------------------------
# History & Audio Endpoints
# ---------------------------------------------------------------------------


@router.get("/history")
async def api_list_history():
    return {"history": db.list_history_reports()}


@router.post("/history")
async def api_save_history(payload: dict[str, Any]):
    try:
        return db.save_history_report(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/history/{report_id}")
async def api_delete_history_report(report_id: str):
    if not db.delete_history_report(report_id):
        raise HTTPException(status_code=404, detail="History report not found.")
    return {"status": "deleted", "id": report_id}


@router.delete("/history")
async def api_clear_history():
    count = db.clear_history_reports()
    return {"status": "cleared", "deletedCount": count}


@router.get("/audio/{recording_id}")
async def api_get_audio_recording(recording_id: str):
    if not db.SAFE_ID_REGEX.match(recording_id):
        raise HTTPException(status_code=400, detail="Invalid recording ID.")
    audio_path = db.get_recording_path(recording_id)
    if not audio_path:
        raise HTTPException(status_code=404, detail="Audio recording not found.")
    media_type, _ = mimetypes.guess_type(str(audio_path))
    return FileResponse(path=str(audio_path), media_type=media_type or "audio/wav")


# ---------------------------------------------------------------------------
# One-Time localStorage Migration
# ---------------------------------------------------------------------------


@router.post("/v1/localStorage-import")
async def api_import_local_storage(payload: dict[str, Any]):
    return db.import_local_storage(payload)


# ---------------------------------------------------------------------------
# Model Catalog & Runtime Activation
# ---------------------------------------------------------------------------


@router.get("/models")
async def api_list_models():
    return get_model_catalog_state()


@router.post("/models/activate")
async def api_activate_model(req: ModelActivateRequest):
    target_id = (req.modelId or req.profileId or "").strip()
    if not target_id:
        raise HTTPException(status_code=400, detail="modelId or profileId is required.")

    async with _model_switch_lock:
        state = get_model_catalog_state()
        previous_id = state["activeModelId"]
        target = next((m for m in state["models"] if m["id"] == target_id), None)
        if not target:
            raise HTTPException(status_code=404, detail=f"Unknown model ID: {target_id}")
        if not target["installed"]:
            raise HTTPException(
                status_code=400,
                detail=f"Model '{target['displayName']}' is not installed in models/.",
            )

        was_online = await _is_llama_online()
        restarted = False
        note = "Active model updated."

        if was_online and not os.getenv("PYTEST_CURRENT_TEST"):
            ok, msg = await _restart_llama_server(target["filename"], target_id)
            if not ok:
                # Attempt rollback to previous working model
                prev_entry = next((m for m in state["models"] if m["id"] == previous_id and m["installed"]), None)
                if prev_entry and prev_entry["id"] != target_id:
                    await _restart_llama_server(prev_entry["filename"], prev_entry["id"])
                raise HTTPException(status_code=500, detail=f"Failed to activate model: {msg}")
            restarted = True
            note = msg

        db.update_settings({"active_model_id": target_id})
        updated_state = get_model_catalog_state()
        _write_manifest(target_id, updated_state["models"])
        active_entry = next((m for m in updated_state["models"] if m["id"] == target_id), target)
        return {
            "status": "ok",
            "activeModelId": target_id,
            "activeProfileId": target_id,
            "activeModel": active_entry,
            "restarted": restarted,
            "note": note,
        }


# ---------------------------------------------------------------------------
# System Status, Settings & Shutdown
# ---------------------------------------------------------------------------


@router.get("/system/status")
async def api_system_status():
    return await build_system_status()


@router.get("/system/settings")
async def api_get_system_settings():
    return await build_system_status()


@router.post("/system/settings")
async def api_update_system_settings(req: SystemSettingsPatch):
    patch = req.model_dump(exclude_none=True)
    db.update_settings(patch)
    return await build_system_status()


def _is_allowed_shutdown_origin(origin: str, request_host_header: str) -> bool:
    if not origin:
        return True
    parsed = urlparse(origin)
    origin_host = (parsed.hostname or "").strip().lower()
    if origin_host in {"127.0.0.1", "localhost", "::1"} or any(
        h in origin for h in ("127.0.0.1", "localhost", "[::1]")
    ):
        return True
    if not db.get_settings().get("tailscale_enabled", True):
        return False
    if origin_host.endswith(".ts.net"):
        return True
    try:
        ip = ipaddress.ip_address(origin_host)
        if ip in ipaddress.ip_network("100.64.0.0/10"):
            return True
    except ValueError:
        pass
    req_host = request_host_header.split(":", 1)[0].strip().lower()
    if req_host and origin_host and req_host == origin_host and req_host not in {"testserver"}:
        return True
    return False


@router.post("/system/shutdown")
async def api_system_shutdown(request: Request, background_tasks: BackgroundTasks):
    client_host = request.client.host if request.client else "127.0.0.1"
    allowed_hosts = {"127.0.0.1", "::1", "localhost", "testclient"}
    if client_host not in allowed_hosts:
        raise HTTPException(status_code=403, detail="Shutdown is restricted to local requests.")

    origin = request.headers.get("origin", "")
    if origin and not _is_allowed_shutdown_origin(origin, request.headers.get("host", "")):
        raise HTTPException(status_code=403, detail="Cross-origin shutdown request rejected.")

    try:
        PIDS_DIR.mkdir(parents=True, exist_ok=True)
        (PIDS_DIR / "shutdown.requested").write_text("1\n", encoding="utf-8")
    except OSError:
        pass

    background_tasks.add_task(_schedule_shutdown_exit)
    return {"status": "shutting_down"}
