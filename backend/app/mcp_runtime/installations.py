"""Explicit downloads into app-owned, isolated package directories.

The catalog never executes a user supplied installer. One download at a time;
an interrupted install cannot replace a working package or become registered.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import platform
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path

import httpx

from app.config import settings
from app.mcp_runtime.catalog import recipe
from app.mcp_runtime.diagnostics import ConnectionIssue, launch_environment
from app.portability import child_command, subprocess_flags
from app.providers._cli_runtime import _kill_group
from app.services import install_lock, managed_node


class Installations:
    def __init__(self, changed=lambda: None, log=lambda *a, **k: None):
        self.jobs, self.tasks = {}, {}
        self.changed, self.log = changed, log

    @property
    def root(self):
        return settings.home_dir / "mcp-packages"

    def manifest(self, rid):
        r = recipe(rid)
        if r["kind"] == "remote":
            return {"version": "hosted", "remote": True}
        try:
            value = json.loads((self.root / rid / "current.json").read_text())
            if (
                not isinstance(value, dict)
                or not re.fullmatch(r"[a-f0-9]{32}", value.get("directory", ""))
                or value.get("package") != r["package"]
            ):
                return None
            target = self.root / rid / value["directory"]
            if target.parent != self.root / rid or not (target / "installed.json").is_file():
                return None
            if r["kind"] == "python" and value.get("python") != list(sys.version_info[:2]):
                return None
            if (
                value.get("platform") != platform.system()
                or value.get("machine", platform.machine().lower()) != platform.machine().lower()
            ):
                return None
            if r["kind"] == "python":
                if (
                    not (target / "site").is_dir()
                    or not (self.root / "python-runner-v1.py").is_file()
                ):
                    return None
            elif (
                not managed_node.which("node")
                or not isinstance(value.get("entry"), str)
                or not (target / value["entry"]).resolve().is_relative_to(target.resolve())
                or not (target / value["entry"]).is_file()
            ):
                return None
            return value
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def state(self, rid):
        manifest = self.manifest(rid)
        return {
            "installed": bool(manifest),
            "version": (manifest or {}).get("version", ""),
            "download_required": recipe(rid)["kind"] != "remote",
            **self.jobs.get(
                rid, {"phase": "ready" if manifest else "idle", "step": "", "log": [], "error": ""}
            ),
        }

    def start(self, rid):
        r = recipe(rid)
        if r["kind"] == "remote" or self.manifest(rid):
            return self.state(rid)
        if rid in self.tasks and not self.tasks[rid].done():
            return self.state(rid)
        from app.services.desktop_setup import service as setup

        if setup.busy or any(not task.done() for task in self.tasks.values()):
            raise ValueError("mcp_installation_busy")
        owner = object()
        if not install_lock.claim(owner):
            raise ValueError("mcp_installation_busy")
        self.jobs[rid] = {
            "phase": "installing",
            "step": "resolve",
            "log": [],
            "error": "",
            "started_at": time.time(),
        }
        self.tasks[rid] = asyncio.create_task(self._install(rid))
        self.tasks[rid].add_done_callback(lambda task: install_lock.release(owner))
        self.log(None, "info", "download_started", recipe_id=rid)
        self.changed()
        return self.state(rid)

    async def cancel(self, rid):
        recipe(rid)
        task = self.tasks.get(rid)
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return self.state(rid)

    async def _exec(self, argv, job, cwd):
        # No provider credentials, shell interpolation or user's package-manager config.
        env = launch_environment({"env": {}})
        env.update(
            UV_NO_PROGRESS="1",
            UV_CACHE_DIR=str(self.root / "cache"),
            UV_NO_CONFIG="1",
            UV_PYTHON_DOWNLOADS="never",
            npm_config_update_notifier="false",
            npm_config_fund="false",
            npm_config_audit="false",
        )
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
            **subprocess_flags(),
        )
        try:
            while chunk := await proc.stdout.read(4096):
                job["log"] = (
                    job["log"] + chunk.decode("utf-8", "replace").replace("\r", "\n").splitlines()
                )[-40:]
                job["log"] = [line[:400] for line in job["log"]]
            if await proc.wait():
                raise RuntimeError("mcp_package_install_failed")
        finally:
            if proc.returncode is None:
                await asyncio.to_thread(_kill_group, proc)
                await proc.wait()

    async def _version(self, r):
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            if r["kind"] == "python":
                response = await client.get("https://pypi.org/pypi/" + r["package"] + "/json")
                response.raise_for_status()
                value = response.json()["info"]["version"]
            else:
                response = await client.get(
                    "https://registry.npmjs.org/" + r["package"].replace("/", "%2f") + "/latest"
                )
                response.raise_for_status()
                value = response.json()["version"]
        if (
            not isinstance(value, str)
            or len(value) > 80
            or not value
            or any(
                c not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+!-"
                for c in value
            )
        ):
            raise RuntimeError("invalid_package_version")
        return value

    async def _install(self, rid):
        r, job = recipe(rid), self.jobs[rid]
        parent = self.root / rid
        try:
            async with asyncio.timeout(600):
                parent.mkdir(parents=True, exist_ok=True)
                version = await self._version(r)
                job["version"] = version
                with tempfile.TemporaryDirectory(prefix=".download-", dir=parent) as directory:
                    stage = Path(directory)
                    if r["kind"] == "python":
                        job["step"] = "package"
                        await self._exec(
                            [
                                sys.executable,
                                "-I",
                                "-m",
                                "uv",
                                "pip",
                                "install",
                                "--python",
                                sys.executable,
                                "--target",
                                str(stage / "site"),
                                "--default-index",
                                "https://pypi.org/simple",
                                "--no-build",
                                r["package"] + "==" + version,
                            ],
                            job,
                            stage,
                        )
                        matches = [
                            d
                            for d in importlib.metadata.distributions(path=[str(stage / "site")])
                            if d.metadata["Name"].lower().replace("_", "-")
                            == r["package"].lower().replace("_", "-")
                        ]
                        if len(matches) != 1 or not any(
                            e.name == r["entry"] and e.group == "console_scripts"
                            for e in matches[0].entry_points
                        ):
                            raise RuntimeError("installed_entry_missing")
                        entry = ""
                    else:
                        if not managed_node.status()["installed"]:
                            job["step"] = "node"
                            await managed_node.install(job)
                        npm = managed_node.which("npm")
                        if not npm:
                            raise RuntimeError("node_required")
                        job["step"] = "package"
                        empty = stage / "empty.npmrc"
                        empty.write_text("")
                        await self._exec(
                            child_command(
                                npm,
                                [
                                    "install",
                                    "--prefix",
                                    str(stage),
                                    "--ignore-scripts",
                                    "--no-audit",
                                    "--no-fund",
                                    "--userconfig",
                                    str(empty),
                                    "--registry",
                                    "https://registry.npmjs.org",
                                    r["package"] + "@" + version,
                                ],
                            ),
                            job,
                            stage,
                        )
                        pkg_dir = stage / "node_modules" / r["package"]
                        meta = json.loads((pkg_dir / "package.json").read_text())
                        bins = meta.get("bin", {})
                        entry = bins.get(r["entry"]) if isinstance(bins, dict) else bins
                        if (
                            not entry
                            or not (pkg_dir / entry).resolve().is_relative_to(stage.resolve())
                            or not (pkg_dir / entry).is_file()
                        ):
                            raise RuntimeError("installed_entry_missing")
                        entry = str((pkg_dir / entry).relative_to(stage))
                    manifest = {
                        "version": version,
                        "package": r["package"],
                        "entry": entry,
                        "python": list(sys.version_info[:2]),
                        "platform": platform.system(),
                        "machine": platform.machine().lower(),
                        "directory": uuid.uuid4().hex,
                        "source": r["source"],
                        "installed_at": time.time(),
                    }
                    (stage / "installed.json").write_text(json.dumps(manifest))
                    destination = parent / manifest["directory"]
                    stage.rename(destination)
                    pointer = parent / (".current-" + uuid.uuid4().hex)
                    pointer.write_text(json.dumps(manifest))
                    os.replace(pointer, parent / "current.json")
                    if r["kind"] == "python":
                        # This stable, app-owned runner also supports a repair before an app update.
                        runner = self.root / "python-runner-v1.py"
                        temporary = runner.with_suffix(".tmp")
                        temporary.write_bytes(
                            Path(__file__).with_name("package_runner.py").read_bytes()
                        )
                        os.replace(temporary, runner)
                job.update(phase="ready", step="done", error="")
                self.log(None, "info", "download_completed", recipe_id=rid, version=version)
        except asyncio.CancelledError:
            job.update(phase="cancelled", error="")
            self.log(None, "info", "download_cancelled", recipe_id=rid)
        except Exception as exc:
            job.update(phase="error", error=type(exc).__name__ + ": " + str(exc)[:300])
            self.log(None, "error", "download_failed", type(exc).__name__, recipe_id=rid)
        finally:
            self.changed()

    def materialize(self, spec):
        if spec["command"] != "geny-managed":
            return spec
        rid = spec.get("catalog_id", "")
        r, manifest = recipe(rid), self.manifest(rid)
        if r["kind"] == "remote":  # a package entry of a recipe that is hosted now
            raise ConnectionIssue(
                "package_missing", "This package was replaced: set it up again from the catalog or manual setup."
            )
        if not manifest:
            raise ConnectionIssue(
                "package_missing", "Download this MCP package from the catalog first."
            )
        root = self.root / rid / manifest["directory"]
        if r["kind"] == "python":
            return {
                **spec,
                "command": sys.executable,
                "args": [
                    "-I",
                    str(self.root / "python-runner-v1.py"),
                    str(root / "site"),
                    r["package"],
                    r["entry"],
                    *spec["args"],
                ],
            }
        return {
            **spec,
            "command": managed_node.which("node"),
            "args": [str(root / manifest["entry"]), *spec["args"]],
        }

    async def stop(self):
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
