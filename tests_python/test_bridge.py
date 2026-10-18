import json
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from threading import Thread
from mt5_bridge.bridge import BridgeService, IdempotencyStore, create_handler, stable_order_comment, validate_order_payload
from http.server import ThreadingHTTPServer


class FakeMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_MARGIN_MODE_RETAIL_HEDGING = 2
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 2
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_FILLING_IOC = 1
    ORDER_TIME_GTC = 0
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE_PARTIAL = 10010
    POSITION_TYPE_BUY = 0

    def __init__(self, trade_mode=0, margin_mode=2):
        self.trade_mode = trade_mode
        self.margin_mode = margin_mode
        self.order_send_calls = 0
        self.position = SimpleNamespace(ticket=77, magic=61016001, comment="XAUAI-abcd", type=0,
            volume=0.1, price_open=1990.0, sl=1980.0, tp=2010.0, profit=2.0, time=1792152000)

    def initialize(self, **kwargs): return True
    def terminal_info(self): return SimpleNamespace(connected=True)
    def account_info(self): return SimpleNamespace(trade_mode=self.trade_mode, margin_mode=self.margin_mode, login=12345, server="Demo", currency="USD")
    def symbol_select(self, symbol, enabled): return True
    def symbol_info_tick(self, symbol): return SimpleNamespace(bid=2000.0, ask=2000.2, time=1792152000)
    def symbol_info(self, symbol): return SimpleNamespace(volume_min=0.01, volume_max=100.0, volume_step=0.01, digits=2, trade_tick_size=0.1, trade_tick_value=1.0, point=0.01, trade_stops_level=10)
    def order_check(self, request): return SimpleNamespace(retcode=0)
    def order_send(self, request):
        self.order_send_calls += 1
        return SimpleNamespace(retcode=10009, order=9876, deal=9877)
    def positions_get(self, **kwargs):
        if kwargs.get("ticket") and kwargs["ticket"] != self.position.ticket: return ()
        return (self.position,)


class BridgeUnitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = IdempotencyStore(Path(self.tmp.name) / "state.sqlite3")
        self.service = BridgeService("test-bridge-key", self.store)

    def tearDown(self):
        self.tmp.cleanup()

    def test_order_validation_fails_closed_for_live_and_invalid_fields(self):
        valid = {"environment":"DEMO","symbol":"XAUUSD","direction":"BUY","idempotencyKey":"abc","volume":0.1,"stopLoss":2000,"takeProfit":2010}
        self.assertEqual(validate_order_payload(valid)[0], True)
        self.assertEqual(validate_order_payload({**valid,"environment":"LIVE"})[1], "LIVE_DISABLED")
        self.assertEqual(validate_order_payload({**valid,"volume":float("nan")})[1], "INVALID_VOLUME")
        self.assertEqual(validate_order_payload({**valid,"direction":"HOLD"})[1], "INVALID_DIRECTION")

    def test_stable_comment_is_bounded_and_does_not_embed_raw_key(self):
        key = "customer-provided-key-that-must-not-be-logged"
        comment = stable_order_comment(key)
        self.assertTrue(comment.startswith("XAUAI-"))
        self.assertLessEqual(len(comment), 31)
        self.assertNotIn(key, comment)
        self.assertEqual(comment, stable_order_comment(key))

    def test_idempotency_reservation_is_atomic_and_uncertain_state_is_retrievable(self):
        created, row = self.store.reserve("same-key",stable_order_comment("same-key"),{"environment":"DEMO"})
        self.assertTrue(created)
        self.store.update("same-key","UNKNOWN",{"state":"UNKNOWN"})
        created_again, existing = self.store.reserve("same-key",stable_order_comment("same-key"),{"environment":"DEMO"})
        self.assertFalse(created_again)
        self.assertEqual(existing["status"],"UNKNOWN")
        self.assertEqual(json.loads(existing["result_json"])["state"],"UNKNOWN")

    def test_historical_candle_request_limit_and_partial_available_history(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        class CandleMT5(FakeMT5):
            TIMEFRAME_M1 = 1
            def copy_rates_from_pos(self, symbol, timeframe, start_pos, count):
                self.requested_count = count
                base_time = 1792152000 - 60 * 39
                return [
                    {"time": base_time + i * 60, "open": 2000.0+i, "high": 2001.0+i,
                     "low": 1999.0+i, "close": 2000.5+i, "tick_volume": 10}
                    for i in range(40)
                ]
        fake = CandleMT5()
        bridge_module.mt5 = fake
        try:
            rejected = self.service.candles("M1", 5001)
            self.assertEqual(rejected[0], 400)
            status, result = self.service.candles("M1", 100)
            self.assertEqual(status, 200)
            self.assertEqual(len(result["candles"]), 40)
            self.assertTrue(all(item["isClosed"] for item in result["candles"]))
        finally:
            bridge_module.mt5 = previous

    def test_health_is_not_claimed_connected_without_terminal_module(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        try:
            bridge_module.mt5 = None
            self.assertEqual(self.service.health()["state"],"NOT_CONFIGURED")
        finally:
            bridge_module.mt5 = previous



    def test_health_distinguishes_market_connected_from_execution_ready(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        try:
            bridge_module.mt5 = FakeMT5(trade_mode=0, margin_mode=2)
            healthy = self.service.health()
            self.assertEqual(healthy["state"],"CONNECTED")
            self.assertTrue(healthy["executionReady"])
            bridge_module.mt5 = FakeMT5(trade_mode=0, margin_mode=0)
            netting = self.service.health()
            self.assertEqual(netting["state"],"BLOCKED")
            self.assertFalse(netting["executionReady"])
            self.assertEqual(netting["reason"],"HEDGING_ACCOUNT_REQUIRED")
        finally:
            bridge_module.mt5 = previous

    def test_live_account_is_rejected_before_any_order_submission(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        fake = FakeMT5(trade_mode=2)
        bridge_module.mt5 = fake
        try:
            payload = {"environment":"DEMO","symbol":"XAUUSD","direction":"BUY","idempotencyKey":"real-account-test","volume":0.1,"stopLoss":1990,"takeProfit":2020}
            status, result = self.service.submit_order(payload)
            self.assertEqual(status,503)
            self.assertEqual(result["error"],"EXECUTION_ENVIRONMENT_MISMATCH")
            self.assertEqual(fake.order_send_calls,0)
            self.assertIsNone(self.store.get("real-account-test"))
        finally:
            bridge_module.mt5 = previous


    def test_netting_account_is_blocked_from_automated_execution(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        fake = FakeMT5(trade_mode=0, margin_mode=0)
        bridge_module.mt5 = fake
        try:
            payload = {"environment":"DEMO","symbol":"XAUUSD","direction":"BUY","idempotencyKey":"netting-account-test","volume":0.1,"stopLoss":1990,"takeProfit":2020}
            status, result = self.service.submit_order(payload)
            self.assertEqual(status,503)
            self.assertEqual(result["error"],"HEDGING_ACCOUNT_REQUIRED")
            self.assertEqual(fake.order_send_calls,0)
        finally:
            bridge_module.mt5 = previous

    def test_demo_order_is_sent_once_for_a_repeated_idempotency_key(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        fake = FakeMT5(trade_mode=0)
        bridge_module.mt5 = fake
        try:
            payload = {"environment":"DEMO","symbol":"XAUUSD","direction":"BUY","idempotencyKey":"repeat-demo-order","volume":0.1,"stopLoss":1990,"takeProfit":2020}
            first = self.service.submit_order(payload)
            second = self.service.submit_order(payload)
            self.assertEqual(first[0],200)
            self.assertEqual(first[1]["state"],"CONFIRMED")
            self.assertEqual(second[0],200)
            self.assertEqual(second[1]["state"],"CONFIRMED")
            self.assertEqual(fake.order_send_calls,1)
        finally:
            bridge_module.mt5 = previous

    def test_close_order_is_idempotent_after_success(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        fake = FakeMT5(trade_mode=0)
        bridge_module.mt5 = fake
        try:
            payload = {"ticket":77,"idempotencyKey":"close-position-77"}
            first = self.service.close_position(payload)
            second = self.service.close_position(payload)
            self.assertEqual(first[0],200)
            self.assertEqual(first[1]["state"],"CONFIRMED")
            self.assertEqual(second[1]["state"],"CONFIRMED")
            self.assertEqual(fake.order_send_calls,1)
        finally:
            bridge_module.mt5 = previous



    def test_symbol_spec_and_bot_owned_positions_are_returned_only_for_demo_hedging(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        bridge_module.mt5 = FakeMT5(trade_mode=0, margin_mode=2)
        try:
            status, spec = self.service.symbol_spec()
            self.assertEqual(status,200)
            self.assertEqual(spec["symbol"],"XAUUSD")
            self.assertGreater(spec["tickSize"],0)
            self.assertGreater(spec["point"],0)
            status, result = self.service.positions()
            self.assertEqual(status,200)
            self.assertEqual(len(result["positions"]),1)
            self.assertEqual(result["positions"][0]["ticket"],77)
        finally:
            bridge_module.mt5 = previous


    def test_positions_report_unowned_gold_positions_without_claiming_them(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        fake=FakeMT5(trade_mode=0,margin_mode=2)
        fake.position.magic=0
        fake.position.comment="manual-trade"
        bridge_module.mt5=fake
        try:
            status,result=self.service.positions()
            self.assertEqual(status,200)
            self.assertEqual(len(result["positions"]),1)
            self.assertFalse(result["positions"][0]["ownedByBot"])
            self.assertEqual(result["positions"][0]["comment"],"")
        finally:
            bridge_module.mt5=previous

    def test_position_stop_modification_is_confirmed_only_after_broker_response(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        fake=FakeMT5(trade_mode=0,margin_mode=2)
        bridge_module.mt5=fake
        try:
            status,result=self.service.modify_position({"ticket":77,"stopLoss":1995,"takeProfit":2020})
            self.assertEqual(status,200)
            self.assertEqual(result["state"],"CONFIRMED")
            self.assertEqual(fake.order_send_calls,1)
        finally:
            bridge_module.mt5=previous

    def test_position_management_cannot_remove_existing_stop_loss(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        bridge_module.mt5 = FakeMT5(trade_mode=0)
        try:
            status, result = self.service.modify_position({"ticket":77,"stopLoss":0,"takeProfit":2010})
            self.assertEqual(status,400)
            self.assertEqual(result["error"],"CANNOT_REMOVE_EXISTING_PROTECTION")
        finally:
            bridge_module.mt5 = previous

    def test_http_requires_auth_for_market_data_and_order_routes(self):
        server = ThreadingHTTPServer(("127.0.0.1",0),create_handler(self.service))
        thread = Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            url = "http://127.0.0.1:"+str(server.server_address[1])+"/market/quote"
            with self.assertRaises(HTTPError) as caught:
                urlopen(url,timeout=2)
            self.assertEqual(caught.exception.code,401)
            request = Request(url,headers={"X-Bridge-Token":"test-bridge-key"})
            try:
                with urlopen(request,timeout=2) as response:
                    self.fail("Expected an unavailable response without the MT5 package")
            except HTTPError as response:
                data=json.loads(response.read())
                self.assertEqual(response.code,503)
                self.assertIn(data["error"],("MT5_PACKAGE_MISSING","MT5_INITIALIZE_FAILED","MT5_TERMINAL_DISCONNECTED","MT5_CONNECTION_ERROR"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
