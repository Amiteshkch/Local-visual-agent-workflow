"""
LLM-backed trade decision.

Provider is controlled by the LLM_PROVIDER env var (default) and can be
overridden at runtime via claude_decision.set_runtime_config() — wired up to
the /api/llm/config endpoint so the UI can switch providers without restarting.

Available providers:
  gemini  (default) — free via Google AI Studio, set GOOGLE_API_KEY
  ollama             — fully local, no key needed, set OLLAMA_MODEL (default: llama3.2)
  claude             — Anthropic SDK, set ANTHROPIC_API_KEY, model via CLAUDE_MODEL
"""
import json
import os
from pathlib import Path

# Runtime-overridable config. Seeded from the env, but mutable via set_runtime_config().
_RUNTIME = {
    "provider": os.environ.get("LLM_PROVIDER", "gemini").lower(),
    "model":    None,  # provider-specific default picked below
}

_PROVIDER_DEFAULTS = {
    "ollama": "llama3.2",
    "gemini": "gemini-2.0-flash",
    "claude": "claude-sonnet-4-6",
}


def get_runtime_config() -> dict:
    return {
        "provider": _RUNTIME["provider"],
        "model": _RUNTIME["model"] or _PROVIDER_DEFAULTS.get(_RUNTIME["provider"], ""),
    }


def set_runtime_config(provider: str | None = None, model: str | None = None) -> dict:
    if provider is not None:
        provider = provider.lower()
        if provider not in _PROVIDER_DEFAULTS:
            raise ValueError(f"unknown provider: {provider}")
        if provider != _RUNTIME["provider"]:
            _RUNTIME["model"] = None  # don't carry a model override across providers
        _RUNTIME["provider"] = provider
    if model is not None and model.strip():
        _RUNTIME["model"] = model.strip()
    return get_runtime_config()


_NO_TRADE = {
    "decision": "NO_TRADE",
    "symbol": None,
    "qty": None,
    "reasoning": "LLM call failed — defaulting to no trade.",
    "confidence": "LOW",
}


def get_trade_decision(market_data: dict) -> dict:
    system_prompt = Path("system_prompt.md").read_text()
    user_message = (
        f"{system_prompt}\n\nCurrent market data:\n\n{json.dumps(market_data, indent=2)}"
    )
    provider = get_runtime_config()["provider"]
    try:
        if provider == "ollama":
            raw = _call_ollama(user_message)
        elif provider == "claude":
            raw = _call_claude(user_message)
        else:
            raw = _call_gemini(user_message)
        return json.loads(raw)
    except json.JSONDecodeError:
        result = _NO_TRADE.copy()
        result["reasoning"] = "JSON parse failure — defaulting to no trade."
        return result
    except Exception as e:
        result = _NO_TRADE.copy()
        result["reasoning"] = f"LLM error ({provider}): {e}"
        return result


# ── Gemini ─────────────────────────────────────────────────────────────────────

def _call_gemini(prompt: str) -> str:
    from google import genai
    from google.genai import types

    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise EnvironmentError("GOOGLE_API_KEY is not set")

    client = genai.Client(api_key=api_key)
    model  = get_runtime_config()["model"] or _PROVIDER_DEFAULTS["gemini"]

    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.2,
            max_output_tokens=512,
        ),
    )
    return response.text


# ── Ollama (local) ─────────────────────────────────────────────────────────────

def _call_ollama(prompt: str) -> str:
    try:
        import ollama
    except ImportError:
        raise ImportError("Run: pip install ollama   (and have Ollama running locally)")

    model = get_runtime_config()["model"] or _PROVIDER_DEFAULTS["ollama"]
    response = ollama.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        format="json",
    )
    return response["message"]["content"]


# ── Claude (Anthropic) ────────────────────────────────────────────────────────

def _call_claude(prompt: str) -> str:
    try:
        import anthropic
    except ImportError:
        raise ImportError("Run: pip install anthropic   (and set ANTHROPIC_API_KEY)")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError("ANTHROPIC_API_KEY is not set")

    model = get_runtime_config()["model"] or _PROVIDER_DEFAULTS["claude"]
    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model=model,
        max_tokens=512,
        temperature=0.2,
        # Claude is asked to respond as a strict JSON block; we extract the first {...} object below.
        messages=[{
            "role": "user",
            "content": (
                prompt
                + "\n\nRespond with a single JSON object and nothing else. "
                  "Do not include prose, code fences, or commentary."
            ),
        }],
    )
    text = "".join(
        block.text for block in message.content if getattr(block, "type", None) == "text"
    )
    return _extract_json(text)


def _extract_json(text: str) -> str:
    """Pull the first balanced JSON object out of a string.

    Claude occasionally wraps JSON in prose despite being told not to. We
    tolerate that by scanning for the first '{' and the matching '}'.
    """
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object found in Claude response")
    depth = 0
    for i, ch in enumerate(text[start:], start=start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise ValueError("unbalanced JSON in Claude response")
