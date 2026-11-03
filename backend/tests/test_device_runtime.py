"""Device intent and fixed autonomous policy; no provider calls or paid generation."""
import asyncio
from types import SimpleNamespace
import pytest
from app.services.device_events import DeviceEvents
from app.mate.trigger.fixed import FixedPolicy
from app.mate.trigger.defaults import default_manifest
from tests.test_geny_triggers import runtime
from tests.test_local_screen import respond


def hello(screen,mid,*,on=True,device='dev-a',boot='boot-a',events=None,busy=False):
    c=next((c for c in screen.broker.clients() if c.device==device),None)
    conn=c.conn if c else screen.broker.connect(lambda _:None)
    msg={'type':'client','device':device,'capture':1,'desktop':'0.4.38','surface':'device-runtime',
         'screen_policy':{'enabled':on,'fixed':True,'mate_id':mid,'interval':60},
         'device_runtime':True,'device_boot':boot,'device_mate_id':mid,'device_events':events or [],'user_busy':busy}
    screen.broker.hello(conn,msg)
    return conn,msg

async def test_startup_first_seen_and_enable_coalesce_and_replay_is_idempotent_after_restart(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    screen.mate_service=SimpleNamespace(conversation=lambda _: {'session_id':sid})
    events=[{'id':'enable-1','type':'enabled','mate_id':m['id']},{'id':'start-1','type':'startup','mate_id':m['id'],'start_reason':'autostart'}]
    conn,msg=hello(screen,m['id'],events=events)
    assert screen.device_events.ingest(screen.broker._clients[conn],msg)==['enable-1','start-1']
    await screen.device_events.drain()
    assert len(started)==1
    assert started[0][1]['meta']['events']==['enabled','first_seen','startup']
    assert 'automatically' in started[0][0][1]
    # Reloading visible windows / reconnecting and even recreating server runtime cannot replay it.
    screen.device_events=DeviceEvents(screen)
    screen.device_events.ingest(screen.broker._clients[conn],msg);await screen.device_events.drain()
    assert len(started)==1
    conn,msg=hello(screen,m['id'],boot='boot-b',events=[{'id':'start-2','type':'startup','mate_id':m['id']}])
    screen.device_events.ingest(screen.broker._clients[conn],msg);await screen.device_events.drain()
    assert len(started)==2

async def test_off_cancels_pending_but_never_stops_a_normal_user_turn(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    screen.mate_service=SimpleNamespace(conversation=lambda _: {'session_id':sid})
    stopped=[];monkeypatch.setattr(svc,'stop',lambda s:stopped.append(s))
    conn,msg=hello(screen,m['id'],busy=True,events=[{'id':'e','type':'enabled','mate_id':m['id']}])
    screen.device_events.ingest(screen.broker._clients[conn],msg);await screen.device_events.drain();assert started==[]
    svc._turn_meta[sid]={'internal':False};conn,msg=hello(screen,m['id'],on=False)
    screen.device_events.ingest(screen.broker._clients[conn],msg);await screen.device_events.drain()
    assert stopped==[] and started==[]
    assert db.query_one("SELECT COUNT(*) AS n FROM device_events WHERE status='pending'")['n']==0
    svc._turn_meta[sid]={'internal':True,'kind':'device_greeting'}
    screen.device_events.ingest(screen.broker._clients[conn],msg);assert stopped==[sid]

async def test_busy_device_defers_greeting_and_wrong_device_cannot_deliver_it(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    screen.mate_service=SimpleNamespace(conversation=lambda _: {'session_id':sid})
    conn,msg=hello(screen,m['id'],busy=True,events=[{'id':'e','type':'enabled','mate_id':m['id']}])
    screen.device_events.ingest(screen.broker._clients[conn],msg);await screen.device_events.drain();assert not started
    screen.broker.disconnect(conn)
    hello(screen,m['id'],device='another-device')
    await screen.device_events.drain();assert not started
    hello(screen,m['id']);await screen.device_events.drain();assert len(started)==1

async def test_fixed_policy_ignores_stored_tuners_and_unchanged_frame_skips_model_work(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    legacy=default_manifest().model_dump();legacy['enabled']=False
    store.update(m['id'],{'prefs':{'proactive':{'enabled':False,'scope':'screen','interval':600,'preset':legacy}}})
    conn=next(c.conn for c in screen.broker.clients() if c.device=='dev-a')
    screen.broker.hello(conn,{'device':'dev-a','capture':1,'shares':{sid:'ask'},'screen_policy':{'enabled':True,'fixed':True,'mate_id':m['id'],'interval':600}})
    config=screen.proactive(sid,'dev-a');assert config['interval']==60 and config['preset'] is None and config['enabled']
    assert isinstance(screen.triggers.policy(sid,config,None),FixedPolicy)
    task=asyncio.create_task(screen.observe(sid,'dev-a'));await respond(q,screen,atts,sid);await task
    clock[0]+=61
    task=asyncio.create_task(screen.triggers.consider(sid));await respond(q,screen,atts,sid)
    assert (await task)=={'status':'sent','category':'screen_observation'}
    clock[0]+=61
    assert await screen.triggers.consider(sid)=={'status':'unchanged'}
    assert len(started)==1 and q.empty()

@pytest.mark.parametrize('count,category',[(0,'first_idle'),(1,'continued_idle'),(4,'long_idle')])
def test_fixed_idle_situations_and_screen_priority(count,category):
    p=FixedPolicy(default_manifest(),clock=lambda:100000,hour=9)
    p._consecutive_triggers['s']=count
    p._last_category_fire['s']={'time_morning':100000}
    text,cat=p._pick_category_and_prompt('s',lambda _:False)
    assert cat.id==category and 'internal awareness' not in text
    p.screen_active=True
    assert p._pick_category_and_prompt('s',lambda _:False)[1].id=='screen_observation'
