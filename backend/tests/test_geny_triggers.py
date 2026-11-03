"""Project Geny parity: original timing/selection, screen gating and silence delivery."""
import asyncio,math,random
from types import SimpleNamespace
import pytest
from app.mate.trigger.defaults import default_manifest
from app.mate.trigger.policy import GenyPolicy,_category_eligible,_resolve_time_window
from app.mate.trigger.schemas import TriggerCategory,TriggerPresetManifest
from app.mate.trigger.silence import is_silence_text,deliver_autonomous
from app.providers.base import ProviderEvent
from app.services.screen import ScreenService
from tests.test_mate_screen import _services,_upload,_png
from tests.test_local_screen import client,respond


def test_entire_manifest_matches_the_original_geny_golden():
    import json
    from pathlib import Path
    golden=json.loads((Path(__file__).parent/'fixtures/geny_trigger_manifest.json').read_text())
    assert default_manifest().model_dump()==golden


def test_original_geny_defaults_are_complete():
    m=default_manifest()
    assert m.timing.base_idle_seconds==60 and m.timing.max_idle_seconds==3600
    assert m.timing.adaptive_scale_triggers==20
    cats={c.id:c for c in m.categories}
    assert cats['screen_observation'].weight==800 and cats['screen_observation'].cooldown_seconds==45
    assert cats['sub_worker_working'].weight==1000 and cats['sub_worker_working'].cooldown_seconds==90
    assert all(cats[n].weight==55 for n in ['first_idle','continued_idle','long_idle'])
    assert len(m.categories)==15
    assert all('[SILENT]' in p.content['en'] for p in m.prompts if p.id.startswith('screen_observation__'))

@pytest.mark.parametrize('count',[0,1,4,10,20,100])
def test_original_logarithmic_backoff(count):
    p=GenyPolicy(default_manifest())
    p._consecutive_triggers['s']=count
    expected=60 if count<=0 else 60+3540*min(math.log1p(count)/math.log1p(20),1)
    assert p._get_adaptive_threshold('s')==pytest.approx(expected)

@pytest.mark.parametrize('hour,window',[(0,'night'),(5,'night'),(6,'morning'),(12,'afternoon'),(18,'evening'),(22,'night')])
def test_original_time_boundaries(hour,window):
    assert _resolve_time_window(default_manifest(),hour)==window

@pytest.mark.parametrize('cat,changes,expected',[
 ('first_idle',{'consec':0},True),('first_idle',{'consec':1},False),('continued_idle',{'consec':3},True),('continued_idle',{'consec':4},False),
 ('long_idle',{'consec':4},True),('long_idle',{'consec':3},False),
 ('screen_observation',{'screen_active':False},False),('screen_observation',{'screen_active':True},True),
 ('screen_observation',{'screen_active':True,'last_fire_at':970},False),
 ('screen_observation',{'screen_active':True,'last_fire_at':955},True),
 ('sub_worker_working',{'sub_worker_busy':False},False),('sub_worker_working',{'sub_worker_busy':True},True),
 ('time_morning',{'time_window':'night'},False),('time_night',{'time_window':'night'},True),
])
def test_original_category_conditions(cat,changes,expected):
    category=next(c for c in default_manifest().categories if c.id==cat)
    args=dict(consec=0,sub_worker_busy=False,sub_worker_linked=False,time_window='morning',last_fire_at=0,now=1000,screen_active=False)
    assert _category_eligible(category,**{**args,**changes})==expected


def test_weighted_category_and_prompt_selection_and_cooldown(monkeypatch):
    m=default_manifest()
    for c in m.categories:
        if c.id!='screen_observation':c.weight=0
    p=GenyPolicy(m,clock=lambda:1000,screen_active=True,time_context='2026-11-03 12:00 KST')
    monkeypatch.setattr(random,'random',lambda:0)
    text,cat=p._pick_category_and_prompt('s',lambda _:False)
    assert cat.id=='screen_observation' and text.startswith('[THINKING_TRIGGER:screen_observation]')
    assert '[autonomous_signal: screen_observation, source=live_frame]' in text
    assert '[time_context: 2026-11-03 12:00 KST]' in text
    assert p._pick_category_and_prompt('s',lambda _:False) is None
    p.clock=lambda:1045
    assert p._pick_category_and_prompt('s',lambda _:False) is not None
    m.enabled=False
    assert p._pick_category_and_prompt('s',lambda _:False) is None

