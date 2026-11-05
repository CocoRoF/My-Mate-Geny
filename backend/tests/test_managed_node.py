import asyncio, hashlib, io, os, tarfile
from pathlib import Path
import httpx
import pytest
from app.config import settings
from app.services import managed_node as node
from app.services.desktop_setup import DesktopSetup


def test_official_archive_platforms_and_unsafe_members(tmp_path):
    assert node.archive_name('v24.1.0','Windows','AMD64').endswith('win-x64.zip')
    assert node.archive_name('v24.1.0','Darwin','arm64').endswith('darwin-arm64.tar.gz')
    with pytest.raises(RuntimeError):node.archive_name('v24.1.0','Linux','mips')
    import zipfile
    archive=tmp_path/'bad.zip'
    with zipfile.ZipFile(archive,'w') as z:z.writestr('../escape','bad')
    with pytest.raises(ValueError):node.unpack(archive,tmp_path/'out','node-fixture')
    assert not (tmp_path/'escape').exists()

@pytest.mark.asyncio
async def test_checksum_verified_app_owned_node_and_npm(monkeypatch,tmp_path):
    if os.name=='nt':pytest.skip('executable fixture uses a POSIX shebang')
    monkeypatch.setattr(settings,'data_home',str(tmp_path))
    # home_dir may be an ordinary settings field in a source checkout.
    monkeypatch.setattr(node,'root',lambda:tmp_path/'runtime-node')
    monkeypatch.setattr(node.platform,'system',lambda:'Linux');monkeypatch.setattr(node.platform,'machine',lambda:'x86_64')
    name='node-v24.99.1-linux-x64';buf=io.BytesIO()
    with tarfile.open(fileobj=buf,mode='w:gz') as t:
        for rel,content in [('bin/node',b'#!/bin/sh\necho v24.99.1\n'),('bin/npm',b'#!/bin/sh\necho 10.0.0\n'),('lib/node_modules/npm/bin/npm-cli.js',b'// fixture')]:
            i=tarfile.TarInfo(name+'/'+rel);i.size=len(content);i.mode=0o755;t.addfile(i,io.BytesIO(content))
    data=buf.getvalue();sha=hashlib.sha256(data).hexdigest();seen=[];original=httpx.AsyncClient
    async def handle(request):
        seen.append(request);assert request.url.host=='nodejs.org'
        if request.url.path.endswith('index.json'):return httpx.Response(200,json=[{'version':'v24.99.1','lts':'fixture'}])
        if request.url.path.endswith('SHASUMS256.txt'):return httpx.Response(200,text=sha+'  '+name+'.tar.gz\n')
        return httpx.Response(200,content=data)
    monkeypatch.setattr(node.httpx,'AsyncClient',lambda **kw:original(transport=httpx.MockTransport(handle),**kw))
    job={'log':[]};before=os.environ.get('PATH');await node.install(job)
    assert os.environ.get('PATH')==before
    assert (node.root()/'geny-managed-node.json').exists()
    assert node.status()['installed'] and node.status()['managed']==str(node.root()/'bin')
    assert node.environment()['PATH'].split(os.pathsep)[0]==str(node.root()/'bin')
    assert node.which('npm')==str(node.root()/'bin/npm')
    assert len(seen)==3
    # A damaged official response cannot replace a working installation.
    manifest=(node.root()/'geny-managed-node.json').read_bytes()
    async def damaged(request):
        r=await handle(request)
        if request.url.path.endswith('SHASUMS256.txt'):return httpx.Response(200,text='0'*64+'  '+name+'.tar.gz\n')
        return r
    monkeypatch.setattr(node.httpx,'AsyncClient',lambda **kw:original(transport=httpx.MockTransport(damaged),**kw))
    with pytest.raises(RuntimeError,match='checksum'):await node.install({'log':[]})
    assert (node.root()/'geny-managed-node.json').read_bytes()==manifest

