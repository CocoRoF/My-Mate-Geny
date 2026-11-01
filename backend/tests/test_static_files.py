"""The web console's cache headers (app/static_files.py) and the frontend swap script (deploy/swap-frontend.sh)."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.static_files import ASSET_CACHE, HTML_CACHE, MISSING_CACHE, ConsoleStaticFiles, cache_control_for, index_response

REPO = Path(__file__).resolve().parents[2]
SWAP = REPO / "deploy" / "swap-frontend.sh"


def make_build(root: Path, name: str, files: dict[str, str]) -> Path:
    d = root / name
    (d / "assets").mkdir(parents=True)
    for rel, body in files.items():
        (d / rel).write_text(body)
    return d


def client_for(static: Path) -> TestClient:
    app = FastAPI()

    @app.get("/")
    async def _index():
        return index_response(static)

    app.mount("/", ConsoleStaticFiles(directory=str(static), html=True), name="static")
    return TestClient(app)


def test_cache_control_rules():
    assert cache_control_for("assets/index-abc.js", 200) == ASSET_CACHE
    assert cache_control_for("index.html", 200) == HTML_CACHE
    assert cache_control_for("", 200) == HTML_CACHE
    assert cache_control_for("manifest.webmanifest", 200) == HTML_CACHE
    assert cache_control_for("assets/gone.js", 404) == MISSING_CACHE
    assert "immutable" in ASSET_CACHE and "no-cache" in HTML_CACHE


def test_headers_served(tmp_path: Path):
    static = make_build(tmp_path, "dist", {"index.html": "<html>A</html>", "assets/index-a1.js": "1", "logo.png": "x"})
    c = client_for(static)
    r = c.get("/")
    assert r.status_code == 200 and r.text == "<html>A</html>"
    assert r.headers["cache-control"] == HTML_CACHE
    r = c.get("/?surface=mate-chat&mate=x")
    assert r.headers["cache-control"] == HTML_CACHE
    r = c.get("/index.html")
    assert r.headers["cache-control"] == HTML_CACHE
    r = c.get("/assets/index-a1.js")
    assert r.status_code == 200 and r.headers["cache-control"] == ASSET_CACHE
    assert c.get("/logo.png").headers["cache-control"] == HTML_CACHE
    # a revalidation of an unchanged asset: 304
    etag = r.headers["etag"]
    assert c.get("/assets/index-a1.js", headers={"if-none-match": etag}).status_code == 304
    r = c.get("/assets/index-gone.js")
    assert r.status_code == 404 and r.headers["cache-control"] == MISSING_CACHE


def test_index_missing_mid_swap_is_a_retry_page(tmp_path: Path):
    static = tmp_path / "dist"
    static.mkdir()
    r = client_for(static).get("/")
    assert r.status_code == 503
    assert r.headers["cache-control"] == MISSING_CACHE
    assert "location.reload" in r.text


# ── deploy/swap-frontend.sh ──


def run_swap(frontend: Path, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(SWAP), *args, str(frontend)], capture_output=True, text=True,
                          env={**os.environ, **(env or {})}, timeout=60)


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_swap_keeps_previous_assets_and_prunes_old_ones(tmp_path: Path):
    fe = tmp_path / "frontend"
    fe.mkdir()
    make_build(fe, "dist", {"index.html": "A", "assets/index-a.js": "a", "assets/View-a.js": "va", "assets/shared-s.js": "s"})
    make_build(fe, "dist-next", {"index.html": "B <script src=/assets/index-b.js>", "assets/index-b.js": "b",
                                 "assets/View-b.js": "vb", "assets/shared-s.js": "s2"})
    r = run_swap(fe)
    assert r.returncode == 0, r.stderr + r.stdout
    dist = fe / "dist"
    assert (dist / "index.html").read_text().startswith("B")
    names = sorted(p.name for p in (dist / "assets").iterdir())
    # the new build + the previous build's files a page still open on it may ask for
    assert names == ["View-a.js", "View-b.js", "index-a.js", "index-b.js", "shared-s.js"]
    # a file both builds have keeps the NEW content
    assert (dist / "assets" / "shared-s.js").read_text() == "s2"
    assert not (fe / "dist-next").exists() and not (fe / "dist-old").exists()
    ledger = (fe / ".dist-retired.tsv").read_text()
    assert "index-a.js" in ledger and "View-a.js" in ledger and "index-b.js" not in ledger

    # a third build: A's files are carried again (still within the keep time) …
    make_build(fe, "dist-next", {"index.html": "C", "assets/index-c.js": "c"})
    assert run_swap(fe).returncode == 0
    names = sorted(p.name for p in (dist / "assets").iterdir())
    assert names == ["View-a.js", "View-b.js", "index-a.js", "index-b.js", "index-c.js", "shared-s.js"]

    # … and dropped once they were retired longer ago than --keep-days
    old = time.time() - 9 * 86400
    lines = [ln.split("\t") for ln in (fe / ".dist-retired.tsv").read_text().splitlines() if ln]
    (fe / ".dist-retired.tsv").write_text("".join(f"{n}\t{int(old) if n.endswith('-a.js') else t}\n" for n, t in lines))
    make_build(fe, "dist-next", {"index.html": "D", "assets/index-d.js": "d"})
    r = run_swap(fe, "--keep-days", "7")
    assert r.returncode == 0, r.stderr
    names = sorted(p.name for p in (dist / "assets").iterdir())
    assert "index-a.js" not in names and "View-a.js" not in names
    assert {"index-b.js", "index-c.js", "index-d.js", "View-b.js", "shared-s.js"} <= set(names)


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_swap_refuses_a_broken_build(tmp_path: Path):
    fe = tmp_path / "frontend"
    fe.mkdir()
    make_build(fe, "dist", {"index.html": "A", "assets/index-a.js": "a"})
    (fe / "dist-next" / "assets").mkdir(parents=True)  # no index.html
    r = run_swap(fe)
    assert r.returncode != 0
    assert (fe / "dist" / "index.html").read_text() == "A"
    # an index.html naming an asset the build does not have
    (fe / "dist-next" / "index.html").write_text('<script type="module" src="/assets/index-zz.js"></script>')
    r = run_swap(fe)
    assert r.returncode != 0 and "index-zz.js" in (r.stderr + r.stdout)
    assert (fe / "dist" / "index.html").read_text() == "A"
