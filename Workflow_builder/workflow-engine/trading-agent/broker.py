"""Single import surface — picks broker via BROKER env var.

BROKER=paper (default): paper_broker (yfinance + local book)
BROKER=alpaca         : alpaca_client (paper or live, per its BASE url)

Keep callers broker-agnostic: ``from broker import get_account, get_bars, ...``
"""
import os

_KIND = os.environ.get("BROKER", "paper").lower()

if _KIND == "alpaca":
    from alpaca_client import (
        get_account,
        get_quote,
        get_bars,
        place_order,
        get_positions,
        is_market_open,
    )
    # Alpaca module has no reset/orders helpers
    def reset_book(*_args, **_kwargs):
        raise NotImplementedError("BROKER=alpaca: no local paper book to reset")
else:
    _KIND = "paper"
    from paper_broker import (
        get_account,
        get_quote,
        get_bars,
        place_order,
        get_positions,
        is_market_open,
        reset_book,
    )


def kind() -> str:
    return _KIND


def has_alpaca_keys() -> bool:
    """True iff both Alpaca creds are set in the environment.

    Used by /api/shadow/compare to decide whether to run the parallel
    Alpaca-paper leg alongside the local paper broker.
    """
    return bool(os.environ.get("ALPACA_API_KEY")) and bool(os.environ.get("ALPACA_API_SECRET"))
