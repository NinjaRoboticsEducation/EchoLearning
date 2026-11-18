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
    count_english_syllables,
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


def _make_modulated_pitch_wav(
    median_hz: float,
    std_st: float | None = None,
    std_hz: float | None = None,
    duration_sec: float = 2.0,
    sample_rate: int = 16000,
    amplitude: float = 0.35,
) -> bytes:
    """Synthesizes a voiced WAV with controlled Semitone or linear Hz pitch variation."""
    buf = io.BytesIO()
    n_frames = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        phase = 0.0
        for i in range(n_frames):
            t = i / float(sample_rate)
            if std_st is not None:
                amp_st = std_st * math.sqrt(2.0)
                freq = median_hz * (2.0 ** ((amp_st * math.sin(2.0 * math.pi * 1.5 * t)) / 12.0))
            elif std_hz is not None:
                amp_hz = std_hz * math.sqrt(2.0)
                freq = median_hz + amp_hz * math.sin(2.0 * math.pi * 1.5 * t)
            else:
                freq = median_hz
            phase += 2.0 * math.pi * freq / sample_rate
            env = 0.75 + 0.25 * math.sin(2.0 * math.pi * 2.0 * t)
            val = max(-32767, min(32767, int(math.sin(phase) * amplitude * env * 32767)))
            frames.extend(struct.pack("<h", val))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def test_semitone_gender_parity_and_monotone_penalty(tmp_path: Path):
    """Equal 2.5 ST modulation gives male (105 Hz) & female (215 Hz) equal prosody; 10 Hz monotone at 215 Hz is penalized."""
    male_wav = tmp_path / "male_105hz_2_5st.wav"
    female_wav = tmp_path / "female_215hz_2_5st.wav"
    mono_wav = tmp_path / "female_215hz_10hz_mono.wav"

    male_wav.write_bytes(_make_modulated_pitch_wav(median_hz=105.0, std_st=2.5, duration_sec=2.0))
    female_wav.write_bytes(_make_modulated_pitch_wav(median_hz=215.0, std_st=2.5, duration_sec=2.0))
    mono_wav.write_bytes(_make_modulated_pitch_wav(median_hz=215.0, std_hz=10.0, duration_sec=2.0))

    ac_male = analyze_wav_acoustics(male_wav)
    ac_female = analyze_wav_acoustics(female_wav)
    ac_mono = analyze_wav_acoustics(mono_wav)

    assert abs(ac_male["f0StdSt"] - ac_female["f0StdSt"]) <= 0.25
    assert ac_mono["f0StdSt"] < 0.85

    target = "We often underestimate how daily rhythm shapes fluency."
    eval_male = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=target,
        language="en",
        duration_sec=2.0,
        target_duration_sec=2.0,
        acoustics=ac_male,
    )
    eval_female = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=target,
        language="en",
        duration_sec=2.0,
        target_duration_sec=2.0,
        acoustics=ac_female,
    )
    eval_mono = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=target,
        language="en",
        duration_sec=2.0,
        target_duration_sec=2.0,
        acoustics=ac_mono,
    )

    assert abs(eval_male["prosodyScore"] - eval_female["prosodyScore"]) <= 2.0
    assert eval_mono["prosodyScore"] < eval_female["prosodyScore"] - 15.0


def test_low_male_68hz_pitch_floor_preservation(tmp_path: Path):
    """60 Hz pitch floor preserves low 68 Hz male speech with >= 20 voiced frames and valid score."""
    low_wav = tmp_path / "male_68hz.wav"
    low_wav.write_bytes(
        _make_wav_bytes(duration_sec=1.5, amplitude=0.35, f0_start=66.0, f0_end=72.0)
    )
    acoustics = analyze_wav_acoustics(low_wav)
    assert acoustics["isValidWav"] is True
    assert acoustics["isSilent"] is False
    assert acoustics["voicedFrames"] >= 20
    assert 60.0 <= acoustics["f0MedianHz"] <= 76.0

    res = evaluate_acoustics_and_alignment(
        target_text="Good morning.",
        recognized_text="Good morning",
        language="en",
        duration_sec=1.5,
        target_duration_sec=1.5,
        acoustics=acoustics,
    )
    assert res["assessmentStatus"] == "scored"
    assert res["overallScore"] > 50.0


