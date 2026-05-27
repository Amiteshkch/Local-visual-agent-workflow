import json
from datetime import datetime, timezone
from pathlib import Path


def write_entry(market_data, decision, order):
    Path("journal").mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "market_snapshot": market_data,
        "agent_decision": decision,
        "order_result": order or "NO_ORDER_PLACED",
    }
    with open(f"journal/{today}.jsonl", "a") as f:
        f.write(json.dumps(entry) + "\n")
