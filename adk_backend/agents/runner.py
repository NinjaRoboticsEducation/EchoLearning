import json
import logging
import re
import uuid
from typing import Any, TypeVar

from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel

logger = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

APP_NAME = "echosense_local_adk"
_session_service = InMemorySessionService()

THINK_BLOCK_REGEX = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def extract_clean_json(raw_text: str) -> dict[str, Any]:
    """Strips <think>...</think> blocks, markdown fences, and parses outermost JSON object."""
    cleaned = THINK_BLOCK_REGEX.sub("", raw_text or "").strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
    cleaned = cleaned.removesuffix("```")
    cleaned = cleaned.strip()

    # Locate outermost JSON object { ... }
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        cleaned = cleaned[first_brace : last_brace + 1]

    return json.loads(cleaned)


async def execute_adk_agent_json(
    agent: LlmAgent,
    prompt: str,
    initial_state: dict[str, Any] | None = None,
    schema_model: type[T] | None = None,
    user_id: str = "local_learner",
) -> dict[str, Any]:
    """Executes an ADK 2.x LlmAgent with ephemeral session state and guaranteed cleanup.

    Automatically retries once if the local model outputs malformed JSON.
    """
    session_id = f"sess_{uuid.uuid4().hex[:12]}"
    await _session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        state=initial_state or {},
    )

    runner = Runner(
        agent=agent,
        app_name=APP_NAME,
        session_service=_session_service,
    )

    try:
        current_prompt = prompt
        for attempt in range(2):
            content = types.Content(
                role="user",
                parts=[types.Part(text=current_prompt)],
            )
            final_text = ""
            async for event in runner.run_async(
                user_id=user_id,
                session_id=session_id,
                new_message=content,
            ):
                if event.is_final_response() and event.content and event.content.parts:
                    text_parts = [p.text for p in event.content.parts if getattr(p, "text", None)]
                    if text_parts:
                        final_text = "\n".join(text_parts).strip()

            try:
                parsed = extract_clean_json(final_text)
                if schema_model is not None:
                    validated = schema_model.model_validate(parsed)
                    return validated.model_dump()
                return parsed
            except Exception as parse_err:
                logger.warning(
                    f"JSON validation attempt {attempt + 1} failed for {agent.name}: {parse_err}"
                )
                current_prompt = (
                    f"Your previous response had a JSON formatting error: {parse_err}. "
                    "Please respond ONLY with a valid raw JSON object matching the required keys."
                )
        raise ValueError(f"Agent {agent.name} failed to return valid JSON after retry.")
    finally:
        # Prevent memory leaks by deleting the ephemeral session (and its audio state)
        try:
            await _session_service.delete_session(
                app_name=APP_NAME,
                user_id=user_id,
                session_id=session_id,
            )
        except Exception:
            pass
