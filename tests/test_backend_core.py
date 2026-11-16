"""Comprehensive unit and integration tests for EchoLearning backend-core (R0–R4)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import pty
import shutil
import stat
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from adk_backend import db  # noqa: E402
from adk_backend.agents import dictionary_agent  # noqa: E402
from adk_backend.main import app  # noqa: E402
from adk_backend.routes import dictionary_routes, storage_routes, transcript_routes, tts_routes  # noqa: E402
from adk_backend.tools import dictionary_tools  # noqa: E402


@pytest.fixture()
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Provides isolated SQLite DB, audio dir, and models dir per test."""
    data_dir = tmp_path / "data"
    db_path = data_dir / "echolearning.sqlite3"
    audio_dir = data_dir / "audio"
    models_dir = tmp_path / "models"
    models_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("ECHOLEARNING_DATA_DIR", str(data_dir))
    monkeypatch.setenv("ECHOLEARNING_DB_PATH", str(db_path))
    monkeypatch.setenv("ECHOLEARNING_AUDIO_DIR", str(audio_dir))
    monkeypatch.setattr(storage_routes, "MODELS_DIR", models_dir)
    monkeypatch.setattr(storage_routes, "MODEL_MANIFEST_PATH", models_dir / "manifest.json")
    dictionary_routes._dictionary_cache.clear()
    db.init_db(db_path)

    return {
        "tmp_path": tmp_path,
        "data_dir": data_dir,
        "db_path": db_path,
        "audio_dir": audio_dir,
        "models_dir": models_dir,
    }


@pytest.fixture()
def client(isolated_env):
    with TestClient(app) as tc:
        yield tc


# ---------------------------------------------------------------------------
# R0 Baseline Hygiene Tests
# ---------------------------------------------------------------------------


def test_r0_legacy_server_ts_removed_and_gitignore_updated():
    assert not (ROOT_DIR / "server.ts").exists()
    gitignore = (ROOT_DIR / ".gitignore").read_text(encoding="utf-8")
    assert "data/" in gitignore
    assert "*.sqlite3" in gitignore
    assert "models/manifest.json" in gitignore


def test_scripts_architecture_gpu_offload_and_manifest_tiers():
    start_llama = (ROOT_DIR / "scripts" / "start_llama.sh").read_text(encoding="utf-8")
    assert "arm64" in start_llama
    assert "NGL=99" in start_llama
    assert "NGL=0" in start_llama
    assert "manifest.json" in start_llama

    dl_script = (ROOT_DIR / "scripts" / "download_models.sh").read_text(encoding="utf-8")
    for tier_id in (
        "qwen3.5-4b-q6_k",
        "qwen3.5-9b-q4_k_m",
        "qwen3.5-9b-q6_k",
        "qwen3.5-27b-q4_k_m",
        "qwen3.5-35b-a3b-q4_k_m",
        "ggml-large-v3-turbo.bin",
    ):
        assert tier_id in dl_script


# ---------------------------------------------------------------------------
# R2 SQLite WAL & CRUD Tests
# ---------------------------------------------------------------------------


def test_sqlite_wal_and_foreign_keys_enabled(isolated_env):
    conn = db.get_connection()
    try:
        mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
        fk = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
        assert str(mode).lower() == "wal"
        assert fk == 1
    finally:
        conn.close()


def test_materials_crud_and_segment_retokenize(client: TestClient):
    material = {
        "videoId": "abc123def45",
        "title": "Test Shadowing Video",
        "channel": "Echo Channel",
        "language": "ja",
        "level": "Intermediate",
        "durationSec": 45.0,
        "captionSource": "youtube_manual",
        "captionNote": "Verified captions",
        "segments": [
            {
                "id": "seg-0",
                "index": 0,
                "startTime": 0.0,
                "endTime": 3.2,
                "text": "言葉のリズム",
                "tokens": [{"surface": "言葉", "reading": "ことば", "isKanji": True}],
            }
        ],
    }

    r_create = client.post("/api/materials", json=material)
    assert r_create.status_code == 200
    created = r_create.json()
    assert created["videoId"] == "abc123def45"
    assert len(created["segments"]) == 1

    r_list = client.get("/api/materials")
    assert r_list.status_code == 200
    assert any(m["videoId"] == "abc123def45" for m in r_list.json()["materials"])

    r_get = client.get("/api/materials/abc123def45")
    assert r_get.status_code == 200
    assert r_get.json()["title"] == "Test Shadowing Video"

    # Update segment text -> auto-retokenizes in Japanese
    r_upd = client.put(
        "/api/materials/abc123def45/segments/seg-0",
        json={"text": "日本語を話す"},
    )
    assert r_upd.status_code == 200
    seg = r_upd.json()
    assert seg["text"] == "日本語を話す"
    assert any(t["surface"] == "話す" and t.get("reading") == "はなす" for t in seg["tokens"])

    r_del = client.delete("/api/materials/abc123def45")
    assert r_del.status_code == 200
    assert client.get("/api/materials/abc123def45").status_code == 404


