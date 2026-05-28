"""Paper-trading broker.

Market data: yfinance (free, public, ~15min delayed for free tier).
Positions / cash / fills: local JSON book at paper_book.json.

Same return shapes as alpaca_client so callers don't care which broker is used.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone, time as dtime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yfinance as yf


BOOK_PATH = Path(__file__).parent / "paper_book.json"
DEFAULT_STARTING_CASH = float(os.environ.get("PAPER_STARTING_CASH", "100000"))
SPREAD_BPS = float(os.environ.get("PAPER_SPREAD_BPS", "5"))  # 5 bps each side if yf has no bid/ask
_NY = ZoneInfo("America/New_York")


# ── Book persistence ──────────────────────────────────────────
def _empty_book() -> dict:
    return {
        "cash": DEFAULT_STARTING_CASH,
        "starting_cash": DEFAULT_STARTING_CASH,
        "realized_pnl": 0.0,
        "positions": {},   # symbol → {qty, avg_entry_price}
        "orders": [],      # history
    }


def _load_book() -> dict:
    if not BOOK_PATH.exists():
        book = _empty_book()
        _save_book(book)
        return book
    try:
        return json.loads(BOOK_PATH.read_text())
    except json.JSONDecodeError:
        return _empty_book()


def _save_book(book: dict) -> None:
    BOOK_PATH.write_text(json.dumps(book, indent=2))


def reset_book(starting_cash: float | None = None) -> dict:
    book = _empty_book()
    if starting_cash is not None:
        book["cash"] = float(starting_cash)
        book["starting_cash"] = float(starting_cash)
    _save_book(book)
    return book


# ── Market data ───────────────────────────────────────────────
_TF_MAP = {
    "1Min": "1m",
    "5Min": "5m",
    "15Min": "15m",
    "30Min": "30m",
    "1Hour": "60m",
    "1Day": "1d",
    "1Week": "1wk",
}

_PERIOD_FOR_TF = {
    "1Min": "5d",
    "5Min": "1mo",
    "15Min": "1mo",
    "30Min": "3mo",
    "1Hour": "6mo",
    "1Day": "2y",
    "1Week": "5y",
}


def get_bars(symbol: str, timeframe: str = "1Day", limit: int = 200) -> dict:
    """Return Alpaca-shaped {"bars": [...]}.

    Each bar: {"t": ISO8601 UTC, "o","h","l","c","v"}.
    """
    interval = _TF_MAP.get(timeframe, "1d")
    period = _PERIOD_FOR_TF.get(timeframe, "1y")
    try:
        df = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=False)
    except Exception:
        return {"bars": []}
    if df is None or df.empty:
        return {"bars": []}

    df = df.tail(limit)
    out = []
    for ts, row in df.iterrows():
        # ts is a pandas Timestamp; ensure UTC ISO
        try:
            iso = ts.tz_convert("UTC").isoformat().replace("+00:00", "Z")
        except (TypeError, AttributeError):
            iso = ts.tz_localize("UTC").isoformat().replace("+00:00", "Z")
        out.append({
            "t": iso,
            "o": float(row["Open"]),
            "h": float(row["High"]),
            "l": float(row["Low"]),
            "c": float(row["Close"]),
            "v": int(row["Volume"] or 0),
        })
    return {"bars": out}


def _last_close(symbol: str) -> float | None:
    """Cheap fallback when fast_info / info don't deliver a price."""
    try:
        df = yf.Ticker(symbol).history(period="2d", interval="1d", auto_adjust=False)
        if df is None or df.empty:
            return None
        return float(df["Close"].iloc[-1])
    except Exception:
        return None


def get_quote(symbol: str) -> dict:
    """Return Alpaca-shaped {"quote": {bp, ap, bs, as, t}}.

    yfinance bid/ask is only populated during market hours and only for
    some tickers; otherwise we synthesise a tight spread around the last
    close so the UI still has something sensible.
    """
    bid = ask = None
    bid_size = ask_size = 0
    try:
        fi = yf.Ticker(symbol).fast_info
        bid = float(fi.get("bid")) if fi.get("bid") else None
        ask = float(fi.get("ask")) if fi.get("ask") else None
        last = fi.get("last_price") or fi.get("lastPrice")
    except Exception:
        last = None

    if (bid is None or ask is None):
        last = last if last else _last_close(symbol)
        if last:
            half = last * (SPREAD_BPS / 10_000)
            bid = round(last - half, 4)
            ask = round(last + half, 4)

    return {
        "quote": {
            "bp": bid,
            "ap": ask,
            "bs": bid_size,
            "as": ask_size,
            "t": datetime.now(timezone.utc).isoformat(),
        }
    }


