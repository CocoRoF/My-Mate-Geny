import asyncio
import json
import pytest
from app.services.speech_input import SpeechInput
from tests.test_mate_screen import _services


def setup(db):
    svc, atts, store, mates, logs = _services(db)
    mate = store.create(name='Speech')
    sid = mates.conversation(mate['id'])['session_id']
    clock = [0.]
    broker = SpeechInput(db, svc, clock=lambda: clock[0])
    svc.speech_input = broker
    broker.arm = lambda group: None
    calls = []
    def start(sid, text, ids, client_msg_id=None, meta=None):
        calls.append((clock[0], text))
        mid = svc._add_message(sid, 'user', text, meta=meta)
        svc._publish(sid, {'type':'user.message','data':{'message_id':mid,'text':text,**meta}})
    svc.start_turn = start
    return svc, sid, broker, clock, calls


def packet(text='first', revision=1, idle=1800, **extra):
    return {'group_id':'device-v-one','client_msg_id':'device-v-one','revision':revision,
            'input':text,'window_ms':4000,'idle_ms':idle,**extra}


@pytest.mark.asyncio
async def test_receive_at_pause_and_release_at_parallel_window(db):
    svc,sid,b,clock,calls=setup(db)
    clock[0]=1.8
    await b.receive(sid,packet())
    row=db.query_one('SELECT * FROM speech_inputs')
    assert row['deadline']==pytest.approx(4)  # NOT 1.8 + 4
    assert calls==[]
    assert db.query_one('SELECT content FROM messages WHERE session_id=?',(sid,))['content']=='first'
    clock[0]=4
    await b.release('device-v-one')
    assert calls==[(4,'first')]
    assert db.query_one('SELECT count(*) AS n FROM messages WHERE session_id=?',(sid,))['n']==1
    assert db.query_one('SELECT text,state FROM speech_inputs')['text']==''
    await b.receive(sid,packet())
    assert len(calls)==1


@pytest.mark.asyncio
async def test_three_second_continuation_updates_same_durable_message(db):
    svc,sid,b,clock,calls=setup(db)
    clock[0]=1.8;await b.receive(sid,packet())
    clock[0]=3;await b.receive(sid,packet(op='touch',idle=0))
    assert db.query_one('SELECT deadline FROM speech_inputs')['deadline']==7
    clock[0]=4.8;await b.receive(sid,packet('first second',revision=2))
    assert db.query_one('SELECT deadline FROM speech_inputs')['deadline']==pytest.approx(7)
    assert db.query_one('SELECT content FROM messages WHERE session_id=?',(sid,))['content']=='first second'
    clock[0]=7;await b.release('device-v-one')
    assert calls==[(7,'first second')]
    assert db.query_one('SELECT count(*) AS n FROM messages WHERE session_id=?',(sid,))['n']==1


@pytest.mark.asyncio
async def test_active_reply_receives_one_steer_after_window(db):
    svc,sid,b,clock,calls=setup(db)
    svc.is_running=lambda _:True
    async def steer(sid,text,ids,client_msg_id=None,meta=None):
        calls.append((clock[0],text))
        svc._add_message(sid,'steer',text,meta=meta)
        svc._publish(sid,{'type':'user.steer','data':{'text':text,**meta}})
        return True
    svc.steer=steer
    clock[0]=1.8;await b.receive(sid,packet())
    clock[0]=3;await b.receive(sid,packet('first second',revision=2,idle=0))
    assert not calls
    clock[0]=7;await b.release('device-v-one')
    assert calls==[(7,'first second')]
    assert db.query_one('SELECT count(*) AS n FROM messages WHERE session_id=?',(sid,))['n']==1


@pytest.mark.asyncio
async def test_revision_identity_and_restart_recovery(db):
    svc,sid,b,clock,calls=setup(db)
    clock[0]=1.8;await b.receive(sid,packet('latest',revision=2))
    await b.receive(sid,packet('stale',revision=1))
    assert db.query_one('SELECT content FROM messages WHERE session_id=?',(sid,))['content']=='latest'
    with pytest.raises(ValueError):await b.receive(sid,packet(client_msg_id='another-device'))
    b.cancel(sid)
    assert db.query_one('SELECT content FROM messages WHERE session_id=?',(sid,))['content']=='latest'
    assert db.query_one('SELECT state FROM speech_inputs')['state']=='cancelled'
    assert not calls


@pytest.mark.asyncio
async def test_restart_does_not_replay_a_message_already_recorded_for_model(db):
    svc,sid,b,clock,calls=setup(db)
    clock[0]=1.8;await b.receive(sid,packet())
    mid=db.query_one('SELECT message_id FROM speech_inputs')['message_id']
    db.execute("UPDATE speech_inputs SET state='dispatching' WHERE id='device-v-one'")
    db.execute('UPDATE messages SET meta=? WHERE id=?',(json.dumps({'speech_group':'device-v-one','speech_pending':False}),mid))
    await b.start()
    assert db.query_one('SELECT state,text FROM speech_inputs')['state']=='delivered'
    assert not calls


def test_ws_receipt_is_durable_before_model_release(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        assert client.post('/api/auth/login',json={'username':'admin','password':'test-pass'}).status_code==200
        mate=client.post('/api/mates',json={'name':'Parallel WS','proactive':{'enabled':False}}).json()
        sid=client.post('/api/mates/'+mate['id']+'/conversation').json()['session_id']
        svc=app.state.session_service
        calls=[]
        def start(sid,text,ids,client_msg_id=None,meta=None):
            calls.append(text)
            svc._add_message(sid,'user',text,meta=meta)
            svc._publish(sid,{'type':'user.message','data':{'text':text,**meta}})
        monkeypatch.setattr(svc,'start_turn',start)
        with client.websocket_connect('/ws/chat/'+sid) as ws:
            ws.send_json({'type':'attach','after':0})
            assert ws.receive_json()['data']['speech_protocol']==2
            ws.send_json({'type':'speech',**packet()})
            while ws.receive_json()['type']!='speech.pending':pass
            assert not calls
            assert svc.messages(sid)[0]['content']=='first'
            ws.send_json({'type':'speech',**packet('first second',revision=2,window_ms=0,idle=0)})
            while ws.receive_json()['type']!='speech.closed':pass
            assert calls==['first second']
            assert len(svc.messages(sid))==1
