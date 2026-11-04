"""Task metadata in two-turn windows, with a keyset cursor for unusually large turns.

Running work is pinned independently of its launch turn. Output stays behind the existing output API.
"""
from __future__ import annotations

import base64
import json
import math
from datetime import datetime, timezone

from app.services.history_page import HistoryPager

PAGE_SIZE = 50
_AT = "COALESCE(started_at, unixepoch(updated_at), 0)"


def _epoch(value):
    return datetime.fromisoformat(value).timestamp() if value is not None else None


def _encode(value):
    return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')


def task_page(db, sid, *, cursor=None, turns=2, out=dict):
    as_of = datetime.now(timezone.utc).isoformat()
    pager = HistoryPager(db)
    until, after = None, None
    if cursor:
        try:
            state = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
            if state['v'] != 1 or state['sid'] != sid:
                raise ValueError()
            until = state.get('until')
            if until is not None:
                _epoch(until)
            if state.get('after') is not None:
                after = state['after']
                if len(after) != 2 or not math.isfinite(float(after[0])) or not isinstance(after[1], str):
                    raise ValueError()
                start, more_turns = state['start'], bool(state['more_turns'])
                _epoch(start)
            else:
                start, more_turns = pager.turn_range(sid, turns, until)
        except (ValueError, KeyError, TypeError, IndexError, OverflowError) as exc:
            raise ValueError('invalid task cursor') from exc
    else:
        start, more_turns = pager.turn_range(sid, turns, until)
    where = ["session_id = ?", "status NOT IN ('running','pending')"]
    params = [sid]
    if start is not None:
        where.append(f'{_AT} >= ?'); params.append(_epoch(start))
    if until is not None:
        where.append(f'{_AT} < ?'); params.append(_epoch(until))
    if after is not None:
        where.append(f'({_AT} < ? OR ({_AT} = ? AND task_id < ?))')
        params.extend([after[0], after[0], after[1]])
    rows = db.query(f"SELECT *, {_AT} AS page_at FROM bg_tasks WHERE {' AND '.join(where)} ORDER BY {_AT} DESC, task_id DESC LIMIT ?", (*params, PAGE_SIZE + 1))
    more_rows = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]
    next_cursor = None
    if more_rows:
        next_cursor = _encode({'v': 1, 'sid': sid, 'start': start, 'until': until, 'more_turns': more_turns, 'after': [rows[-1]['page_at'], rows[-1]['task_id']]})
    elif more_turns:
        next_cursor = _encode({'v': 1, 'sid': sid, 'until': start})
    def output(row):
        value = out(row)
        value.pop('page_at', None)
        return value
    running = db.query("SELECT * FROM bg_tasks WHERE session_id=? AND status IN ('running','pending') ORDER BY started_at DESC, task_id DESC", (sid,))
    return {'as_of': as_of, 'tasks': [output(row) for row in rows], 'running': [output(row) for row in running],
            'page': {'cursor': next_cursor, 'has_more': next_cursor is not None, 'turns': turns, 'start': start, 'until': until}}
