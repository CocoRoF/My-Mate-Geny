"""The native packaging contract is checkable without pretending Linux is macOS."""

import importlib.util
from pathlib import Path

import pytest


def module():
    file = Path(__file__).resolve().parents[2] / "desktop/build/macos-dmg.py"
    spec = importlib.util.spec_from_file_location("macos_dmg", file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_dmg_stages_the_app_and_applications_without_mounting(tmp_path, monkeypatch):
    mod = module()
    monkeypatch.setattr(mod.sys, "platform", "darwin")
    app = tmp_path / "mac-arm64/My Mate Geny.app"
    binary = app / "Contents/MacOS/My Mate Geny"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"app")
    (app / "Contents/Current").symlink_to("MacOS", target_is_directory=True)
    calls = []

    def run(argv, **kw):
        calls.append(argv)
        assert kw["check"] is True
        if argv[1] == "create":
            stage = Path(argv[argv.index("-srcfolder") + 1])
            assert (stage / app.name / "Contents/MacOS/My Mate Geny").read_bytes() == b"app"
            assert (stage / app.name / "Contents/Current").is_symlink()
            assert (stage / "Applications").readlink() == Path("/Applications")
            Path(argv[-1]).write_bytes(b"dmg")

    monkeypatch.setattr(mod.subprocess, "run", run)
    result = mod.build(tmp_path, "0.4.99", "arm64")
    assert result.name == "my-mate-geny-0.4.99-macos-arm64.dmg"
    assert [c[1] for c in calls] == ["create", "verify"]
    assert not list(tmp_path.glob(".dmg-stage-*"))
    assert binary.read_bytes() == b"app"


def test_feed_covers_both_architectures_with_real_hashes(tmp_path):
    mod = module()
    for arch in ("arm64", "x64"):
        (tmp_path / f"my-mate-geny-0.4.99-macos-{arch}.dmg").write_bytes(arch.encode())
    feed = mod.write_feed(tmp_path, "0.4.99").read_text()
    for arch in ("arm64", "x64"):
        file = tmp_path / f"my-mate-geny-0.4.99-macos-{arch}.dmg"
        assert file.name in feed and mod.digest(file) in feed
    with pytest.raises(RuntimeError):
        mod.write_feed(tmp_path, "0.4.98")
