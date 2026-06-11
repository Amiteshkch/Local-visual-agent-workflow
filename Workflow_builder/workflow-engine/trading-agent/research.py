import os

import numpy as np
from broker import get_account, get_quote, get_bars, get_positions

DEFAULT_WATCHLIST = [
    "^NSEI",
    "^NSEBANK",
    "NIFTYBEES.NS",
    "RELIANCE.NS",
    "HDFCBANK.NS",
    "ICICIBANK.NS",
    "INFY.NS",
]
WATCHLIST = [
    symbol.strip().upper()
    for symbol in os.environ.get("WATCHLIST", ",".join(DEFAULT_WATCHLIST)).split(",")
    if symbol.strip()
]


def compute_rsi(closes, period=14):
    deltas = np.diff(closes)
    gains = np.where(deltas > 0, deltas, 0)
    losses = np.where(deltas < 0, -deltas, 0)
    avg_gain = np.mean(gains[-period:])
    avg_loss = np.mean(losses[-period:])
    rs = avg_gain / avg_loss if avg_loss != 0 else 100
    return float(round(100 - (100 / (1 + rs)), 2))


def build_market_data():
    account = get_account()
    positions = {p["symbol"]: p for p in get_positions()}
    watchlist_data = []

    for symbol in WATCHLIST:
        bars_resp = get_bars(symbol)
        bars = bars_resp.get("bars", [])
        if not bars or len(bars) < 2:
            continue

        closes = [b["c"] for b in bars]
        quote = get_quote(symbol).get("quote", {})

        watchlist_data.append({
            "symbol": symbol,
            "price": float(quote.get("ap") or closes[-1]),
            "change_pct_1d": float(round((closes[-1] - closes[-2]) / closes[-2] * 100, 2)),
            "rsi_14": compute_rsi(closes),
            "above_20ma": bool(closes[-1] > np.mean(closes[-20:])),
            "current_position": positions.get(symbol),
        })

    return {
        "account": {
            "buying_power": float(account["buying_power"]),
            "portfolio_value": float(account["portfolio_value"]),
        },
        "watchlist": watchlist_data,
    }
