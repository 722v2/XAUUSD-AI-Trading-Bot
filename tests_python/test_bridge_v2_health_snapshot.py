import unittest
import time
from types import SimpleNamespace
from mt5_bridge_v2.agent.health import snapshot

class FakeMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    POSITION_TYPE_BUY = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_OUT_BY = 3
    DEAL_ENTRY_INOUT = 2

    def terminal_info(self):
        return SimpleNamespace(connected=True)

    def account_info(self):
        return SimpleNamespace(login=123456, trade_mode=0, balance=1000.0, currency="USD")

    def symbols_get(self):
        return [SimpleNamespace(name="XAUUSD.m")]

    def symbol_select(self, symbol, selected):
        return True

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(bid=4000.0, ask=4000.2)

    def symbol_info(self, symbol):
        return SimpleNamespace(volume_min=0.01, volume_max=100.0, volume_step=0.01, digits=2, point=0.01, trade_stops_level=10)

    def positions_get(self, symbol):
        return [SimpleNamespace(ticket=77, type=0, magic=2601022, comment="XAUAI-test", volume=0.01, price_open=3999.0, sl=3997.0, tp=4005.0, profit=1.0, time=1_700_000_000)]

    def history_deals_get(self, start, end):
        now = int(time.time())
        return [
            SimpleNamespace(magic=2601022, entry=1, time=now-2, position_id=77, profit=-2.0, commission=0.0, swap=0.0, fee=0.0),
            SimpleNamespace(magic=2601022, entry=1, time=now-1, position_id=78, profit=-1.0, commission=0.0, swap=0.0, fee=0.0),
            SimpleNamespace(magic=999, entry=1, time=now, position_id=79, profit=-100.0, commission=0.0, swap=0.0, fee=0.0),
        ]

class BridgeV2HealthSnapshotTests(unittest.TestCase):
    def test_snapshot_includes_owned_positions_and_bot_only_daily_risk(self):
        result = snapshot(FakeMT5(), "XAUUSD", "DEMO", None)
        self.assertTrue(result["executionReady"])
        self.assertEqual(len(result["positions"]), 1)
        self.assertTrue(result["positions"][0]["ownedByBot"])
        self.assertEqual(result["positions"][0]["ticket"], 77)
        self.assertEqual(result["dailyRisk"]["source"], "MT5_CLOSED_DEALS_BOT_MAGIC")
        self.assertEqual(result["dailyRisk"]["dailyNetPnl"], -3.0)
        self.assertEqual(result["dailyRisk"]["consecutiveLosses"], 2)

    def test_missing_mt5_package_fails_closed(self):
        result = snapshot(None, "XAUUSD", "DEMO", None)
        self.assertFalse(result["executionReady"])
        self.assertEqual(result["lastErrorCode"], "MT5_PACKAGE_MISSING")

if __name__ == "__main__":
    unittest.main()
