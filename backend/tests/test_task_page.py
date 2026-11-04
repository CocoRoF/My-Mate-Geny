"""Bounded task queries, exact turn boundaries and durable read-only pagination."""
from datetime import datetime, timedelta, timezone
import json

import pytest
from app.services.task_page import task_page, PAGE_SIZE
from app.services.session_service import SessionService

T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)


def session(db, sid='s'):
    db.execute("INSERT INTO sessions(id,provider,workspace_path,created_at,updated_at) VALUES (?,?,?,?,?)", (sid,'claude','/tmp',T0.isoformat(),T0.isoformat()))
    return sid


def turn(db, n, sid='s', auto=False):
    at = (T0 + timedelta(seconds=n*100)).isoformat()
    if auto:
        db.execute("INSERT INTO events(session_id,seq,type,data,created_at) VALUES (?,?,?,?,?)", (sid,n,'session.start',json.dumps({'trigger':'background'}),at))
    else:
        db.execute("INSERT INTO messages(id,session_id,role,content,created_at) VALUES (?,?,?,?,?)", (f'{sid}-msg{n}',sid,'user','turn',at))
    return T0.timestamp()+n*100


def task(db, name, at, sid='s', status='completed'):
    db.execute("INSERT INTO bg_tasks(session_id,task_id,started_at,status,output_file,updated_at) VALUES (?,?,?,?,?,?)", (sid,name,at,status,'/private/output',datetime.fromtimestamp(at or T0.timestamp(),timezone.utc).isoformat()))


def ids(page):
    return [t['task_id'] for t in page['tasks']]


def test_latest_two_turns_and_more_preserve_every_row(db):
    session(db)
    for n in range(6):
        task(db,f't{n}',turn(db,n)+1)
    first = task_page(db,'s',out=SessionService._task_out)
    assert ids(first)==['t5','t4']
    assert all('output_file' not in row for row in first['tasks'])
    second=task_page(db,'s',cursor=first['page']['cursor'])
    third=task_page(db,'s',cursor=second['page']['cursor'])
    assert ids(second)==['t3','t2'] and ids(third)==['t1','t0']
    assert third['page']['has_more'] is False
    assert db.query_one('SELECT count(*) AS n FROM bg_tasks')['n']==6


def test_running_old_work_pinned_and_auto_turn_is_a_boundary(db):
    session(db)
    task(db,'old-running',turn(db,0)+1,status='running')
    task(db,'old',turn(db,1)+1)
    task(db,'recent',turn(db,2,auto=True)+1)
    task(db,'newest',turn(db,3)+1)
    p=task_page(db,'s')
    assert ids(p)==['newest','recent']
    assert [r['task_id'] for r in p['running']]==['old-running']


def test_large_turn_keyset_and_identical_timestamps_do_not_drop_or_duplicate(db):
    session(db)
    at=turn(db,1)
    for n in range(PAGE_SIZE*2+3):
        task(db,f'job{n:04}',at+1)
    seen=[];cursor=None
    for _ in range(3):
        p=task_page(db,'s',cursor=cursor)
        assert len(p['tasks'])<=PAGE_SIZE
        seen+=ids(p);cursor=p['page']['cursor']
    assert cursor is None and len(set(seen))==len(seen)==PAGE_SIZE*2+3


def test_prelude_empty_turns_and_legacy_missing_start_are_reachable(db):
    session(db)
    task(db,'prelude',None)
    for n in range(1,6):turn(db,n)
    p=task_page(db,'s');assert p['tasks']==[] and p['page']['has_more']
    p=task_page(db,'s',cursor=p['page']['cursor']);assert p['tasks']==[]
    p=task_page(db,'s',cursor=p['page']['cursor']);assert ids(p)==['prelude']


@pytest.mark.parametrize('cursor',['bad cursor','e30','bnVsbA','W10'])
def test_bad_cursor_rejected(db,cursor):
    session(db)
    with pytest.raises(ValueError,match='invalid task cursor'):task_page(db,'s',cursor=cursor)


def test_other_session_cursor_rejected_and_new_turn_does_not_shift_older_pages(db):
    session(db);session(db,'other')
    for n in range(4):task(db,str(n),turn(db,n)+1)
    p=task_page(db,'s');cursor=p['page']['cursor']
    task(db,'new',turn(db,8)+1)
    assert ids(task_page(db,'s',cursor=cursor))==['1','0']
    with pytest.raises(ValueError):task_page(db,'other',cursor=cursor)


def test_task_page_api_and_legacy_compatibility(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        assert client.post('/api/auth/login',json={'username':'admin','password':'test-pass'}).status_code==200
        svc=app.state.session_service
        sid=svc.create(provider='claude',workspace_path=str(tmp_path),title='Task pages')['id']
        for n in range(4): task(svc._db,str(n),turn(svc._db,n,sid=sid)+1,sid=sid)
        p=client.get(f'/api/sessions/{sid}/tasks/page')
        assert p.status_code==200 and ids(p.json())==['3','2']
        assert client.get(f'/api/sessions/{sid}/tasks/page',params={'cursor':'bad'}).status_code==422
        assert client.get('/api/sessions/missing/tasks/page').status_code==404
        old=client.get(f'/api/sessions/{sid}/tasks')
        assert old.status_code==200 and isinstance(old.json(),list) and len(old.json())==4
        query=svc._db.query("EXPLAIN QUERY PLAN SELECT * FROM bg_tasks WHERE session_id=? AND COALESCE(started_at,unixepoch(updated_at),0)>=? ORDER BY COALESCE(started_at,unixepoch(updated_at),0) DESC,task_id DESC LIMIT 51",(sid,T0.timestamp()))
        assert any('idx_bg_tasks_page' in row['detail'] for row in query)
