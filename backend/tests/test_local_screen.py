"""Local screens: device/session consent, proof-bound responses, model image pipeline, stop and observation."""
import asyncio
import base64
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.mate.capture import CaptureError
from app.providers.base import ProviderEvent
from app.services.screen import ScreenService, BRIDGE
from tests.test_mate_screen import _services, _upload, _png


def setup(db, tmp_path):
    svc, atts, store, mates, logs = _services(db)
    screen = ScreenService(svc, mates.capture)
    svc.screen = screen
    sid = svc.create(provider="claude", workspace_path=str(tmp_path))["id"]
    return svc, atts, mates.capture, screen, sid


def client(broker, sid, mode="ask", device="dev-a"):
    queue = asyncio.Queue()
    conn = broker.connect(queue.put_nowait)
    broker.hello(conn, {"device": device, "capture": 2, "shares": {sid: mode}, "active": True})
    return conn, queue


async def respond(queue, screen, atts, sid):
    msg = await asyncio.wait_for(queue.get(), 2)
    req = msg["data"]
    assert req["scope"] == "session"
    row = await _upload(atts, sid, "local-screen.png", _png())
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachment_id": row["id"]})
    return req, row


async def test_no_consent_wrong_session_wrong_device_never_capture(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    conn, queue = client(broker, "another-session")
    for device in (None, "dev-a", "dev-b"):
        with pytest.raises(CaptureError, match="not enabled"):
            await screen.capture(sid, device=device)
    assert queue.empty()
    broker.hello(conn, {"device": "dev-a", "capture": 2, "shares": {sid: "ask"}})
    with pytest.raises(CaptureError):
        await screen.capture(sid, device="dev-b")
    assert queue.empty()


async def test_tool_returns_real_image_and_one_attachment_without_base64_in_events(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    client_conn, queue = client(broker, sid)
    svc._note_client(sid, "m~dev-a")
    task = asyncio.create_task(screen.tool(sid, {}))
    req, row = await respond(queue, screen, atts, sid)
    result = await task
    assert req["ask"] is True
    assert base64.b64decode(result["images"][0]["data"]) == _png()
    assert atts.get(row["id"])["message_id"].startswith("artifact:screen:")
    assert row["id"] in result["text"]
    assert svc.events(sid) == []


async def test_response_proof_and_session_and_attachment_boundaries(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = client(broker, sid)
    task = asyncio.create_task(screen.capture(sid, device="dev-a"))
    req = (await queue.get())["data"]
    assert not screen.resolve(sid, req["id"], {"proof": "wrong", "ok": False})
    assert not screen.resolve("wrong", req["id"], {"proof": req["proof"], "ok": False})
    foreign = svc.create(provider="claude", workspace_path=str(tmp_path))["id"]
    row = await _upload(atts, foreign, "foreign.png", _png())
    with pytest.raises(CaptureError):
        screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachment_id": row["id"]})
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": False, "code": "denied"})
    with pytest.raises(CaptureError) as exc:
        await task
    assert exc.value.code == "denied"
    assert not screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": False})


@pytest.mark.parametrize("how", ["stop", "disconnect", "cancel"])
async def test_stopping_connection_or_turn_cancels_pending_request(db, tmp_path, how):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    conn, queue = client(broker, sid)
    task = asyncio.create_task(screen.capture(sid, device="dev-a"))
    await queue.get()
    if how == "stop":
        broker.hello(conn, {"device": "dev-a", "capture": 2, "shares": {}})
    elif how == "disconnect":
        broker.disconnect(conn)
    else:
        task.cancel()
    with pytest.raises((CaptureError, asyncio.CancelledError)):
        await task
    assert not broker._pending


async def test_on_turn_adds_current_frame_to_user_and_provider_inputs(db, tmp_path, monkeypatch):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    published = []
    monkeypatch.setattr(svc, "_publish", lambda sid, event: published.append(event))
    _, queue = client(broker, sid, "on_turn")
    seen = []
    async def fake_run(sid, session, attachments, ctx, msg_id):
        seen.extend(attachments)
        yield ProviderEvent(type="turn.complete", data={})
    monkeypatch.setattr(svc, "_run_turn", fake_run)
    async def run():
        return [ev async for ev in svc.run_turn(sid, "Read my screen", client_msg_id="m~dev-a")]
    task = asyncio.create_task(run())
    req, row = await respond(queue, screen, atts, sid)
    await task
    assert req["ask"] is False
    assert len(seen) == 1 and seen[0].is_image
    assert Path(seen[0].inline_path).read_bytes() == _png()
    assert atts.get(row["id"])["message_id"] == svc.messages(sid)[0]["id"]
    assert atts.get(row["id"])["origin"] == "screen"
    assert svc.messages(sid)[0]["attachments"] == []
    assert svc.history_page(sid)["messages"][0]["attachments"] == []
    assert next(e for e in published if e["type"] == "user.message")["data"]["attachments"] == []
    # A delegation/internal/background message must not trigger another screen grab.
    for meta in ({"internal": True}, {"via": {"kind": "mate"}}):
        assert await screen.for_turn(sid, "m~dev-a", meta) is None
    assert await screen.for_turn(sid, None, None) is None
    assert queue.empty()


async def test_manual_image_named_like_capture_remains_visible_next_to_hidden_frame(db, tmp_path, monkeypatch):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    published = []
    monkeypatch.setattr(svc, "_publish", lambda sid, event: published.append(event))
    client(broker, sid, "on_turn")
    manual = await _upload(atts, sid, "screen-20261105-234904.png", _png())
    frame = await _upload(atts, sid, "screen-20261105-234905.png", _png())
    atts.mark_screen(frame["id"])
    seen = []

    async def capture(*args):
        return [atts.get(frame["id"])]

    async def fake_run(sid, session, attachments, ctx, msg_id):
        seen.extend(attachments)
        yield ProviderEvent(type="turn.complete", data={})

    monkeypatch.setattr(screen, "for_turn", capture)
    monkeypatch.setattr(svc, "_run_turn", fake_run)
    _ = [e async for e in svc.run_turn(sid, "사진도 같이 봐줘", [manual["id"]], client_msg_id="m~dev-a")]
    assert len(seen) == 2 and all(a.is_image for a in seen)
    expected = [manual["id"]]
    assert [a["id"] for a in svc.messages(sid)[0]["attachments"]] == expected
    assert [a["id"] for a in svc.history_page(sid)["messages"][0]["attachments"]] == expected
    assert [a["id"] for a in next(e for e in published if e["type"] == "user.message")["data"]["attachments"]] == expected
    # This is persisted provenance, so re-opening/bootstrap cannot bring the frame back.
    db.bootstrap()
    assert [a["id"] for a in svc.messages(sid)[0]["attachments"]] == expected


async def test_legacy_capture_migration_uses_trusted_provenance_not_filenames(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    manual = await _upload(atts, sid, "screen-20261105-234904.png", _png())
    tool = await _upload(atts, sid, "frame.png", _png())
    observed = await _upload(atts, sid, "observation.png", _png())
    atts.link([tool["id"]], "artifact:capture:legacy")
    msg = svc._add_message(sid, "user", "shared screen", meta={"internal": True, "kind": "screen_observation"})
    atts.link([observed["id"]], msg)
    malformed = svc._add_message(sid, "user", "old message")
    db.execute("UPDATE messages SET meta='{broken' WHERE id=?", (malformed,))
    db.execute("ALTER TABLE attachments DROP COLUMN origin")
    db.bootstrap()
    assert atts.get(manual["id"])["origin"] == "user"
    assert atts.get(tool["id"])["origin"] == "screen"
    assert atts.get(observed["id"])["origin"] == "screen"
    db.bootstrap()
    assert atts.get(manual["id"])["origin"] == "user"


async def test_failed_auto_capture_keeps_text_and_warns(db, tmp_path, monkeypatch):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = client(broker, sid, "on_turn")
    async def fake_run(*args):
        assert args[2] == []
        yield ProviderEvent(type="turn.complete", data={})
    monkeypatch.setattr(svc, "_run_turn", fake_run)
    async def run():
        return [ev async for ev in svc.run_turn(sid, "keep this", client_msg_id="m~dev-a")]
    task = asyncio.create_task(run())
    req = (await queue.get())["data"]
    screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": False, "code": "empty"})
    events = await task
    assert events[0].data["code"] == "screen.capture_failed"
    assert svc.messages(sid)[0]["content"] == "keep this"


async def test_observation_skips_busy_rate_limits_and_deduplicates(db, tmp_path, monkeypatch):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    conn, queue = client(broker, sid, "observe")
    started = []
    monkeypatch.setattr(svc, "is_running", lambda sid: True)
    assert await screen.observe(sid, "dev-a") == {"status": "busy"}
    assert queue.empty()
    monkeypatch.setattr(svc, "is_running", lambda sid: False)
    monkeypatch.setattr(svc, "start_turn", lambda *a, **kw: started.append((a, kw)))
    task = asyncio.create_task(screen.observe(sid, "dev-a"))
    req, row = await respond(queue, screen, atts, sid)
    assert await task == {"status": "sent"}
    assert len(started) == 1 and started[0][1]["meta"]["kind"] == "screen_observation"
    assert await screen.observe(sid, "dev-a") == {"status": "rate_limited"}
    screen.last_observe.clear()
    task = asyncio.create_task(screen.observe(sid, "dev-a"))
    _, duplicate = await respond(queue, screen, atts, sid)
    assert await task == {"status": "unchanged"}
    assert atts.get(duplicate["id"]) is None
    assert len(started) == 1


def test_mcp_config_merges_remote_tools_and_tokens_are_per_session(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    req = SimpleNamespace(mcp_config={"mcpServers": {"remote": {"command": "remote"}}}, system_append="existing")
    # Without sharing, unrelated CLI MCP configuration is untouched.
    screen.configure(sid, req)
    assert set(req.mcp_config["mcpServers"]) == {"remote"}
    q = []
    conn = broker.connect(q.append)
    broker.hello(conn, {"device": "dev-a", "capture": 2, "shares": {sid: "ask", "other": "ask"}})
    svc._note_client(sid, "m~dev-a")
    svc._note_client("other", "m~dev-a")
    screen.configure(sid, req)
    assert set(req.mcp_config["mcpServers"]) == {"remote", "screen"}
    token = Path(req.mcp_config["mcpServers"]["screen"]["env"]["HRH_SCREEN_TOKEN_FILE"]).read_text()
    assert screen.token_info(token) == sid and screen.token_info("bad") is None
    other = SimpleNamespace(mcp_config=None, system_append="")
    screen.configure("other", other)
    assert Path(other.mcp_config["mcpServers"]["screen"]["env"]["HRH_SCREEN_TOKEN_FILE"]).read_text() != token
    assert "SSH" in req.system_append


def test_stdio_protocol_lists_only_screen_tool():
    requests = [{"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    proc = subprocess.run([sys.executable, "-I", BRIDGE], input="\n".join(map(json.dumps, requests))+"\n",
                          text=True, capture_output=True, timeout=5)
    assert proc.returncode == 0 and proc.stderr == ""
    out = [json.loads(s) for s in proc.stdout.splitlines()]
    assert out[1]["result"]["tools"][0]["name"] == "capture_screen"
    assert len(out[1]["result"]["tools"]) == 1


@pytest.mark.parametrize("codex_dump", [False, True])
async def test_general_screen_results_store_only_attachment_references(db, tmp_path, codex_dump):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    row = await _upload(atts, sid, "screen.png", _png())
    text = f"Screen [{row['id']}]"
    raw = base64.b64encode(_png()).decode()
    output = json.dumps({"content": [{"type": "text", "text": text}, {"type": "image", "data": raw}]}) if codex_dump else text
    ev = ProviderEvent(type="tool.result", data={"id": "tool1", "output": output, "images": [{"data": raw}]})
    assert svc._screen_result(sid, ev, {"tool_calls": {"tool1": {"name": "mcp__screen__capture_screen"}}})
    assert ev.data["output"] == text
    assert ev.data["images"][0]["id"] == row["id"]
    assert raw not in json.dumps(ev.data)


def test_deletion_revokes_consent_and_bridge_credentials(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    sent = []
    conn = broker.connect(sent.append)
    broker.hello(conn, {"device": "dev-a", "capture": 2, "shares": {sid: "ask"}})
    svc._note_client(sid, "m~dev-a")
    req = SimpleNamespace(mcp_config=None, system_append="")
    screen.configure(sid, req)
    file = Path(req.mcp_config["mcpServers"]["screen"]["env"]["HRH_SCREEN_TOKEN_FILE"])
    token = file.read_text()
    svc.delete(sid)
    assert not file.exists() and screen.token_info(token) is None
    assert broker.shared_client(sid, "dev-a") is None
    assert sent[-1] == {"type": "capture.revoked", "data": {"session_id": sid}}


async def test_cancel_discards_registered_uploads_and_rejects_late_uploads(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = client(broker, sid)
    task = asyncio.create_task(screen.capture(sid, device='dev-a'))
    req = (await queue.get())['data']
    assert broker.register_upload(sid, req['id'], req['proof'])
    row = await _upload(atts, sid, 'cancelled.png', _png())
    assert broker.register_upload(sid, req['id'], req['proof'], row['id'])
    path = Path(atts.get(row['id'])['path'])
    broker.cancel_session(sid)
    with pytest.raises(CaptureError): await task
    assert atts.get(row['id']) is None and not path.exists()
    assert not broker.register_upload(sid, req['id'], req['proof'])


async def test_cancel_between_response_and_consumption_revokes_success(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = client(broker, sid)
    task = asyncio.create_task(screen.capture(sid, device='dev-a'))
    req = (await queue.get())['data']
    row = await _upload(atts, sid, 'raced.png', _png())
    assert broker.register_upload(sid, req['id'], req['proof'], row['id'])
    screen.resolve(sid, req['id'], {'ok':True,'proof':req['proof'],'attachment_id':row['id']})
    broker.cancel_session(sid)
    with pytest.raises(CaptureError): await task
    assert atts.get(row['id']) is None


def test_proactive_preferences_are_opt_in_partial_and_validated():
    from app.mate.store import normalize_prefs, MateError
    assert normalize_prefs(None)['proactive'] == {'enabled':False,'interval':180,'guidance':'','scope':'all','preset':None}
    base=normalize_prefs({'proactive':{'enabled':True,'interval':300,'guidance':'Only offer help'}})
    assert normalize_prefs({'proactive':{'interval':600}},base)['proactive'] == {'enabled':True,'interval':600,'guidance':'Only offer help','scope':'all','preset':None}
    for bad in ({'enabled':'yes'},{'interval':0},{'interval':True},{'interval':30},'on'):
        with pytest.raises(MateError): normalize_prefs({'proactive':bad})


async def test_mate_proactive_requires_opt_in_and_device_consent_and_respects_interval(db,tmp_path,monkeypatch):
    svc,atts,broker,screen,sid=setup(db,tmp_path)
    config={'enabled':False,'interval':300,'guidance':'Offer help without interrupting concentration'}
    monkeypatch.setattr(screen,'proactive',lambda _,device=None: config)
    assert await screen.observe(sid,'dev-a') == {'status':'disabled'}
    config['enabled']=True
    with pytest.raises(CaptureError): await screen.observe(sid,'dev-a')
    _,queue=client(broker,sid,'ask')
    started=[]
    monkeypatch.setattr(svc,'start_turn',lambda *a,**k:started.append((a,k)))
    task=asyncio.create_task(screen.observe(sid,'dev-a'))
    req,row=await respond(queue,screen,atts,sid)
    assert req['automatic'] is True
    assert await task == {'status':'cached'}
    assert started == []  # frame collection must not fire a model turn
    assert await screen.observe(sid,'dev-a') == {'status':'rate_limited'}
    screen.last_observe.clear()
    screen.last_proactive.clear()
    task=asyncio.create_task(screen.observe(sid,'dev-a'))
    _,duplicate=await respond(queue,screen,atts,sid)
    assert await task == {'status':'unchanged'}
    assert atts.get(duplicate['id']) is not None
    assert atts.get(row['id']) is None
    assert started == []


async def test_disable_proactive_while_capture_pending_discards_image(db,tmp_path,monkeypatch):
    svc,atts,broker,screen,sid=setup(db,tmp_path)
    config={'enabled':True,'interval':60}
    monkeypatch.setattr(screen,'proactive',lambda _,device=None:config)
    _,queue=client(broker,sid,'ask')
    monkeypatch.setattr(svc,'start_turn',lambda *a,**k:pytest.fail('must not start'))
    task=asyncio.create_task(screen.observe(sid,'dev-a'))
    req=(await queue.get())['data']
    config['enabled']=False
    row=await _upload(atts,sid,'late.png',_png())
    screen.resolve(sid,req['id'],{'proof':req['proof'],'ok':True,'attachment_id':row['id']})
    assert await task == {'status':'stopped'}
    assert atts.get(row['id']) is None


def test_geny_dhash_ignores_encoding_noise_and_uniform_color_changes(tmp_path):
    from PIL import Image
    a,b,c=[tmp_path/n for n in ('a.png','b.jpg','c.png')]
    Image.new('RGB',(120,100),(180,40,90)).save(a)
    Image.new('RGB',(120,100),(180,40,90)).save(b,quality=90)
    Image.new('RGB',(120,100),(0,200,30)).save(c)
    x,y,z=[ScreenService.visual(str(p)) for p in (a,b,c)]
    assert x[0]==y[0]==z[0]==0  # original Geny dHash has no additional RGB heuristic


async def test_proactive_cooldown_survives_connection_change(db,tmp_path,monkeypatch):
    svc,atts,broker,screen,sid=setup(db,tmp_path)
    monkeypatch.setattr(screen,'proactive',lambda _,device=None: {'enabled':True,'interval':300})
    conn,queue=client(broker,sid,'ask')
    monkeypatch.setattr(svc,'start_turn',lambda *a,**k:None)
    task=asyncio.create_task(screen.observe(sid,'dev-a'))
    await respond(queue,screen,atts,sid)
    assert await task == {'status':'cached'}
    broker.disconnect(conn)
    _,new_queue=client(broker,sid,'ask')
    assert await screen.observe(sid,'dev-a') == {'status':'rate_limited'}
    assert new_queue.empty()


async def test_proactive_failed_turn_start_removes_pending_frame(db,tmp_path,monkeypatch):
    svc,atts,broker,screen,sid=setup(db,tmp_path)
    monkeypatch.setattr(screen,'proactive',lambda _,device=None: {'enabled':True,'interval':60})
    _,queue=client(broker,sid,'ask')
    def fail(*a,**k): raise RuntimeError('turn unavailable')
    monkeypatch.setattr(svc,'start_turn',fail)
    task=asyncio.create_task(screen.observe(sid,'dev-a'))
    _,row=await respond(queue,screen,atts,sid)
    assert await task == {'status':'cached'}
    assert atts.get(row['id']) is not None
    screen.triggers.expire(sid)
    assert atts.get(row['id']) is None
    assert not screen.hashes

def test_device_proactive_policy_is_connection_scoped_and_never_mutates_the_mate(db,tmp_path):
    svc,atts,store,mates,logs = _services(db)
    mate=store.create(name="Device policy",prefs={"proactive":{"enabled":True,"interval":300}})
    sid=svc.create(provider="claude",workspace_path=str(tmp_path),kind="mate",mate_id=mate["id"])["id"]
    screen=ScreenService(svc,mates.capture,mates=store)
    a=screen.broker.connect(lambda _:None);b=screen.broker.connect(lambda _:None)
    screen.broker.hello(a,{"device":"a","capture":3,"shares":{sid:"ask"},"screen_policy":{"enabled":False,"interval":60}})
    screen.broker.hello(b,{"device":"b","capture":3,"shares":{sid:"ask"},"screen_policy":{"enabled":True,"interval":180}})
    assert screen.proactive(sid,"a")["enabled"] is False
    assert screen.proactive(sid,"b")["interval"] == 180
    assert store.get(mate["id"])["prefs"]["proactive"]["interval"] == 300
    screen.broker.hello(b,{"device":"b","capture":3,"shares":{sid:"ask"},"screen_policy":{"enabled":"bad","interval":"bad"}})
    assert screen.proactive(sid,"b")["interval"] == 300
