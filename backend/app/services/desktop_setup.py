"""Explicit first-run CLI installation. Never upgrades an existing CLI or changes its credentials."""
from __future__ import annotations
from app.portability import child_command, subprocess_flags
import asyncio
import os
import platform
import time
import shutil
import tempfile
from pathlib import Path
import httpx
from fastapi import HTTPException
from app.config import settings
from app.providers._cli_runtime import _ENV_WHITELIST, _kill_group
from app.services.cli_tools.tools import effective_binary, resolve_path

TOOLS = {'claude': ('Claude Code', 'https://claude.ai/install'),
         'codex': ('Codex', 'https://chatgpt.com/codex/install')}


class DesktopSetup:
    def __init__(self):
        self.tasks: dict[str, asyncio.Task] = {}
        self.jobs: dict[str, dict] = {}
        self.versions: dict[str, tuple[float, str, str]] = {}

    def state(self, tool):
        return self.jobs.get(tool, {'phase': 'idle', 'log': [], 'error': ''})

    async def tools(self, providers):
        statuses = {p["provider"]: p for p in await providers.status_all()}
        async def one(tool):
            binary = resolve_path(effective_binary(tool))
            version = ''
            cached=self.versions.get(tool)
            if binary and cached and cached[1]==binary and time.monotonic()-cached[0]<60:
                version=cached[2]
            elif binary:
                proc = None
                try:
                    proc = await asyncio.create_subprocess_exec(*child_command(binary, ['--version']),
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True, **subprocess_flags())
                    out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
                    version = out.decode(errors='replace').strip()[:120]
                    self.versions[tool]=(time.monotonic(),binary,version)
                except (OSError, RuntimeError, TimeoutError):
                    if proc and proc.returncode is None:
                        _kill_group(proc)
            p = statuses.get(tool)
            return {'id': tool, 'label': TOOLS[tool][0], 'installed': bool(binary), 'path': binary,
                    'version': version, 'connected': bool(p and p["connected"]), 'job': self.state(tool)}
        return {'execution_mode': settings.execution_mode, 'platform': platform.system(),
                'home': str(Path.home()), 'tools': await asyncio.gather(*(one(t) for t in TOOLS))}

    def install(self, tool):
        if tool not in TOOLS:
            raise HTTPException(404, 'unsupported setup tool')
        if self.tasks.get(tool) and not self.tasks[tool].done():
            return self.state(tool)
        if resolve_path(effective_binary(tool)):
            raise HTTPException(409, 'Already installed; the assistant does not upgrade existing tools')
        if any(not t.done() for t in self.tasks.values()):
            raise HTTPException(409, 'Another CLI installation is running')
        self.jobs[tool] = {'phase': 'installing', 'log': [], 'error': ''}
        self.tasks[tool] = asyncio.create_task(self._install(tool))
        return self.state(tool)

    def cancel(self, tool):
        if tool in self.tasks:
            self.tasks[tool].cancel()
        return {'ok': True}

    async def stop(self):
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    async def _install(self, tool):
        job = self.jobs[tool]
        proc = None
        try:
            suffix = '.ps1' if os.name == 'nt' else '.sh'
            url = TOOLS[tool][1] + suffix
            async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
                response = await client.get(url)
                response.raise_for_status()
                content = response.content
            if not content or len(content) > 2_000_000:
                raise RuntimeError('Invalid installer response')
            root = settings.home_dir / 'setup'
            root.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=root) as directory:
                script = Path(directory) / ('install' + suffix)
                script.write_bytes(content)
                if os.name == 'nt':
                    shell = shutil.which('powershell') or shutil.which('pwsh')
                    if not shell:
                        raise RuntimeError('PowerShell is required for the official native installer')
                    cmd = [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(script)]
                else:
                    shell = shutil.which('bash' if tool == 'claude' else 'sh')
                    if not shell:
                        raise RuntimeError('The installer shell is missing')
                    cmd = [shell, str(script)]
                env = {k: os.environ[k] for k in _ENV_WHITELIST if k in os.environ}
                env['CODEX_NON_INTERACTIVE'] = '1'
                proc = await asyncio.create_subprocess_exec(*cmd, env=env, cwd=directory,
                    stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT, start_new_session=True, **subprocess_flags())
                async with asyncio.timeout(600):
                    while line := await proc.stdout.readline():
                        job['log'].append(line.decode(errors='replace').rstrip()[:500])
                        job['log'] = job['log'][-60:]
                    rc = await proc.wait()
                if rc or not resolve_path(effective_binary(tool)):
                    raise RuntimeError(f'Installation did not finish successfully (exit {rc}); see the log and retry')
                job['phase'] = 'done'
        except asyncio.CancelledError:
            job['phase'] = 'cancelled'
        except Exception as exc:
            job.update(phase='error', error=str(exc)[:500])
        finally:
            if proc and proc.returncode is None:
                await asyncio.to_thread(_kill_group, proc)
                await proc.wait()
