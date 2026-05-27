import os
import requests

BASE = "https://paper-api.alpaca.markets"
DATA = "https://data.alpaca.markets"
HEADERS = {
    "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
    "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET"],
}


def get_account():
    return requests.get(f"{BASE}/v2/account", headers=HEADERS).json()


def get_quote(symbol):
    return requests.get(f"{DATA}/v2/stocks/{symbol}/quotes/latest", headers=HEADERS).json()


def get_bars(symbol, timeframe="1Day", limit=20):
    return requests.get(
        f"{DATA}/v2/stocks/{symbol}/bars",
        headers=HEADERS,
        params={"timeframe": timeframe, "limit": limit, "feed": "iex"},
    ).json()


def place_order(symbol, qty, side, order_type="market", tif="day"):
    return requests.post(
        f"{BASE}/v2/orders",
        headers=HEADERS,
        json={"symbol": symbol, "qty": qty, "side": side, "type": order_type, "time_in_force": tif},
    ).json()


def get_positions():
    return requests.get(f"{BASE}/v2/positions", headers=HEADERS).json()


def is_market_open():
    clock = requests.get(f"{BASE}/v2/clock", headers=HEADERS).json()
    return clock["is_open"]
