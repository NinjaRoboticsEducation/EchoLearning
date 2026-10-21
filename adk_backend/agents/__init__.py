from google.adk.models.lite_llm import LiteLlm

from ..config import LLAMA_MODEL_NAME, LLAMA_SERVER_URL


def get_local_model(temperature: float = 0.2) -> LiteLlm:
    """Creates a LiteLLM wrapper pointing to local llama-server (Qwen3.5-9B).

    Disables extended <think> monologues via chat_template_kwargs so CPU
    inference starts generating structured JSON immediately.
    """
    return LiteLlm(
        model=f"openai/{LLAMA_MODEL_NAME}",
        api_base=LLAMA_SERVER_URL,
        api_key="local-adk-no-key",
        temperature=temperature,
        extra_body={
            "chat_template_kwargs": {"enable_thinking": False},
        },
    )
