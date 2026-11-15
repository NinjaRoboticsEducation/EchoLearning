import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .config import (
    API_PORT,
    LLAMA_MODEL_NAME,
    LLAMA_SERVER_URL,
    PROJECT_ROOT,
    TEMP_AUDIO_DIR,
    WHISPER_SERVER_URL,
)
from .mcp_server import mcp as mcp_server
from .routes.dictionary_routes import router as dictionary_router
from .routes.health_routes import router as health_router
from .routes.shadowing_routes import router as shadowing_router
from .routes.storage_routes import router as storage_router
from .routes.transcript_routes import router as transcript_router
from .routes.tts_routes import router as tts_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initializes temp audio storage and durable SQLite WAL database on startup."""
    TEMP_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    db.init_db()
    logger.info("EchoLearning ADK 2.x Backend initialized on http://127.0.0.1:%s", API_PORT)
    yield


app = FastAPI(
    title="EchoLearning Local Google ADK 2.x Application",
    description="100% Local AI Backend running Google ADK 2.x + Qwen3.5 + whisper.cpp + offline macOS TTS + MCP",
    version="2.0.0",
    lifespan=lifespan,
)

LOCAL_CLIENT_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}
LOCAL_HOST_HEADERS = {"127.0.0.1", "::1", "[::1]", "localhost", "testserver", ""}


def _extract_host_name(raw_host: str) -> str:
    host = (raw_host or "").strip().lower()
    if not host:
        return ""
    if host.startswith("["):
        bracket_end = host.find("]")
        return host[: bracket_end + 1] if bracket_end != -1 else host
    if host.count(":") == 1:
        return host.split(":", 1)[0]
    return host


@app.middleware("http")
async def enforce_tailscale_access_guard(request: Request, call_next):
    """Blocks non-loopback / Tailscale requests when Tailscale remote access is disabled."""
    client_host = (request.client.host if request.client else "127.0.0.1").strip().lower()
    forwarded_for = request.headers.get("x-forwarded-for", "")
    forwarded_ip = forwarded_for.split(",")[0].strip().lower() if forwarded_for else ""
    host_name = _extract_host_name(request.headers.get("host", ""))

    is_remote = (
        client_host not in LOCAL_CLIENT_HOSTS
        or bool(forwarded_ip and forwarded_ip not in LOCAL_CLIENT_HOSTS)
        or bool(host_name and host_name not in LOCAL_HOST_HEADERS)
    )
    if is_remote:
        settings = db.get_settings()
        if not settings.get("tailscale_enabled", True):
            if request.url.path.startswith("/mcp"):
                return JSONResponse(
                    status_code=403,
                    content={
                        "jsonrpc": "2.0",
                        "error": {
                            "code": -32001,
                            "message": "Tailscale remote access is disabled in Settings.",
                        },
                        "id": None,
                    },
                )
            return JSONResponse(
                status_code=403,
                content={"detail": "Tailscale remote access is disabled in Settings."},
            )

    return await call_next(request)


@app.get("/api/health")
async def enhanced_health_check():
    """Returns comprehensive health status for FastAPI, SQLite, MCP, whisper-server, and llama-server."""
    llama_ready = False
    whisper_ready = False
    sqlite_ready = False
    active_model = LLAMA_MODEL_NAME

    try:
        db.init_db()
        settings = db.get_settings()
        active_model = str(settings.get("active_model_id") or LLAMA_MODEL_NAME)
        sqlite_ready = True
    except Exception as exc:
        logger.warning("SQLite health probe warning: %s", exc)

    async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
        try:
            r = await client.get(f"{LLAMA_SERVER_URL}/models")
            if r.status_code == 200:
                llama_ready = True
        except Exception:
            pass

        try:
            r = await client.get(f"{WHISPER_SERVER_URL}/")
            if r.status_code in (200, 404, 405):
                whisper_ready = True
        except Exception:
            pass

    ready = llama_ready and whisper_ready and sqlite_ready
    return {
        "status": "ok",
        "ready": ready,
        "framework": "Google ADK 2.x",
        "activeModel": active_model,
        "sqliteReady": sqlite_ready,
        "mcpReady": True,
        "whisperReady": whisper_ready,
        "llamaReady": llama_ready,
        "services": {
            "fastapi": "ok",
            "llamaServer": "online" if llama_ready else "offline",
            "whisperServer": "online" if whisper_ready else "offline",
            "sqlite": "ok" if sqlite_ready else "offline",
            "mcp": "ok",
        },
    }


@app.get("/mcp")
async def mcp_info():
    """Returns EchoLearning Streamable HTTP MCP endpoint metadata."""
    settings = db.get_settings()
    tools = await mcp_server.list_tools()
    return {
        "name": "EchoLearning",
        "protocol": "mcp-streamable-http",
        "enabled": bool(settings.get("mcp_http_enabled", True)),
        "tools": [t.name for t in tools],
    }


@app.post("/mcp")
async def mcp_http_endpoint(request: Request):
    """Streamable HTTP / JSON-RPC 2.0 MCP endpoint for AI tools and personal bots."""
    settings = db.get_settings()
    if not settings.get("mcp_http_enabled", True):
        return JSONResponse(
            status_code=403,
            content={
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32000, "message": "HTTP MCP endpoint is disabled in Settings."},
            },
        )

    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "Parse error: invalid JSON body."},
            },
        )

    req_id = payload.get("id")
    method = payload.get("method", "")
    params = payload.get("params") or {}
    session_id = request.headers.get("Mcp-Session-Id") or uuid.uuid4().hex
    headers = {"Mcp-Session-Id": session_id}

    if method == "initialize":
        return JSONResponse(
            content={
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "EchoLearning", "version": "2.0.0"},
                },
            },
            headers=headers,
        )

    if method in ("notifications/initialized", "ping"):
        return JSONResponse(
            content={"jsonrpc": "2.0", "id": req_id, "result": {}},
            headers=headers,
        )

    if method == "tools/list":
        tools = await mcp_server.list_tools()
        serialized_tools = []
        for t in tools:
            schema = getattr(t, "inputSchema", None) or getattr(t, "parameters", None) or {"type": "object", "properties": {}}
            serialized_tools.append(
                {
                    "name": t.name,
                    "description": t.description or "",
                    "inputSchema": schema,
                }
            )
        return JSONResponse(
            content={"jsonrpc": "2.0", "id": req_id, "result": {"tools": serialized_tools}},
            headers=headers,
        )

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments") or {}
        if not tool_name:
            return JSONResponse(
                status_code=400,
                content={
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32602, "message": "Missing tool name in params.name."},
                },
                headers=headers,
            )
        try:
            call_res = await mcp_server.call_tool(tool_name, arguments)
            # Support both mcp 2.x CallToolResult and tuple/list return shapes
            raw_content = getattr(call_res, "content", call_res)
            is_err = bool(getattr(call_res, "isError", False) or getattr(call_res, "is_error", False))
            if isinstance(raw_content, tuple):
                raw_content = raw_content[0]

            content_items: list[dict[str, Any]] = []
            if isinstance(raw_content, list):
                for item in raw_content:
                    if hasattr(item, "model_dump"):
                        content_items.append(item.model_dump())
                    elif isinstance(item, dict):
                        content_items.append(item)
                    else:
                        content_items.append({"type": "text", "text": str(item)})
            else:
                content_items.append(
                    {
                        "type": "text",
                        "text": json.dumps(raw_content, ensure_ascii=False)
                        if isinstance(raw_content, (dict, list))
                        else str(raw_content),
                    }
                )

            return JSONResponse(
                content={
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": content_items,
                        "isError": is_err,
                    },
                },
                headers=headers,
            )
        except Exception as exc:
            return JSONResponse(
                content={
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Tool error: {exc}"}],
                        "isError": True,
                    },
                },
                headers=headers,
            )

    return JSONResponse(
        status_code=404,
        content={
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        },
        headers=headers,
    )


# Register API routes (storage_router already declares prefix="/api")
app.include_router(storage_router)
app.include_router(health_router, prefix="/api", tags=["Health"])
app.include_router(transcript_router, prefix="/api", tags=["Transcript"])
app.include_router(dictionary_router, prefix="/api", tags=["Dictionary"])
app.include_router(shadowing_router, prefix="/api", tags=["Shadowing"])
app.include_router(tts_router, prefix="/api", tags=["TTS"])

# Serve built frontend assets if dist/ exists
dist_dir = PROJECT_ROOT / "dist"
if dist_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "adk_backend.main:app",
        host="127.0.0.1",
        port=API_PORT,
        reload=True,
    )