def test_mode_b_long_form_non_collapse_and_duration_latency():
    """3-min Mode B take with 12 clause pauses does not collapse; trailing latency is penalized."""
    clause = "We practice speaking clearly every single morning"
    clauses = [clause] * 32  # 32 * 14 = 448 syllables
    target_text = ", ".join(clauses[:13]) + " " + " ".join(clauses[13:]) + "."
    assert count_english_syllables(target_text) >= 440

    long_acoustics = {
        "isValidWav": True,
        "isSilent": False,
        "durationSec": 180.0,
        "rmsDb": -18.0,
        "energyDb": -18.0,
        "energyDynamicRangeDb": 8.0,
        "pauseCount": 14,  # 12 clause boundaries + 2 unplanned mid-clause hesitations
        "silenceRatio": 0.22,
        "voicedFrames": 180,
        "f0StdHz": 22.0,
        "f0StdSt": 2.4,
        "f0MedianHz": 145.0,
        "pitchContour": [145.0] * 30,
        "peakClipRatio": 0.0,
    }
    res_long = evaluate_acoustics_and_alignment(
        target_text=target_text,
        recognized_text=target_text,
        language="en",
        duration_sec=180.0,
        target_duration_sec=180.0,
        acoustics=long_acoustics,
        mode="simultaneous",
    )
    assert res_long["unplannedPauseCount"] == 2
    assert res_long["fluencyScore"] >= 85.0

    # Trailing recording latency penalty after video ends
    short_target = "Practice makes progress every single day."
    ontime_ac = {
        "isValidWav": True,
        "isSilent": False,
        "durationSec": 10.0,
        "rmsDb": -18.0,
        "energyDb": -18.0,
        "energyDynamicRangeDb": 8.0,
        "pauseCount": 0,
        "silenceRatio": 0.20,
        "voicedFrames": 50,
        "f0StdHz": 22.0,
        "f0StdSt": 2.4,
        "pitchContour": [145.0] * 20,
        "peakClipRatio": 0.0,
    }
    late_ac = {**ontime_ac, "durationSec": 25.0}
    res_ontime = evaluate_acoustics_and_alignment(
        target_text=short_target,
        recognized_text=short_target,
        language="en",
        duration_sec=10.0,
        target_duration_sec=10.0,
        acoustics=ontime_ac,
        mode="simultaneous",
    )
    res_late = evaluate_acoustics_and_alignment(
        target_text=short_target,
        recognized_text=short_target,
        language="en",
        duration_sec=25.0,
        target_duration_sec=10.0,
        acoustics=late_ac,
        mode="simultaneous",
    )
    assert res_late["durationLatencySec"] > 10.0
    assert res_late["fluencyScore"] < res_ontime["fluencyScore"] - 10.0


def test_whisper_boh_hallucination_filter():
    """Whisper Bag-of-Hallucinations phrases with zero target overlap trigger hallucination_filtered gate."""
    noisy_acoustics = {
        "isValidWav": True,
        "isSilent": False,
        "durationSec": 1.6,
        "rmsDb": -28.0,
        "energyDb": -28.0,
        "energyDynamicRangeDb": 4.0,
        "pauseCount": 0,
        "silenceRatio": 0.45,
        "voicedFrames": 8,
        "f0StdHz": 12.0,
        "f0StdSt": 1.5,
        "pitchContour": [140.0] * 8,
        "peakClipRatio": 0.0,
    }
    res_boh = evaluate_acoustics_and_alignment(
        target_text="Practice makes progress.",
        recognized_text="Thank you for watching!",
        language="en",
        duration_sec=1.6,
        target_duration_sec=1.6,
        acoustics=noisy_acoustics,
    )
    assert res_boh["overallScore"] == 0.0
    assert res_boh["hardGateTriggered"] is True
    assert res_boh["assessmentStatus"] == "hallucination_filtered"

    # Real target overlap must NOT be filtered even if target contains phrase
    res_legit = evaluate_acoustics_and_alignment(
        target_text="Thank you for watching today.",
        recognized_text="Thank you for watching",
        language="en",
        duration_sec=1.6,
        target_duration_sec=1.6,
        acoustics=noisy_acoustics,
    )
    assert res_legit["hardGateTriggered"] is False
    assert res_legit["assessmentStatus"] == "scored"


