"""Real upgrade check for services/cli_tools (not collected by pytest): the real registries and the real npm /
native installer, against temp prefixes / a temp HOME only — never the CLIs in use (docs/providers.md, "CLI versions").

  cd backend && HOME=<temp home> CODEX_BINARY=<temp prefix>/bin/codex HIGGSFIELD_BINARY=<temp prefix>/bin/higgsfield \
    PYTHONPATH=. python -P tests/manual_cli_upgrade.py status upgrade:codex upgrade:codex@0.165.0 …

steps: status | upgrade:<tool>[@<version>] | readonly:<dir> (chmod 555, e.g. <prefix>/lib/node_modules)
"""

import asyncio
import json
import os
import sys
import time

from app.services.cli_tools import service as S
from app.services.cli_tools import tools as T


class Sessions:
    active_runs: dict = {}

    def add_turn_end_listener(self, cb):
        pass

    def broadcast_list(self, msg):
        if msg["type"] == "cli.log":
            for ln in msg["data"]["lines"]:
                print(f"    | {ln}", flush=True)

    def engines(self):
        return []

    async def retire_engines(self):
        return {"restarted": 0, "deferred": 0}


def brief(t: dict) -> str:
    i = t["installed"]
    out = (f"{t['id']:<10} installed={i['version']} ({i['method']}, writable={i['writable']}) {i['path']} -> {i['realpath']}"
           f"\n           latest[{t['channel']}]={t['latest']['version']} {t['latest']['tags']} "
           f"update={t['update_available']} using_managed={t['using_managed']}"
           f"\n           upgrade={json.dumps(t['upgrade'])}")
    if t.get("notes"):
        out += f"\n           notes={[(s['version'], s['count'], s['items'][:1]) for s in t['notes']['sections']]}"
    if t.get("self_update"):
        out += f"\n           self_update={t['self_update']}"
    return out


async def main(steps: list[str]) -> None:
    svc = S.CliToolsService(Sessions())
    print("capped:", S.capped_path(), "| managed prefix:", T.managed_prefix(), flush=True)
    for step in steps:
        print(f"== {step}", flush=True)
        if step == "status":
            await svc.check()
            for t in (await svc.status())["tools"]:
                print(brief(t), flush=True)
        elif step.startswith("upgrade:"):
            tool, _, ver = step[8:].partition("@")
            t0 = time.time()
            job = await svc.upgrade(tool, version=ver or None)
            print(f"  job {job['id']}: {job['from_version']} -> {job['target']} via {job['method']}", flush=True)
            while svc._job is not None:
                await asyncio.sleep(0.2)
            st = await svc.tool_status(tool)
            j = st["job"]
            print(f"  => {j['state']} in {time.time() - t0:.1f}s error={j['error_code']} {j['error']} "
                  f"result={j['result']} mem_cap={j['mem_cap']}", flush=True)
            print(brief(st), flush=True)
        elif step.startswith("readonly:"):
            os.chmod(step[9:], 0o555)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
