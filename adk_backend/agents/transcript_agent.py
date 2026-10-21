import re
from typing import Any

from google.adk.agents import LlmAgent

from . import get_local_model
from .runner import execute_adk_agent_json

TRANSCRIPT_AGENT_INSTRUCTION = """You are an expert language curriculum specialist and linguist.
Your job is to repair punctuation and sentence boundaries in raw auto-generated speech recognition transcripts
and estimate learning difficulty level (Beginner, Intermediate, Advanced).

Always respond with clean, valid JSON matching the user's prompt request.
"""


def create_transcript_agent() -> LlmAgent:
    """Creates the ADK 2.x TranscriptAgent."""
    return LlmAgent(
        name="transcript_agent",
        model=get_local_model(temperature=0.1),
        instruction=TRANSCRIPT_AGENT_INSTRUCTION,
        tools=[],
    )


async def estimate_transcript_level(
    sample_text: str,
    language: str,
) -> str:
    """Estimates difficulty level for a transcript excerpt (Beginner / Intermediate / Advanced)."""
    if not sample_text.strip():
        return "Intermediate"

    prompt = (
        f"Language: {language}\n"
        f'Sample text: "{sample_text[:500]}"\n'
        "Estimate the learner difficulty level for this material. "
        'Respond ONLY with a JSON object: {"level": "Beginner" | "Intermediate" | "Advanced"}'
    )

    try:
        agent = create_transcript_agent()
        res = await execute_adk_agent_json(agent=agent, prompt=prompt)
        level = res.get("level")
        if level in ("Beginner", "Intermediate", "Advanced"):
            return level
    except Exception as exc:
        print(f"estimate_transcript_level fallback: {exc}")

    # Deterministic heuristic fallback based on average sentence/word length
    words = sample_text.split() if language == "en" else list(sample_text)
    if len(words) < 20:
        return "Beginner"
    if any(len(w) > 9 for w in words):
        return "Advanced"
    return "Intermediate"


def merge_caption_lines_into_complete_segments(
    raw_lines: list[dict[str, Any]],
    language: str,
) -> list[dict[str, Any]]:
    """Deterministically merges fragmented 2-4s YouTube caption lines into natural grammatical sentences.

    Matches the exact proven algorithm from server.ts (lines 100-240):
    - maxChars: 58 for JA, 130 for EN
    - maxDuration: 10.5 seconds
    - minDuration: 2.2 seconds
    - Sentence terminators: [.?!。！？]
    """
    if not raw_lines:
        return []

    is_ja = language == "ja"
    max_chars = 58 if is_ja else 130
    max_dur = 10.5
    min_dur = 2.2
    terminator_re = re.compile(r"[。！？.?!]$")

    segments: list[dict[str, Any]] = []
    current_text = ""
    start_time = float(raw_lines[0].get("start", 0.0))
    current_end = start_time + float(raw_lines[0].get("dur", 2.5))

    for line in raw_lines:
        txt = (line.get("text") or "").strip()
        if not txt:
            continue
        line_start = float(line.get("start", 0.0))
        line_dur = float(line.get("dur", 2.5))
        line_end = line_start + line_dur

        if not current_text:
            current_text = txt
            start_time = line_start
            current_end = line_end
            continue

        accum_dur = line_end - start_time
        accum_len = len(current_text) + (0 if is_ja else 1) + len(txt)
        has_terminator = bool(terminator_re.search(current_text))

        should_split = False
        if (
            has_terminator
            and accum_dur >= min_dur
            or accum_dur >= max_dur
            or accum_len >= max_chars
            and accum_dur >= min_dur
        ):
            should_split = True

        if should_split:
            segments.append(
                {
                    "startTime": round(start_time, 2),
                    "endTime": round(current_end, 2),
                    "text": current_text,
                }
            )
            current_text = txt
            start_time = line_start
            current_end = line_end
        else:
            sep = "" if is_ja else " "
            current_text = f"{current_text}{sep}{txt}"
            current_end = max(current_end, line_end)

    if current_text:
        segments.append(
            {
                "startTime": round(start_time, 2),
                "endTime": round(current_end, 2),
                "text": current_text,
            }
        )

    return segments
