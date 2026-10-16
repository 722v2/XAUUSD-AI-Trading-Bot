import json
import tempfile
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from threading import Thread
from mt5_bridge.bridge import BridgeService, IdempotencyStore, create_handler, stable_order_comment, validate_order_payload
from http.server import ThreadingHTTPServer


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

    def test_health_is_not_claimed_connected_without_terminal_module(self):
        import mt5_bridge.bridge as bridge_module
        previous = bridge_module.mt5
        try:
            bridge_module.mt5 = None
            self.assertEqual(self.service.health()["state"],"NOT_CONFIGURED")
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
            with urlopen(request,timeout=2) as response:
                data=json.loads(response.read())
                self.assertIn(data["state"],("NOT_CONFIGURED","DISCONNECTED"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
