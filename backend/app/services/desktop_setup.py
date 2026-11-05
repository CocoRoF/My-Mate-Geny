"""Explicit CLI and prerequisite installation. Existing installations and credentials are never changed."""
from __future__ import annotations
import asyncio, os, platform, shutil, tempfile, time
from pathlib import Path
import httpx
from fastapi import HTTPException
from app.config import settings
from app.portability import child_command, subprocess_flags
from app.providers._cli_runtime import _ENV_WHITELIST, _kill_group
from app.services import managed_node
from app.services.cli_tools import tools as T
from app.services.cli_tools.tools import resolve_path

TOOLS={'claude':('Claude Code','https://claude.ai/install'),'codex':('Codex','https://chatgpt.com/codex/install'),'higgsfield':('Higgsfield',None),'node':('Node.js / npm',None)}

class DesktopSetup:
    def __init__(self):
        self.tasks: dict[str,asyncio.Task]={};self.jobs: dict[str,dict]={};self.versions={}
    @property
    def busy(self):return any(not task.done() for task in self.tasks.values())
    def state(self,tool):return self.jobs.get(tool,{'phase':'idle','log':[],'error':''})
    async def _tool(self,tool,connected=False):
        binary=resolve_path(T.effective_binary(tool));version='';cached=self.versions.get(tool)
        if binary and cached and cached[1]==binary and time.monotonic()-cached[0]<60:version=cached[2]
        elif binary:
            proc=None
            try:
                proc=await asyncio.create_subprocess_exec(*child_command(binary,['--version']),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,env=managed_node.environment(),start_new_session=True,**subprocess_flags())
                out,_=await asyncio.wait_for(proc.communicate(),5);version=out.decode(errors='replace').strip()[:120];self.versions[tool]=(time.monotonic(),binary,version)
            except (OSError,RuntimeError,TimeoutError):pass
            finally:
                if proc and proc.returncode is None:await asyncio.to_thread(_kill_group,proc);await proc.wait()
        return {'id':tool,'label':TOOLS[tool][0],'installed':bool(binary),'path':binary,'version':version,'connected':connected,'job':self.state(tool)}
    async def tools(self,providers):
        statuses={p['provider']:p for p in await providers.status_all()}
        return {'execution_mode':settings.execution_mode,'platform':platform.system(),'home':str(Path.home()),'tools':await asyncio.gather(*(self._tool(t,bool(statuses.get(t,{}).get('connected'))) for t in ('claude','codex')))}
    async def installations(self):
        return {'tools':await asyncio.gather(*(self._tool(t) for t in ('claude','codex','higgsfield'))),'node':{**managed_node.status(),'job':self.state('node')},'busy':self.busy}
    def install(self,tool,dependencies=False):
        if tool not in TOOLS:raise HTTPException(404,'unsupported setup tool')
        if self.tasks.get(tool) and not self.tasks[tool].done():return self.state(tool)
        installed=managed_node.status()['installed'] if tool=='node' else resolve_path(T.effective_binary(tool))
        if installed:raise HTTPException(409,'Already installed; installation does not upgrade existing tools')
        if self.busy:raise HTTPException(409,'Another installation is running')
        if tool=='higgsfield' and not managed_node.status()['installed'] and not dependencies:raise HTTPException(409,'node_required')
        self.jobs[tool]={'phase':'installing','step':'providerInstall','log':[],'error':'','transferred':0,'total':0}
        self.tasks[tool]=asyncio.create_task(self._install(tool,dependencies));return self.state(tool)
    def cancel(self,tool):
        if tool in self.tasks:self.tasks[tool].cancel()
        return {'ok':True}
    async def stop(self):
        for task in self.tasks.values():task.cancel()
        await asyncio.gather(*self.tasks.values(),return_exceptions=True)
    async def _exec(self,cmd,job,cwd):
        env=managed_node.environment({k:os.environ[k] for k in _ENV_WHITELIST if k in os.environ});env.update(CODEX_NON_INTERACTIVE='1',npm_config_update_notifier='false',npm_config_fund='false')
        proc=await asyncio.create_subprocess_exec(*cmd,env=env,cwd=cwd,stdin=asyncio.subprocess.DEVNULL,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT,start_new_session=True,**subprocess_flags())
        try:
            rest=b''
            while chunk:=await proc.stdout.read(4096):
                rest+=chunk
                while b'\n' in rest or len(rest)>2000:
                    line,sep,rest=rest.partition(b'\n') if b'\n' in rest else (rest[:2000],b'',rest[2000:])
                    job['log'].append(line.decode(errors='replace').rstrip()[:500]);job['log']=job['log'][-60:]
            if rest:job['log'].append(rest.decode(errors='replace')[:500])
            if await proc.wait():raise RuntimeError(f'Installer failed (exit {proc.returncode}); see the log')
        finally:
            if proc.returncode is None:await asyncio.to_thread(_kill_group,proc);await proc.wait()
    async def _install_npm(self,tool,job,dependencies):
        if not managed_node.status()['installed']:
            if not dependencies:raise RuntimeError('node_required: install Node.js/npm in Providers and retry')
            await managed_node.install(job)
        job['step']='providerInstall';npm=managed_node.which('npm')
        if not npm:raise RuntimeError('node_required')
        await self._exec(child_command(npm,['install','--global','--prefix',T.managed_prefix(),'--no-audit','--no-fund',T.TOOLS[tool].pkg+'@latest']),job,Path.home())
        if not Path(T.managed_binary(tool)).is_file():raise RuntimeError('CLI binary was not found after installation')
        T.update_state(tool,use_managed=True)
    async def _install(self,tool,dependencies=False):
        job=self.jobs[tool]
        try:
            async with asyncio.timeout(600):
                if tool=='node' or (tool=='higgsfield' and not managed_node.status()['installed']):
                    if tool!='node' and not dependencies:raise RuntimeError('node_required')
                    await managed_node.install(job)
                if tool=='higgsfield':
                    await self._install_npm(tool,job,dependencies)
                elif tool!='node':
                    try:
                        suffix='.ps1' if os.name=='nt' else '.sh'
                        async with httpx.AsyncClient(follow_redirects=True,timeout=60) as client:
                            response=await client.get(TOOLS[tool][1]+suffix);response.raise_for_status();content=response.content
                        if not content or len(content)>2_000_000 or content.lstrip().lower().startswith((b'<html',b'<!doctype')):raise RuntimeError('Invalid installer response')
                        target=settings.home_dir/'setup';target.mkdir(parents=True,exist_ok=True)
                        with tempfile.TemporaryDirectory(dir=target) as directory:
                            script=Path(directory)/('install'+suffix);script.write_bytes(content)
                            shell=shutil.which('powershell') or shutil.which('pwsh') if os.name=='nt' else shutil.which('bash' if tool=='claude' else 'sh')
                            if not shell:raise RuntimeError('The official installer shell is missing')
                            args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(script)] if os.name=='nt' else [str(script)]
                            await self._exec([shell,*args],job,directory)
                    except (httpx.HTTPError,OSError,RuntimeError) as exc:
                        # Official installers may be blocked or depend on a shell/curl that a new PC lacks.
                        # npm packages are also official and stay inside the app-owned prefix.
                        if resolve_path(T.effective_binary(tool)):
                            raise RuntimeError('An installation appeared while preparing; keeping it unchanged') from exc
                        job['log'].append(f'Native installer unavailable ({type(exc).__name__}); using the official npm package.')
                        await self._install_npm(tool,job,dependencies)
                if tool!='node' and not resolve_path(T.effective_binary(tool)):raise RuntimeError('Installation finished but the CLI could not be detected; check the log')
                self.versions.pop(tool,None);job.update(phase='done',step='done')
        except asyncio.CancelledError:job.update(phase='cancelled',error='')
        except Exception as exc:job.update(phase='error',error=str(exc)[:500])

service=DesktopSetup()
