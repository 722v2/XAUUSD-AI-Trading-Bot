from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from mt5_bridge_v2.agent.outbox import Outbox
from mt5_bridge_v2.agent.order_executor import _finite_positive

class BridgeV2OutboxTests(unittest.TestCase):
    def test_order_numbers_must_be_finite_positive_numbers(self):
        self.assertTrue(_finite_positive(0.01))
        self.assertFalse(_finite_positive(0))
        self.assertFalse(_finite_positive(float("nan")))
        self.assertFalse(_finite_positive(True))
    def test_idempotency_ledger_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/"outbox.sqlite3")
            Outbox(path).mark("unique-order-key","SUBMITTING",{"comment":"XAUAI-test"})
            reopened=Outbox(path)
            state=reopened.command_state("unique-order-key")
            self.assertIsNotNone(state)
            self.assertEqual(state["state"],"SUBMITTING")
            self.assertIn("XAUAI-test",state["result_json"])
    def test_results_remain_pending_until_server_acknowledges(self):
        with tempfile.TemporaryDirectory() as directory:
            outbox=Outbox(str(Path(directory)/"outbox.sqlite3"))
            payload={"commandId":"command-1","idempotencyKey":"key-1","state":"UNKNOWN","code":"TIMEOUT","details":{}}
            outbox.enqueue_result("command-1","key-1","UNKNOWN",payload)
            self.assertEqual(len(outbox.pending_results()),1)
            outbox.mark_delivered("command-1")
            self.assertEqual(outbox.pending_results(),[])
    def test_duplicate_result_does_not_create_second_outbox_record(self):
        with tempfile.TemporaryDirectory() as directory:
            outbox=Outbox(str(Path(directory)/"outbox.sqlite3"))
            payload={"commandId":"command-1","idempotencyKey":"key-1","state":"REJECTED","code":"INVALID","details":{}}
            outbox.enqueue_result("command-1","key-1","REJECTED",payload)
            outbox.enqueue_result("command-1","key-1","REJECTED",payload)
            self.assertEqual(len(outbox.pending_results()),1)

if __name__=="__main__": unittest.main()
