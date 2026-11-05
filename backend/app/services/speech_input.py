"""Durable speech messages: receive after the send pause, release after the parallel merge window.

Only the owning client may revise a group. A closed group is never rewritten after the model saw it.
No conversation text is logged. Accepted text survives disconnect and backend restart.
"""
from __future__ import annotations

import asyncio
import json
import math
import time



class SpeechInput:
    def __init__(self, db, sessions, *, clock=time.time):
        self.db, self.sessions, self.clock = db, sessions, clock
        self.tasks: dict[str, asyncio.Task] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.closed = False

    async def start(self):
        for row in self.db.query("SELECT id FROM speech_inputs WHERE state IN ('pending','dispatching')"):
            delivered = self.db.query_one("SELECT 1 FROM messages WHERE json_valid(meta) AND json_extract(meta,'$.speech_group')=? LIMIT 1", (row['id'],))
            if delivered and self.db.query_one("SELECT 1 FROM messages WHERE json_valid(meta) AND json_extract(meta,'$.speech_group')=? AND coalesce(json_extract(meta,'$.speech_pending'),0)=0 LIMIT 1", (row['id'],)):
                self.db.execute("UPDATE speech_inputs SET state='delivered',text='',attachments='[]' WHERE id=?", (row['id'],))
                continue
            # Retry only inputs not recorded as delivered.
            self.db.execute("UPDATE speech_inputs SET state='pending' WHERE id=?", (row['id'],))
            self.arm(row['id'])

    def output(self, row):
        return {'group_id': row['id'], 'client_msg_id': row['client_id'], 'text': row['text'],
                'attachments': [self.sessions._attachments.out(r) for aid in json.loads(row['attachments']) if (r := self.sessions._attachments.get(aid)) and r['session_id'] == row['session_id']] if self.sessions._attachments else [], 'at': row['created_at'], 'deadline': row['deadline'],
                'revision': row['revision'], 'message_id': row['message_id'], 'role': row['role']}

    def publish(self, sid, type_, data):
        self.sessions._publish(sid, {'type': type_, 'data': data})

    def replay(self, sid):
        return [{'type': 'speech.pending', 'data': self.output(row)} for row in self.db.query(
            "SELECT * FROM speech_inputs WHERE session_id=? AND state IN ('pending','dispatching') ORDER BY created_at", (sid,))]

    @staticmethod
    def number(value, low, high, default):
        try:
            result = float(value)
            return min(high, max(low, result)) if math.isfinite(result) else default
        except (ValueError, TypeError):
            return default

    async def receive(self, sid, msg):
        session = self.sessions.get(sid)
        if session.get('kind') != 'mate':
            raise ValueError('speech groups require a mate conversation')
        group, client = msg.get('group_id'), msg.get('client_msg_id')
        if not isinstance(group, str) or not isinstance(client, str) or not (1 <= len(group) <= 180) or group != client:
            raise ValueError('invalid speech group identity')
        async with self.locks.setdefault(group, asyncio.Lock()):
            row = self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (group,))
            if row and (row['session_id'] != sid or row['client_id'] != client):
                raise ValueError('speech group belongs to another conversation')
            if row and row['state'] not in ('pending',):
                self.close_event(row)
                return
            now = self.clock()
            window = self.number(msg.get('window_ms'), 0, 10000, 4000) / 1000
            idle = self.number(msg.get('idle_ms'), 0, window * 1000, 0) / 1000
            deadline = now + max(0, window - idle)
            if msg.get('op') not in (None, 'submit', 'touch'):
                raise ValueError('invalid speech operation')
            touch = msg.get('op') == 'touch'
            if touch and not row:
                return
            if not touch:
                text = msg.get('input')
                if not isinstance(text, str) or not text.strip() or len(text) > 100000:
                    raise ValueError('speech input must contain 1–100000 characters')
                revision = msg.get('revision')
                if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
                    raise ValueError('invalid speech revision')
                if row and revision <= row['revision']:
                    self.publish(sid, 'speech.pending', self.output(row))
                    return
                ids = msg.get('attachments') or []
                if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
                    raise ValueError('invalid speech attachments')
                if row:
                    ids = list(dict.fromkeys([*json.loads(row['attachments']), *ids]))
                if self.sessions._attachments and ids:
                    self.sessions._attachments.pending(sid, ids)
                if row:
                    self.db.execute('UPDATE speech_inputs SET text=?,attachments=?,revision=?,deadline=? WHERE id=?',
                                    (text.strip(), json.dumps(ids), revision, deadline, group))
                else:
                    # Bound abandoned groups per conversation without imposing a bound on an active utterance.
                    if len(self.replay(sid)) >= 8:
                        raise ValueError('too many pending speech groups')
                    role = 'steer' if self.sessions.is_running(sid) else 'user'
                    meta = {'speech_group': group, 'speech_pending': True, 'speech_at': now}
                    mid = self.sessions._add_message(sid, role, text.strip(), meta=meta)
                    self.db.execute('INSERT INTO speech_inputs(id,session_id,client_id,message_id,role,text,attachments,revision,created_at,deadline,state) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                    (group, sid, client, mid, role, text.strip(), json.dumps(ids), revision, now, deadline, 'pending'))
                    data = {'text': text.strip(), 'client_msg_id': client, 'message_id': mid, 'attachments': [], **meta}
                    if role == 'steer':
                        from app.providers.base import ProviderEvent
                        event = ProviderEvent(type='user.steer', data=data)
                        self.sessions._add_event(sid, event)
                        self.sessions._publish(sid, event.to_dict())
                    else:
                        self.publish(sid, 'user.message', data)
                row = self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (group,))
                self.db.execute('UPDATE messages SET content=? WHERE id=?', (text.strip(), row['message_id']))
                self.publish(sid, 'speech.pending', self.output(row))
            else:
                self.db.execute('UPDATE speech_inputs SET deadline=? WHERE id=?', (deadline, group))
            if getattr(self.sessions, 'screen', None):
                self.sessions.screen.triggers.activity_now(sid)
            self.arm(group)

    def arm(self, group):
        old = self.tasks.pop(group, None)
        if old and old is not asyncio.current_task():
            old.cancel()
        if not self.closed:
            self.tasks[group] = asyncio.create_task(self.release(group))

    async def release(self, group):
        try:
            while not self.closed:
                row = self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (group,))
                if not row or row['state'] != 'pending':
                    return
                remaining = row['deadline'] - self.clock()
                if remaining > 0:
                    await asyncio.sleep(remaining)
                    continue
                async with self.locks.setdefault(group, asyncio.Lock()):
                    row = self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (group,))
                    if not row or row['state'] != 'pending' or row['deadline'] > self.clock():
                        continue
                    self.db.execute("UPDATE speech_inputs SET state='dispatching' WHERE id=?", (group,))
                sid, text = row['session_id'], row['text']
                ids = json.loads(row['attachments'])
                meta = {'speech_group': group, 'speech_pending': False, 'speech_at': row['created_at']}
                if self.sessions.is_running(sid):
                    if await self.sessions.steer(sid, text, ids, client_msg_id=row['client_id'], meta=meta):
                        return
                # A rejected steer is finishing. Preserve the accepted message server-side and start next.
                while self.sessions.is_running(sid):
                    await asyncio.sleep(.05)
                self.sessions.start_turn(sid, text, ids, client_msg_id=row['client_id'], meta=meta)
                # run_turn marks delivery when its user row is durable (screen permission may delay it).
                return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            row = self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (group,))
            if row:
                self.db.execute("UPDATE speech_inputs SET state='failed',text='',attachments='[]' WHERE id=?", (group,))
                self.publish(row['session_id'], 'speech.failed', {'group_id': group, 'message': str(exc)[:200]})
                self.close_event(self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (group,)))
        finally:
            if self.tasks.get(group) is asyncio.current_task():
                self.tasks.pop(group, None)

    def close_event(self, row):
        message = self.db.query_one('SELECT content,meta FROM messages WHERE id=?', (row['message_id'],))
        if message and row['state'] not in ('pending', 'dispatching'):
            meta = json.loads(message['meta'] or '{}');meta['speech_pending'] = False
            self.db.execute('UPDATE messages SET meta=? WHERE id=?', (json.dumps(meta), row['message_id']))
            from app.mate.knowledge import record_message
            for mate_id in record_message(self.db, row['message_id']):
                self.sessions.mates_changed('memory', mate_id)
        self.publish(row['session_id'], 'speech.closed', {'group_id': row['id'], 'state': row['state'], 'revision': row['revision'], 'accepted_text': message['content'] if message else '', 'attachments': self.sessions._attachments.by_message(row['session_id']).get(row['message_id'], []) if self.sessions._attachments else []})

    def delivered(self, sid, group):
        self.db.execute("UPDATE speech_inputs SET state='delivered',text='',attachments='[]' WHERE id=? AND session_id=?", (group, sid))
        row = self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (group,))
        if row:
            self.close_event(row)
        lock = self.locks.get(group)
        if lock and not lock.locked():
            self.locks.pop(group, None)

    def cancel(self, sid):
        for row in self.db.query("SELECT * FROM speech_inputs WHERE session_id=? AND state IN ('pending','dispatching')", (sid,)):
            task = self.tasks.pop(row['id'], None)
            if task:
                task.cancel()
            meta = {'speech_group': row['id'], 'speech_pending': False, 'speech_cancelled': True, 'speech_at': row['created_at']}
            self.db.execute('UPDATE messages SET meta=? WHERE id=?', (json.dumps(meta), row['message_id']))
            from app.mate.knowledge import record_message
            for mate_id in record_message(self.db, row['message_id']):
                self.sessions.mates_changed('memory', mate_id)
            if self.sessions._attachments:
                self.sessions._attachments.link(json.loads(row['attachments']), row['message_id'])
            self.db.execute("UPDATE speech_inputs SET state='cancelled',text='',attachments='[]' WHERE id=?", (row['id'],))
            self.close_event(self.db.query_one('SELECT * FROM speech_inputs WHERE id=?', (row['id'],)))
            lock = self.locks.get(row['id'])
            if lock and not lock.locked():
                self.locks.pop(row['id'], None)

    async def stop(self):
        self.closed = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()