@pytest.mark.parametrize('text,expected',[('[SILENT]',True),('[neutral] [SILENT].',True),('[calm:0.3] [SILENT]!!',True),('[SILENT] hello',False),('hello [SILENT]',False),('Hello',False),('',False)])
def test_original_silence_contract(text,expected):assert is_silence_text(text)==expected

@pytest.mark.parametrize('text,silent',[('[neutral] [SILENT].',True),('A new error appeared.',False)])
async def test_no_silence_fragments_reach_ui_or_tts(text,silent):
    async def events():
        for chunk in [text[:3],text[3:8],text[8:]]:yield ProviderEvent(type='text.delta',data={'text':chunk})
        yield ProviderEvent(type='turn.complete',data={'text':text,'cost_usd':0.02})
    out=[e async for e in deliver_autonomous(events())]
    assert [e.data['text'] for e in out if e.type=='text.delta']==([] if silent else [text])
    assert out[-1].data['text']==('' if silent else text)
    assert out[-1].data['cost_usd']==0.02


def runtime(db,tmp_path,monkeypatch):
    svc,atts,store,mates,logs=_services(db)
    m=store.create(name='Mate',prefs={'proactive':{'enabled':True,'scope':'screen'}})
    sid=svc.create(provider='claude',workspace_path=str(tmp_path),kind='mate',mate_id=m['id'])['id']
    store.set_session(m['id'],sid)
    screen=ScreenService(svc,mates.capture,mates=store)
    svc._note_client(sid,'u~dev-a')
    conn,queue=client(screen.broker,sid,'ask')
    clock=[1000.0];screen.triggers.clock=lambda:clock[0];screen.triggers.frame_clock=lambda:clock[0]
    started=[];monkeypatch.setattr(svc,'start_turn',lambda *a,**k:started.append((a,k)))
    return screen,svc,atts,store,m,sid,queue,clock,started


