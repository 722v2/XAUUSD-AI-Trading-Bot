import unittest
from types import SimpleNamespace

from mt5_bridge_v2.agent.session import MT5Session


class FakeMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_REAL = 1

    def __init__(self):
        self.initialized = 0
        self.connected = False
        self.account = SimpleNamespace(trade_mode=0)

    def terminal_info(self):
        return SimpleNamespace(connected=self.connected) if self.connected else None

    def account_info(self):
        return self.account if self.connected else None

    def initialize(self, path=None):
        self.initialized += 1
        self.connected = True
        return True

    def shutdown(self):
        self.connected = False


class BridgeV2SessionReconnectTests(unittest.TestCase):
    def test_connect_initializes_when_terminal_is_down(self):
        mt5 = FakeMT5()
        session = MT5Session(mt5, None)

        self.assertEqual(session.connect(), (True, "CONNECTED"))
        self.assertEqual(mt5.initialized, 1)

    def test_connect_does_not_reinitialize_healthy_terminal(self):
        mt5 = FakeMT5()
        mt5.connected = True
        session = MT5Session(mt5, None)

        self.assertEqual(session.connect(), (True, "CONNECTED"))
        self.assertEqual(mt5.initialized, 0)

    def test_connect_retries_after_terminal_disconnect(self):
        mt5 = FakeMT5()
        session = MT5Session(mt5, None)

        self.assertEqual(session.connect(), (True, "CONNECTED"))
        mt5.connected = False

        self.assertEqual(session.connect(), (True, "CONNECTED"))
        self.assertEqual(mt5.initialized, 2)

    def test_live_account_is_never_accepted_by_demo_agent(self):
        mt5 = FakeMT5()
        mt5.connected = True
        mt5.account = SimpleNamespace(trade_mode=1)
        session = MT5Session(mt5, None)

        self.assertEqual(session.connect(), (False, "DEMO_ACCOUNT_REQUIRED"))
        self.assertEqual(mt5.initialized, 0)

    def test_live_agent_accepts_live_account_only_when_selected(self):
        mt5 = FakeMT5()
        mt5.connected = True
        mt5.account = SimpleNamespace(trade_mode=1)
        session = MT5Session(mt5, None, "LIVE")

        self.assertEqual(session.connect(), (True, "CONNECTED"))
        self.assertEqual(mt5.initialized, 0)

    def test_live_agent_rejects_demo_account(self):
        mt5 = FakeMT5()
        mt5.connected = True
        mt5.account = SimpleNamespace(trade_mode=0)
        session = MT5Session(mt5, None, "LIVE")

        self.assertEqual(session.connect(), (False, "LIVE_ACCOUNT_REQUIRED"))
        self.assertEqual(mt5.initialized, 0)


if __name__ == "__main__":
    unittest.main()
