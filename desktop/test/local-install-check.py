"""Opt-in network integration: official installers in a disposable HOME, never the developer's CLI/auth."""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

async def main():
    runtime = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(runtime / 'backend'))
    with tempfile.TemporaryDirectory(prefix='.local-install-check-', dir=Path.cwd()) as directory:
        home=Path(directory)
        os.environ.update(HOME=directory, USERPROFILE=directory, DATA_HOME=str(home/'state'),
                          PATH='/usr/bin:/bin', AUTH_PASSWORD='installation-test-only',
                          CLAUDE_BINARY='claude', CODEX_BINARY='codex', CODEX_HOME=str(home/'.codex'))
        from app.services.desktop_setup import DesktopSetup
        from app.services.cli_tools.tools import effective_binary, resolve_path
        service=DesktopSetup()
        result={}
        try:
            for tool in ('claude','codex'):
                if resolve_path(effective_binary(tool)):
                    raise RuntimeError('Refusing to run installation test with an existing tool on the isolated PATH')
                service.install(tool)
                await service.tasks[tool]
                state=service.state(tool)
                result[tool]={'phase':state['phase'],'error':state['error'],'log':state['log'][-8:]}
                print(json.dumps({tool:result[tool]}),flush=True)
                if state['phase']!='done':raise RuntimeError(f'{tool} official installation failed')
                binary=resolve_path(effective_binary(tool))
                assert str(binary).startswith(directory)
                proc=await asyncio.create_subprocess_exec(binary, '--version',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
                stdout,stderr=await asyncio.wait_for(proc.communicate(),15)
                assert proc.returncode==0,(stdout,stderr)
                print(json.dumps({'tool':tool,'version':stdout.decode().strip(),'executable':True}),flush=True)
            print('LOCAL_INSTALLERS_OK',flush=True)
        finally:
            await service.stop()

asyncio.run(main())
