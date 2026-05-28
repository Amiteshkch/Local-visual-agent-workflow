import os
import requests

BASE = "https://paper-api.alpaca.markets"
DATA = "https://data.alpaca.markets"


def _headers():
    key = os.environ.get("ALPACA_API_KEY")
    secret = os.environ.get("ALPACA_API_SECRET")
    if not key or not secret:
        raise RuntimeError(
            "ALPACA_API_KEY / ALPACA_API_SECRET not set. "
            "Either configure them in .env or run with BROKER=paper (default)."
        )
    return {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}


def get_account():
    return requests.get(f"{BASE}/v2/account", headers=_headers()).json()


def get_quote(symbol):
    return requests.get(f"{DATA}/v2/stocks/{symbol}/quotes/latest", headers=_headers()).json()


def get_bars(symbol, timeframe="1Day", limit=20):
    return requests.get(
        f"{DATA}/v2/stocks/{symbol}/bars",
        headers=_headers(),
        params={"timeframe": timeframe, "limit": limit, "feed": "iex"},
    ).json()


def place_order(symbol, qty, side, order_type="market", tif="day"):
    return requests.post(
        f"{BASE}/v2/orders",
        headers=_headers(),
        json={"symbol": symbol, "qty": qty, "side": side, "type": order_type, "time_in_force": tif},
    ).json()


def get_positions():
    return requests.get(f"{BASE}/v2/positions", headers=_headers()).json()


def is_market_open():
    clock = requests.get(f"{BASE}/v2/clock", headers=_headers()).json()
    return clock["is_open"]
