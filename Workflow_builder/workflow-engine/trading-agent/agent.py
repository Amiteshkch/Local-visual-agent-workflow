from broker import is_market_open
from research import build_market_data
from claude_decision import get_trade_decision
from execution import execute
from journal import write_entry


def run_cycle():
    if not is_market_open():
        print("Market closed — skipping cycle.")
        return

    market_data = build_market_data()
    decision = get_trade_decision(market_data)
    order = execute(decision, market_data)
    write_entry(market_data, decision, order)
    print(f"Cycle complete → {decision['decision']} | Confidence: {decision['confidence']}")


if __name__ == "__main__":
    run_cycle()
