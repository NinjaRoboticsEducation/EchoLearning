import io
import json
import math
import struct
import wave
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from adk_backend import db
from adk_backend.main import app
from adk_backend.mcp_server import (
    export_study_data,
    get_capabilities,
    list_history,
    list_materials,
    list_vocabulary,
    lookup_word,
    retokenize_text,
    save_vocabulary,
)
from adk_backend.tools.whisper_tools import (
    analyze_wav_acoustics,
    compute_deterministic_word_diff,
    count_japanese_moras,
    evaluate_acoustics_and_alignment,
)


def _make_wav_bytes(
    duration_sec: float = 1.5,
    sample_rate: int = 16000,
    nchannels: int = 1,
    sampwidth: int = 2,
    amplitude: float = 0.3,
    f0_start: float = 140.0,
    f0_end: float = 210.0,
    noise_only: bool = False,
) -> bytes:
    """Generates deterministic synthetic PCM WAV bytes in memory."""
    buf = io.BytesIO()
    n_frames = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(nchannels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)

        frames = bytearray()
        phase = 0.0
        for i in range(n_frames):
            t = i / float(sample_rate)
            frac = i / float(max(1, n_frames - 1))
            if amplitude <= 0.0:
                val = 0
            elif noise_only:
                # Deterministic pseudo-random aperiodic noise
                pseudo = math.sin(i * 12.9898) * 43758.5453
                val = int(((pseudo - math.floor(pseudo)) * 2.0 - 1.0) * amplitude * 32767)
            else:
                freq = f0_start + (f0_end - f0_start) * math.sin(math.pi * frac)
                phase += 2.0 * math.pi * freq / sample_rate
                env = 0.5 + 0.5 * math.sin(2.0 * math.pi * 2.5 * t)
                val = int(math.sin(phase) * amplitude * env * 32767)

            val = max(-32767, min(32767, val))
            for _ in range(nchannels):
                if sampwidth == 2:
                    frames.extend(struct.pack("<h", val))
                elif sampwidth == 3:
                    b3 = struct.pack("<i", val << 8)[:3]
                    frames.extend(b3)
        wf.writeframes(bytes(frames))
    return buf.getvalue()


