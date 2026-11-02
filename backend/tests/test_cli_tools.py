"""Settings -> Providers -> CLI versions (app/services/cli_tools): version parsing and comparison, the registries'
answers, install-method detection and upgrade-command selection, "when idle", and whole upgrades against fake CLIs
and a fake npm (real npm installs are exercised by hand against a temp prefix: docs/providers.md, "CLI versions")."""

from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path

import pytest

from app.config import settings
from app.services.cli_tools import service as S
from app.services.cli_tools import tools as T
from app.services.cli_tools.versions import (
    Install,
    PlanError,
    capped_argv,
    channel_target,
    compare_versions,
    detect_install,
    is_exact_version,
    is_newer,
    npm_for_prefix,
    parse_changelog,
    parse_dist_tags,
    parse_version,
    plan_upgrade,
    release_bullets,
    split_output,
)

FIX = Path(__file__).parent / "fixtures" / "cli_tools"


# ---- versions -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "out, want",
    [
        ("2.1.309 (Claude Code)", "2.1.309"),
        ("2.1.314 (Claude Code)\n", "2.1.314"),
        ("codex-cli 0.166.0", "0.166.0"),
        ("codex-cli 0.167.0-alpha.3", "0.167.0-alpha.3"),
        ("higgsfield 1.2.2 (53301eadf7311fc6a6a4c024cf4aff432028e974) built 2026-10-16T23:42:35Z", "1.2.2"),
        ("v1.2.3", "1.2.3"),
        ("version 10.20.30.", "10.20.30"),
        ("built 2026-10-16", None),
        ("1.2", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_version(out, want):
    assert parse_version(out) == want


def test_compare_versions_semver_precedence():
    assert compare_versions("2.1.316", "2.1.309") == 1
    assert compare_versions("2.1.309", "2.1.309") == 0
    assert compare_versions("1.10.0", "1.9.9") == 1           # numeric, not lexical
    assert compare_versions("0.167.0-alpha.3", "0.167.0") == -1  # a prerelease is older than its release
    assert compare_versions("0.167.0-alpha.10", "0.167.0-alpha.9") == 1
    assert compare_versions("1.0.0-alpha", "1.0.0-alpha.1") == -1
    assert compare_versions("1.0.0-beta", "1.0.0-alpha.5") == 1


def test_is_newer_only_for_real_newer_versions():
    assert is_newer("2.1.316", "2.1.314")
    assert not is_newer("2.1.309", "2.1.314")  # the stable channel behind the installed one: nothing to do
    assert not is_newer("2.1.314", "2.1.314")
    assert not is_newer("2.1.316", None)        # unknown install: no "update available"
    assert not is_newer(None, "2.1.314")
    assert not is_newer("garbage", "1.0.0")


def test_exact_versions():
    assert is_exact_version("2.1.309") and is_exact_version("v0.167.0-alpha.3")
    assert not is_exact_version("latest") and not is_exact_version("2.1") and not is_exact_version("1.2.3; rm -rf /")


# ---- registries ------------------------------------------------------------------------------------------------


def test_dist_tags_keep_channels_only():
    codex = parse_dist_tags(json.loads((FIX / "dist-tags-codex.json").read_text()))
    assert codex["latest"] == "0.166.0"
    assert codex["alpha"] == "0.167.0-alpha.3"
    assert not any(k.startswith(("release-", "linux", "darwin", "win32", "alpha-")) for k in codex)
    claude = parse_dist_tags(json.loads((FIX / "dist-tags-claude.json").read_text()))
    assert claude == {"stable": "2.1.309", "next": "2.1.316", "latest": "2.1.316"}
    assert channel_target(claude, "stable") == "2.1.309"
    assert channel_target(claude, "nope") == "2.1.316"
    assert parse_dist_tags({"dist-tags": {"latest": "1.2.2"}}) == {"latest": "1.2.2"}  # a packument
    assert parse_dist_tags("nope") == {}


def test_changelog_between_installed_and_target():
    md = (FIX / "claude-changelog.md").read_text()
    secs = parse_changelog(md, "2.1.314", "2.1.316")
    assert [s["version"] for s in secs] == ["2.1.316", "2.1.315"]
    assert secs[0]["count"] == 3 and secs[0]["items"][0].startswith("Added `CLAUDE_CODE_DISABLE_ULTRATHINK`")
    limited = parse_changelog(md, "2.1.309", "2.1.316", limit=4)
    assert [len(s["items"]) for s in limited] == [3, 1, 0]
    assert [s["count"] for s in limited] == [3, 2, 1]
    assert parse_changelog(md, None, "2.1.309") == [{"version": "2.1.309", "items": ["Fixed a crash on resume"], "count": 1}]


def test_release_bullets_drop_pr_refs():
    rel = json.loads((FIX / "release-codex.json").read_text())
    items, count = release_bullets(rel["body"], limit=2)
    assert count == 4
    assert items == [
        "Added keyboard-driven transcript selection with word, line, and page motions.",
        "Rendered Markdown consistently in async questions.",
    ]
    assert release_bullets(None) == ([], 0)
    # codex appends every PR under "## Changelog": not part of the summary
    body = rel["body"] + "\n## Changelog\n\n- #57221 transcript selection\n- #57222 search\n"
    assert release_bullets(body)[1] == 4


# ---- installs and upgrade commands ------------------------------------------------------------------------------


def _access(writable: set[str]):
    return lambda p, mode: any(p == w or p.startswith(w + "/") for w in writable)


def test_detect_install_methods():
    mp = "/home/u/.hr-harnessor/cli"
    # Claude's native installer: ~/.local/bin/claude -> ~/.local/share/claude/versions/2.1.309
    nat = detect_install("@anthropic-ai/claude-code", "/home/u/.local/bin/claude",
                         "/home/u/.local/share/claude/versions/2.1.309", mp, native=True,
                         access=_access({"/home/u/.local"}))
    assert (nat.method, nat.prefix, nat.writable) == ("native", "/home/u/.local/share/claude", True)
    # the image's npm global (Docker): /usr/bin/claude -> /usr/lib/node_modules/…, root-owned
    img = detect_install("@anthropic-ai/claude-code", "/usr/bin/claude",
                         "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", mp, native=True,
                         access=_access(set()))
    assert (img.method, img.prefix, img.writable) == ("npm", "/usr", False)
    # a user npm prefix (higgsfield in ~/.local)
    usr = detect_install("@higgsfield/cli", "/home/u/.local/bin/higgsfield",
                         "/home/u/.local/lib/node_modules/@higgsfield/cli/bin/higgsfield.js", mp,
                         access=_access({"/home/u/.local"}))
    assert (usr.method, usr.prefix, usr.writable) == ("npm", "/home/u/.local", True)
    man = detect_install("@openai/codex", f"{mp}/bin/codex", f"{mp}/lib/node_modules/@openai/codex/bin/codex.js", mp,
                         access=_access({mp}))
    assert (man.method, man.writable) == ("managed", True)
    assert detect_install("@openai/codex", "/opt/homebrew/bin/codex", "/opt/homebrew/Cellar/codex/1/bin/codex",
                          mp).method == "unknown"
    assert detect_install("@openai/codex", None, None, mp).method == "missing"
    # not native for a tool without the native installer
    assert detect_install("@openai/codex", "/x/bin/codex", "/x/share/claude/versions/1", mp).method == "unknown"


def test_plan_upgrade_per_install_method():
    mp = "/home/u/.hr-harnessor/cli"
    pkg = "@anthropic-ai/claude-code"
    native = plan_upgrade(pkg=pkg, install=Install("native", "/home/u/.local/share/claude", True),
                          binary_path="/home/u/.local/bin/claude", version="2.1.316", npm=None, managed_prefix=mp)
    assert native.argv == ["/home/u/.local/bin/claude", "install", "2.1.316"] and native.in_place
    npm = plan_upgrade(pkg="@openai/codex", install=Install("npm", "/home/u/.local", True),
                       binary_path="/home/u/.local/bin/codex", version="0.166.0", npm="/usr/bin/npm", managed_prefix=mp)
    assert npm.argv[:5] == ["/usr/bin/npm", "install", "--global", "--prefix", "/home/u/.local"]
    assert npm.argv[-1] == "@openai/codex@0.166.0" and npm.in_place and not npm.switch_to_managed
    ro = plan_upgrade(pkg=pkg, install=Install("npm", "/usr", False), binary_path="/usr/bin/claude",
                      version="2.1.316", npm="/usr/bin/npm", managed_prefix=mp)
    assert ro.method == "managed" and ro.switch_to_managed and ro.reason == "read_only" and not ro.in_place
    assert ro.argv[4] == mp and ro.argv[-1] == f"{pkg}@2.1.316"
    # a native install this process can't write (another user's HOME) also falls back to the app's own copy
    nat_ro = plan_upgrade(pkg=pkg, install=Install("native", "/x/share/claude", False), binary_path="/x/bin/claude",
                          version="2.1.316", npm="/usr/bin/npm", managed_prefix=mp)
    assert nat_ro.switch_to_managed
    unk = plan_upgrade(pkg="@openai/codex", install=Install("unknown"), binary_path="/opt/x/codex",
                       version="1.0.0", npm="/usr/bin/npm", managed_prefix=mp)
    assert unk.reason == "unknown_install" and unk.switch_to_managed
    missing = plan_upgrade(pkg="@higgsfield/cli", install=Install("missing"), binary_path=None, version="1.2.2",
                           npm="/usr/bin/npm", managed_prefix=mp)
    assert missing.reason == "missing"  # "Install" puts the app's own copy in place
    with pytest.raises(PlanError) as e:
        plan_upgrade(pkg="@openai/codex", install=Install("npm", "/usr", False), binary_path="/usr/bin/codex",
                     version="1.0.0", npm=None, managed_prefix=mp)
    assert e.value.code == "npm_missing"


def test_npm_for_prefix_prefers_the_prefix_own_npm():
    nvm = "/home/u/.nvm/versions/node/v24.21.0"
    assert npm_for_prefix(nvm, lambda n: "/usr/bin/npm", lambda p: p == f"{nvm}/bin/npm") == f"{nvm}/bin/npm"
    assert npm_for_prefix("/usr", lambda n: "/usr/bin/npm", lambda p: False) == "/usr/bin/npm"
    assert npm_for_prefix(None, lambda n: None, lambda p: True) is None


def test_capped_and_output_splitting():
    assert capped_argv(["npm", "i"], "/home/u/.local/bin/capped", "3G") == ["/home/u/.local/bin/capped", "-m", "3G", "--", "npm", "i"]
    assert capped_argv(["npm", "i"], None, "3G") == ["npm", "i"]
    lines, rest = split_output("\x1b[32mone\x1b[0m\r\ntwo\r 50%\r100%\nhalf")
    assert lines == ["one", "two", " 50%", "100%"] and rest == "half"


# ---- "when idle" -------------------------------------------------------------------------------------------------


async def test_wait_until_idle_wakes_on_turn_end_and_settles():
    running = {"n": 2}
    evt = asyncio.Event()
    seen: list[int] = []

    async def finish() -> None:
        for _ in range(2):
            await asyncio.sleep(0.05)
            running["n"] -= 1
            evt.set()

    t = asyncio.create_task(finish())
    await asyncio.wait_for(S.wait_until_idle(lambda: running["n"], evt, recheck_s=5, settle_s=0.05,
                                             on_wait=seen.append), timeout=3)
    await t
    assert running["n"] == 0 and seen[0] == 2


async def test_wait_until_idle_rechecks_without_a_signal():
    running = {"n": 1}

    async def finish() -> None:
        await asyncio.sleep(0.05)
        running["n"] = 0  # e.g. a run ended without a turn-end callback

    t = asyncio.create_task(finish())
    await asyncio.wait_for(S.wait_until_idle(lambda: running["n"], asyncio.Event(), recheck_s=0.05, settle_s=0),
                           timeout=3)
    await t


# ---- the service, end to end with fake CLIs and a fake npm ----------------------------------------------------

FAKE_NPM = r"""#!/bin/sh
# fake npm: install --global --prefix P … <pkg>@<version>  (writes a CLI that prints "$FAKE_NAME <version>")
prefix=""; spec=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    install|-*) shift ;;
    *) spec="$1"; shift ;;
  esac
done
pkg="${spec%@*}"; ver="${spec##*@}"
echo "npm http fetch GET 200 https://registry.npmjs.org/$pkg 12ms"
if [ -n "$FAKE_NPM_FAIL" ]; then echo "npm ERR! code E404"; exit 1; fi
d="$prefix/lib/node_modules/$pkg/bin"; mkdir -p "$d" "$prefix/bin"
printf '#!/bin/sh\necho "%s %s"\n' "$FAKE_NAME" "${FAKE_VER:-$ver}" > "$d/cli"; chmod +x "$d/cli"
ln -sf "$d/cli" "$prefix/bin/$FAKE_BIN"
printf 'added 1 package in 0.1s\r\n'
"""


def _exe(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _npm_cli(prefix: Path, pkg: str, bin_name: str, out: str) -> Path:
    """An npm-style install: <prefix>/bin/<bin> -> <prefix>/lib/node_modules/<pkg>/bin/cli."""
    real = _exe(prefix / "lib" / "node_modules" / pkg / "bin" / "cli", f'#!/bin/sh\necho "{out}"\n')
    (prefix / "bin").mkdir(parents=True, exist_ok=True)
    link = prefix / "bin" / bin_name
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(real)
    return link


class FakeSessions:
    def __init__(self) -> None:
        self.active_runs: dict[str, dict] = {}
        self.listeners: list = []
        self.msgs: list[dict] = []
        self.retired = 0

    def add_turn_end_listener(self, cb) -> None:
        self.listeners.append(cb)

    def broadcast_list(self, msg: dict) -> None:
        self.msgs.append(msg)

    def engines(self) -> list[dict]:
        return []

    async def retire_engines(self) -> dict:
        self.retired += 1
        return {"restarted": 1, "deferred": 0}

    def end_turn(self, sid: str) -> None:
        self.active_runs.pop(sid, None)
        for cb in self.listeners:
            cb(sid, {"status": "ok"})


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(settings, "cli_managed_prefix", str(home / ".hr-harnessor" / "cli"))
    monkeypatch.setattr(settings, "cli_update_check", True)
    monkeypatch.setattr(S, "capped_path", lambda: None)
    monkeypatch.setattr(S, "IDLE_SETTLE_S", 0.05)
    T.reset_state_cache()
    fakebin = tmp_path / "fakebin"
    _exe(fakebin / "npm", FAKE_NPM)
    monkeypatch.setenv("PATH", f"{fakebin}:{os.environ.get('PATH', '/usr/bin:/bin')}")
    tags = {
        "@anthropic-ai/claude-code": json.loads((FIX / "dist-tags-claude.json").read_text()),
        "@openai/codex": json.loads((FIX / "dist-tags-codex.json").read_text()),
        "@higgsfield/cli": {"latest": "1.2.2"},
    }
    calls: list[str] = []

    async def get_json(url, headers=None):
        calls.append(url)
        if "api.github.com" in url:
            return json.loads((FIX / "release-codex.json").read_text())
        for pkg, t in tags.items():
            if f"/-/package/{pkg}/dist-tags" in url:
                return t
        raise OSError("unexpected " + url)

    async def get_text(url, headers=None, max_bytes=0):
        calls.append(url)
        return (FIX / "claude-changelog.md").read_text()

    sessions = FakeSessions()
    svc = S.CliToolsService(sessions, get_json=get_json, get_text=get_text)
    yield {"tmp": tmp_path, "home": home, "svc": svc, "sessions": sessions, "calls": calls,
           "monkeypatch": monkeypatch, "fakebin": fakebin}
    T.reset_state_cache()


def _use(monkeypatch, tool: str, path: Path | str) -> None:
    if T.TOOLS[tool].setting in type(settings).model_fields:
        monkeypatch.setattr(settings, T.TOOLS[tool].setting, str(path))
    monkeypatch.setenv(T.TOOLS[tool].env, str(path))


async def _done(svc: S.CliToolsService, timeout: float = 10) -> None:
    async def wait() -> None:
        while svc._job is not None:
            await asyncio.sleep(0.02)

    await asyncio.wait_for(wait(), timeout)


def _tool(st: dict, tool: str) -> dict:
    return next(t for t in st["tools"] if t["id"] == tool)


async def test_status_and_in_place_npm_upgrade(env):
    mp, tmp, svc = env["monkeypatch"], env["tmp"], env["svc"]
    prefix = tmp / "npm-prefix"
    _use(mp, "codex", _npm_cli(prefix, "@openai/codex", "codex", "codex-cli 0.160.0"))
    _exe(prefix / "bin" / "npm", FAKE_NPM)  # the prefix's own npm is the one used
    mp.setenv("FAKE_NAME", "codex-cli")
    mp.setenv("FAKE_BIN", "codex")
    await svc.check("codex")
    st = _tool(await svc.status(), "codex")
    assert st["installed"]["version"] == "0.160.0" and st["installed"]["method"] == "npm"
    assert st["installed"]["writable"] and st["latest"]["version"] == "0.166.0" and st["update_available"]
    assert st["upgrade"]["in_place"] and st["upgrade"]["command"].startswith(str(prefix / "bin" / "npm"))
    assert st["notes"]["sections"][0]["items"][0].startswith("Added keyboard-driven")
    job = await svc.upgrade("codex")
    assert job["target"] == "0.166.0" and job["from_version"] == "0.160.0"
    await _done(svc)
    st = _tool(await svc.status(), "codex")
    assert st["job"]["state"] == "succeeded", st["job"]
    assert st["installed"]["version"] == "0.166.0" and not st["update_available"]
    assert st["previous_version"] == "0.160.0" and not st["using_managed"]
    log = st["job"]["log"]
    assert any(ln.startswith("$ ") and "@openai/codex@0.166.0" in ln for ln in log)
    assert "added 1 package in 0.1s" in log and any("--version → codex-cli 0.166.0" in ln for ln in log)
    pushed = [m for m in env["sessions"].msgs if m["type"] == "cli.log"]
    assert pushed and pushed[0]["data"]["start"] == 0
    assert any(m["type"] == "cli.changed" for m in env["sessions"].msgs)
    # roll back = pin the previous version (cleanly supported by npm)
    await svc.upgrade("codex", version="0.160.0")
    await _done(svc)
    st = _tool(await svc.status(), "codex")
    assert st["job"]["reason"] == "pin" and st["job"]["state"] == "succeeded"
    assert st["installed"]["version"] == "0.160.0" and st["previous_version"] == "0.166.0"


async def test_read_only_install_switches_to_the_managed_copy(env):
    mp, tmp, svc = env["monkeypatch"], env["tmp"], env["svc"]
    prefix = tmp / "image-usr"
    link = _npm_cli(prefix, "@anthropic-ai/claude-code", "claude", "2.1.314 (Claude Code)")
    _use(mp, "claude", link)
    os.chmod(prefix / "lib" / "node_modules", 0o555)  # like the image's root-owned /usr/lib/node_modules
    mp.setenv("FAKE_NAME", "")
    mp.setenv("FAKE_BIN", "claude")
    try:
        await svc.check("claude")
        st = _tool(await svc.status(), "claude")
        assert st["installed"]["method"] == "npm" and not st["installed"]["writable"]
        assert st["channel"] == "latest" and st["latest"]["version"] == "2.1.316" and st["update_available"]
        assert st["upgrade"]["switch_to_managed"] and st["upgrade"]["reason"] == "read_only"
        assert [s["version"] for s in st["notes"]["sections"]] == ["2.1.316", "2.1.315"]
        await svc.upgrade("claude")
        await _done(svc)
        st = _tool(await svc.status(), "claude")
        assert st["job"]["state"] == "succeeded", st["job"]
        assert st["using_managed"] and T.effective_binary("claude") == T.managed_binary("claude")
        assert st["installed"]["version"] == "2.1.316" and st["installed"]["method"] == "managed"
        assert st["bundled"]["version"] == "2.1.314"  # the image's copy, offered back ("Use bundled copy")
        assert env["sessions"].retired == 1 and st["job"]["result"]["engines"] == {"restarted": 1, "deferred": 0}
        # the Claude provider launches the managed copy from now on
        from app.providers.claude_code import ClaudeCodeProvider

        assert ClaudeCodeProvider()._binary == T.managed_binary("claude")
        svc.update_settings("claude", use_managed=False)
        assert T.effective_binary("claude") == str(link) and env["sessions"].retired >= 1
        # the stable channel is behind the installed copy: no update to offer
        svc.update_settings("claude", channel="stable")
        st = _tool(await svc.status(), "claude")
        assert st["latest"]["version"] == "2.1.309" and not st["update_available"]
    finally:
        os.chmod(prefix / "lib" / "node_modules", 0o755)


async def test_failures_are_reported_and_nothing_switches(env):
    mp, tmp, svc = env["monkeypatch"], env["tmp"], env["svc"]
    _use(mp, "higgsfield", _exe(tmp / "opt" / "higgsfield",
                                '#!/bin/sh\necho "higgsfield 1.2.1 (abc) built 2026-10-01T00:00:00Z"\n'))
    mp.setenv("FAKE_NAME", "higgsfield")
    mp.setenv("FAKE_BIN", "higgsfield")
    await svc.check("higgsfield")
    st = _tool(await svc.status(), "higgsfield")
    assert st["installed"]["method"] == "unknown" and st["upgrade"]["reason"] == "unknown_install"
    mp.setenv("FAKE_NPM_FAIL", "1")
    await svc.upgrade("higgsfield")
    await _done(svc)
    st = _tool(await svc.status(), "higgsfield")
    assert st["job"]["state"] == "failed" and st["job"]["error_code"] == "exit_code"
    assert "npm ERR! code E404" in st["job"]["log"] and not st["using_managed"]
    # the updater "succeeds" but the version didn't change → not a success
    mp.delenv("FAKE_NPM_FAIL")
    mp.setenv("FAKE_VER", "1.2.1")
    await svc.upgrade("higgsfield")
    await _done(svc)
    st = _tool(await svc.status(), "higgsfield")
    assert st["job"]["state"] == "failed" and st["job"]["error_code"] == "verify_failed"
    assert not st["using_managed"] and st["installed"]["version"] == "1.2.1"


async def test_upgrade_when_idle_waits_for_running_chats(env):
    mp, tmp, svc, sessions = env["monkeypatch"], env["tmp"], env["svc"], env["sessions"]
    prefix = tmp / "p"
    _use(mp, "codex", _npm_cli(prefix, "@openai/codex", "codex", "codex-cli 0.160.0"))
    mp.setenv("FAKE_NAME", "codex-cli")
    mp.setenv("FAKE_BIN", "codex")
    sessions.active_runs = {"s1": {}, "s2": {}}
    job = await svc.upgrade("codex", when="idle")
    await asyncio.sleep(0.1)
    st = _tool(await svc.status(), "codex")
    assert st["job"]["state"] == "waiting" and st["job"]["waiting_for"] == 2
    assert (await svc.status())["running_chats"] == 2
    with pytest.raises(S.UpgradeError) as busy:
        await svc.upgrade("higgsfield")
    assert busy.value.code == "busy" and busy.value.status == 409
    sessions.end_turn("s1")
    await asyncio.sleep(0.1)
    assert _tool(await svc.status(), "codex")["job"]["waiting_for"] == 1
    sessions.end_turn("s2")
    await _done(svc)
    st = _tool(await svc.status(), "codex")
    assert st["job"]["id"] == job["id"] and st["job"]["state"] == "succeeded"
    assert st["job"]["log"][0].startswith("waiting for 2 running chat")


async def test_cancel_a_waiting_upgrade_and_input_checks(env):
    mp, tmp, svc, sessions = env["monkeypatch"], env["tmp"], env["svc"], env["sessions"]
    _use(mp, "codex", _npm_cli(tmp / "p", "@openai/codex", "codex", "codex-cli 0.166.0"))
    with pytest.raises(S.UpgradeError) as up:
        await svc.upgrade("codex")
    assert up.value.code == "up_to_date"
    with pytest.raises(S.UpgradeError) as bad:
        await svc.upgrade("codex", version="1.2; rm -rf /")
    assert bad.value.code == "invalid_version"
    sessions.active_runs = {"s1": {}}
    await svc.upgrade("codex", version="0.165.0", when="idle")
    await asyncio.sleep(0.05)
    out = await svc.cancel("codex")
    assert out["state"] == "cancelled" and svc._job is None
    with pytest.raises(S.UpgradeError):
        await svc.cancel("codex")
    with pytest.raises(S.UpgradeError) as ch:
        svc.update_settings("codex", channel="stable")
    assert ch.value.code == "invalid_channel"


async def test_missing_cli_can_be_installed_and_auto_upgrade(env):
    mp, svc, sessions = env["monkeypatch"], env["svc"], env["sessions"]
    import dataclasses

    _use(mp, "higgsfield", "higgsfield-not-installed-here")
    mp.setitem(T.TOOLS, "higgsfield", dataclasses.replace(T.TOOLS["higgsfield"], fallbacks=()))
    mp.setenv("FAKE_NAME", "higgsfield")
    mp.setenv("FAKE_BIN", "higgsfield")
    await svc.check("higgsfield")
    st = _tool(await svc.status(), "higgsfield")
    assert st["installed"]["path"] is None and st["installed"]["method"] == "missing"
    assert st["upgrade"]["reason"] == "missing" and not st["update_available"]
    await svc.upgrade("higgsfield")  # "Install": the app's own copy
    await _done(svc)
    st = _tool(await svc.status(), "higgsfield")
    assert st["job"]["state"] == "succeeded" and st["using_managed"] and st["installed"]["version"] == "1.2.2"
    # auto-upgrade: opt-in, runs "when idle", never repeats a failed target
    _use(mp, "codex", _npm_cli(env["tmp"] / "p", "@openai/codex", "codex", "codex-cli 0.160.0"))
    mp.setenv("FAKE_NAME", "codex-cli")
    mp.setenv("FAKE_BIN", "codex")
    await svc.check("codex")
    await svc._auto_upgrade()
    assert svc._job is None  # off by default
    svc.update_settings("codex", auto_upgrade=True)
    sessions.active_runs = {"s1": {}}
    await svc._auto_upgrade()
    assert svc._job is not None and svc._job.reason == "auto" and svc._job.when == "idle"
    await asyncio.sleep(0.05)
    assert svc._job.state == "waiting"
    sessions.end_turn("s1")
    await _done(svc)
    assert _tool(await svc.status(), "codex")["installed"]["version"] == "0.166.0"


async def test_claude_self_update_status(env):
    home = env["home"]
    svc = env["svc"]
    native = {"method": "native", "writable": True}
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text(json.dumps({"autoUpdatesChannel": "stable"}))
    (home / ".claude.json").write_text(json.dumps({"autoUpdates": False, "autoUpdatesProtectedForNative": True}))
    assert svc._self_update("claude", native) == {"enabled": True, "source": "default", "channel": "stable"}
    assert svc._self_update("claude", {"method": "npm", "writable": True})["source"] == "global_config"
    assert svc._self_update("claude", {"method": "npm", "writable": False})["source"] == "read_only"
    (home / ".claude" / "settings.json").write_text(json.dumps({"env": {"DISABLE_AUTOUPDATER": "1"}}))
    assert svc._self_update("claude", native)["source"] == "settings_env"
    assert svc._self_update("codex", native) is None
    assert svc._channel("claude") == "latest"


def test_router_lists_three_clis(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        r = c.post("/api/auth/login", json={"username": "admin", "password": "test-pass"})
        assert r.status_code == 200
        st = c.get("/api/cli-tools").json()
        assert [t["id"] for t in st["tools"]] == ["claude", "codex", "higgsfield"]
        assert st["check_enabled"] is False  # tests: no outbound lookups
        r = c.post("/api/cli-tools/nope/upgrade", json={})
        assert r.status_code == 404
        r = c.put("/api/cli-tools/claude", json={"channel": "nightly"})
        assert r.status_code == 400 and r.json()["code"] == "invalid_channel"