def test_vocabulary_crud_and_deduplication(client: TestClient):
    item = {
        "id": "v1",
        "word": "resilient",
        "lemma": "resilient",
        "language": "en",
        "reading": "ri-ZIL-yuhnt",
        "romaji": None,
        "ipa": "/rɪˈzɪljənt/",
        "pitchAccent": None,
        "partOfSpeech": "adjective",
        "contextualMeaning": "Able to recover quickly",
        "dictionaryDefinitions": ["Able to bounce back"],
        "sourceSentence": "We stay resilient.",
        "videoId": "vid1",
        "videoTitle": "Resilience",
        "timestampSec": 12.5,
    }
    r1 = client.post("/api/vocabulary", json=item)
    assert r1.status_code == 200
    assert r1.json()["word"] == "resilient"
    assert r1.json()["romaji"] is None

    # Re-saving same (language, word) with new ID deduplicates
    item2 = dict(item, id="v2", contextualMeaning="Updated meaning")
    r2 = client.post("/api/vocabulary", json=item2)
    assert r2.status_code == 200
    vocab_list = client.get("/api/vocabulary").json()["vocabulary"]
    assert len(vocab_list) == 1
    assert vocab_list[0]["contextualMeaning"] == "Updated meaning"

    assert client.delete("/api/vocabulary/v2").status_code == 200
    assert client.get("/api/vocabulary").json()["vocabulary"] == []

    client.post("/api/vocabulary", json=item)
    r_clear = client.delete("/api/vocabulary")
    assert r_clear.status_code == 200
    assert r_clear.json()["deletedCount"] == 1


def test_history_audio_persistence_and_traversal_protection(client: TestClient, isolated_env):
    fake_wav = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\x3e\x00\x00\x00\x7d\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    data_url = "data:audio/wav;base64," + base64.b64encode(fake_wav).decode("ascii")
    report = {
        "id": "rep_1",
        "videoId": "vid1",
        "videoTitle": "Demo",
        "language": "en",
        "mode": "listen_repeat",
        "targetText": "Hello world",
        "recognizedTranscript": "Hello world",
        "overallScore": 92.0,
        "audioDataUrl": data_url,
    }

    r_save = client.post("/api/history", json=report)
    assert r_save.status_code == 200
    saved = r_save.json()
    assert "audioDataUrl" not in saved
    rec_id = saved["recordingId"]
    assert rec_id
    assert saved["audioUrl"] == f"/api/audio/{rec_id}"

    # Verify audio file exists and can be streamed via GET /api/audio/{recording_id}
    r_audio = client.get(f"/api/audio/{rec_id}")
    assert r_audio.status_code == 200
    assert r_audio.content == fake_wav

    # Directory traversal attempt must be rejected
    assert client.get("/api/audio/..%2F..%2Fetc%2Fpasswd").status_code in (400, 404)

    # Delete history removes orphaned WAV file too
    assert client.delete("/api/history/rep_1").status_code == 200
    assert client.get(f"/api/audio/{rec_id}").status_code == 404


def test_local_storage_import_idempotent_with_nulls_and_quarantine(client: TestClient):
    payload = {
        "materials": [
            {
                "videoId": "mat_1",
                "title": "Sample Material",
                "language": "en",
                "segments": [
                    {"id": "s1", "index": 0, "startTime": 0.0, "endTime": 2.0, "text": "Hello"}
                ],
            },
            {"title": "Missing videoId"},  # Invalid -> quarantined
        ],
        "vocabulary": [
            {
                "id": "voc_1",
                "word": "approach",
                "lemma": "approach",
                "language": "en",
                "reading": "uh-PROHCH",
                "romaji": None,
                "ipa": "/əˈproʊtʃ/",
                "pitchAccent": None,
                "partOfSpeech": "verb",
                "contextualMeaning": "Move closer",
                "dictionaryDefinitions": ["Come near"],
                "sourceSentence": "Approach carefully.",
                "videoId": "mat_1",
                "videoTitle": "Sample Material",
                "timestampSec": 1.0,
            }
        ],
        "history": [
            {
                "id": "hist_1",
                "videoId": "mat_1",
                "language": "en",
                "targetText": "Hello",
                "recognizedTranscript": "Hello",
                "overallScore": 88,
            }
        ],
    }

    r1 = client.post("/api/v1/localStorage-import", json=payload)
    assert r1.status_code == 200
    d1 = r1.json()
    assert d1["imported"] == {"materials": 1, "vocabulary": 1, "history": 1}
    assert d1["skipped"]["materials"] == 1
    assert len(d1["errors"]) == 1

    # Second import is idempotent (counts remain 1, 1, 1)
    r2 = client.post("/api/v1/localStorage-import", json=payload)
    assert r2.status_code == 200
    assert r2.json()["counts"] == {"materials": 1, "vocabulary": 1, "history": 1}


# ---------------------------------------------------------------------------
# C09 TTS Argument Injection & Validation Tests
# ---------------------------------------------------------------------------


