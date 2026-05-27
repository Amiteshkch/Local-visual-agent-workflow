from alpaca_client import place_order


def max_shares(portfolio_value, price, risk_pct=0.02):
    return int((portfolio_value * risk_pct) / price)


def execute(decision: dict, market_data: dict) -> dict | None:
    if decision["decision"] == "NO_TRADE" or decision["confidence"] == "LOW":
        print(f"Skipping: {decision['reasoning']}")
        return None

    portfolio_value = market_data["account"]["portfolio_value"]
    symbol = decision["symbol"]
    side = decision["decision"].lower()

    ticker = next((t for t in market_data["watchlist"] if t["symbol"] == symbol), None)
    if not ticker:
        print(f"Symbol {symbol} not found in watchlist data — skipping.")
        return None

    safe_qty = max_shares(portfolio_value, ticker["price"])
    qty = min(decision["qty"], safe_qty)

    if qty <= 0:
        print("Quantity too small after guardrail — skipping.")
        return None

    order = place_order(symbol, qty, side)
    print(f"Order placed: {order}")
    return order
