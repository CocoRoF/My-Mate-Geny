#!/usr/bin/env python3
"""Build a relocatable, real Python runtime; never copy developer credentials or a hot-deploy asset archive."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(args, **kw):
    subprocess.run([str(a) for a in args], check=True, **kw)


def build(output: Path, frontend: Path, cache: Path, python_version: str = "3.12.16") -> None:
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("Build dependency uv is required; users of the packaged app do not need it")
    cache.mkdir(parents=True, exist_ok=True)
    run([uv, "python", "install", python_version, "--install-dir", cache, "--no-bin", "--no-registry"])
    # uv also links cpython-3.12-* to the install. It is only a convenience, and a Windows junction doesn't survive the CI
    # cache: restored, uv can neither reuse nor remove it ("The directory name is invalid"). So it never reaches the cache.
    for link in cache.glob(f"cpython-{'.'.join(python_version.split('.')[:2])}-*"):
        os.unlink(link)
    pattern = f"cpython-{python_version}-*"
    candidates = list(cache.glob(pattern + "/python.exe")) if os.name == "nt" else list(cache.glob(pattern + "/bin/python3"))
    candidates = list({p.resolve(): p.resolve() for p in candidates}.values())
    if len(candidates) != 1:
        raise RuntimeError(f"Expected one managed runtime, found {len(candidates)}")
    python = candidates[0]
    pyroot = python.parent if os.name == "nt" else python.parent.parent
    requirements = tomllib.loads((ROOT / "backend/pyproject.toml").read_text())["project"]["dependencies"]
    run([uv, "pip", "install", "--python", python, "--break-system-packages", *requirements])
    if not (frontend / "index.html").is_file():
        raise RuntimeError("Build the clean frontend/dist-local before packaging the local runtime")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".local-build-", dir=output.parent) as temp:
        stage = Path(temp) / "runtime"
        shutil.copytree(pyroot, stage / "python", symlinks=False, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        backend = stage / "backend"
        shutil.copytree(ROOT / "backend/app", backend / "app", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy2(ROOT / "backend/local_main.py", backend / "local_main.py")
        shutil.copytree(frontend, stage / "web")
        executable = "python/python.exe" if os.name == "nt" else "python/bin/python3"
        version = subprocess.check_output([stage / executable, "--version"], text=True).strip()
        # Import from the relocated copy, not the build checkout or the host Python.
        run([stage / executable, "-c", "import app.main; print('LOCAL_RUNTIME_IMPORT_OK')"],
            cwd=backend, env={**os.environ, "PYTHONNOUSERSITE": "1"})
        manifest = {"format": 1, "python": executable, "backend": "backend/local_main.py", "web": "web",
                    "platform": sys.platform, "arch": platform.machine().lower(), "version": version,
                    "commit": os.environ.get("BUILD_COMMIT", "development"),
                    "dependencies_sha256": hashlib.sha256("\n".join(requirements).encode()).hexdigest()}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2))
        if output.exists():
            if not (output / "manifest.json").is_file():
                raise RuntimeError(f"Refusing to replace an unowned output directory: {output}")
            shutil.rmtree(output)
        stage.rename(output)
    print(f"LOCAL_RUNTIME_BUILT {output} ({version}, {platform.machine()})", flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, default=ROOT / "desktop/local-runtime")
    p.add_argument("--frontend", type=Path, default=ROOT / "frontend/dist-local")
    p.add_argument("--cache", type=Path, default=ROOT / "desktop/.python-build")
    p.add_argument("--python-version", default="3.12.16")
    args = p.parse_args()
    build(args.output.resolve(), args.frontend.resolve(), args.cache.resolve(), args.python_version)
