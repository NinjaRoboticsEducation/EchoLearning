"""Local EchoLearning tools over MCP stdio."""

from typing import Annotated, Literal

from mcp.server.mcpserver import MCPServer
from pydantic import Field

from .schemas.transcript_schemas import RetokenizeResponse, WordToken
from .tools.tokenizer_tools import tokenize_sentence

server = MCPServer("EchoLearning")
Language = Literal["en", "ja"]


@server.tool()
def get_capabilities() -> dict:
    """List the learning languages and tools available in this local server."""
    return {
        "learningLanguages": ["en", "ja"],
        "transport": "stdio",
        "tools": ["retokenize_text", "lookup_word"],
    }


@server.tool()
def retokenize_text(
    text: Annotated[str, Field(min_length=1, max_length=20_000)],
    language: Language,
) -> RetokenizeResponse:
    """Split lesson text into tokens and attach readings where available."""
    if not text.strip():
        raise ValueError("Provide nonblank lesson text.")
    return RetokenizeResponse(tokens=[WordToken(**token) for token in tokenize_sentence(text.strip(), language)])


@server.tool()
async def lookup_word(
    word: Annotated[str, Field(min_length=1, max_length=256)],
    language: Language,
    sentence: Annotated[str, Field(max_length=20_000)] = "",
) -> dict:
    """Look up a word in context using the running local EchoLearning API."""
    import httpx

    if not word.strip():
        raise ValueError("Provide a nonblank word.")
    try:
        async with httpx.AsyncClient(timeout=90, trust_env=False) as client:
            response = await client.post(
                "http://127.0.0.1:3000/api/dictionary/lookup",
                json={"word": word.strip(), "sentence": sentence, "language": language},
            )
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise RuntimeError("Dictionary lookup failed. Check the local EchoLearning API.") from error


def main() -> None:
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
