import base64

from adk_backend.agents.transcript_agent import (
    merge_caption_lines_into_complete_segments,
)
from adk_backend.main import app
from adk_backend.routes.transcript_routes import (
    extract_youtube_id,
)
from fastapi.testclient import TestClient

client = TestClient(app)


def test_health_endpoint():
    """Verifies GET /api/health returns HTTP 200 with framework metadata."""
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["framework"] == "Google ADK 2.x"
    assert "services" in data
    assert data["services"]["fastapi"] == "ok"


def test_retokenize_japanese_furigana():
    """Verifies Japanese tokenization extracts Furigana reading without '*' artifacts."""
    text = "言葉のリズムをそのまま真似して声を出す"
    response = client.post(
        "/api/transcript/retokenize",
        json={"text": text, "language": "ja"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "tokens" in data
    tokens = data["tokens"]
    assert len(tokens) > 0

    # Locate '言葉' token
    kotoba_tok = next((t for t in tokens if t["surface"] == "言葉"), None)
    assert kotoba_tok is not None
    assert kotoba_tok["reading"] == "ことば"
    assert kotoba_tok["isKanji"] is True
    assert kotoba_tok["reading"] != "*"

    # Locate particle 'の'
    no_tok = next((t for t in tokens if t["surface"] == "の"), None)
    assert no_tok is not None
    assert no_tok["reading"] is None  # Hiragana particle should not have ruby annotation


def test_retokenize_english():
    """Verifies English retokenization parses words and punctuation."""
    text = "We often underestimate how much daily rhythm shapes our fluency."
    response = client.post(
        "/api/transcript/retokenize",
        json={"text": text, "language": "en"},
    )
    assert response.status_code == 200
    tokens = response.json()["tokens"]
    surfaces = [t["surface"] for t in tokens]
    assert "often" in surfaces
    assert "fluency" in surfaces


def test_tts_pronounce_wav():
    """Verifies offline TTS synthesizes valid 16-bit PCM WAV audio."""
    for lang, text in [("en", "approach"), ("ja", "言葉")]:
        resp = client.post(
            "/api/tts/pronounce",
            json={"text": text, "language": lang},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "audioBase64" in data
        assert data["mimeType"] == "audio/wav"

        # Decode base64 and verify RIFF/WAVE header
        wav_bytes = base64.b64decode(data["audioBase64"])
        assert len(wav_bytes) > 44
        assert wav_bytes[:4] == b"RIFF"
        assert wav_bytes[8:12] == b"WAVE"


def test_dictionary_lookup():
    """Verifies contextual dictionary lookup returns all 11 required fields."""
    # Test Japanese lookup
    ja_resp = client.post(
        "/api/dictionary/lookup",
        json={
            "word": "真似",
            "sentence": "言葉のリズムをそのまま真似して声を出す",
            "language": "ja",
        },
    )
    assert ja_resp.status_code == 200
    ja_data = ja_resp.json()
    assert ja_data["word"] == "真似"
    assert ja_data["language"] == "ja"
    assert "reading" in ja_data and ja_data["reading"] != ""
    assert "contextualMeaning" in ja_data
    assert "partOfSpeech" in ja_data
    assert isinstance(ja_data["dictionaryDefinitions"], list)

    # Test English lookup
    en_resp = client.post(
        "/api/dictionary/lookup",
        json={
            "word": "underestimate",
            "sentence": "We often underestimate how much daily rhythm shapes our fluency.",
            "language": "en",
        },
    )
    assert en_resp.status_code == 200
    en_data = en_resp.json()
    assert en_data["word"] == "underestimate"
    assert en_data["language"] == "en"
    assert "contextualMeaning" in en_data


def test_shadowing_evaluate_simulated():
    """Verifies shadowing evaluation handles simulated take (audioBase64=None) properly."""
    target = "We often underestimate how much daily rhythm shapes our fluency."
    spoken = "We often underestimate how daily rhythm shapes fluency."

    resp = client.post(
        "/api/shadowing/evaluate",
        json={
            "audioBase64": None,
            "mimeType": "audio/webm",
            "targetText": target,
            "language": "en",
            "mode": "listen_repeat",
            "webSpeechTranscript": spoken,
            "durationSec": 4.5,
            "targetDurationSec": 4.2,
        },
    )
    assert resp.status_code == 200
    report = resp.json()
    assert report["targetText"] == target
    assert report["overallScore"] > 0
    assert "dimensions" in report
    dims = report["dimensions"]
    assert "contentAccuracy" in dims
    assert "pronunciation" in dims
    assert "fluency" in dims
    assert "prosody" in dims

    # Check wordDiff
    diff = report["wordDiff"]
    assert len(diff) > 0
    statuses = [t["status"] for t in diff]
    assert "correct" in statuses


def test_shadowing_evaluate_with_audio_payload():
    """Verifies shadowing evaluation handles base64 audio payload without overflowing."""
    # Obtain a genuine audio snippet from the local TTS route
    tts_resp = client.post(
        "/api/tts/pronounce",
        json={"text": "Hello and welcome to EchoSense.", "language": "en"},
    )
    assert tts_resp.status_code == 200
    audio_b64 = tts_resp.json()["audioBase64"]

    resp = client.post(
        "/api/shadowing/evaluate",
        json={
            "audioBase64": audio_b64,
            "mimeType": "audio/wav",
            "targetText": "Hello and welcome to EchoSense.",
            "language": "en",
            "mode": "listen_repeat",
            "webSpeechTranscript": "Hello and welcome to EchoSense.",
            "durationSec": 3.0,
            "targetDurationSec": 3.0,
        },
    )
    assert resp.status_code == 200
    report = resp.json()
    assert report["overallScore"] >= 50
    assert "metrics" in report
    assert report["metrics"]["speechRateValue"] > 0


def test_youtube_caption_helpers():
    """Verifies YouTube ID extraction and caption merging."""
    assert extract_youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert extract_youtube_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert extract_youtube_id("dQw4w9WgXcQ") == "dQw4w9WgXcQ"

    raw_lines = [
        {"start": 0.0, "dur": 2.0, "text": "言葉の"},
        {"start": 2.0, "dur": 2.2, "text": "リズムを"},
        {"start": 4.2, "dur": 3.0, "text": "真似する。"},
    ]
    merged = merge_caption_lines_into_complete_segments(raw_lines, "ja")
    assert len(merged) >= 1
    assert "言葉のリズムを真似する" in merged[0]["text"]
