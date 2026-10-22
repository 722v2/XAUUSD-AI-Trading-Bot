from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from mt5_bridge_v2.agent.outbox import Outbox

class OutboxTests(unittest.TestCase):
    def test_idempotency_ledger_survives_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/"outbox.sqlite3")
            first=Outbox(path)
            first.mark("same-key","SUBMITTING",{"comment":"XAUAI-test"})
            second=Outbox(path)
            state=second.command_state("same-key")
            self.assertIsNotNone(state)
            self.assertEqual(state["state"],"SUBMITTING")
            self.assertIn("XAUAI-test",state["result_json"])
    def test_result_outbox_retries_until_acknowledged(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Outbox(str(Path(directory)/"outbox.sqlite3"))
            payload={"commandId":"cmd","idempotencyKey":"key","state":"UNKNOWN","code":"TIMEOUT","details":{}}
            store.enqueue_result("cmd","key","UNKNOWN",payload)
            self.assertEqual(len(store.pending_results()),1)
            store.mark_delivered("cmd")
            self.assertEqual(store.pending_results(),[])
    def test_duplicate_result_insert_does_not_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Outbox(str(Path(directory)/"outbox.sqlite3"))
            payload={"commandId":"cmd","idempotencyKey":"key","state":"REJECTED","code":"INVALID","details":{}}
            store.enqueue_result("cmd","key","REJECTED",payload)
            store.enqueue_result("cmd","key","REJECTED",payload)
            self.assertEqual(len(store.pending_results()),1)

if __name__=="__main__": unittest.main()
