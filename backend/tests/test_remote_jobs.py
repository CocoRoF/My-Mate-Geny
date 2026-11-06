"""Real remote supervisor subprocesses, with local sh as SSH transport; no external credentials."""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shlex
import signal
import time

import pytest
from app.workspaces import remote_jobs
from app.workspaces.remote_jobs import RemoteJobs, RemoteTransportError
from app.services.remote_jobs import RemoteJobService
from app.workspaces.remote_runner import group_alive


def manager(tmp_path, sid='s'):
    return RemoteJobs(tmp_path/'local',sid,prefix=lambda h:['sh','-c'])


def host(tmp_path):
    work=tmp_path/'work';work.mkdir(exist_ok=True)
    return {'name':'box','host':'localhost','port':22,'user':'u','cwd':str(work),'roots':[str(work)],'job_root':str(tmp_path/'remote')}


def finished(client, job, *, offset=0):
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
        result=client.poll(job,offset=offset,wait_ms=100)
        if result['status'] in ('completed','failed','stopped','timed_out','lost'):return result
    raise AssertionError('job did not finish')


def test_short_job_and_idempotent_concurrent_start(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    script="printf x >> count; printf 'hello 원격'; sleep .15"
    job=c.prepare(h,script,h['cwd'])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:c.start(job,wait_ms=1000),range(2)))
    assert (tmp_path/'work/count').read_text()=='x'
    assert all(r['status']=='completed' and r['exit_code']==0 for r in results)
    assert base64.b64decode(results[0]['data']).decode()=='hello 원격'