def test_function_word_weights_and_self_repair_non_penalty():
    """EN/JA function words & particles weigh 0.5x vs 1.0x content words; self-repairs charge 0 penalty."""
    en_target = "We finished the new project today."
    en_omit_func = compute_deterministic_word_diff(en_target, "We finished new project today.", "en")
    en_omit_content = compute_deterministic_word_diff(en_target, "We finished the new today.", "en")
    assert en_omit_func["contentAccuracyEstimate"] > en_omit_content["contentAccuracyEstimate"]

    ja_target = "私は毎日静かに本を読みます。"
    ja_omit_particle = compute_deterministic_word_diff(ja_target, "私は毎日静かに本読みます。", "ja")
    ja_omit_content = compute_deterministic_word_diff(ja_target, "私は毎日静かにを読みます。", "ja")
    assert ja_omit_particle["contentAccuracyEstimate"] > ja_omit_content["contentAccuracyEstimate"]

    repair_diff = compute_deterministic_word_diff(
        "We finished the project today.",
        "We finished the pro project today.",
        "en",
    )
    assert repair_diff["repairCount"] == 1
    assert repair_diff["contentAccuracyEstimate"] == 100.0
    assert any(item["status"] == "self_repair" for item in repair_diff["baselineWordDiff"])


def test_mode_adaptive_weights():
    """listen_repeat uses 30/30/20/20 and simultaneous uses 25/20/30/25 while mode=None keeps 35/25/25/15."""
    acoustics = {
        "isValidWav": True,
        "isSilent": False,
        "durationSec": 4.0,
        "rmsDb": -18.0,
        "energyDb": -18.0,
        "energyDynamicRangeDb": 8.0,
        "pauseCount": 0,
        "silenceRatio": 0.15,
        "voicedFrames": 40,
        "f0StdHz": 20.0,
        "f0StdSt": 2.4,
        "pitchContour": [150.0] * 25,
        "peakClipRatio": 0.0,
    }
    target = "We often underestimate how daily rhythm shapes fluency."
    spoken = "We often underestimate daily shapes fluency."  # partial accuracy, high fluency

    res_lr = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=spoken,
        language="en",
        duration_sec=4.0,
        target_duration_sec=4.0,
        acoustics=acoustics,
        mode="listen_repeat",
    )
    res_sim = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=spoken,
        language="en",
        duration_sec=4.0,
        target_duration_sec=4.0,
        acoustics=acoustics,
        mode="simultaneous",
    )
    res_legacy = evaluate_acoustics_and_alignment(
        target_text=target,
        recognized_text=spoken,
        language="en",
        duration_sec=4.0,
        target_duration_sec=4.0,
        acoustics=acoustics,
        mode=None,
    )

    assert res_lr["overallScore"] == round(
        0.30 * res_lr["accuracyScore"]
        + 0.30 * res_lr["pronunciationScore"]
        + 0.20 * res_lr["fluencyScore"]
        + 0.20 * res_lr["prosodyScore"],
        1,
    )
    assert res_sim["overallScore"] == round(
        0.25 * res_sim["accuracyScore"]
        + 0.20 * res_sim["pronunciationScore"]
        + 0.30 * res_sim["fluencyScore"]
        + 0.25 * res_sim["prosodyScore"],
        1,
    )
    assert res_legacy["overallScore"] == round(
        0.35 * res_legacy["accuracyScore"]
        + 0.25 * res_legacy["fluencyScore"]
        + 0.25 * res_legacy["pronunciationScore"]
        + 0.15 * res_legacy["prosodyScore"],
        1,
    )
    assert res_sim["overallScore"] != res_lr["overallScore"]
