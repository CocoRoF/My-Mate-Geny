"""Mirror durable SSH jobs into the task API. A restart resumes monitoring, never execution."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
from pathlib import Path
import time

from app.workspaces.remote_jobs import RemoteJobs, RemoteTransportError, TERMINAL, atomic


class RemoteJobService:
    def __init__(self, sessions, root, *, manager_factory=RemoteJobs):
        self.sessions, self.root, self.factory = sessions, Path(root), manager_factory
        self.task = None
        self.active, self.polling, self.next_poll, self.locks = set(), {}, {}, {}
        self.semaphore = asyncio.Semaphore(3)

    def environment(self, sid):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        return {'HRH_REMOTE_JOBS_ROOT': str(self.root), 'HRH_REMOTE_SESSION_ID': sid}

    def active_note(self, sid):
        rows=self.sessions._db.query("SELECT task_id,description FROM bg_tasks WHERE session_id=? AND task_type='remote_bash' AND status IN ('running','pending') ORDER BY started_at DESC LIMIT 30",(sid,))
        rows=[dict(row) for row in rows]
        known={row['task_id'] for row in rows}
        for file in (self.root/'inbox').glob(sid+'_*.json'):
            if len(rows)>=30:break
            try:
                identity=json.loads(file.read_text());manager=self.factory(self.root,sid)
                manifest=manager.manifest(identity['job_id']);task_id='remote_'+manifest['job_id']
                if task_id not in known and self.state(manager.path(manifest['job_id'])).get('status') not in TERMINAL:
                    rows.append({'task_id':task_id,'description':manifest['description']});known.add(task_id)
            except (OSError,ValueError,KeyError):continue
        if not rows:return ''
        lines=['Existing remote jobs (already submitted; do not re-run their commands):']
        for row in rows:
            lines.append('job_id='+row['task_id'][7:]+' — '+json.dumps(row['description'] or 'remote command',ensure_ascii=False))
        return '\n'.join(lines)+'\nUse remote_poll on those IDs to recover progress/output, or remote_stop to cancel.'

    async def start(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for row in self.sessions._db.query("SELECT session_id,task_id FROM bg_tasks WHERE task_type='remote_bash' AND status IN ('running','pending')"):
            path=self.root/row['session_id']/row['task_id'][7:]/'manifest.json'
            if path.is_file():self.active.add(path)
            else:self.sessions._on_task(row['session_id'], {'task_id':row['task_id'],'task_type':'remote_bash','status':'lost','summary':'Remote job metadata missing; command was not replayed.'})
        self.task = asyncio.create_task(self.run())

    async def close(self):
        for task in [self.task,*self.polling.values()]:
            if task: task.cancel()
        await asyncio.gather(*[t for t in [self.task,*self.polling.values()] if t],return_exceptions=True)

    def has(self, sid, task_id):
        if not task_id.startswith('remote_'):
            return False
        try:
            return (RemoteJobs(self.root,sid).path(task_id[7:])/'manifest.json').is_file()
        except ValueError:
            return False

    def cancel(self, sid, *, include_background=False):
        changed = False
        try:directory=self.factory(self.root,sid).root
        except ValueError:return False
        for file in directory.glob('*/manifest.json'):
            try:
                manifest=json.loads(file.read_text());state=self.state(file.parent)
                if include_background:
                    self.active.add(file);self.next_poll.pop(file,None)
                if state.get('status') not in TERMINAL and (include_background or not manifest.get('background')):
                    (file.parent/'cancel').touch(mode=0o600)
                    self.active.add(file);self.next_poll.pop(file,None);changed=True
            except (OSError,ValueError):
                continue
        return changed

    async def stop_task(self, sid, task_id):
        manager=self.factory(self.root,sid);manifest=manager.manifest(task_id[7:])
        path=manager.path(manifest['job_id']);(path/'cancel').touch(mode=0o600)
        file=path/'manifest.json';self.active.add(file);self.next_poll.pop(file,None)
        return True  # Accepted immediately; confirmed cancellation is published by the monitor.

    @staticmethod
    def state(path):
        try:return json.loads((path/'state.json').read_text())
        except (OSError,ValueError):return {}

    async def refresh(self, manager, manifest):
        path=manager.path(manifest['job_id'])
        async with self.locks.setdefault(str(path),asyncio.Lock()),self.semaphore:
            output=path/'output.bin'
            offset=output.stat().st_size if output.exists() else 0
            if (path/'cancel').exists():
                result=await asyncio.to_thread(manager.stop,manifest)
                if offset:result=await asyncio.to_thread(manager.poll,manifest,offset=offset,max_bytes=1048576)
            elif (path/'launch.json').exists():
                result=await asyncio.to_thread(manager.start,manifest,wait_ms=0,max_bytes=1048576)
                if offset:result=await asyncio.to_thread(manager.poll,manifest,offset=offset,max_bytes=1048576)
            else:
                result=await asyncio.to_thread(manager.poll,manifest,offset=offset,max_bytes=1048576)
            if result.get('status')=='not_found':
                raise RemoteTransportError('Job unavailable; retain its ID and reconnect instead of resubmitting.')
            data=base64.b64decode(result.get('data') or '')
            if data:
                fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
                with os.fdopen(fd,'ab') as stream:
                    os.fchmod(stream.fileno(),0o600)
                    stream.write(data);stream.flush();os.fsync(stream.fileno())
            saved={k:v for k,v in result.items() if k!='data'}
            saved['cached_bytes']=offset+len(data)
            if result.get('status') in TERMINAL:
                saved['received_ended_at']=self.state(path).get('received_ended_at') or time.time()
            atomic(path/'state.json',saved)
            self.publish(manifest,saved)
            return saved

    def publish(self, manifest, state):
        status={'queued':'pending','timed_out':'failed'}.get(state.get('status'),state.get('status') or 'pending')
        if state.get('status') in TERMINAL and state.get('has_more'):status='pending'
        self.sessions._on_task(manifest['sid'],{
            'task_id':'remote_'+manifest['job_id'],'description':manifest['description'],'task_type':'remote_bash',
            'status':status,'started_at':manifest['started_at'],'ended_at':state.get('received_ended_at'),
            'output_file':str(self.root/manifest['sid']/manifest['job_id']/'output.bin'),'is_backgrounded':bool(manifest.get('background')),
            'summary':state.get('error') or (f"Exit {state['exit_code']}" if 'exit_code' in state else None),
            'activity':state.get('connection_error') or state.get('status')})

    async def poll_one(self, file):
        manifest=None;state={}
        try:
            manifest=json.loads(file.read_text());manager=self.factory(self.root,manifest['sid'])
            if manager.path(manifest['job_id'])!=file.parent:raise ValueError('job identity mismatch')
            state=self.state(file.parent)
            exists=self.sessions._db.query_one('SELECT id FROM sessions WHERE id=?',(manifest['sid'],))
            if not exists and state.get('status') not in TERMINAL:(file.parent/'cancel').touch(mode=0o600)
            if state.get('status') in TERMINAL and not state.get('has_more'):
                if not exists:
                    async with self.semaphore:
                        await asyncio.to_thread(manager.purge,manifest)
                    shutil.rmtree(file.parent)
                else:self.publish(manifest,state)
                self.active.discard(file);self.next_poll.pop(file,None);return
            self.publish(manifest,state or {'status':'pending'})
            result=await self.refresh(manager,manifest)
            if result.get('status') in TERMINAL and not result.get('has_more'):
                if not exists:
                    async with self.semaphore:
                        await asyncio.to_thread(manager.purge,manifest)
                    shutil.rmtree(file.parent)
                self.active.discard(file)
                self.next_poll.pop(file,None)
                self.locks.pop(str(file.parent),None)
                return
            self.next_poll[file]=time.monotonic()+(.05 if result.get('has_more') else 2)
        except asyncio.CancelledError:raise
        except (RemoteTransportError,ValueError,OSError,KeyError) as exc:
            self.next_poll[file]=time.monotonic()+5
            if manifest:self.publish(manifest,{**state,'connection_error':str(exc)[:200]})
        finally:
            self.polling.pop(file,None)

    async def run(self):
        scan_after=0
        while True:
            if time.monotonic()>=scan_after:
                # New launches have a tiny durable inbox. Do not rescan every historical output directory.
                for file in list((self.root/'inbox').glob('*.json'))[:100]:
                    try:
                        identity=json.loads(file.read_text());manager=self.factory(self.root,identity['sid'])
                        manifest=manager.manifest(identity['job_id']);path=manager.path(manifest['job_id'])/'manifest.json'
                        self.publish(manifest,self.state(path.parent) or {'status':'pending'})
                        self.active.add(path);file.unlink()
                    except (OSError,ValueError,KeyError):continue
                scan_after=time.monotonic()+1
            for file in list(self.active):
                if file not in self.polling and time.monotonic()>=self.next_poll.get(file,0):
                    self.polling[file]=asyncio.create_task(self.poll_one(file))
            await asyncio.sleep(.1)