def test_yield_and_fresh_client_resume_same_command(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    job=c.prepare(h,"printf once >> count; printf start; sleep .4; printf end",h['cwd'])
    first=c.start(job,wait_ms=80)
    assert first['status'] in ('queued','running')
    restored=manager(tmp_path)
    result=finished(restored,restored.manifest(job['job_id']))
    assert base64.b64decode(result['data'])==b'startend'
    assert (tmp_path/'work/count').read_text()=='once'
    assert result['exit_code']==0


def test_timeout_and_process_group_cancellation(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    timed=c.prepare(h,'sleep 20',h['cwd'],timeout_ms=150)
    assert c.start(timed,wait_ms=1000)['status']=='timed_out'
    job=c.prepare(h,"trap '' TERM; sleep 20 & wait",h['cwd'])
    c.start(job,wait_ms=150)
    state=c.stop(job)
    assert state['status']=='stopped' and state['exit_code']==130
    assert not group_alive(state)


def test_a_wait_that_can_never_finish_ends_at_the_default_limit(tmp_path,monkeypatch):
    # The real case: waiting in the background for a line in a log that was deleted, with nobody polling.
    monkeypatch.setattr(remote_jobs,'BACKGROUND_TIMEOUT_MS',300)
    c=manager(tmp_path);h=host(tmp_path)
    job=c.prepare(h,'until grep -q DONE gone.log; do sleep .05; done; echo finished',h['cwd'],background=True)
    c.start(job,wait_ms=0)
    result=finished(c,job)
    assert result['status']=='timed_out' and result['exit_code']==124
    assert 'time limit' in result['error']
    assert not group_alive(result)
    assert b'finished' not in base64.b64decode(result.get('data') or '')


def test_a_supervisor_that_died_ends_as_lost_instead_of_running_for_ever(tmp_path):
    # (killed by the memory guard, a reboot...: the state carries an error, which is an answer and not a failed request)
    c=manager(tmp_path);h=host(tmp_path)
    job=c.prepare(h,'sleep 20',h['cwd'],background=True)
    state=c.start(job,wait_ms=200)
    assert state['status']=='running' and state['worker'] and state['pid']
    os.kill(state['worker'],signal.SIGKILL);os.killpg(state['pid'],signal.SIGKILL)
    result=finished(c,job)
    assert result['status']=='lost' and 'supervisor' in result['error']


async def test_the_task_list_ends_a_job_whose_state_carries_an_error(db,tmp_path):
    from app.services.connection_service import ConnectionService
    from app.services.provider_service import ProviderService
    from app.services.session_service import SessionService
    from app.services.workspace_service import WorkspaceService
    from app.vault import SecretVault
    v=SecretVault(db)
    service=SessionService(db,ProviderService(db,v),WorkspaceService(ConnectionService(db,v)))
    sid=service.create(provider='claude',workspace_path=str(tmp_path))['id']
    c=manager(tmp_path,sid);h=host(tmp_path)
    mirror=RemoteJobService(service,tmp_path/'local',manager_factory=lambda root,sid:RemoteJobs(root,sid,prefix=lambda h:['sh','-c']))
    job=c.prepare(h,'sleep 20',h['cwd'],timeout_ms=200,background=True)
    c.start(job,wait_ms=0)
    await mirror.start()
    try:
        for _ in range(80):
            row=db.query_one('SELECT * FROM bg_tasks WHERE session_id=? AND task_id=?',(sid,'remote_'+job['job_id']))
            if row and row['status']=='failed':break
            await asyncio.sleep(.1)
        assert row['status']=='failed' and 'time limit' in row['summary']
    finally:await mirror.close()


def test_limits_default_by_kind_and_an_explicit_one_wins(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    def limit(**kw):
        job=c.prepare(h,'true',h['cwd'],**kw)
        return json.loads((c.path(job['job_id'])/'launch.json').read_text())['timeout_ms']
    assert limit(background=True)==remote_jobs.BACKGROUND_TIMEOUT_MS
    assert limit()==remote_jobs.FOREGROUND_TIMEOUT_MS
    assert limit(background=True,timeout_ms=0)==remote_jobs.BACKGROUND_TIMEOUT_MS
    assert limit(background=True,timeout_ms=5*3600*1000)==5*3600*1000
    with pytest.raises(ValueError):limit(timeout_ms=-1)


def test_stop_before_start_is_a_tombstone_and_never_runs(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    job=c.prepare(h,'touch should-not-exist',h['cwd'])
    assert c.stop(job)['status']=='stopped'
    assert c.start(job)['status']=='stopped'
    assert not (tmp_path/'work/should-not-exist').exists()


def test_output_chunks_are_lossless_and_cwd_symlinks_refused(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    text='안녕🌎'+('원격 출력\n'*3000)
    script='python3 -c '+shlex.quote('import sys;sys.stdout.write('+repr(text)+')')
    job=c.prepare(h,script,h['cwd']);c.start(job,wait_ms=1000,max_bytes=7)
    offset=0;result=''
    while True:
        part=c.display(c.poll(job,offset=offset,max_bytes=4097))
        result+=part['output'];offset=part['next_offset']
        if not part['has_more']:break
    assert result==text
    outside=tmp_path/'outside';outside.mkdir();(tmp_path/'work/link').symlink_to(outside)
    bad=c.prepare(h,'touch no',str(tmp_path/'work/link'))
    with pytest.raises(ValueError,match='refused'):c.start(bad)
    assert not (outside/'no').exists()
    with pytest.raises(ValueError,match='unknown job'):manager(tmp_path,'another').manifest(job['job_id'])


def test_shell_background_children_stay_managed(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    job=c.prepare(h,'sleep 20 &',h['cwd'])
    state=c.start(job,wait_ms=150)
    for _ in range(30):  # (a loaded machine takes longer to get it going)
        if state['status']=='running':
            break
        state=c.poll(job,wait_ms=100)
    assert state['status']=='running'
    stopped=c.stop(job)
    assert stopped['status']=='stopped' and not group_alive(stopped)


async def test_backend_mirrors_output_restart_and_stop(db,tmp_path):
    from app.services.connection_service import ConnectionService
    from app.services.provider_service import ProviderService
    from app.services.session_service import SessionService
    from app.services.workspace_service import WorkspaceService
    from app.vault import SecretVault
    v=SecretVault(db)
    service=SessionService(db,ProviderService(db,v),WorkspaceService(ConnectionService(db,v)))
    sid=service.create(provider='claude',workspace_path=str(tmp_path))['id']
    c=manager(tmp_path,sid);h=host(tmp_path)
    mirror=RemoteJobService(service,tmp_path/'local',manager_factory=lambda root,sid:RemoteJobs(root,sid,prefix=lambda h:['sh','-c']))
    service.remote_jobs=mirror
    job=c.prepare(h,"printf begin; sleep .5; printf ' 끝'",h['cwd'])
    c.start(job,wait_ms=100)
    await mirror.start()
    await asyncio.sleep(.2)
    await mirror.close()
    # Restart only the monitor; the remote command remains the SAME execution.
    mirror=RemoteJobService(service,tmp_path/'local',manager_factory=lambda root,sid:RemoteJobs(root,sid,prefix=lambda h:['sh','-c']))
    await mirror.start()
    try:
        for _ in range(50):
            row=db.query_one('SELECT * FROM bg_tasks WHERE session_id=? AND task_id=?',(sid,'remote_'+job['job_id']))
            if row and row['status']=='completed':break
            await asyncio.sleep(.1)
        assert row['status']=='completed'
        assert Path(row['output_file']).read_bytes()=='begin 끝'.encode()
        assert Path(row['output_file']).stat().st_mode & 0o777 == 0o600
        assert 'output_file' not in service._task_out(row)
        slow=c.prepare(h,'sleep 20',h['cwd']);c.start(slow,wait_ms=100)
        service.remote_jobs=mirror
        assert await service.stop_task(sid,'remote_'+slow['job_id'])
        for _ in range(60):
            row=db.query_one('SELECT * FROM bg_tasks WHERE session_id=? AND task_id=?',(sid,'remote_'+slow['job_id']))
            if row and row['status']=='stopped':break
            await asyncio.sleep(.1)
        assert row['status']=='stopped'
    finally:await mirror.close()


def test_lost_start_reply_retries_same_id_without_reexecution(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    job=c.prepare(h,'printf x >> count; sleep .1',h['cwd'])
    actual=c.control
    def lost(manifest, request):
        actual(manifest,request)
        raise RemoteTransportError('connection lost after submission')
    c.control=lost
    with pytest.raises(RemoteTransportError):c.start(job,wait_ms=0)
    restored=manager(tmp_path)
    restored.start(job,wait_ms=1000)
    assert (tmp_path/'work/count').read_text()=='x'


def test_completed_job_cleanup_is_scoped_and_running_purge_refused(tmp_path):
    c=manager(tmp_path);h=host(tmp_path)
    job=c.prepare(h,'sleep 20',h['cwd']);c.start(job,wait_ms=100)
    with pytest.raises(ValueError,match='running'):c.purge(job)
    c.stop(job);assert c.purge(job)['status']=='purged'
    assert not (tmp_path/'remote'/job['job_id']).exists()
    assert (tmp_path/'work').exists()


def test_control_banner_and_lost_connection_after_valid_reply_do_not_fail_command(tmp_path,monkeypatch):
    import subprocess
    from app.workspaces import remote_jobs
    c=manager(tmp_path);h=host(tmp_path);job=c.prepare(h,'true',h['cwd'])
    monkeypatch.setattr(remote_jobs.subprocess,'run',lambda *a,**k:subprocess.CompletedProcess([],255,b'Login banner\n{"status":"running","job_id":"test"}\n',b''))
    assert c.control(job,{'action':'poll'})['status']=='running'


def test_engine_exit_and_server_initialization_preserve_managed_remote_jobs(db,tmp_path):
    from app.services.connection_service import ConnectionService
    from app.services.provider_service import ProviderService
    from app.services.session_service import SessionService
    from app.services.workspace_service import WorkspaceService
    from app.vault import SecretVault
    v=SecretVault(db)
    def service():return SessionService(db,ProviderService(db,v),WorkspaceService(ConnectionService(db,v)))
    s=service();sid=s.create(provider='claude',workspace_path=str(tmp_path))['id']
    s._on_task(sid,{'task_id':'native','task_type':'local_bash','status':'running'})
    s._on_task(sid,{'task_id':'remote_'+'a'*32,'task_type':'remote_bash','status':'running'})
    s._on_engine_closed(sid,None,'test')
    assert db.query_one("SELECT status FROM bg_tasks WHERE task_id='native'")['status']=='killed'
    assert db.query_one("SELECT status FROM bg_tasks WHERE task_id LIKE 'remote_%'")['status']=='running'
    s=service()
    assert db.query_one("SELECT status FROM bg_tasks WHERE task_id LIKE 'remote_%'")['status']=='running'
    assert 'a'*32 in s.remote_jobs.active_note(sid)
