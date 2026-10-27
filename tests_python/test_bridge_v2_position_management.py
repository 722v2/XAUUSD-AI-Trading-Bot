import unittest
from types import SimpleNamespace
from mt5_bridge_v2.agent.order_executor import OrderExecutor

class FakeOutbox:
    def __init__(self):
        self.states = {}
        self.saved = []

    def command_state(self, key):
        return self.states.get(key)

    def mark(self, key, state, details):
        self.states[key] = {"state": state, "result_json": "{}"}
        self.saved.append((key, state, details))

class FakeMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    POSITION_TYPE_BUY = 0
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6
    ORDER_TIME_GTC = 0
    ORDER_FILLING_IOC = 1
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008

    def __init__(self, owned=True, send_result=True):
        self.sent = []
        self.owned = owned
        self.send_result = send_result
        self.position = SimpleNamespace(ticket=123, symbol="XAUUSD.m", magic=2601022 if owned else 0,
            comment="XAUAI-test" if owned else "manual", type=0, volume=0.01, sl=3995.0, tp=4010.0)

    def positions_get(self, ticket):
        return [self.position] if ticket == 123 else []

    def account_info(self):
        return SimpleNamespace(trade_mode=0)

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(bid=4000.0, ask=4000.2)

    def symbol_info(self, symbol):
        return SimpleNamespace(point=0.01, trade_stops_level=10, digits=2, filling_mode=1)

    def order_check(self, request):
        return SimpleNamespace(retcode=10009)

    def order_send(self, request):
        self.sent.append(request)
        if not self.send_result:
            return None
        return SimpleNamespace(retcode=10009, order=456, deal=789, volume=request.get("volume", 0.01), price=request.get("price", 4000.0), comment="done")

class BridgeV2PositionManagementTests(unittest.TestCase):
    def command(self, operation, payload):
        return {"id":"00000000-0000-0000-0000-000000000001","idempotencyKey":"test-"+operation,
                "environment":"DEMO","kind":"EXECUTE_ORDER","payload":{"operation":operation,**payload}}

    def test_modify_position_tightens_stop_and_preserves_target(self):
        mt5=FakeMT5(); outbox=FakeOutbox(); executor=OrderExecutor(mt5,outbox,"XAUUSD")
        result=executor.execute(self.command("MODIFY_POSITION",{"ticket":123,"stopLoss":3996.0,"takeProfit":4010.0}))
        self.assertEqual(result["state"],"FILLED")
        self.assertEqual(result["code"],"POSITION_MODIFIED")
        self.assertEqual(mt5.sent[0]["action"],mt5.TRADE_ACTION_SLTP)
        self.assertEqual(mt5.sent[0]["sl"],3996.0)
        self.assertEqual(mt5.sent[0]["tp"],4010.0)

    def test_close_position_targets_ticket_and_does_not_open_opposite_position(self):
        mt5=FakeMT5(); outbox=FakeOutbox(); executor=OrderExecutor(mt5,outbox,"XAUUSD")
        result=executor.execute(self.command("CLOSE_POSITION",{"ticket":123}))
        self.assertEqual(result["state"],"FILLED")
        self.assertEqual(result["code"],"POSITION_CLOSED")
        self.assertEqual(mt5.sent[0]["position"],123)
        self.assertEqual(mt5.sent[0]["volume"],0.01)

    def test_manual_position_is_not_modified_or_closed_by_bot_command(self):
        mt5=FakeMT5(owned=False); outbox=FakeOutbox(); executor=OrderExecutor(mt5,outbox,"XAUUSD")
        result=executor.execute(self.command("CLOSE_POSITION",{"ticket":123}))
        self.assertEqual(result["state"],"REJECTED")
        self.assertEqual(result["code"],"OWNED_POSITION_NOT_FOUND")
        self.assertEqual(mt5.sent,[])

    def test_unknown_broker_result_is_not_retried_automatically(self):
        mt5=FakeMT5(send_result=False); outbox=FakeOutbox(); executor=OrderExecutor(mt5,outbox,"XAUUSD")
        result=executor.execute(self.command("CLOSE_POSITION",{"ticket":123}))
        self.assertEqual(result["state"],"UNKNOWN")
        self.assertEqual(result["code"],"POSITION_CLOSE_NO_RESPONSE")
        self.assertEqual(len(mt5.sent),1)

if __name__ == "__main__":
    unittest.main()
