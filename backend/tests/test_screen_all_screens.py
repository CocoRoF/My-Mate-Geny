"""All screens (docs/mate.md §4 "Seeing the screen"): a desktop app ≥ 4 sharing every screen answers one capture
request with one picture per screen — each uploaded with the request's proof, the screen in use (main) first. Her
see_screen result and a message's pictures present them in that order, labelled by role only; an older app (one
picture) and a one-picture request (observation, an older app asked) keep working."""
import asyncio
import base64
import io

import pytest
from PIL import Image

from app.mate.capture import MAX_PICTURES, MULTI_BRIDGE, CaptureError, pictures, screen_labels
from app.providers._attachments import attachment_note, inline_note
from app.providers.base import ProviderEvent
from tests.test_local_screen import setup
from tests.test_mate_screen import _png, _start, _upload, _wait, _Window

RED, BLUE = (200, 10, 10), (10, 10, 200)


def window(broker, sid, mode="ask", device="dev-a", capture=MULTI_BRIDGE):
    queue = asyncio.Queue()
    conn = broker.connect(queue.put_nowait)
    broker.hello(conn, {"device": device, "capture": capture, "shares": {sid: mode}, "active": True})
    return conn, queue


async def request_of(queue):
    return (await asyncio.wait_for(queue.get(), 2))["data"]


async def uploads(broker, atts, sid, req, *colors):
    rows = []
    for k, color in enumerate(colors):
        row = await _upload(atts, sid, f"screen-{k}.png", _png(color=color))
        assert broker.register_upload(sid, req["id"], req["proof"], row["id"])
        rows.append(row)
    return rows


def reds(images):
    return [Image.open(io.BytesIO(base64.b64decode(i["data"]))).convert("RGB").getpixel((5, 5))[0] for i in images]


def test_pictures_main_first_each_once_at_most_max():
    assert pictures({"attachment_id": "att_a", "source": {"name": " Screen  1 ", "kind": "screen"}}) == [
        {"id": "att_a", "role": "main", "source": {"name": "Screen 1", "kind": "screen"}}]
    many = {"attachment_id": "att_ignored", "attachments": [
        {"id": "att_b", "role": "sub"}, {"id": "att_a", "role": "main", "source": {"kind": "window"}},
        {"id": "att_b", "role": "sub"}, "junk", {"id": 7}, *({"id": f"att_{k}"} for k in range(10))]}
    out = pictures(many)
    assert [p["id"] for p in out] == ["att_a", "att_b", "att_0", "att_1", "att_2", "att_3"]
    assert len(out) == MAX_PICTURES and [p["role"] for p in out] == ["main"] + ["sub"] * (MAX_PICTURES - 1)
    assert out[0]["source"] == {"name": "", "kind": "window"}
    # (nobody marked main: the first one is; two marked main: the first of them)
    assert [p["role"] for p in pictures({"attachments": [{"id": "x"}, {"id": "y", "role": "sub"}]})] == ["main", "sub"]
    assert [p["id"] for p in pictures({"attachments": [{"id": "x"}, {"id": "y", "role": "main"}, {"id": "z", "role": "main"}]})] == ["y", "x", "z"]
    assert pictures({}) == [] and pictures({"attachments": "x"}) == []
    assert screen_labels(1) == [""]
    assert screen_labels(3) == ["main screen (the one in use)", "other screen 1", "other screen 2"]


async def test_see_screen_tool_presents_the_main_screen_first_as_separate_labelled_images(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = window(broker, sid)
    svc._note_client(sid, "m~dev-a")
    task = asyncio.create_task(screen.tool(sid, {}))
    req = await request_of(queue)
    assert req["multi"] is True and req["max_pictures"] == MAX_PICTURES
    main, other = await uploads(broker, atts, sid, req, RED, BLUE)
    # (listed in any order: the one marked main comes first)
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachment_id": main["id"], "attachments": [
        {"id": other["id"], "role": "sub", "source": {"name": "Screen 2"}},
        {"id": main["id"], "role": "main", "source": {"name": "Screen 1"}}]})
    result = await task
    text = result["text"]
    assert text.startswith("Current local screens: all 2 of them, one image each")
    assert text.index(f"1. main screen (the one in use): [{main['id']}]") < text.index(f"2. other screen 1: [{other['id']}]")
    r = reds(result["images"])
    assert r[0] > 150 and r[1] < 50
    for x in (main, other):
        row = atts.get(x["id"])
        assert row["origin"] == "screen" and row["message_id"] == f"artifact:screen:{main['id']}"
    assert svc.events(sid) == []


