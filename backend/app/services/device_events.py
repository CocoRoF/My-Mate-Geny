"""Durable idempotent device lifecycle events. No screenshot permission is implied by a greeting."""
import asyncio,json,time

class DeviceEvents:
    def __init__(self,screen):
        self.screen=screen;self.db=screen.sessions._db;self.lock=asyncio.Lock()
        self.db.execute('CREATE TABLE IF NOT EXISTS device_presence(device TEXT PRIMARY KEY, first_seen REAL NOT NULL, last_seen REAL NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS device_events(id TEXT PRIMARY KEY, device TEXT NOT NULL, mate_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL, status TEXT NOT NULL DEFAULT \'pending\')')
        self.db.execute('CREATE INDEX IF NOT EXISTS device_events_pending ON device_events(status,device,mate_id)')
    def ingest(self,client,msg):
        if not client.device:return []
        if client.screen_policy.get('enabled') is False:
            self.db.execute("UPDATE device_events SET status='cancelled' WHERE device=? AND status='pending'",(client.device,))
            for sid,meta in list(self.screen.sessions._turn_meta.items()):
                if meta.get('internal') and meta.get('kind') in ('device_greeting','screen_observation','thinking_trigger') and self.screen.sessions.last_client_device(sid)==client.device:self.screen.sessions.stop(sid)
        if msg.get('device_runtime') is not True:return []
        device=client.device;mate_id=msg.get('device_mate_id');boot=msg.get('device_boot')
        if not isinstance(mate_id,str) or not isinstance(boot,str) or len(boot)>100:return []
        try:self.screen.mates.get(mate_id)
        except (KeyError,AttributeError):return []
        now=time.time();fresh=self.db.query_one('SELECT device FROM device_presence WHERE device=?',(device,)) is None
        self.db.execute('INSERT INTO device_presence(device,first_seen,last_seen) VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET last_seen=excluded.last_seen',(device,now,now))
        enabled=client.screen_policy.get('enabled') is True
        def add(key,kind,payload):
            self.db.execute('INSERT OR IGNORE INTO device_events(id,device,mate_id,kind,payload,created,status) VALUES(?,?,?,?,?,?,?)',(key,device,mate_id,kind,json.dumps(payload),now,'pending' if enabled else 'cancelled'))
        if fresh:add(f'first:{device}','first_seen',{})
        accepted=[]
        for event in (msg.get('device_events') or [])[:30]:
            if not isinstance(event,dict) or event.get('type') not in ('startup','enabled'):continue
            eid=event.get('id');target=event.get('mate_id')
            if not isinstance(eid,str) or len(eid)>100 or not isinstance(target,str):continue
            try:self.screen.mates.get(target)
            except KeyError:continue
            # Selection is explicit in the device policy. Do not greet an unrelated Mate.
            if target!=mate_id:accepted.append(eid);continue
            key=f'start:{device}:{boot}:{mate_id}' if event['type']=='startup' else f'enable:{device}:{eid}'
            add(key,event['type'],{'start_reason':str(event.get('start_reason') or 'manual')[:30]});accepted.append(eid)
        if not enabled:self.db.execute("UPDATE device_events SET status='cancelled' WHERE device=? AND status='pending'",(device,))
        return accepted
    async def drain(self):
        if self.lock.locked() or self.screen.mates is None:return
        async with self.lock:
            rows=self.db.query("SELECT * FROM device_events WHERE status='pending' ORDER BY created")
            groups={}
            for r in rows:groups.setdefault((r['device'],r['mate_id']),[]).append(r)
            for (device,mid),events in groups.items():
                clients=[c for c in self.screen.broker.clients() if c.device==device and c.screen_policy.get('enabled') and (not c.screen_policy.get('mate_id') or c.screen_policy['mate_id']==mid)]
                if not clients:continue
                if any(c.device==device and c.user_busy and time.monotonic()-c.busy_at<10 for c in self.screen.broker.clients()):continue
                try:conv=self.screen.mate_service.conversation(mid)
                except (KeyError,AttributeError):continue
                sid=conv['session_id']
                if self.screen.sessions.is_running(sid) or self.screen.sessions.running_task_count(sid)>0:continue
                kinds=sorted({e['kind'] for e in events})
                prompt='Device lifecycle event: '+','.join(kinds)+'. '+('The app started automatically after computer login. ' if any('autostart' in e['payload'] for e in events) else '')
                prompt+='The user enabled you to speak first on this device. Give one short, natural greeting or acknowledgement suited to the current conversation and character. Do not repeat a greeting already in recent messages. Do not claim to see a screen unless an image is actually attached. Do not change settings or store this event as memory.'
                try:
                    self.screen.sessions.start_turn(sid,prompt,[],client_msg_id=f'device-event~{device}',meta={'internal':True,'kind':'device_greeting','device':device,'events':kinds})
                except Exception:continue
                self.screen.triggers.activity_now(sid)
                self.screen.triggers.consecutive[sid]=1
                for event in events:self.db.execute("UPDATE device_events SET status='delivered' WHERE id=?",(event['id'],))