# ── Account / positions ───────────────────────────────────────
def _mark_to_market_value(book: dict) -> float:
    total = book["cash"]
    for sym, pos in book["positions"].items():
        if pos["qty"] == 0:
            continue
        q = get_quote(sym)["quote"]
        px = q.get("bp") or q.get("ap") or _last_close(sym) or pos.get("avg_entry_price", 0)
        if px:
            total += pos["qty"] * px
    return round(total, 2)


def get_account() -> dict:
    book = _load_book()
    portfolio_value = _mark_to_market_value(book)
    return {
        "cash": book["cash"],
        "buying_power": book["cash"],   # paper: no margin
        "portfolio_value": portfolio_value,
        "starting_cash": book["starting_cash"],
        "realized_pnl": book["realized_pnl"],
        "unrealized_pnl": round(portfolio_value - book["cash"] - sum(
            p["qty"] * p["avg_entry_price"] for p in book["positions"].values()
        ) + sum(
            p["qty"] * p["avg_entry_price"] for p in book["positions"].values()
        ), 2),
    }


def get_positions() -> list[dict]:
    book = _load_book()
    out = []
    for sym, pos in book["positions"].items():
        if pos["qty"] == 0:
            continue
        out.append({
            "symbol": sym,
            "qty": str(pos["qty"]),
            "avg_entry_price": str(pos["avg_entry_price"]),
        })
    return out


# ── Order placement ───────────────────────────────────────────
def place_order(symbol: str, qty: int, side: str,
                order_type: str = "market", tif: str = "day") -> dict:
    """Fill instantly at current ask (buy) or bid (sell)."""
    symbol = symbol.upper()
    side = side.lower()
    qty = int(qty)
    if qty <= 0:
        return {"id": None, "status": "rejected", "reason": "qty must be > 0"}

    quote = get_quote(symbol)["quote"]
    if side == "buy":
        price = quote.get("ap") or quote.get("bp") or _last_close(symbol)
    else:
        price = quote.get("bp") or quote.get("ap") or _last_close(symbol)
    if not price:
        return {"id": None, "status": "rejected", "reason": "no market price"}

    book = _load_book()
    cost = qty * price
    pos = book["positions"].setdefault(symbol, {"qty": 0, "avg_entry_price": 0.0})

    if side == "buy":
        if cost > book["cash"]:
            return {"id": None, "status": "rejected", "reason": f"insufficient cash (need ${cost:,.2f}, have ${book['cash']:,.2f})"}
        new_qty = pos["qty"] + qty
        if pos["qty"] >= 0:  # adding to long (or opening new)
            total_cost = pos["qty"] * pos["avg_entry_price"] + cost
            pos["avg_entry_price"] = total_cost / new_qty if new_qty else 0
        # else (covering short): realized P&L = (avg_short_price - fill_price) * min(qty, |pos.qty|)
        else:
            cover_qty = min(qty, abs(pos["qty"]))
            realized = (pos["avg_entry_price"] - price) * cover_qty
            book["realized_pnl"] = round(book["realized_pnl"] + realized, 2)
        pos["qty"] = new_qty
        book["cash"] = round(book["cash"] - cost, 2)

    else:  # sell
        # close long or open short
        if pos["qty"] > 0:
            close_qty = min(qty, pos["qty"])
            realized = (price - pos["avg_entry_price"]) * close_qty
            book["realized_pnl"] = round(book["realized_pnl"] + realized, 2)
        new_qty = pos["qty"] - qty
        if new_qty < 0 and pos["qty"] <= 0:  # extending short
            short_open = abs(new_qty) - abs(pos["qty"])
            total = abs(pos["qty"]) * pos["avg_entry_price"] + short_open * price
            pos["avg_entry_price"] = total / abs(new_qty) if new_qty else 0
        pos["qty"] = new_qty
        book["cash"] = round(book["cash"] + qty * price, 2)

    order = {
        "id": uuid.uuid4().hex,
        "status": "filled",
        "symbol": symbol,
        "qty": qty,
        "side": side,
        "type": order_type,
        "time_in_force": tif,
        "filled_avg_price": round(price, 4),
        "filled_at": datetime.now(timezone.utc).isoformat(),
        "broker": "paper",
    }
    book["orders"].append(order)
    _save_book(book)
    return order


# ── Calendar ──────────────────────────────────────────────────
def is_market_open() -> bool:
    """NYSE regular hours: Mon-Fri 09:30-16:00 America/New_York.

    Doesn't account for holidays — good enough for paper trading.
    """
    now = datetime.now(_NY)
    if now.weekday() >= 5:
        return False
    return dtime(9, 30) <= now.time() < dtime(16, 0)