def test_tts_max_length_and_stdin_prevents_argument_injection(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    # Enforce max_length=500
    too_long = "a" * 501
    r_long = client.post("/api/tts/pronounce", json={"text": too_long, "language": "en"})
    assert r_long.status_code == 422

    # Enforce language Literal
    r_lang = client.post("/api/tts/pronounce", json={"text": "hello", "language": "fr"})
    assert r_lang.status_code == 422

    # Mock /usr/bin/say + ffmpeg to inspect exact subprocess arguments
    captured_calls: list[dict[str, Any]] = []

    def fake_run(cmd, **kwargs):
        captured_calls.append({"cmd": list(cmd), "kwargs": kwargs})
        if cmd[0] == "ffmpeg":
            out_wav = Path(cmd[-1])
            out_wav.write_bytes(b"RIFF" + b"\x00" * 60)
        return MagicMock(returncode=0)

    monkeypatch.setattr(tts_routes.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(tts_routes.os.path, "exists", lambda p: True)
    monkeypatch.setattr(tts_routes.subprocess, "run", fake_run)

    payload_text = "-f /etc/passwd --input-file=/etc/shadow"
    r_ok = client.post("/api/tts/pronounce", json={"text": payload_text, "language": "en"})
    assert r_ok.status_code == 200

    say_call = captured_calls[0]
    assert say_call["cmd"][0] == "/usr/bin/say"
    assert say_call["cmd"][-2:] == ["-f", "-"]
    assert payload_text not in say_call["cmd"]
    assert say_call["kwargs"]["input"] == payload_text.encode("utf-8")


# ---------------------------------------------------------------------------
# C10 & C11 Dictionary Security & Non-Caching Tests
# ---------------------------------------------------------------------------


def test_dictionary_url_encoding_and_punct_stripping(monkeypatch: pytest.MonkeyPatch):
    requested_urls: list[str] = []

    class FakeResp:
        status_code = 200

        def json(self):
            return [
                {
                    "phonetic": "/tɛst/",
                    "meanings": [{"partOfSpeech": "noun", "definitions": [{"definition": "A check"}]}],
                }
            ]

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, **kwargs):
            requested_urls.append(url)
            return FakeResp()

    monkeypatch.setattr(dictionary_tools.httpx, "AsyncClient", FakeClient)
    res = asyncio.run(dictionary_tools.lookup_free_dictionary("foo/bar?baz=1#x"))
    assert res["found"] is True
    assert requested_urls[0] == "https://api.dictionaryapi.dev/api/v2/entries/en/foo%2Fbar%3Fbaz%3D1%23x"


def test_dictionary_prompt_escaping_and_degraded_never_cached(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    captured_prompts: list[str] = []
    call_count = {"n": 0}

    async def fake_execute(agent, prompt, schema_model=None, **kwargs):
        captured_prompts.append(prompt)
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("llama-server offline")
        return {
            "word": "resilient",
            "lemma": "resilient",
            "language": "en",
            "reading": "ri-ZIL-yuhnt",
            "romaji": None,
            "ipa": "/rɪˈzɪljənt/",
            "pitchAccent": None,
            "partOfSpeech": "Adjective",
            "contextualMeaning": "Recovering quickly from difficulty.",
            "dictionaryDefinitions": ["Able to recover quickly."],
            "usageExample": "She is resilient.",
            "usageExampleTranslation": "She recovers quickly.",
            "conversationExamples": [],
            "pronunciationTip": "Stress the second syllable.",
        }

    async def fake_free_dict(word: str):
        return {"found": False, "word": word, "definitions": []}

    async def fake_tatoeba(word: str, language: str = "en", limit: int = 3):
        return []

    monkeypatch.setattr(dictionary_agent, "execute_adk_agent_json", fake_execute)
    monkeypatch.setattr(dictionary_agent, "lookup_free_dictionary", fake_free_dict)
    monkeypatch.setattr(dictionary_agent, "lookup_tatoeba_examples", fake_tatoeba)

    # First call fails LLM -> returns degraded fallback and MUST NOT cache
    r1 = client.post(
        "/api/dictionary/lookup",
        json={"word": "resilient/?#", "sentence": "Stay 'resilient' always.", "language": "en"},
    )
    assert r1.status_code == 200
    d1 = r1.json()
    assert d1["word"] == "resilient"
    assert d1["isDegraded"] is True
    assert d1["source"] == "offline_fallback"
    assert len(dictionary_routes._dictionary_cache) == 0

    # Verify structured JSON delimiters were used in prompt (C10)
    assert "<dictionary_request_json>" in captured_prompts[0]

    # Second call succeeds -> returns non-degraded entry and caches it
    r2 = client.post(
        "/api/dictionary/lookup",
        json={"word": "resilient", "sentence": "Stay 'resilient' always.", "language": "en"},
    )
    assert r2.status_code == 200
    d2 = r2.json()
    assert d2["isDegraded"] is False
    assert d2["source"] == "adk_agent"
    assert len(dictionary_routes._dictionary_cache) == 1


# ---------------------------------------------------------------------------
# C12 & C01 Transcript Subprocess Cleanup & XML/VTT Parsing Tests
# ---------------------------------------------------------------------------


def test_parse_timedtext_xml_and_vtt():
    # C04: reject unrelated URLs while accepting valid YouTube URLs/IDs
    assert transcript_routes.extract_youtube_id("https://example.com/abcdefghijk") is None
    assert transcript_routes.extract_youtube_id("https://evil.com/watch?v=dQw4w9WgXcQ") is None
    assert transcript_routes.extract_youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert transcript_routes.extract_youtube_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert transcript_routes.extract_youtube_id("https://youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert transcript_routes.extract_youtube_id("dQw4w9WgXcQ") == "dQw4w9WgXcQ"

    xml_body = '<transcript><text dur="7.0" start="1.0">Hello &amp; welcome</text></transcript>'
    rows = transcript_routes.parse_timedtext_body(xml_body)
    assert len(rows) == 1
    assert rows[0]["start"] == 1.0
    assert rows[0]["dur"] == 7.0
    assert rows[0]["text"] == "Hello & welcome"

    vtt_body = "WEBVTT\n\n00:00:01.000 --> 00:00:04.500\nFirst line\n"
    vtt_rows = transcript_routes.parse_timedtext_body(vtt_body)
    assert len(vtt_rows) == 1
    assert vtt_rows[0]["start"] == 1.0
    assert vtt_rows[0]["dur"] == 3.5
    assert vtt_rows[0]["text"] == "First line"


def test_ytdlp_subprocess_killed_on_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    fake_proc = MagicMock()
    fake_proc.returncode = None
    fake_proc.kill = MagicMock()
    fake_proc.wait = AsyncMock(return_value=-9)

    async def hanging_communicate():
        await asyncio.sleep(5)
        return (b"", b"")

    fake_proc.communicate = hanging_communicate

    monkeypatch.setattr(transcript_routes, "download_audio_with_ytdl_in_process", lambda *a: False)
    monkeypatch.setattr(transcript_routes.shutil, "which", lambda name: "/usr/bin/true")
    monkeypatch.setattr(
        transcript_routes.asyncio,
        "create_subprocess_exec",
        AsyncMock(return_value=fake_proc),
    )

    ok = asyncio.run(
        transcript_routes.download_youtube_audio_wav(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            tmp_path / "out.wav",
            timeout_sec=0.05,
        )
    )
    assert ok is False
    fake_proc.kill.assert_called_once()
    fake_proc.wait.assert_awaited()


# ---------------------------------------------------------------------------
# Model Management, System Status, Settings & Shutdown Tests
# ---------------------------------------------------------------------------


def test_models_listing_and_activation(client: TestClient, isolated_env):
    models_dir: Path = isolated_env["models_dir"]
    # Create a dummy installed model file for qwen3.5-4b-q6_k
    (models_dir / "Qwen3.5-4B-Q6_K.gguf").write_bytes(b"GGUF" + b"\x00" * 1024)

    r_list = client.get("/api/models")
    assert r_list.status_code == 200
    data = r_list.json()
    assert len(data["models"]) >= 5
    four_b = next(m for m in data["models"] if m["id"] == "qwen3.5-4b-q6_k")
    assert four_b["installed"] is True

    # Unknown model -> 404
    assert client.post("/api/models/activate", json={"modelId": "nonexistent"}).status_code == 404
    # Uninstalled model -> 400
    assert client.post("/api/models/activate", json={"modelId": "qwen3.5-27b-q4_k_m"}).status_code == 400

    # Installed model activates cleanly and updates manifest.json + SQLite settings
    r_act = client.post("/api/models/activate", json={"modelId": "qwen3.5-4b-q6_k"})
    assert r_act.status_code == 200
    act_data = r_act.json()
    assert act_data["activeModelId"] == "qwen3.5-4b-q6_k"
    manifest = json.loads((models_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["active_model"] == "qwen3.5-4b-q6_k"


def test_system_status_settings_and_shutdown(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    r_status = client.get("/api/system/status")
    assert r_status.status_code == 200
    st = r_status.json()
    assert st["sqliteReady"] is True
    assert "tailscale" in st
    assert "mcp" in st
    assert "counts" in st

    r_set = client.post(
        "/api/system/settings",
        json={"tailscaleEnabled": True, "mcpHttpEnabled": True, "mcpStdioEnabled": False},
    )
    assert r_set.status_code == 200
    updated = r_set.json()
    assert updated["tailscale"]["enabled"] is True
    assert updated["mcp"]["httpEnabled"] is True
    assert updated["mcp"]["stdioEnabled"] is False

    # External origin shutdown must be rejected
    r_forbidden = client.post(
        "/api/system/shutdown",
        headers={"Origin": "https://evil.example.com"},
    )
    assert r_forbidden.status_code == 403

    shutdown_called = {"called": False}
    monkeypatch.setattr(
        storage_routes,
        "_schedule_shutdown_exit",
        lambda: shutdown_called.__setitem__("called", True),
    )
    r_shut = client.post(
        "/api/system/shutdown",
        headers={"Origin": "http://127.0.0.1:5173"},
    )
    assert r_shut.status_code == 200
    assert r_shut.json() == {"status": "shutting_down"}
    assert shutdown_called["called"] is True


def test_no_unredirected_stdout_prints_in_mcp_path():
    # U09: ensure library/route/tool/agent modules do not print to stdout
    checked = [
        ROOT_DIR / "adk_backend" / "tools" / "dictionary_tools.py",
        ROOT_DIR / "adk_backend" / "tools" / "tokenizer_tools.py",
        ROOT_DIR / "adk_backend" / "agents" / "dictionary_agent.py",
        ROOT_DIR / "adk_backend" / "agents" / "transcript_agent.py",
        ROOT_DIR / "adk_backend" / "routes" / "transcript_routes.py",
    ]
    for path in checked:
        text = path.read_text(encoding="utf-8")
        for idx, line in enumerate(text.splitlines(), start=1):
            if "print(" in line and "file=sys.stderr" not in line:
                pytest.fail(f"Unredirected print() at {path.name}:{idx}: {line.strip()}")


def test_uninstaller_script_and_system_status(client: TestClient, tmp_path: Path):
    # 1. GET /api/system/status includes uninstall metadata
    r_status = client.get("/api/system/status")
    assert r_status.status_code == 200
    uninstall = r_status.json().get("uninstall")
    assert uninstall is not None
    assert uninstall["scriptPath"] == "./uninstall.sh"
    assert uninstall["commands"]["interactive"] == "./uninstall.sh"
    assert uninstall["commands"]["dryRun"] == "./uninstall.sh --dry-run --all"
    assert uninstall["commands"]["keepData"] == "./uninstall.sh --all --keep-data"
    assert uninstall["commands"]["fullReset"] == "./uninstall.sh --all"
    assert uninstall["commands"]["completeWithBrew"] == "./uninstall.sh --all --brew --remove-app-dir"
    assert set(uninstall["components"].keys()) == {
        "modelsPresent",
        "venvPresent",
        "nodeModulesPresent",
        "dataPresent",
    }

    # 2. ./uninstall.sh --help and --dry-run --all succeed without deleting anything
    help_proc = subprocess.run(
        [str(ROOT_DIR / "uninstall.sh"), "--help"],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    assert help_proc.returncode == 0
    assert "EchoLearning Uninstaller" in help_proc.stdout
    assert "--keep-data" in help_proc.stdout

    dry_proc = subprocess.run(
        [str(ROOT_DIR / "uninstall.sh"), "--dry-run", "--all"],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    assert dry_proc.returncode == 0
    assert "[DRY-RUN]" in dry_proc.stdout
    assert (ROOT_DIR / "package.json").is_file()
    assert (ROOT_DIR / "adk_backend" / ".venv").is_dir()

    # 3. Staged mock EchoLearning directory destructive tests
    staged = tmp_path / "staged_echo"
    backup_dir = tmp_path / "backups"

    def populate_staged() -> None:
        (staged / "adk_backend" / ".venv").mkdir(parents=True, exist_ok=True)
        (staged / "adk_backend" / ".venv" / "dummy").write_text("venv", encoding="utf-8")
        (staged / "node_modules").mkdir(parents=True, exist_ok=True)
        (staged / "node_modules" / "dummy").write_text("nm", encoding="utf-8")
        (staged / "dist").mkdir(parents=True, exist_ok=True)
        (staged / "dist" / "dummy").write_text("dist", encoding="utf-8")
        (staged / "models").mkdir(parents=True, exist_ok=True)
        (staged / "models" / "test.gguf").write_bytes(b"GGUF")
        (staged / "logs").mkdir(parents=True, exist_ok=True)
        (staged / "logs" / "test.log").write_text("log", encoding="utf-8")
        (staged / ".pids").mkdir(parents=True, exist_ok=True)
        (staged / ".pids" / "test.pid").write_text("999999\n", encoding="utf-8")
        (staged / "data").mkdir(parents=True, exist_ok=True)
        (staged / "data" / "echolearning.sqlite3").write_bytes(b"SQLite format 3\x00")
        (staged / "package.json").write_text('{"name":"echo-learning"}', encoding="utf-8")

    populate_staged()

    # 3a. --all --keep-data removes deps/caches/models while preserving data/echolearning.sqlite3
    keep_proc = subprocess.run(
        [
            str(ROOT_DIR / "scripts" / "uninstall.sh"),
            "--project-root",
            str(staged),
            "--all",
            "--keep-data",
            "--backup-dir",
            str(backup_dir),
            "--yes",
        ],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    assert keep_proc.returncode == 0, keep_proc.stderr
    assert not (staged / "adk_backend" / ".venv").exists()
    assert not (staged / "node_modules").exists()
    assert not (staged / "dist").exists()
    assert not (staged / "models" / "test.gguf").exists()
    assert not (staged / "logs").exists()
    assert not (staged / ".pids").exists()
    assert (staged / "data" / "echolearning.sqlite3").is_file()

    # 3b. Repopulate and run --all --backup-dir <backup_dir> --remove-app-dir --yes
    populate_staged()
    full_proc = subprocess.run(
        [
            str(ROOT_DIR / "scripts" / "uninstall.sh"),
            "--project-root",
            str(staged),
            "--all",
            "--backup-dir",
            str(backup_dir),
            "--remove-app-dir",
            "--yes",
        ],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    assert full_proc.returncode == 0, full_proc.stderr
    assert "run 'cd ..'" in full_proc.stdout
    assert not staged.exists()
    archives = list(backup_dir.glob("echolearning-study-backup-*.tar.gz"))
    assert len(archives) == 1
    with tarfile.open(archives[0], "r:gz") as tf:
        assert "data/echolearning.sqlite3" in tf.getnames()


def test_installer_and_setup_bash32_nounset(tmp_path: Path):
    # 1. Verify syntax of all installer/setup/downloader/uninstaller scripts under /bin/bash (Bash 3.2)
    syntax_proc = subprocess.run(
        [
            "/bin/bash",
            "-n",
            str(ROOT_DIR / "scripts" / "install.sh"),
            str(ROOT_DIR / "install.sh"),
            str(ROOT_DIR / "scripts" / "setup.sh"),
            str(ROOT_DIR / "setup.sh"),
            str(ROOT_DIR / "scripts" / "download_models.sh"),
            str(ROOT_DIR / "scripts" / "uninstall.sh"),
        ],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    assert syntax_proc.returncode == 0, syntax_proc.stderr

    # 2. Verify --help exits 0 for install.sh, setup.sh, and download_models.sh
    for rel_script, expected_text in (
        ("scripts/install.sh", "EchoLearning Automated Installer"),
        ("scripts/setup.sh", "EchoLearning Automated Environment Setup"),
        ("scripts/download_models.sh", "Usage: ./scripts/download_models.sh"),
    ):
        help_proc = subprocess.run(
            ["/bin/bash", str(ROOT_DIR / rel_script), "--help"],
            cwd=str(ROOT_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
        assert help_proc.returncode == 0, f"{rel_script} --help failed: {help_proc.stderr}"
        assert expected_text in help_proc.stdout

    # 3. Prepare stubbed toolchain + isolated project directory for Bash 3.2 set -euo pipefail tests
    stub_bin = tmp_path / "stub_bin"
    stub_bin.mkdir(parents=True, exist_ok=True)
    real_python = sys.executable

    def write_stub(name: str, body: str) -> None:
        p = stub_bin / name
        p.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body, encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    write_stub("shasum", "exit 0\n")
    write_stub(
        "curl",
        """out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output" || "$1" == "-o" ]]; then
    out="$2"
    shift 2
  else
    shift
  fi
done
if [[ -n "$out" ]]; then
  printf 'STUB_MODEL_DATA' > "$out"
fi
exit 0
""",
    )
    write_stub("brew", "exit 0\n")
    write_stub("ffmpeg", "exit 0\n")
    write_stub("llama-server", "exit 0\n")
    write_stub("whisper-server", "exit 0\n")
    write_stub("node", 'if [[ "${1:-}" == "-v" ]]; then echo "v22.0.0"; fi\nexit 0\n')
    write_stub("npm", "exit 0\n")
    write_stub(
        "python3",
        f"""if [[ "${{1:-}}" == "-m" && "${{2:-}}" == "venv" ]]; then
  mkdir -p "$3/bin"
  cp "{stub_bin}/python3" "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
elif [[ "${{1:-}}" == "-m" && "${{2:-}}" == "pip" ]]; then
  exit 0
elif [[ "${{1:-}}" == "-m" && "${{2:-}}" == "certifi" ]]; then
  echo "/tmp/stub-cacert.pem"
  exit 0
fi
exec "{real_python}" "$@"
""",
    )

    test_env = os.environ.copy()
    test_env["PATH"] = f"{stub_bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"

    # 3a. download_models.sh: --write-manifest-only, --models, non-TTY fallback, and interactive PTY
    dl_proj = tmp_path / "dl_proj"
    (dl_proj / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT_DIR / "scripts" / "download_models.sh", dl_proj / "scripts" / "download_models.sh")

    wmo_proc = subprocess.run(
        ["/bin/bash", str(dl_proj / "scripts" / "download_models.sh"), "--write-manifest-only"],
        cwd=str(dl_proj),
        env=test_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert wmo_proc.returncode == 0, wmo_proc.stderr
    assert (dl_proj / "models" / "manifest.json").is_file()

    models_proc = subprocess.run(
        ["/bin/bash", str(dl_proj / "scripts" / "download_models.sh"), "--models", "1,3"],
        cwd=str(dl_proj),
        env=test_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert models_proc.returncode == 0, models_proc.stderr
    manifest_13 = json.loads((dl_proj / "models" / "manifest.json").read_text(encoding="utf-8"))
    assert set(manifest_13["installed_models"]) >= {"qwen3.5-4b-q6_k", "qwen3.5-9b-q6_k"}

    # Non-TTY fallback (no --non-interactive, no /dev/tty) should default to tier 3 without hanging or unbound errors
    dl_nontty = tmp_path / "dl_nontty"
    (dl_nontty / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT_DIR / "scripts" / "download_models.sh", dl_nontty / "scripts" / "download_models.sh")
    nontty_proc = subprocess.run(
        ["/bin/bash", str(dl_nontty / "scripts" / "download_models.sh")],
        cwd=str(dl_nontty),
        env=test_env,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert nontty_proc.returncode == 0, nontty_proc.stderr
    assert "unbound variable" not in nontty_proc.stderr
    manifest_nontty = json.loads((dl_nontty / "models" / "manifest.json").read_text(encoding="utf-8"))
    assert "qwen3.5-9b-q6_k" in manifest_nontty["installed_models"]

    # Interactive PTY prompt test under /bin/bash
    dl_pty = tmp_path / "dl_pty"
    (dl_pty / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT_DIR / "scripts" / "download_models.sh", dl_pty / "scripts" / "download_models.sh")
    master_fd, slave_fd = pty.openpty()
    try:
        pty_proc = subprocess.Popen(
            ["/bin/bash", str(dl_pty / "scripts" / "download_models.sh")],
            cwd=str(dl_pty),
            env=test_env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        os.close(slave_fd)

    os.write(master_fd, b"1\n")
    pty_chunks: list[bytes] = []
    while True:
        try:
            chunk = os.read(master_fd, 4096)
            if not chunk:
                break
            pty_chunks.append(chunk)
        except OSError:
            break
    os.close(master_fd)
    pty_rc = pty_proc.wait(timeout=15)
    pty_out = b"".join(pty_chunks).decode("utf-8", errors="replace")
    assert pty_rc == 0, pty_out
    assert "unbound variable" not in pty_out
    manifest_pty = json.loads((dl_pty / "models" / "manifest.json").read_text(encoding="utf-8"))
    assert "qwen3.5-4b-q6_k" in manifest_pty["installed_models"]

    # 3b. setup.sh with NO args (empty dl_args) under /bin/bash 3.2 set -euo pipefail
    setup_proj = tmp_path / "setup_proj"
    (setup_proj / "scripts").mkdir(parents=True, exist_ok=True)
    (setup_proj / "adk_backend").mkdir(parents=True, exist_ok=True)
    (setup_proj / "adk_backend" / "requirements.txt").write_text("", encoding="utf-8")
    shutil.copy2(ROOT_DIR / "scripts" / "setup.sh", setup_proj / "scripts" / "setup.sh")
    shutil.copy2(ROOT_DIR / "scripts" / "download_models.sh", setup_proj / "scripts" / "download_models.sh")

    setup_proc = subprocess.run(
        ["/bin/bash", str(setup_proj / "scripts" / "setup.sh")],
        cwd=str(setup_proj),
        env=test_env,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert setup_proc.returncode == 0, setup_proc.stderr + "\n" + setup_proc.stdout
    assert "unbound variable" not in setup_proc.stderr
    assert (setup_proj / "adk_backend" / ".venv" / ".echo-location").read_text(encoding="utf-8").strip() == str(
        setup_proj.resolve()
    )

    # 3c. install.sh: deleted-cwd detection + end-to-end local git clone with preserved .venv
    deleted_cwd = tmp_path / "deleted_cwd"
    deleted_cwd.mkdir(parents=True, exist_ok=True)
    gone_proc = subprocess.run(
        [
            "/bin/bash",
            "-c",
            f'cd "{deleted_cwd}" && rmdir "{deleted_cwd}" && exec /bin/bash "{ROOT_DIR / "scripts" / "install.sh"}"',
        ],
        env=test_env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert gone_proc.returncode != 0
    assert "cd .." in gone_proc.stderr

    src_repo = tmp_path / "src_repo"
    (src_repo / "scripts").mkdir(parents=True, exist_ok=True)
    (src_repo / "adk_backend").mkdir(parents=True, exist_ok=True)
    (src_repo / "adk_backend" / "requirements.txt").write_text("", encoding="utf-8")
    shutil.copy2(ROOT_DIR / "scripts" / "setup.sh", src_repo / "scripts" / "setup.sh")
    shutil.copy2(ROOT_DIR / "scripts" / "download_models.sh", src_repo / "scripts" / "download_models.sh")
    subprocess.run(["git", "init", "-q"], cwd=str(src_repo), check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(src_repo), check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(src_repo), check=True)
    subprocess.run(["git", "add", "."], cwd=str(src_repo), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(src_repo), check=True)

    install_dest = tmp_path / "installed_echo"
    install_env = test_env.copy()
    install_env["ECHO_REPO_URL"] = src_repo.as_uri()
    install_proc = subprocess.run(
        ["/bin/bash", str(ROOT_DIR / "scripts" / "install.sh"), "--non-interactive", str(install_dest)],
        cwd=str(tmp_path),
        env=install_env,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        capture_output=True,
        text=True,
        timeout=25,
        check=False,
    )
    assert install_proc.returncode == 0, install_proc.stderr + "\n" + install_proc.stdout
    assert (install_dest / "adk_backend" / ".venv" / "bin" / "python").is_file()
    assert (install_dest / ".installed-commit").is_file()
    assert "./scripts/start_all.sh" in install_proc.stdout


def test_tailscale_access_guard_blocks_remote_when_disabled(client: TestClient):
    """When tailscale_enabled is False, remote Tailscale requests receive 403 while localhost stays 200."""
    r_disable = client.post("/api/system/settings", json={"tailscale_enabled": False})
    assert r_disable.status_code == 200
    assert r_disable.json()["settings"]["tailscale_enabled"] is False

    remote_header_variants = [
        {"X-Forwarded-For": "100.124.136.6"},
        {"Host": "100.124.136.6:3000"},
    ]

    for hdrs in remote_header_variants:
        r_mat = client.get("/api/materials", headers=hdrs)
        assert r_mat.status_code == 403
        assert "Tailscale remote access is disabled" in r_mat.json()["detail"]

        r_tf = client.post(
            "/api/transcript/fetch",
            json={"urlOrId": "invalid", "stream": False},
            headers=hdrs,
        )
        assert r_tf.status_code == 403
        assert "Tailscale remote access is disabled" in r_tf.json()["detail"]

        r_mcp_post = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            headers=hdrs,
        )
        assert r_mcp_post.status_code == 403
        assert r_mcp_post.json()["error"]["code"] == -32001

        r_mcp_get = client.get("/mcp", headers=hdrs)
        assert r_mcp_get.status_code == 403
        assert r_mcp_get.json()["error"]["code"] == -32001

    # Local loopback requests continue to succeed with tailscale_enabled=False
    for local_hdrs in (
        {},
        {"Host": "localhost:5173", "X-Forwarded-For": "127.0.0.1"},
        {"Host": "127.0.0.1:3000", "X-Forwarded-For": "::1"},
    ):
        assert client.get("/api/materials", headers=local_hdrs).status_code == 200
        assert (
            client.post(
                "/mcp",
                json={"jsonrpc": "2.0", "id": 2, "method": "ping"},
                headers=local_hdrs,
            ).status_code
            == 200
        )

    # Re-enabling Tailscale restores remote access
    r_enable = client.post("/api/system/settings", json={"tailscale_enabled": True})
    assert r_enable.status_code == 200
    assert r_enable.json()["settings"]["tailscale_enabled"] is True

    for hdrs in remote_header_variants:
        assert client.get("/api/materials", headers=hdrs).status_code == 200
        assert (
            client.post(
                "/mcp",
                json={"jsonrpc": "2.0", "id": 3, "method": "ping"},
                headers=hdrs,
            ).status_code
            == 200
        )
        # Reaches transcript route (returns 400 for invalid URL instead of 403 guard)
        r_tf_ok = client.post(
            "/api/transcript/fetch",
            json={"urlOrId": "invalid", "stream": False},
            headers=hdrs,
        )
        assert r_tf_ok.status_code == 400


def test_coaching_agent_is_tool_free_and_falls_back_on_timeout(monkeypatch: pytest.MonkeyPatch):
    """Lightweight coaching agent has no tools and falls back deterministically on timeout."""
    from adk_backend.agents import shadowing_agent

    agent = shadowing_agent.create_coaching_agent()
    assert agent.tools == []
    assert "/no_think" in agent.instruction

    captured_prompts: list[str] = []

    async def slow_execute_json(*, agent, prompt: str, initial_state=None, schema_model=None):
        captured_prompts.append(prompt)
        raise asyncio.TimeoutError("simulated slow local CPU")

    monkeypatch.setattr(shadowing_agent, "execute_adk_agent_json", slow_execute_json)

    long_text = "word " * 120
    det = shadowing_agent.create_deterministic_shadowing_report(
        target_text=long_text,
        spoken_text="word " * 10,
        language="en",
        mode="simultaneous",
        duration_sec=10.0,
        target_duration_sec=12.0,
        simulated_take=True,
    )
    res = asyncio.run(
        shadowing_agent.generate_coaching_and_merge(det, language="en", mode="simultaneous")
    )
    assert res["coachingSource"] == "deterministic_fallback"
    assert res["status"] == "partial_coaching"
    assert res["scoreExplanation"]
    assert len(captured_prompts) == 1
    payload_str = captured_prompts[0].split("<shadowing_evidence>\n", 1)[1].rsplit("\n</shadowing_evidence>", 1)[0]
    payload = json.loads(payload_str)
    assert len(payload["targetText"]) <= 240
    assert len(payload["recognizedText"]) <= 240
    assert len(payload["mismatchedWords"]) <= 8


def test_pitch_contour_caps_frames_and_analyze_skips_whisper_and_forwards_window(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """Pitch contour caps evaluated frames on long audio, and /analyze skips Whisper when recognized_text is given."""
    import io
    import math
    import time
    import wave
    from array import array
    from adk_backend.agents import shadowing_agent
    from adk_backend.routes import shadowing_routes
    from adk_backend.tools import whisper_tools

    # 1. 120s @ 16kHz synthetic voiced wave -> _extract_pitch_contour stays fast & <= 205 voiced frames
    sr = 16000
    one_sec = [int(10000 * math.sin(2.0 * math.pi * 160.0 * i / sr)) for i in range(sr)]
    long_samples = array("h", one_sec * 120)
    t0 = time.perf_counter()
    contour_res = whisper_tools._extract_pitch_contour(long_samples, sr)
    elapsed = time.perf_counter() - t0
    assert elapsed < 1.5
    assert 50 <= contour_res["voicedFrames"] <= 205
    assert len(contour_res["pitchContour"]) <= 120

    # 2. /api/shadowing/analyze skips transcribe_audio_with_whisper when recognized_text is provided
    #    and forwards start_sec / end_sec to compare_with_reference_wav
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(array("h", one_sec * 2).tobytes())
    wav_bytes = buf.getvalue()

    whisper_calls = 0
    captured_window: list[tuple[float | None, float | None]] = []

    async def fail_if_called(*args, **kwargs):
        nonlocal whisper_calls
        whisper_calls += 1
        raise AssertionError("transcribe_audio_with_whisper must not run when recognized_text is non-empty")

    def fake_compare(learner_acoustics, video_id=None, start_sec=None, end_sec=None):
        captured_window.append((start_sec, end_sec))
        return {"hasReference": False, "referencePitchContour": []}

    async def fake_adk(*args, **kwargs):
        return {
            "scoreExplanation": "Good pacing.",
            "pronunciationFeedback": [],
            "intonationTips": ["Steady pitch."],
            "improvementSuggestions": ["Keep going."],
        }

    monkeypatch.setattr(shadowing_routes, "transcribe_audio_with_whisper", fail_if_called)
    monkeypatch.setattr(shadowing_routes, "compare_with_reference_wav", fake_compare)
    monkeypatch.setattr(shadowing_agent, "execute_adk_agent_json", fake_adk)

    resp = client.post(
        "/api/shadowing/analyze",
        data={
            "target_text": "Hello and welcome to EchoLearning.",
            "language": "en",
            "mode": "simultaneous",
            "recognized_text": "Hello and welcome to EchoLearning",
            "video_id": "dQw4w9WgXcQ",
            "start_sec": "12.5",
            "end_sec": "24.0",
        },
        files={"audio": ("take.wav", wav_bytes, "audio/wav")},
    )
    assert resp.status_code == 200
    assert whisper_calls == 0
    assert captured_window == [(12.5, 24.0)]


def test_long_simultaneous_wav_with_long_pause_not_marked_silent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Long Simultaneous WAV with clear speech followed by long silence reports isSilent=False and valid rmsDb."""
    import math
    import wave
    from array import array
    import httpx
    from adk_backend.tools import whisper_tools

    sr = 16000
    # 2 seconds of clear voiced speech (~160 Hz) followed by 38 seconds of silence -> silenceRatio ~0.95 > 0.94
    speech_samples = [
        int(12000 * math.sin(2.0 * math.pi * 160.0 * i / sr))
        for i in range(sr * 2)
    ]
    silence_samples = [0] * (sr * 38)
    combined = array("h", speech_samples + silence_samples)

    wav_path = tmp_path / "long_simultaneous.wav"
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(combined.tobytes())

    acoustics = whisper_tools.analyze_wav_acoustics(wav_path)
    assert acoustics["isValidWav"] is True
    assert acoustics["silenceRatio"] > 0.94
    assert acoustics["voicedFrames"] >= 5
    assert acoustics["isSilent"] is False
    assert acoustics["rmsDb"] >= -46.0

    # Also verify transcribe_audio_with_whisper formats ReadTimeout without empty string
    class TimeoutClient:
        def __init__(self, *args, **kwargs):
            self.timeout = kwargs.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            raise httpx.ReadTimeout("")

    monkeypatch.setattr(whisper_tools.httpx, "AsyncClient", TimeoutClient)
    err_res = asyncio.run(whisper_tools.transcribe_audio_with_whisper(wav_path, language="en"))
    assert err_res["whisperOnline"] is False
    assert err_res["error"] == "ReadTimeout"
