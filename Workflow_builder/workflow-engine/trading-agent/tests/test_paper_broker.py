import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import paper_broker


class PaperBrokerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_book_path = paper_broker.BOOK_PATH
        self.old_get_quote = paper_broker.get_quote
        self.old_last_close = paper_broker._last_close
        self.price = 100.0

        paper_broker.BOOK_PATH = Path(self.tmp.name) / "paper_book.json"
        paper_broker.get_quote = self.fake_quote
        paper_broker._last_close = lambda _symbol: self.price
        paper_broker.reset_book(1000)

    def tearDown(self):
        paper_broker.BOOK_PATH = self.old_book_path
        paper_broker.get_quote = self.old_get_quote
        paper_broker._last_close = self.old_last_close
        self.tmp.cleanup()

    def fake_quote(self, _symbol):
        return {
            "quote": {
                "bp": self.price,
                "ap": self.price,
                "bs": 0,
                "as": 0,
                "t": "2026-06-10T00:00:00+00:00",
            }
        }

    def test_unrealized_pnl_for_long_position(self):
        paper_broker.place_order("NIFTYBEES.NS", 2, "buy")

        self.price = 110.0
        account = paper_broker.get_account()

        self.assertEqual(account["portfolio_value"], 1020.0)
        self.assertEqual(account["unrealized_pnl"], 20.0)

    def test_selling_more_than_long_flips_to_short_at_fill_price(self):
        paper_broker.place_order("NIFTYBEES.NS", 2, "buy")

        self.price = 110.0
        paper_broker.place_order("NIFTYBEES.NS", 5, "sell")
        pos = paper_broker._load_book()["positions"]["NIFTYBEES.NS"]
        account = paper_broker.get_account()

        self.assertEqual(pos["qty"], -3)
        self.assertEqual(pos["avg_entry_price"], 110.0)
        self.assertEqual(account["realized_pnl"], 20.0)
        self.assertEqual(account["unrealized_pnl"], 0.0)

    def test_buying_more_than_short_flips_to_long_at_fill_price(self):
        paper_broker.place_order("NIFTYBEES.NS", 4, "sell")

        self.price = 90.0
        paper_broker.place_order("NIFTYBEES.NS", 6, "buy")
        pos = paper_broker._load_book()["positions"]["NIFTYBEES.NS"]
        account = paper_broker.get_account()

        self.assertEqual(pos["qty"], 2)
        self.assertEqual(pos["avg_entry_price"], 90.0)
        self.assertEqual(account["realized_pnl"], 40.0)
        self.assertEqual(account["unrealized_pnl"], 0.0)

    def test_invalid_side_is_rejected(self):
        order = paper_broker.place_order("NIFTYBEES.NS", 1, "hold")

        self.assertEqual(order["status"], "rejected")
        self.assertIn("side", order["reason"])


if __name__ == "__main__":
    unittest.main()
