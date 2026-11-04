from pathlib import Path
import os
import sys
import asyncio
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from starlette.requests import Request
from app.routers.local_runtime import authorize_native
from app.config import settings
from app.providers._cli_runtime import CLIProcessRunner, _ENV_WHITELIST
from app.services.desktop_setup import DesktopSetup


def request(secret='test-secret',host='127.0.0.1:8080',extra=None):
    headers={'host':host,'x-geny-local-bootstrap':secret,**(extra or {})}
    return Request({'type':'http','method':'POST','path':'/api/local/bootstrap','client':('127.0.0.1',1234),
                    'headers':[(k.encode(),v.encode()) for k,v in headers.items()]})


def test_bootstrap_is_native_only(monkeypatch):
    monkeypatch.setattr(settings,'execution_mode','local');monkeypatch.setattr(settings,'local_bootstrap_secret','test-secret');monkeypatch.setattr(settings,'port',8080)
    authorize_native(request())
    for bad in (request(secret='wrong'),request(host='attacker.example:8080'),request(extra={'origin':'http://evil.test'}),request(extra={'x-forwarded-for':'127.0.0.1'})):
        with pytest.raises(HTTPException):authorize_native(bad)
    monkeypatch.setattr(settings,'execution_mode','server')
    with pytest.raises(HTTPException) as e:authorize_native(request())
    assert e.value.status_code==404


@pytest.mark.asyncio
async def test_native_runner_keeps_shell_characters_literal(tmp_path):
    text='a & b; $(private) `private` 한글'
    r=CLIProcessRunner(sys.executable,cwd=str(tmp_path))
    output=b''.join([line async for line in r.stream(['-c','import sys; print(sys.argv[1])',text])])
    assert output.decode().strip()==text
    assert r.last_result.returncode==0
    for key in ('USERPROFILE','SYSTEMROOT','LOCALAPPDATA','COMSPEC','TEMP'):
        assert key in _ENV_WHITELIST
    assert 'LOCAL_BOOTSTRAP_SECRET' not in _ENV_WHITELIST


@pytest.mark.asyncio
async def test_installer_never_upgrades_existing_cli(monkeypatch):
    monkeypatch.setattr('app.services.desktop_setup.resolve_path',lambda b:'/existing/tool')
    svc=DesktopSetup()
    with pytest.raises(HTTPException) as e:svc.install('claude')
    assert e.value.status_code==409
    with pytest.raises(HTTPException) as e:svc.install('higgsfield')
    assert e.value.status_code==404
    assert not svc.tasks


@pytest.mark.asyncio
async def test_setup_status_no_conversation_or_credential_data(monkeypatch):
    monkeypatch.setattr('app.services.desktop_setup.resolve_path',lambda b:None)
    class Providers:
        async def status_all(self):return [{'provider':'claude','connected':False}]
    out=await DesktopSetup().tools(Providers())
    assert {t['id'] for t in out['tools']}=={'claude','codex'}
    assert all(not t['installed'] for t in out['tools'])


def test_portable_host_memory_and_processes():
    from app.services.sysmon.portable import Collector
    c=Collector(disk_paths=[('home',str(Path.home()))])
    m=c.memory();assert 0<=m['used']<=m['total']
    assert m['occupied']==m['total']-m['free']
    me,kids=c.processes(0,None);assert me.pid==os.getpid()
    assert c.disk_usage()[0]['total']>0