async def test_older_apps_and_one_picture_requests_keep_one_picture(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    conn, queue = window(broker, sid, capture=3)
    svc._note_client(sid, "m~dev-a")
    # an older app: asked for one picture, answers one attachment_id
    task = asyncio.create_task(screen.tool(sid, {}))
    req = await request_of(queue)
    assert req["multi"] is False and req["max_pictures"] == 1
    row = await _upload(atts, sid, "screen.png", _png())
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachment_id": row["id"]})
    result = await task
    assert result["text"] == f"Current local screen: [{row['id']}] screen.png. Image attached below."
    assert len(result["images"]) == 1
    # a one-picture request answered with more anyway: the main one only, the rest is dropped
    task = asyncio.create_task(screen.capture_all(sid, device="dev-a"))
    req = await request_of(queue)
    a, b = await uploads(broker, atts, sid, req, RED, BLUE)
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachments": [
        {"id": a["id"], "role": "main"}, {"id": b["id"], "role": "sub"}]})
    rows = await task
    assert [(x["id"], x["screen_role"], x["screen_label"]) for x in rows] == [(a["id"], "main", "")]
    assert atts.get(b["id"]) is None
    # a new app sharing one screen or window: one attachment_id, as before
    broker.hello(conn, {"device": "dev-a", "capture": MULTI_BRIDGE, "shares": {sid: "ask"}})
    task = asyncio.create_task(screen.tool(sid, {}))
    req = await request_of(queue)
    assert req["multi"] is True
    one = await _upload(atts, sid, "window.png", _png())
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachment_id": one["id"],
                                           "source": {"name": "Editor", "kind": "window"}})
    assert (await task)["text"].startswith(f"Current local screen: [{one['id']}]")


async def test_with_each_message_every_screen_goes_along_main_first_and_labelled(db, tmp_path, monkeypatch):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = window(broker, sid, "on_turn")
    seen = []

    async def fake_run(sid, session, attachments, ctx, msg_id):
        seen.extend(attachments)
        yield ProviderEvent(type="turn.complete", data={})

    monkeypatch.setattr(svc, "_run_turn", fake_run)

    async def run():
        return [ev async for ev in svc.run_turn(sid, "Which screen am I on?", client_msg_id="m~dev-a")]

    task = asyncio.create_task(run())
    req = await request_of(queue)
    assert req["multi"] is True and req["automatic"] is True and req["ask"] is False
    main, other = await uploads(broker, atts, sid, req, RED, BLUE)
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachments": [
        {"id": main["id"], "role": "main"}, {"id": other["id"], "role": "sub"}]})
    await task
    assert [a.id for a in seen] == [main["id"], other["id"]] and all(a.is_image for a in seen)
    assert [a.label for a in seen] == ["main screen (the one in use)", "other screen 1"]
    for note in (inline_note(seen, inline_images=True), attachment_note(seen, inline_images=True)):
        assert note.index("main screen (the one in use)") < note.index("other screen 1")
    msg = svc.messages(sid)[0]
    assert msg["attachments"] == []  # (hidden from the transcript, like one picture)
    assert all(atts.get(x["id"])["message_id"] == msg["id"] and atts.get(x["id"])["origin"] == "screen" for x in (main, other))


async def test_observation_asks_for_one_frame_the_screen_in_use(db, tmp_path, monkeypatch):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    monkeypatch.setattr(screen, "proactive", lambda _, device=None: {"enabled": True, "interval": 60})
    monkeypatch.setattr(svc, "start_turn", lambda *a, **k: None)
    _, queue = window(broker, sid)
    task = asyncio.create_task(screen.observe(sid, "dev-a"))
    req = await request_of(queue)
    assert req["multi"] is False and req["max_pictures"] == 1
    row = await _upload(atts, sid, "frame.png", _png())
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachment_id": row["id"]})
    assert await task == {"status": "cached"}