async def test_collection_is_separate_single_owner_then_unchanged_skips_all_model_work(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    task=asyncio.create_task(screen.observe(sid,'dev-a'))
    _,row=await respond(q,screen,atts,sid)
    assert await task=={'status':'cached'} and started==[]
    assert await screen.triggers.consider(sid)=={'status':'idle_wait'}
    clock[0]+=61
    trigger=asyncio.create_task(screen.triggers.consider(sid))
    _,fresh=await respond(q,screen,atts,sid)
    result=await trigger
    assert result=={'status':'sent','category':'screen_observation'}
    assert started[0][0][2]==[fresh['id']]
    # Marked before firing: even [SILENT] cannot trigger the same frame twice.
    clock[0]+=61
    assert await screen.triggers.consider(sid)=={'status':'unchanged'}
    assert q.empty() and len(started)==1
    assert screen.triggers.consecutive[sid]==1
    screen.triggers.activity_now(sid)
    assert screen.triggers.consecutive.get(sid,0)==0


async def test_frame_cache_expires_and_consent_revocation_deletes_unconsumed_frame(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    task=asyncio.create_task(screen.observe(sid,'dev-a'));_,row=await respond(q,screen,atts,sid);await task
    frame=screen.triggers.frames[sid]
    screen.broker.disconnect(frame.conn)
    assert sid not in screen.triggers.frames and atts.get(row['id']) is None
    assert await screen.triggers.consider(sid)=={'status':'not_shared'}


async def test_force_show_now_bypasses_idle_cooldown_and_unchanged_but_never_busy(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    task=asyncio.create_task(screen.observe(sid,'dev-a'));_,row=await respond(q,screen,atts,sid);await task
    frame=screen.triggers.frames[sid];screen.triggers.last_comment[sid]=frame.hash
    task=asyncio.create_task(screen.triggers.consider(sid,force=True));await respond(q,screen,atts,sid)
    assert (await task)['status']=='sent'
    monkeypatch.setattr(svc,'is_running',lambda _:True)
    assert await screen.triggers.consider(sid,force=True)=={'status':'busy'}


async def test_full_geny_idle_path_uses_backoff_and_user_activity_resets_it(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    store.update(m['id'],{'prefs':{'proactive':{'scope':'all'}}})
    monkeypatch.setattr(random,'random',lambda:0)
    assert await screen.triggers.consider(sid)=={'status':'idle_wait'}
    clock[0]+=61
    assert (await screen.triggers.consider(sid))['category']=='first_idle'
    assert started[0][0][2]==[] and q.empty()
    clock[0]+=61
    assert await screen.triggers.consider(sid)=={'status':'idle_wait'}
    screen.triggers.activity_now(sid)
    clock[0]+=61
    assert (await screen.triggers.consider(sid))['category']=='first_idle'


async def test_same_screen_silent_or_spoken_never_retriggers(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    task=asyncio.create_task(screen.observe(sid,'dev-a'));_,row=await respond(q,screen,atts,sid);await task
    task=asyncio.create_task(screen.triggers.consider(sid,force=True));await respond(q,screen,atts,sid);await task
    screen.triggers.ended(sid,{'meta':{'internal':True,'kind':'screen_observation'},'text':''})
    assert screen.triggers.status[sid]=='silent'
    clock[0]+=61
    assert await screen.triggers.consider(sid)=={'status':'unchanged'}
    assert len(started)==1 and q.empty()


async def test_linked_worker_remains_linked_after_completion_and_runtime_restart(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    worker=svc.create(provider='claude',workspace_path=str(tmp_path))['id']
    screen.triggers.link(sid,worker)
    assert screen.triggers.worker(sid)==(worker,False)
    monkeypatch.setattr(svc,'is_running',lambda s:s==worker)
    assert screen.triggers.worker(sid)==(worker,True)
    from app.mate.trigger.runtime import GenyTriggers
    restarted=GenyTriggers(screen)
    assert restarted.worker(sid)==(worker,True)


@pytest.mark.parametrize('raw,threshold',[('12',12),('invalid',10)])
def test_original_screen_threshold_environment(monkeypatch,raw,threshold):
    from app.mate.trigger.frame import _same_screen_threshold
    monkeypatch.setenv('GENY_SCREEN_OBS_SAME_THRESHOLD',raw)
    assert _same_screen_threshold()==threshold


async def test_frame_ttl_and_startup_cleanup_never_delete_delivered_images(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    task=asyncio.create_task(screen.observe(sid,'dev-a'));_,row=await respond(q,screen,atts,sid);await task
    assert atts.get(row['id'])['message_id'].startswith('artifact:observation-cache:')
    clock[0]+=401
    assert screen.triggers.active_frame(sid) is None and atts.get(row['id']) is None
    permanent=await _upload(atts,sid,'sent.png',_png())
    atts.link([permanent['id']],'artifact:screen:sent')
    orphan=await _upload(atts,sid,'cache.png',_png())
    atts.link([orphan['id']],'artifact:observation-cache:old')
    from app.mate.trigger.runtime import GenyTriggers
    GenyTriggers(screen)
    assert atts.get(orphan['id']) is None and atts.get(permanent['id']) is not None


async def test_actual_changed_frame_reenables_screen_trigger_then_same_frame_skips(db,tmp_path,monkeypatch):
    import io
    from PIL import Image
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    task=asyncio.create_task(screen.observe(sid,'dev-a'));_,old=await respond(q,screen,atts,sid);await task
    screen.triggers.last_comment[sid]=0
    image=Image.new('RGB',(180,160),'black')
    for x in range(180):
        for y in range(160):image.putpixel((x,y),(255,255,255) if (x//20)%2 else (0,0,0))
    buf=io.BytesIO();image.save(buf,'PNG')
    uploaded=await _upload(atts,sid,'changed.png',buf.getvalue())
    row=atts.get(uploaded['id']);hash=screen.visual(row['path'])[0]
    assert hash.bit_count()>=10
    client=screen.broker.shared_client(sid,'dev-a')
    screen.triggers.ingest(sid,'dev-a',client,row,hash)
    clock[0]+=61
    task=asyncio.create_task(screen.triggers.consider(sid))
    req=(await q.get())['data']
    fresh=await _upload(atts,sid,'fresh.png',buf.getvalue())
    screen.resolve(sid,req['id'],{'proof':req['proof'],'ok':True,'attachment_id':fresh['id']})
    assert (await task)['status']=='sent' and len(started)==1
    clock[0]+=61
    assert await screen.triggers.consider(sid)=={'status':'unchanged'}
    assert len(started)==1 and q.empty()


async def test_user_input_preempts_autonomous_turn_instead_of_steering_into_it(db,tmp_path,monkeypatch):
    screen,svc,atts,store,m,sid,q,clock,started=runtime(db,tmp_path,monkeypatch)
    svc.screen=screen
    task=asyncio.create_task(asyncio.sleep(60))
    svc._tasks[sid]=task
    svc._turn_meta[sid]={'internal':True,'kind':'screen_observation'}
    screen.triggers.consecutive[sid]=4
    assert await svc.steer(sid,'User takes priority',client_msg_id='u~dev-a') is False
    with pytest.raises(asyncio.CancelledError):await task
    assert screen.triggers.consecutive.get(sid,0)==0
    svc._tasks.pop(sid,None);svc._turn_meta.pop(sid,None)
