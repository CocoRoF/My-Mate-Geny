"""Local CLI credential-store discovery, including OS Keychain/Credential Manager.

Only the CLI reports whether it can use its own login. No credential contents are read or copied.
"""
import json
import os
import subprocess
import threading
import time
from app.config import settings
from app.portability import child_command

_cache: dict[tuple[str,str],tuple[float,bool]]={}
_lock=threading.Lock()


def logged_in(tool: str, binary: str) -> bool:
    if settings.execution_mode != 'local':
        return False
    key=(tool,binary)
    with _lock:
        cached=_cache.get(key)
        if cached and time.monotonic()-cached[0]<15:
            return cached[1]
    args=['auth','status','--json'] if tool=='claude' else ['login','status']
    ok=False
    try:
        result=subprocess.run(child_command(binary,args),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,timeout=5,env=_env(),
            **({'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}))
        ok=result.returncode==0 and (tool=='codex' or json.loads(result.stdout).get('loggedIn') is True)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        pass
    with _lock:
        _cache[key]=(time.monotonic(),ok)
    return ok


def _env():
    from ._cli_runtime import _ENV_WHITELIST
    from app.services.managed_node import environment
    return environment({k:os.environ[k] for k in _ENV_WHITELIST if k in os.environ})


def invalidate(tool: str):
    with _lock:
        for key in list(_cache):
            if key[0]==tool:
                _cache.pop(key,None)
