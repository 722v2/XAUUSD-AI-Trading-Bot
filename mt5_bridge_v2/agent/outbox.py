from __future__ import annotations
import json, sqlite3, threading
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

class Outbox:
    """Durable local result queue; uncertain commands are never resubmitted automatically."""
    def __init__(self, path: str):
        self.path = Path(path); self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS results(
              command_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, state TEXT NOT NULL,
              payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS idx_results_pending ON results(delivered,updated_at)")
            db.execute("""CREATE TABLE IF NOT EXISTS command_ledger(
              idempotency_key TEXT PRIMARY KEY, state TEXT NOT NULL, result_json TEXT,
              updated_at TEXT NOT NULL)""")
    def connect(self):
        db=sqlite3.connect(self.path,timeout=10)
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA busy_timeout=10000")
        return db
    def command_state(self, key: str):
        with self.connect() as db:
            row=db.execute("SELECT state,result_json FROM command_ledger WHERE idempotency_key=?",(key,)).fetchone()
            return dict(row) if row else None
    def mark(self,key: str,state: str,result: dict[str,Any]|None=None):
        now=datetime.now(timezone.utc).isoformat()
        with self.lock,self.connect() as db:
            db.execute("""INSERT INTO command_ledger(idempotency_key,state,result_json,updated_at) VALUES(?,?,?,?)
              ON CONFLICT(idempotency_key) DO UPDATE SET state=excluded.state,result_json=excluded.result_json,updated_at=excluded.updated_at""",
              (key,state,json.dumps(result) if result is not None else None,now))
    def enqueue_result(self,command_id: str,key: str,state: str,payload: dict[str,Any]):
        now=datetime.now(timezone.utc).isoformat()
        with self.lock,self.connect() as db:
            db.execute("INSERT OR IGNORE INTO results(command_id,idempotency_key,state,payload,updated_at) VALUES(?,?,?,?,?)",
              (command_id,key,state,json.dumps(payload,separators=(",",":")),now))
            db.execute("""INSERT INTO command_ledger(idempotency_key,state,result_json,updated_at) VALUES(?,?,?,?)
              ON CONFLICT(idempotency_key) DO UPDATE SET state=excluded.state,result_json=excluded.result_json,updated_at=excluded.updated_at""",
              (key,state,json.dumps(payload),now))
    def pending_results(self,limit=50):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT * FROM results WHERE delivered=0 ORDER BY updated_at LIMIT ?",(limit,))]
    def mark_delivered(self,command_id: str):
        with self.connect() as db: db.execute("UPDATE results SET delivered=1 WHERE command_id=?",(command_id,))
