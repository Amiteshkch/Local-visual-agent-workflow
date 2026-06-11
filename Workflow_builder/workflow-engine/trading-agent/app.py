import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Load .env before any module that reads os.environ at import time
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from flask import Flask, jsonify, render_template, request

# Ensure imports resolve relative to this file's directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from research import build_market_data, WATCHLIST
from claude_decision import get_trade_decision
from execution import execute
from journal import write_entry
from broker import is_market_open, get_bars, get_quote, place_order
import broker
import claude_decision
from indicators import ema_series, rsi_series
import alerts as alerts_store

# Alpaca timeframe strings we'll accept from the chart UI
_ALLOWED_TF = {"1Min", "5Min", "15Min", "30Min", "1Hour", "1Day", "1Week"}

app = Flask(__name__)

# In-memory state shared across a single research→decide→act cycle
_state: dict = {}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def status():
    try:
        open_ = is_market_open()
    except Exception:
        open_ = False
    return jsonify({
        "market_open": open_,
        "server_time": datetime.now(timezone.utc).isoformat(),
        "broker": broker.kind(),
    })


@app.route("/api/paper/reset", methods=["POST"])
def paper_reset():
    if broker.kind() != "paper":
        return jsonify({"ok": False, "error": "Only available when BROKER=paper"}), 400
    body = request.get_json(force=True, silent=True) or {}
    starting_cash = body.get("starting_cash")
    book = broker.reset_book(starting_cash)
    return jsonify({"ok": True, "book": book})


