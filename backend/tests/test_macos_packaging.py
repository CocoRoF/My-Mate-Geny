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


def test_feed_puts_a_signed_builds_zips_first_for_the_updater(tmp_path):
    mod = module()
    for arch in ("arm64", "x64"):
        (tmp_path / f"my-mate-geny-0.4.99-macos-{arch}.dmg").write_bytes(arch.encode())
        (tmp_path / f"my-mate-geny-0.4.99-macos-{arch}.zip").write_bytes(b"zip" + arch.encode())
    lines = mod.write_feed(tmp_path, "0.4.99").read_text().splitlines()
    urls = [ln.split('"')[1] for ln in lines if "url:" in ln]
    assert urls == [f"my-mate-geny-0.4.99-macos-{a}.{e}" for e in ("zip", "dmg") for a in ("arm64", "x64")]
    assert next(ln for ln in lines if ln.startswith("path:")).endswith('arm64.zip"')


def signer():
    file = Path(__file__).resolve().parents[2] / "desktop/build/macos-sign.py"
    spec = importlib.util.spec_from_file_location("macos_sign", file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_every_binary_is_found_by_what_it_is_and_signed_from_the_inside_out(tmp_path):
    mod = signer()
    macho = bytes.fromhex("cffaedfe07000001")
    app = tmp_path / "My Mate Geny.app"

    def put(rel, data=macho):
        path = app / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    main = put("Contents/MacOS/My Mate Geny")
    framework_main = put("Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework")
    dylib = put("Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib")
    helper_main = put("Contents/Frameworks/My Mate Geny Helper.app/Contents/MacOS/My Mate Geny Helper")
    module_so = put("Contents/Resources/local-runtime/python/lib/python3.12/lib-dynload/_ssl.cpython-312-darwin.so")
    python = put("Contents/Resources/local-runtime/python/bin/python3.12")
    no_suffix = put("Contents/Resources/local-runtime/python/lib/python3.12/site-packages/x/tool")
    fat = put("Contents/Resources/fat", bytes.fromhex("cafebabe00000002"))
    put("Contents/Resources/Foo.class", bytes.fromhex("cafebabe00000041"))  # (a Java class: the same magic, not a binary)
    put("Contents/Resources/local-runtime/python/lib/python3.12/os.py", b"import sys\n")
    (app / "Contents/Resources/local-runtime/python/bin/python3").symlink_to("python3.12")
    (app / "Contents/Frameworks/Electron Framework.framework/Electron Framework").symlink_to(
        "Versions/A/Electron Framework")

    loose, bundles = mod.signing_order(app)
    assert set(loose) == {dylib, module_so, python, no_suffix, fat}
    assert not {main, framework_main, helper_main} & set(loose)  # (signed with their bundles)
    assert {b.name for b in bundles} == {"My Mate Geny Helper.app", "Electron Framework.framework"}
    assert [len(p.parts) for p in loose] == sorted((len(p.parts) for p in loose), reverse=True)
