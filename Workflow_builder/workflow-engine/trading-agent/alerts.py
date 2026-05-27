"""File-backed price alerts.

Each alert: {id, symbol, condition: "above"|"below", price, created_at,
            triggered_at (nullable), triggered_price (nullable)}.
"""
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

ALERTS_FILE = Path(__file__).parent / "alerts.json"


def _load():
    if not ALERTS_FILE.exists():
        return []
    try:
        return json.loads(ALERTS_FILE.read_text() or "[]")
    except json.JSONDecodeError:
        return []


def _save(items):
    ALERTS_FILE.write_text(json.dumps(items, indent=2))


def list_alerts():
    return _load()


def add_alert(symbol, condition, price):
    if condition not in ("above", "below"):
        raise ValueError("condition must be 'above' or 'below'")
    item = {
        "id": uuid.uuid4().hex[:8],
        "symbol": symbol.upper(),
        "condition": condition,
        "price": float(price),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "triggered_at": None,
        "triggered_price": None,
    }
    items = _load()
    items.append(item)
    _save(items)
    return item


def delete_alert(alert_id):
    items = _load()
    new = [x for x in items if x["id"] != alert_id]
    _save(new)
    return len(new) != len(items)


def evaluate(get_quote_fn):
    """Walk pending alerts; if quote crosses threshold, mark triggered.

    Returns the list of alerts that newly fired this call.
    """
    items = _load()
    fired = []
    changed = False
    quote_cache = {}

    for it in items:
        if it.get("triggered_at"):
            continue
        sym = it["symbol"]
        try:
            if sym not in quote_cache:
                q = get_quote_fn(sym).get("quote", {})
                # Alpaca latest-quote: ap=ask price, bp=bid price
                quote_cache[sym] = q.get("ap") or q.get("bp")
            px = quote_cache[sym]
            if px is None:
                continue
            cond = it["condition"]
            hit = (cond == "above" and px >= it["price"]) or (
                cond == "below" and px <= it["price"]
            )
            if hit:
                it["triggered_at"] = datetime.now(timezone.utc).isoformat()
                it["triggered_price"] = float(px)
                fired.append(it)
                changed = True
        except Exception:
            continue

    if changed:
        _save(items)
    return fired