async def test_uploads_per_capture_are_capped_strays_dropped_and_a_bad_picture_refuses_the_answer(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = window(broker, sid)
    task = asyncio.create_task(screen.capture_all(sid, device="dev-a"))
    req = await request_of(queue)
    rows = [await _upload(atts, sid, f"s{k}.png", _png()) for k in range(MAX_PICTURES + 1)]
    assert all(broker.register_upload(sid, req["id"], req["proof"], r["id"]) for r in rows[:MAX_PICTURES])
    assert not broker.register_upload(sid, req["id"], req["proof"], rows[-1]["id"])
    assert not broker.register_upload(sid, req["id"], req["proof"])  # (the router's check before saving)
    # a picture of another conversation among them: refused, nothing is accepted
    foreign_sid = svc.create(provider="claude", workspace_path=str(tmp_path))["id"]
    foreign = await _upload(atts, foreign_sid, "foreign.png", _png())
    with pytest.raises(CaptureError):
        screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachments": [
            {"id": rows[0]["id"], "role": "main"}, {"id": foreign["id"]}]})
    # answered with two of them: the other uploads of this request are dropped
    assert screen.resolve(sid, req["id"], {"proof": req["proof"], "ok": True, "attachments": [
        {"id": rows[0]["id"], "role": "main"}, {"id": rows[1]["id"]}]})
    got = await task
    assert [(r["id"], r["screen_role"]) for r in got] == [(rows[0]["id"], "main"), (rows[1]["id"], "sub")]
    assert all(atts.get(r["id"]) is None for r in rows[2:MAX_PICTURES])
    assert atts.get(foreign["id"]) is not None


async def test_cancelled_all_screens_capture_discards_every_picture(db, tmp_path):
    svc, atts, broker, screen, sid = setup(db, tmp_path)
    _, queue = window(broker, sid)
    task = asyncio.create_task(screen.capture_all(sid, device="dev-a"))
    req = await request_of(queue)
    rows = await uploads(broker, atts, sid, req, RED, BLUE)
    broker.cancel_session(sid)
    with pytest.raises(CaptureError):
        await task
    assert all(atts.get(r["id"]) is None for r in rows)


async def test_her_see_screen_with_all_screens(db, tmp_path):
    svc, atts, store, mates, logs, m, msid, ctx = await _start(db, tmp_path)
    win = _Window(mates.capture, device="dev-a", surface="mate-chat", desktop="0.5.0", capture=MULTI_BRIDGE, shares={msid: "ask"})
    task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {"reason": "both"}))
    await _wait(lambda: win.requests())
    req = win.requests()[0]
    assert req["multi"] is True
    main = await _upload(atts, msid, "screen-main.png", _png(320, 200, RED))
    other = await _upload(atts, msid, "screen-other.png", _png(160, 100, BLUE))
    assert mates.capture_result(m["id"], req["id"], {"ok": True, "attachment_id": main["id"], "attachments": [
        {"id": main["id"], "role": "main", "source": {"name": "Display 1", "kind": "screen"}},
        {"id": other["id"], "role": "sub", "source": {"name": "Display 2", "kind": "screen"}}]})
    text, is_error, images = await asyncio.wait_for(task, 5)
    assert is_error is False and len(images) == 2
    first = text.index(f"1. main screen (the one in use) “Display 1”, 320×200 — [{main['id']}]")
    assert first < text.index(f"2. other screen 1 “Display 2”, 160×100 — [{other['id']}]")
    r = reds(images)
    assert r[0] > 150 and r[1] < 50
    assert all(atts.get(x["id"])["message_id"] == f"artifact:capture:{req['id']}" for x in (main, other))
    # the engine's echo refers to both pictures, in that order, without storing them again
    ev = ProviderEvent(type="tool.result", data={"id": "t1", "output": text, "images": images})
    assert svc._screen_result(msid, ev, {"tool_calls": {"t1": {"name": "mcp__mate__see_screen"}}})
    assert [i["id"] for i in ev.data["images"]] == [main["id"], other["id"]]
    # an answer with a picture that was sent already is refused
    win2_task = asyncio.create_task(mates.call_tool_full(ctx, "see_screen", {}))
    await _wait(lambda: len(win.requests()) == 2)
    rid = win.requests()[1]["id"]
    fresh = await _upload(atts, msid, "fresh.png", _png())
    with pytest.raises(CaptureError):
        mates.capture_result(m["id"], rid, {"ok": True, "attachments": [{"id": fresh["id"], "role": "main"}, {"id": main["id"]}]})
    assert mates.capture_result(m["id"], rid, {"ok": False, "code": "denied"})
    assert (await asyncio.wait_for(win2_task, 5))[1] is True