@app.route("/api/research", methods=["POST"])
def research():
    try:
        data = build_market_data()
        _state.clear()
        _state["market_data"] = data
        return jsonify({"ok": True, "data": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/decide", methods=["POST"])
def decide():
    if "market_data" not in _state:
        return jsonify({"ok": False, "error": "Run research first"}), 400
    try:
        decision = get_trade_decision(_state["market_data"])
        _state["decision"] = decision
        return jsonify({"ok": True, "decision": decision})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/execute", methods=["POST"])
def execute_trade():
    if "market_data" not in _state or "decision" not in _state:
        return jsonify({"ok": False, "error": "Run research and decision first"}), 400
    try:
        order = execute(_state["decision"], _state["market_data"])
        write_entry(_state["market_data"], _state["decision"], order)
        result = _state["decision"].copy()
        _state.clear()
        return jsonify({"ok": True, "order": order, "decision": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/skip", methods=["POST"])
def skip_trade():
    if "market_data" not in _state or "decision" not in _state:
        return jsonify({"ok": False, "error": "Nothing to skip"}), 400
    try:
        logged_decision = _state["decision"].copy()
        logged_decision["reasoning"] = (
            "[User skipped] " + logged_decision.get("reasoning", "")
        )
        write_entry(_state["market_data"], logged_decision, None)
        _state.clear()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/journal")
def journal():
    journal_dir = Path("journal")
    entries = []
    if journal_dir.exists():
        for f in sorted(journal_dir.glob("*.jsonl"), reverse=True)[:7]:
            text = f.read_text().strip()
            if not text:
                continue
            for line in reversed(text.split("\n")):
                if line.strip():
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
                if len(entries) >= 25:
                    break
    return jsonify({"entries": entries[:25]})


@app.route("/api/watchlist")
def watchlist():
    """Default symbols that populate the TV-style sidebar before research runs."""
    return jsonify({"symbols": WATCHLIST})


@app.route("/api/watchlist/quotes")
def watchlist_quotes():
    """Last price + 1-day change for every watchlist symbol, so the sidebar
    is populated on page load (TradingView-style) without running research."""
    out = []
    for symbol in WATCHLIST:
        row = {"symbol": symbol, "price": None, "change_pct_1d": None}
        try:
            bars_ = get_bars(symbol, timeframe="1Day", limit=2).get("bars", [])
            if bars_:
                last = float(bars_[-1]["c"])
                row["price"] = last
                if len(bars_) >= 2 and bars_[-2]["c"]:
                    prev = float(bars_[-2]["c"])
                    row["change_pct_1d"] = round((last - prev) / prev * 100, 2)
        except Exception:
            pass
        out.append(row)
    return jsonify({"ok": True, "quotes": out})


@app.route("/api/bars/<symbol>")
def bars(symbol):
    timeframe = request.args.get("timeframe", "15Min")
    if timeframe not in _ALLOWED_TF:
        return jsonify({"ok": False, "error": f"timeframe must be one of {sorted(_ALLOWED_TF)}"}), 400
    try:
        limit = int(request.args.get("limit", 200))
    except ValueError:
        limit = 200
    limit = max(20, min(limit, 1000))

    try:
        resp = get_bars(symbol.upper(), timeframe=timeframe, limit=limit)
        raw = resp.get("bars", []) or []
        candles = []
        closes = []
        for b in raw:
            # Alpaca v2: t is RFC3339 UTC; lightweight-charts wants seconds.
            t_iso = b["t"]
            ts = int(datetime.fromisoformat(t_iso.replace("Z", "+00:00")).timestamp())
            candles.append({
                "time": ts,
                "open": b["o"],
                "high": b["h"],
                "low": b["l"],
                "close": b["c"],
                "volume": b.get("v", 0),
            })
            closes.append(b["c"])

        ema = ema_series(closes, period=20)
        rsi = rsi_series(closes, period=14)
        return jsonify({
            "ok": True,
            "symbol": symbol.upper(),
            "timeframe": timeframe,
            "candles": candles,
            "ema20": [
                {"time": c["time"], "value": v}
                for c, v in zip(candles, ema) if v is not None
            ],
            "rsi14": [
                {"time": c["time"], "value": v}
                for c, v in zip(candles, rsi) if v is not None
            ],
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/quote/<symbol>")
def quote(symbol):
    try:
        q = get_quote(symbol.upper()).get("quote", {})
        return jsonify({
            "ok": True,
            "symbol": symbol.upper(),
            "bid": q.get("bp"),
            "ask": q.get("ap"),
            "bid_size": q.get("bs"),
            "ask_size": q.get("as"),
            "ts": q.get("t"),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/order", methods=["POST"])
def manual_order():
    """Direct buy/sell, independent of Claude's decision flow.

    Body: {symbol, qty, side: "buy"|"sell"}
    """
    body = request.get_json(force=True, silent=True) or {}
    symbol = (body.get("symbol") or "").upper()
    side = (body.get("side") or "").lower()
    try:
        qty = int(body.get("qty") or 0)
    except (TypeError, ValueError):
        qty = 0

    if not symbol or side not in ("buy", "sell") or qty <= 0:
        return jsonify({"ok": False, "error": "symbol, qty>0, side in {buy,sell} required"}), 400

    try:
        order = place_order(symbol, qty, side)
        # Mirror the order into the journal so it shows in the feed.
        manual_decision = {
            "decision": side.upper(),
            "symbol": symbol,
            "qty": qty,
            "confidence": "HIGH",
            "reasoning": "[Manual ticket] placed via Quick BUY/SELL.",
        }
        try:
            snapshot = build_market_data()
        except Exception:
            snapshot = {"account": {}, "watchlist": []}
        write_entry(snapshot, manual_decision, order)
        return jsonify({"ok": True, "order": order})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/alerts", methods=["GET", "POST"])
def alerts_handler():
    if request.method == "GET":
        return jsonify({"alerts": alerts_store.list_alerts()})
    body = request.get_json(force=True, silent=True) or {}
    try:
        item = alerts_store.add_alert(
            body.get("symbol", ""),
            body.get("condition", ""),
            body.get("price"),
        )
        return jsonify({"ok": True, "alert": item})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/api/alerts/<alert_id>", methods=["DELETE"])
def alerts_delete(alert_id):
    removed = alerts_store.delete_alert(alert_id)
    return jsonify({"ok": removed})


@app.route("/api/alerts/check", methods=["POST"])
def alerts_check():
    fired = alerts_store.evaluate(get_quote)
    return jsonify({"ok": True, "fired": fired})


@app.route("/api/journal/markers/<symbol>")
def journal_markers(symbol):
    """Return decision markers for the given symbol, oldest first.

    Each marker: {time (unix s), side: BUY|SELL|NO_TRADE, qty, executed (bool)}
    """
    sym = symbol.upper()
    out = []
    journal_dir = Path("journal")
    if journal_dir.exists():
        for f in sorted(journal_dir.glob("*.jsonl")):
            for line in f.read_text().splitlines():
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                dec = entry.get("agent_decision") or {}
                if (dec.get("symbol") or "").upper() != sym:
                    continue
                try:
                    ts = int(datetime.fromisoformat(
                        entry["timestamp"].replace("Z", "+00:00")
                    ).timestamp())
                except Exception:
                    continue
                out.append({
                    "time": ts,
                    "side": dec.get("decision"),
                    "qty": dec.get("qty"),
                    "executed": entry.get("order_result") not in (None, "NO_ORDER_PLACED"),
                })
    return jsonify({"markers": out})


# ── LLM provider config (runtime-overridable from the UI) ────────────────────

_VALID_PROVIDERS = {"ollama", "gemini", "claude"}


def _llm_snapshot() -> dict:
    """Public-safe view of the current LLM config (no secrets)."""
    cfg = claude_decision.get_runtime_config()
    return {
        "provider": cfg["provider"],
        "model":    cfg["model"],
        "has_key_for": {
            "ollama": True,  # local, no key
            "gemini": bool(os.environ.get("GOOGLE_API_KEY")),
            "claude": bool(os.environ.get("ANTHROPIC_API_KEY")),
        },
    }


@app.route("/api/llm/config", methods=["GET"])
def llm_config_get():
    return jsonify(_llm_snapshot())


@app.route("/api/llm/config", methods=["POST"])
def llm_config_post():
    body = request.get_json(force=True, silent=True) or {}
    provider = (body.get("provider") or "").lower().strip()
    if provider not in _VALID_PROVIDERS:
        return jsonify({"ok": False, "error": f"provider must be one of {sorted(_VALID_PROVIDERS)}"}), 400
    model = (body.get("model") or "").strip() or None
    api_key = (body.get("api_key") or "").strip() or None

    # Only persist keys into the env for the providers the user is configuring.
    # We never echo them back, and we never write them to disk.
    if api_key:
        if provider == "gemini" and not os.environ.get("GOOGLE_API_KEY"):
            os.environ["GOOGLE_API_KEY"] = api_key
        elif provider == "claude" and not os.environ.get("ANTHROPIC_API_KEY"):
            os.environ["ANTHROPIC_API_KEY"] = api_key

    claude_decision.set_runtime_config(provider=provider, model=model)
    return jsonify({"ok": True, "config": _llm_snapshot()})


# ── Paper-vs-Alpaca shadow comparison ────────────────────────────────────────

@app.route("/api/shadow/compare", methods=["POST"])
def shadow_compare():
    """Run the same ticket through the active broker AND Alpaca paper (if keyed),
    return both responses side-by-side. Useful to surface price/fill drift before
    flipping BROKER=alpaca for live execution.

    The Alpaca leg is always paper-account (no real money), and we never place
    a real Alpaca order for the active position — we only compare fills.
    """
    if broker.kind() != "paper":
        return jsonify({
            "ok": False,
            "error": "shadow compare only runs alongside the paper broker; "
                     "when BROKER=alpaca the live broker IS the reference.",
        }), 400

    body = request.get_json(force=True, silent=True) or {}
    symbol = (body.get("symbol") or "").upper()
    side   = (body.get("side")   or "").lower()
    try:
        qty = int(body.get("qty") or 0)
    except (TypeError, ValueError):
        qty = 0

    if not symbol or side not in ("buy", "sell") or qty <= 0:
        return jsonify({"ok": False, "error": "symbol, qty>0, side in {buy,sell} required"}), 400

    # Paper leg
    t0 = datetime.now(timezone.utc)
    try:
        paper_order = broker.place_order(symbol, qty, side)
        paper_err = None
    except Exception as e:
        paper_order, paper_err = None, str(e)
    paper_ms = int((datetime.now(timezone.utc) - t0).total_seconds() * 1000)

    # Alpaca leg — only if keys are present
    alpaca_section = {"available": False}
    if broker.has_alpaca_keys():
        try:
            import alpaca_client
            t1 = datetime.now(timezone.utc)
            alpaca_section = {
                "available": True,
                "order": alpaca_client.place_order(symbol, qty, side),
                "latency_ms": int((datetime.now(timezone.utc) - t1).total_seconds() * 1000),
            }
        except Exception as e:
            alpaca_section = {"available": True, "error": str(e)}

    # Drift
    drift = {}
    if paper_order and alpaca_section.get("order"):
        try:
            p_px = float(paper_order.get("filled_avg_price") or 0)
            a_px = float((alpaca_section["order"].get("filled_avg_price")
                          or alpaca_section["order"].get("price") or 0))
            if p_px and a_px:
                drift["price_diff_bps"] = round(((a_px - p_px) / p_px) * 10_000, 2)
                drift["paper_price"] = p_px
                drift["alpaca_price"] = a_px
        except (TypeError, ValueError):
            pass

    return jsonify({
        "ok": True,
        "ticket": {"symbol": symbol, "qty": qty, "side": side},
        "paper": {"order": paper_order, "error": paper_err, "latency_ms": paper_ms},
        "alpaca": alpaca_section,
        "drift": drift,
    })


if __name__ == "__main__":
    # host=0.0.0.0 so phones/laptops on the same network can open the desk
    # at http://<this-machine's-LAN-IP>:8766 (find it with: ipconfig getifaddr en0)
    app.run(debug=True, host="0.0.0.0", port=8766, use_reloader=False)
