from __future__ import annotations
import unittest
from types import SimpleNamespace
from mt5_bridge_v2.agent.health import snapshot

class FakeMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    def __init__(self, names):
        self.names = names
    def terminal_info(self): return SimpleNamespace(connected=True)
    def account_info(self): return SimpleNamespace(login=12345, trade_mode=0)
    def symbols_get(self): return [SimpleNamespace(name=n) for n in self.names]
    def symbol_select(self, name, selected): return name in self.names
    def symbol_info(self, name):
        if name not in self.names: return None
        return SimpleNamespace(volume_min=0.01, volume_max=10.0, volume_step=0.01, digits=2, point=0.01, trade_stops_level=10)
    def symbol_info_tick(self, name):
        if name not in self.names: return None
        return SimpleNamespace(bid=2300.0, ask=2300.2)

class HealthSymbolResolutionTests(unittest.TestCase):
    def test_configured_suffix_symbol_is_selected(self):
        state = snapshot(FakeMT5(["EURUSD", "XAUUSD.m"]), "XAUUSD.m", "DEMO", None)
        self.assertEqual(state["brokerSymbol"], "XAUUSD.m")
        self.assertTrue(state["executionReady"])
    def test_canonical_symbol_falls_back_to_suffix(self):
        state = snapshot(FakeMT5(["EURUSD", "XAUUSD.pro"]), "XAUUSD", "DEMO", None)
        self.assertEqual(state["brokerSymbol"], "XAUUSD.pro")
        self.assertTrue(state["executionReady"])
    def test_missing_gold_symbol_is_not_ready(self):
        state = snapshot(FakeMT5(["EURUSD"]), "XAUUSD.m", "DEMO", None)
        self.assertFalse(state["executionReady"])
        self.assertIsNone(state["brokerSymbol"])

if __name__ == "__main__":
    unittest.main()