@pytest.mark.asyncio
async def test_higgsfield_dependency_chain_uses_only_fixture_commands(monkeypatch,tmp_path):
    from app.services import desktop_setup as setup
    installed={'node':False,'provider':False};events=[]
    monkeypatch.setattr(node,'status',lambda:{'installed':installed['node']})
    monkeypatch.setattr(setup,'resolve_path',lambda _b:str(tmp_path/'higgsfield') if installed['provider'] else None)
    monkeypatch.setattr(setup.T,'effective_binary',lambda _t:'fixture-higgsfield')
    monkeypatch.setattr(setup.T,'managed_binary',lambda _t:str(tmp_path/'higgsfield'))
    monkeypatch.setattr(setup.T,'managed_prefix',lambda:str(tmp_path/'prefix'))
    monkeypatch.setattr(setup.T,'update_state',lambda _t,**p:events.append(('state',p)))
    monkeypatch.setattr(node,'which',lambda _t:'/fixture/npm')
    async def install_node(job):events.append('node');installed['node']=True
    monkeypatch.setattr(node,'install',install_node)
    svc=DesktopSetup()
    async def execute(cmd,job,cwd):
        events.append(cmd);(tmp_path/'higgsfield').write_text('fixture only');installed['provider']=True
    monkeypatch.setattr(svc,'_exec',execute)
    with pytest.raises(Exception) as error:svc.install('higgsfield')
    assert error.value.status_code==409
    svc.install('higgsfield',dependencies=True);await svc.tasks['higgsfield']
    assert svc.state('higgsfield')['phase']=='done' and events[0]=='node'
    assert any(isinstance(e,list) and '@higgsfield/cli@latest' in e and '--prefix' in e for e in events)
    assert not any(isinstance(e,list) and 'login' in e for e in events)


def test_installed_node_reaches_session_and_login_subprocesses(monkeypatch,tmp_path):
    from app.providers._cli_runtime import CLIProcessRunner
    from app.providers import native_login
    from app.providers.oauth import OAuthManager
    monkeypatch.setattr(node,'root',lambda:tmp_path/'node')
    (node.root()/'bin').mkdir(parents=True)
    expected=str(node.root()/'bin')
    runner=CLIProcessRunner('fixture',cwd=str(tmp_path))
    assert runner._build_env()['PATH'].split(os.pathsep)[0]==expected
    assert native_login._env()['PATH'].split(os.pathsep)[0]==expected
    assert OAuthManager()._env()['PATH'].split(os.pathsep)[0]==expected


@pytest.mark.asyncio
@pytest.mark.parametrize('tool,package',[('claude','@anthropic-ai/claude-code@latest'),('codex','@openai/codex@latest')])
async def test_blocked_native_installer_falls_back_to_official_app_owned_npm(monkeypatch,tmp_path,tool,package):
    from app.services import desktop_setup as setup
    installed={'node':False,'tool':False};events=[]
    monkeypatch.setattr(setup,'resolve_path',lambda b:str(tmp_path/'provider') if installed['tool'] else None)
    monkeypatch.setattr(setup.T,'effective_binary',lambda t:'missing-provider')
    monkeypatch.setattr(setup.T,'managed_binary',lambda t:str(tmp_path/'provider'))
    monkeypatch.setattr(setup.T,'managed_prefix',lambda:str(tmp_path/'prefix'))
    monkeypatch.setattr(setup.T,'update_state',lambda t,**p:None)
    monkeypatch.setattr(node,'status',lambda:{'installed':installed['node']})
    monkeypatch.setattr(node,'which',lambda t:'/fixture/npm')
    async def install_node(job):events.append('node');installed['node']=True
    monkeypatch.setattr(node,'install',install_node)
    original=httpx.AsyncClient
    monkeypatch.setattr(setup.httpx,'AsyncClient',lambda **kw:original(transport=httpx.MockTransport(lambda r:httpx.Response(403)),**kw))
    svc=DesktopSetup()
    async def execute(cmd,job,cwd):events.append(cmd);(tmp_path/'provider').write_text('fixture only');installed['tool']=True
    monkeypatch.setattr(svc,'_exec',execute)
    svc.install(tool,dependencies=True);await svc.tasks[tool]
    assert svc.state(tool)['phase']=='done'
    assert events[0]=='node' and package in events[1]
    assert '--prefix' in events[1]
    assert any('Native installer unavailable' in line for line in svc.state(tool)['log'])
