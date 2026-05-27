"""
LLM-backed trade decision.

Provider is controlled by the LLM_PROVIDER env var:
  gemini  (default) — free via Google AI Studio, set GOOGLE_API_KEY
  ollama             — fully local, no key needed, set OLLAMA_MODEL (default: llama3.2)
"""
import json
import os
from pathlib import Path

_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").lower()

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
    try:
        if _PROVIDER == "ollama":
            raw = _call_ollama(user_message)
        else:
            raw = _call_gemini(user_message)
        return json.loads(raw)
    except json.JSONDecodeError:
        result = _NO_TRADE.copy()
        result["reasoning"] = "JSON parse failure — defaulting to no trade."
        return result
    except Exception as e:
        result = _NO_TRADE.copy()
        result["reasoning"] = f"LLM error ({_PROVIDER}): {e}"
        return result


# ── Gemini ─────────────────────────────────────────────────────────────────────

def _call_gemini(prompt: str) -> str:
    from google import genai
    from google.genai import types

    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise EnvironmentError("GOOGLE_API_KEY is not set")

    client = genai.Client(api_key=api_key)
    model  = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

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

    model = os.environ.get("OLLAMA_MODEL", "llama3.2")
    response = ollama.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        format="json",
    )
    return response["message"]["content"]