@pytest.fixture()
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Isolates SQLite DB and audio directory per test."""
    db_path = tmp_path / "test_echolearning.sqlite3"
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("ECHOLEARNING_DB_PATH", str(db_path))
    monkeypatch.setenv("ECHOLEARNING_AUDIO_DIR", str(audio_dir))
    db.init_db(db_path)
    return db_path


def test_r11_analyze_wav_acoustics_rejects_corrupt_and_non_mono(tmp_path: Path):
    """R11: Stereo, 24-bit, and corrupt WAVs must return isValidWav=False, isSilent=True."""
    # 1. Stereo WAV
    stereo_path = tmp_path / "stereo.wav"
    stereo_path.write_bytes(_make_wav_bytes(duration_sec=1.2, nchannels=2, sampwidth=2))
    res_stereo = analyze_wav_acoustics(stereo_path)
    assert res_stereo["isValidWav"] is False
    assert res_stereo["isSilent"] is True
    assert "nchannels=2" in res_stereo.get("error", "")

    # 2. 24-bit WAV
    bit24_path = tmp_path / "bit24.wav"
    bit24_path.write_bytes(_make_wav_bytes(duration_sec=1.2, nchannels=1, sampwidth=3))
    res_24 = analyze_wav_acoustics(bit24_path)
    assert res_24["isValidWav"] is False
    assert res_24["isSilent"] is True

    # 3. Corrupt garbage bytes
    corrupt_path = tmp_path / "corrupt.wav"
    corrupt_path.write_bytes(b"RIFF\x00\x00\x00\x00WAVEnot_valid_chunks")
    res_corrupt = analyze_wav_acoustics(corrupt_path)
    assert res_corrupt["isValidWav"] is False
    assert res_corrupt["isSilent"] is True
    assert res_corrupt["rmsDb"] == -90.0


def test_pitch_contour_and_japanese_mora_calculation(tmp_path: Path):
    """Verifies F0 contour extraction on voiced audio and accurate Japanese mora counts."""
    voiced_path = tmp_path / "voiced.wav"
    voiced_path.write_bytes(
        _make_wav_bytes(duration_sec=1.5, amplitude=0.35, f0_start=130.0, f0_end=220.0)
    )
    acoustics = analyze_wav_acoustics(voiced_path)
    assert acoustics["isValidWav"] is True
    assert acoustics["isSilent"] is False
    assert acoustics["durationSec"] == pytest.approx(1.5, abs=0.05)
    assert acoustics["voicedFrames"] >= 20
    assert len(acoustics["pitchContour"]) >= 20
    assert acoustics["f0StdHz"] > 5.0

    # Japanese mora tests via fugashi
    assert count_japanese_moras("きょう") == 2
    assert count_japanese_moras("がっこう") == 4
    assert count_japanese_moras("コンピューター") == 6


def test_deterministic_scoring_and_insertion_penalty(tmp_path: Path):
    """R03/R07: Exact match > partial overlap; insertions reduce accuracy; monotone < modulated prosody."""
    voiced_path = tmp_path / "modulated.wav"
    voiced_path.write_bytes(
        _make_wav_bytes(duration_sec=2.0, amplitude=0.35, f0_start=135.0, f0_end=215.0)
    )
    acoustics_mod = analyze_wav_acoustics(voiced_path)

    mono_path = tmp_path / "monotone.wav"
    mono_path.write_bytes(
        _make_wav_bytes(duration_sec=2.0, amplitude=0.35, f0_start=150.0, f0_end=150.0)
    )
    acoustics_mono = analyze_wav_acoustics(mono_path)

    target = "We often underestimate how daily rhythm shapes fluency."
    full_eval = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=target,
        language="en",
        duration_sec=2.0,
        target_duration_sec=2.0,
        acoustics=acoustics_mod,
    )
    partial_eval = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text="We underestimate daily shapes",
        language="en",
        duration_sec=2.0,
        target_duration_sec=2.0,
        acoustics=acoustics_mod,
    )
    mono_eval = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=target,
        language="en",
        duration_sec=2.0,
        target_duration_sec=2.0,
        acoustics=acoustics_mono,
    )

    assert full_eval["accuracyScore"] == 100.0
    assert full_eval["overallScore"] > partial_eval["overallScore"]
    assert full_eval["prosodyScore"] > mono_eval["prosodyScore"]

    # Verify exact weighted formula: 0.35*acc + 0.25*flu + 0.25*pron + 0.15*prosody
    expected_overall = round(
        0.35 * full_eval["accuracyScore"]
        + 0.25 * full_eval["fluencyScore"]
        + 0.25 * full_eval["pronunciationScore"]
        + 0.15 * full_eval["prosodyScore"],
        1,
    )
    assert full_eval["overallScore"] == expected_overall

    # Verify R07 insertion penalty
    ins_diff = compute_deterministic_word_diff("hello", "hello extra unrelated words", "en")
    assert ins_diff["contentAccuracyEstimate"] < 100.0
    assert ins_diff["insertedCount"] == 3


def test_silent_and_short_wav_hard_gate(
    isolated_db: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """R01/R02/R03: Silent, short (<0.8s), and corrupt WAVs trigger 0-score hard gate and bypass LLM."""
    llm_called = False

    async def fake_execute_adk(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal llm_called
        llm_called = True
        return {"scoreExplanation": "Should never run on hard gate."}

    monkeypatch.setattr("adk_backend.agents.shadowing_agent.execute_adk_agent_json", fake_execute_adk)

    client = TestClient(app)

    # 1. Pure silent WAV
    silent_bytes = _make_wav_bytes(duration_sec=1.5, amplitude=0.0)
    resp = client.post(
        "/api/shadowing/analyze",
        data={"target_text": "Hello world", "language": "en"},
        files={"audio": ("silent.wav", silent_bytes, "audio/wav")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["overallScore"] == 0
    assert data["accuracyScore"] == 0
    assert data["fluencyScore"] == 0
    assert data["pronunciationScore"] == 0
    assert data["prosodyScore"] == 0
    assert data["intonationScore"] == 0
    assert data["rhythmScore"] == 0
    assert all(w["status"] == "missing" for w in data["wordAnalysis"])
    assert llm_called is False

    # 2. Short WAV (< 0.8s)
    short_bytes = _make_wav_bytes(duration_sec=0.4, amplitude=0.35)
    resp_short = client.post(
        "/api/shadowing/analyze",
        data={"target_text": "Hello world", "language": "en", "recognized_text": "Hello world"},
        files={"audio": ("short.wav", short_bytes, "audio/wav")},
    )
    assert resp_short.status_code == 200
    assert resp_short.json()["overallScore"] == 0
    assert llm_called is False

    # 3. Corrupt WAV
    resp_bad = client.post(
        "/api/shadowing/analyze",
        data={"target_text": "Hello world", "language": "en"},
        files={"audio": ("bad.wav", b"not-a-wav", "audio/wav")},
    )
    assert resp_bad.status_code == 200
    assert resp_bad.json()["overallScore"] == 0
    assert resp_bad.json()["isValidWav"] is False
    assert llm_called is False


def test_shadowing_transcribe_and_analyze_endpoints(
    isolated_db: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """Tests /api/shadowing/transcribe preview and /api/shadowing/analyze with LLM score override."""

    async def fake_whisper(wav_path: Path, language: str = "en") -> dict[str, Any]:
        return {
            "text": "Hello and welcome to EchoLearning",
            "words": [
                {"word": "Hello", "probability": 0.96},
                {"word": "welcome", "probability": 0.94},
            ],
            "meanConfidence": 0.95,
            "whisperOnline": True,
        }

    async def fake_adk(*args: Any, **kwargs: Any) -> dict[str, Any]:
        # Even if LLM attempts to return bogus score fields, deterministic values must win
        return {
            "scoreExplanation": "Clear articulation and natural pitch sweep.",
            "feedback": "Clear articulation and natural pitch sweep.",
            "pronunciationFeedback": [],
            "intonationTips": ["Good rising-falling contour."],
            "improvementSuggestions": ["Keep steady pacing."],
            "actionableImprovements": ["Keep steady pacing."],
            "recommendedRetryText": "Hello and welcome to EchoLearning.",
        }

    monkeypatch.setattr("adk_backend.routes.shadowing_routes.transcribe_audio_with_whisper", fake_whisper)
    monkeypatch.setattr("adk_backend.agents.shadowing_agent.execute_adk_agent_json", fake_adk)

    client = TestClient(app)
    voiced_bytes = _make_wav_bytes(duration_sec=2.0, amplitude=0.35, f0_start=135.0, f0_end=210.0)

    # 1. S05 preview endpoint
    t_resp = client.post(
        "/api/shadowing/transcribe",
        data={"language": "en", "target_text": "Hello and welcome to EchoLearning."},
        files={"audio": ("take.wav", voiced_bytes, "audio/wav")},
    )
    assert t_resp.status_code == 200
    t_data = t_resp.json()
    assert t_data["recognizedText"] == "Hello and welcome to EchoLearning"
    assert t_data["isSilent"] is False
    assert t_data["durationSec"] == pytest.approx(2.0, abs=0.1)
    assert t_data["rmsDb"] > -48.0
    assert isinstance(t_data["pitchContour"], list)
    assert len(t_data["pitchContour"]) >= 10

    # 2. S06 analyze endpoint + SQLite recording persistence
    a_resp = client.post(
        "/api/shadowing/analyze",
        data={
            "target_text": "Hello and welcome to EchoLearning.",
            "language": "en",
            "mode": "listen_repeat",
            "recognized_text": "Hello and welcome to EchoLearning",
            "video_id": "dQw4w9WgXcQ",
        },
        files={"audio": ("take.wav", voiced_bytes, "audio/wav")},
    )
    assert a_resp.status_code == 200
    a_data = a_resp.json()
    assert a_data["overallScore"] >= 75.0
    assert a_data["accuracyScore"] == 100.0
    assert a_data["recordingId"] is not None
    assert a_data["feedback"] == "Clear articulation and natural pitch sweep."
    assert len(a_data["pitchContour"]) >= 10


@pytest.mark.asyncio
async def test_mcp_tools_and_http_endpoint(
    isolated_db: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """Verifies MCP tools (capabilities, retokenize, lookup, vocab, materials, export) and /mcp HTTP."""
    caps = get_capabilities()
    assert "en" in caps["learningLanguages"]
    assert "ja" in caps["learningLanguages"]
    assert "retokenize_text" in caps["tools"]
    assert "fetch_transcript" in caps["tools"]

    retok = retokenize_text("言葉のリズム", "ja")
    surfaces = [t.surface for t in retok.tokens]
    assert "言葉" in surfaces
    assert retok.tokens[0].reading == "ことば"

    async def fake_lookup(word: str, sentence: str = "", language: str = "en") -> dict[str, Any]:
        return {
            "word": word,
            "lemma": word,
            "language": language,
            "reading": "ことば" if language == "ja" else "/wɜːrd/",
            "partOfSpeech": "noun",
            "contextualMeaning": "word or speech",
            "dictionaryDefinitions": ["word"],
            "isDegraded": False,
        }

    monkeypatch.setattr("adk_backend.agents.dictionary_agent.lookup_word_with_agent", fake_lookup)
    looked = await lookup_word(word="言葉", sentence="言葉のリズム", language="ja")
    assert looked["word"] == "言葉"
    assert looked["reading"] == "ことば"

    saved_v = save_vocabulary(word="rhythm", definition="regular repeated pattern", language="en")
    assert saved_v["status"] == "saved"
    vocab_list = list_vocabulary(language="en")
    assert vocab_list["count"] == 1
    assert vocab_list["items"][0]["word"] == "rhythm"

    db.save_material(
        {
            "videoId": "abc12345678",
            "title": "Sample Lesson",
            "language": "en",
            "segments": [{"id": "s1", "index": 0, "startTime": 0.0, "endTime": 2.0, "text": "Hello."}],
        }
    )
    mats = list_materials()
    assert mats["count"] == 1
    assert mats["materials"][0]["videoId"] == "abc12345678"

    hist = list_history()
    assert hist["count"] == 0

    exported = export_study_data(format="json")
    assert len(exported["materials"]) == 1
    assert len(exported["vocabulary"]) == 1

    # Verify HTTP /mcp JSON-RPC endpoint and enhanced /api/health
    client = TestClient(app)

    h_resp = client.get("/api/health")
    assert h_resp.status_code == 200
    h_data = h_resp.json()
    assert h_data["sqliteReady"] is True
    assert h_data["mcpReady"] is True
    assert "activeModel" in h_data
    assert "whisperReady" in h_data
    assert "llamaReady" in h_data

    mcp_info_resp = client.get("/mcp")
    assert mcp_info_resp.status_code == 200
    assert mcp_info_resp.json()["enabled"] is True
    assert "retokenize_text" in mcp_info_resp.json()["tools"]

    # When toggled off in Settings -> 403
    off_resp = client.post("/api/system/settings", json={"mcpHttpEnabled": False})
    assert off_resp.status_code == 200
    assert off_resp.json()["mcp"]["httpEnabled"] is False

    disabled_resp = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}},
    )
    assert disabled_resp.status_code == 403

    # Re-enable HTTP MCP via Settings API
    toggle_resp = client.post("/api/system/settings", json={"mcpHttpEnabled": True})
    assert toggle_resp.status_code == 200
    assert toggle_resp.json()["mcp"]["httpEnabled"] is True

    init_resp = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
    )
    assert init_resp.status_code == 200
    assert init_resp.json()["result"]["serverInfo"]["name"] == "EchoLearning"

    list_resp = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert list_resp.status_code == 200
    tool_names = [t["name"] for t in list_resp.json()["result"]["tools"]]
    assert "get_capabilities" in tool_names
    assert "retokenize_text" in tool_names

    call_resp = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "retokenize_text", "arguments": {"text": "言葉", "language": "ja"}},
        },
    )
    assert call_resp.status_code == 200
    call_json = call_resp.json()
    assert call_json["result"]["isError"] is False
    parsed_content = json.loads(call_json["result"]["content"][0]["text"])
    assert parsed_content["tokens"][0]["reading"] == "ことば"
