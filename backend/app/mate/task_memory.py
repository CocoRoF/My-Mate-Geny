"""Durable delegation receipts. A successful model turn is only a report,
not proof that an external page was published or a deployment succeeded.
"""

from __future__ import annotations

import json

from app.mate.knowledge import safe_text
from app.services._ids import new_id, now_iso


class TaskMemory:
    def __init__(self, db):
        self.db = db

    def create(self, worker_sid, mate, mate_sid, title, instruction, depth):
        rid, now = new_id("req_"), now_iso()
        self.db.execute(
            "INSERT INTO mate_delegation_requests(id,mate_id,mate_sid,worker_sid,instruction,title,depth,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (rid, mate["id"], mate_sid, worker_sid, instruction[:16000], title, depth, now, now),
        )
        return rid

    def fail_delivery(self, rid):
        self.db.execute(
            "UPDATE mate_delegation_requests SET state='delivery_failed',delivered=1,updated_at=? WHERE id=?",
            (now_iso(), rid),
        )

    def complete(self, sid, outcome, background=0):
        out = []
        with self.db.transaction():
            for r in self.db.query(
                "SELECT * FROM mate_delegation_requests WHERE worker_sid=? AND state IN ('requested','background')",
                (sid,),
            ):
                state = (
                    "background"
                    if background
                    else "reported"
                    if outcome.get("status") == "ok"
                    else "interrupted"
                )
                payload = {
                    "session_id": sid,
                    "title": outcome.get("title") or r["title"],
                    "status": outcome.get("status") or "error",
                    "text": str(outcome.get("text") or "")[:8000],
                    "error": outcome.get("error"),
                    "depth": r["depth"],
                    "request_id": r["id"],
                    "receipt_revision": r["result_revision"] + 1,
                    "verification": "unverified",
                    "background": background,
                }
                if not safe_text(payload["text"]):
                    payload["text"] = (
                        "[Report contains credentials; inspect the original worker chat.]"
                    )
                self.db.execute(
                    "UPDATE mate_delegation_requests SET state=?,result=?,outcome=?,delivered=0,result_revision=result_revision+1,updated_at=? WHERE id=?",
                    (
                        state,
                        json.dumps(payload, ensure_ascii=False),
                        str(outcome.get("status") or "error"),
                        now_iso(),
                        r["id"],
                    ),
                )
                out.append((r["mate_sid"], payload))
        return out

    def mark_delivered(self, ids):
        with self.db.transaction():
            for rid in ids:
                self.db.execute(
                    "UPDATE mate_delegation_requests SET delivered=1 WHERE id=?", (rid,)
                )

    def recover(self):
        """No automatic retry of side effects after a crash. Uncertain work is
        reported as interrupted, with original event receipts available."""
        self.db.execute(
            "UPDATE mate_delegation_requests SET state='interrupted',outcome='unknown',delivered=0,result=NULL,result_revision=result_revision+1,updated_at=? WHERE state IN ('requested','background')",
            (now_iso(),),
        )
        out = []
        for r in self.db.query(
            "SELECT * FROM mate_delegation_requests WHERE delivered=0 ORDER BY created_at,id"
        ):
            # start_turn stores this id before scheduling the provider. A crash
            # after acceptance must not deliver the same result twice.
            accepted = self.db.query_one(
                "SELECT 1 FROM messages WHERE session_id=? AND json_valid(meta) AND EXISTS(SELECT 1 FROM json_each(meta,'$.delegation_receipts') WHERE value=?) LIMIT 1",
                (r["mate_sid"], r["id"] + ":" + str(r["result_revision"])),
            )
            if accepted:
                self.mark_delivered([r["id"]])
                continue
            result = (
                json.loads(r["result"])
                if r["result"] and r["state"] != "interrupted"
                else {
                    "session_id": r["worker_sid"],
                    "title": r["title"],
                    "status": "error",
                    "text": "",
                    "error": "The application restarted before this request was confirmed. Check its receipts before retrying any external action.",
                    "depth": r["depth"],
                    "request_id": r["id"],
                    "receipt_revision": r["result_revision"],
                    "verification": "unknown",
                }
            )
            out.append((r["mate_sid"], result))
        return out

    def get(self, mate_id, rid):
        row = self.db.query_one(
            "SELECT * FROM mate_delegation_requests WHERE mate_id=? AND id=?", (mate_id, rid)
        )
        if not row:
            raise ValueError("Task request not found")
        # Tool invocations and results are independent evidence; preserve exact
        # event IDs for opening the original session. Only this request's time
        # window, no secrets or tool payloads copied into task metadata.
        until = (
            row["updated_at"]
            if row["state"] in ("reported", "interrupted", "delivery_failed")
            else now_iso()
        )
        receipts = [
            dict(r)
            for r in self.db.query(
                "SELECT id,type,created_at FROM events WHERE session_id=? AND created_at>=? AND created_at<=? AND type IN ('tool.start','tool.result','turn.complete','error') ORDER BY id LIMIT 100",
                (row["worker_sid"], row["created_at"], until),
            )
        ]
        return {
            **dict(row),
            "result": json.loads(row["result"]) if row["result"] else None,
            "verification": "unknown" if row["outcome"] == "unknown" else "unverified",
            "receipts": receipts,
            "receipts_are_execution_evidence": True,
            "receipt_scope": "shared_worker_time_window",
            "external_success_requires_verification": True,
        }

    def list(self, mate_id, limit=20):
        return [
            self.get(mate_id, r["id"])
            for r in self.db.query(
                "SELECT id FROM mate_delegation_requests WHERE mate_id=? ORDER BY created_at DESC LIMIT ?",
                (mate_id, min(50, max(1, limit))),
            )
        ]

    def read_receipt(self, mate_id, rid, event_id):
        record = self.get(mate_id, rid)
        if not any(r["id"] == event_id for r in record["receipts"]):
            raise ValueError("Receipt outside this request")
        row = self.db.query_one(
            "SELECT type,data,created_at FROM events WHERE id=? AND session_id=?",
            (event_id, record["worker_sid"]),
        )
        if not row:
            raise ValueError("Receipt not found")
        data = json.loads(row["data"])
        text = str(data.get("output") or data.get("text") or data.get("message") or "")
        if not safe_text(text):
            text = "[Credentials omitted. Inspect the original chat with appropriate access.]"
        return {
            "request_id": rid,
            "event_id": event_id,
            "type": row["type"],
            "created_at": row["created_at"],
            "is_error": data.get("is_error"),
            "text": text[:6000],
            "truncated": len(text) > 6000,
            "untrusted_evidence": True,
            "verification": "observed_execution_not_external_validation",
        }
