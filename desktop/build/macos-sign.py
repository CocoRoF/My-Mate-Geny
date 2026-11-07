#!/usr/bin/env python3
"""Developer ID signing and notarization of the macOS app, so Gatekeeper opens it and it can update itself.

    macos-sign.py app --version 0.4.80 --arch arm64    sign, try it, notarize, staple the .app; zip it for the updater
    macos-sign.py dmg --version 0.4.80 --arch arm64    sign, notarize, staple the .dmg made from it

Signed by hand instead of by electron-builder: the app carries a whole Python runtime, whose extension modules (*.so)
the Electron signing tools don't recognize, and notarization refuses a single unsigned binary. Everything is found by what
the file is (its Mach-O header), not by its name.

Needs (only in the release workflow): MAC_CSC_LINK (a .p12, base64), MAC_CSC_KEY_PASSWORD, APPLE_API_KEY_B64 (a .p8,
base64), APPLE_API_KEY_ID, APPLE_API_ISSUER. No secret is ever printed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTITLEMENTS = HERE / "entitlements.mac.plist"
APP_NAME = "My Mate Geny.app"
BUNDLES = (".app", ".framework", ".xpc", ".appex")
_THIN = {0xFEEDFACE, 0xFEEDFACF, 0xCEFAEDFE, 0xCFFAEDFE}
_FAT = {0xCAFEBABE, 0xBEBAFECA, 0xCAFEBABF, 0xBFBAFECA}
#: signing one file asks Apple's time server: a few at a time, and it does say no now and then
PARALLEL = 8
TRIES = 4


def is_macho(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            head = f.read(8)
    except OSError:
        return False
    if len(head) < 8:
        return False
    magic = int.from_bytes(head[:4], "big")
    if magic in _THIN:
        return True
    # (a Java class starts the same way as a universal binary, whose next word is a small number of architectures)
    return magic in _FAT and int.from_bytes(head[4:8], "big") < 32


def _depth(path: Path) -> int:
    return len(path.parts)


def signing_order(app: Path) -> tuple[list[Path], list[Path]]:
    """-> (loose binaries, nested bundles), each deepest first: what is inside has to be signed before what holds it. A
    bundle's own executable is signed with the bundle, and the app itself comes last, by the caller."""
    bundles: list[Path] = []
    mains: set[Path] = set()
    loose: list[Path] = []
    for root, dirs, files in os.walk(app, followlinks=False):
        here = Path(root)
        for name in dirs:
            path = here / name
            if path.is_symlink() or not name.endswith(BUNDLES):
                continue
            bundles.append(path)
        for name in files:
            path = here / name
            if not path.is_symlink() and is_macho(path):
                loose.append(path)
    for bundle in [app, *bundles]:
        name = bundle.stem
        mains.update({bundle / "Contents/MacOS" / name, bundle / "Versions/A" / name, bundle / name})
    return (
        sorted((p for p in loose if p not in mains), key=_depth, reverse=True),
        sorted(bundles, key=_depth, reverse=True),
    )


def run(*cmd: object, **kw) -> subprocess.CompletedProcess:
    return subprocess.run([str(c) for c in cmd], check=True, text=True, **kw)


def precompile(app: Path) -> None:
    """A signed bundle must never change, and Python writes __pycache__ next to what it imports: every process, also the
    bridges it starts with -I, which no environment variable reaches. So all the bytecode goes in before signing, valid
    wherever the app is copied to (no mtime check), and nothing is left to write. (Packaging drops any that is there
    earlier. A few test files of the standard library don't compile: fine.)"""
    runtime = app / "Contents/Resources/local-runtime"
    subprocess.run([str(runtime / "python/bin/python3"), "-I", "-m", "compileall", "-q", "-f", "--invalidation-mode",
                    "unchecked-hash", str(runtime / "backend"), str(runtime / "python/lib")], check=False,
                   stdout=subprocess.DEVNULL)
    count = sum(1 for _ in runtime.rglob("*.pyc"))
    if count < 1000:
        raise SystemExit(f"Only {count} compiled modules in the runtime")
    print(f"PRECOMPILED {count} modules", flush=True)


def need(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"{name} is not set")
    return value


class Signer:
    """A keychain of its own for this run, gone at the end: nothing stays on the machine."""

    def __enter__(self) -> "Signer":
        self.dir = Path(tempfile.mkdtemp(prefix="mac-sign-"))
        self.keychain = self.dir / "signing.keychain-db"
        password = secrets.token_urlsafe(24)
        p12 = self.dir / "cert.p12"
        p12.write_bytes(base64.b64decode(need("MAC_CSC_LINK")))
        p12.chmod(0o600)
        self.old = subprocess.run(["security", "list-keychains", "-d", "user"], check=True, text=True,
                                  capture_output=True).stdout.replace('"', "").split()
        run("security", "create-keychain", "-p", password, self.keychain)
        run("security", "set-keychain-settings", "-lut", 21600, self.keychain)
        run("security", "unlock-keychain", "-p", password, self.keychain)
        run("security", "import", p12, "-k", self.keychain, "-P", need("MAC_CSC_KEY_PASSWORD"), "-f", "pkcs12",
            "-T", "/usr/bin/codesign", "-T", "/usr/bin/security", stdout=subprocess.DEVNULL)
        run("security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, self.keychain,
            stdout=subprocess.DEVNULL)
        run("security", "list-keychains", "-d", "user", "-s", self.keychain, *self.old)
        found = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning", str(self.keychain)], check=True,
                               text=True, capture_output=True).stdout
        line = next((ln for ln in found.splitlines() if "Developer ID Application" in ln), "")
        if not line:
            raise SystemExit("No Developer ID Application identity in the certificate")
        self.identity = line.split()[1]  # (its hash: a name could be ambiguous)
        print("IDENTITY", line.split('"')[1], flush=True)
        key = self.dir / "AuthKey.p8"
        key.write_bytes(base64.b64decode(need("APPLE_API_KEY_B64")))
        key.chmod(0o600)
        self.notary = ["--key", str(key), "--key-id", need("APPLE_API_KEY_ID"), "--issuer", need("APPLE_API_ISSUER")]
        return self

    def __exit__(self, *_exc) -> None:
        subprocess.run(["security", "list-keychains", "-d", "user", "-s", *self.old], check=False)
        subprocess.run(["security", "delete-keychain", str(self.keychain)], check=False, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)

    def sign(self, path: Path, *, entitlements: bool = True) -> None:
        cmd = ["codesign", "--force", "--timestamp", "--options", "runtime", "--keychain", str(self.keychain),
               "--sign", self.identity]
        if entitlements:
            cmd += ["--entitlements", str(ENTITLEMENTS)]
        for attempt in range(TRIES):
            done = subprocess.run([*cmd, str(path)], text=True, capture_output=True)
            if done.returncode == 0:
                return
            if attempt == TRIES - 1:
                raise SystemExit(f"codesign failed on {path}:\n{done.stderr}")

    def sign_app(self, app: Path) -> None:
        loose, bundles = signing_order(app)
        print(f"SIGNING {len(loose)} binaries, {len(bundles)} bundles", flush=True)
        with ThreadPoolExecutor(PARALLEL) as pool:
            list(pool.map(self.sign, loose))
        for bundle in bundles:
            self.sign(bundle)
        self.sign(app)
        run("codesign", "--verify", "--deep", "--strict", "--verbose=1", app)

    def notarize(self, path: Path) -> None:
        print(f"NOTARIZING {path.name}", flush=True)
        done = subprocess.run(["xcrun", "notarytool", "submit", str(path), *self.notary, "--wait", "--timeout", "2h",
                               "--output-format", "json"], text=True, capture_output=True)
        try:
            result = json.loads(done.stdout)
        except ValueError:
            raise SystemExit(f"notarytool failed:\n{done.stdout}\n{done.stderr}") from None
        status, sub = result.get("status"), result.get("id")
        print("NOTARY", status, sub, flush=True)
        if status != "Accepted":
            log = subprocess.run(["xcrun", "notarytool", "log", str(sub), *self.notary], text=True, capture_output=True)
            raise SystemExit(f"notarization: {status}\n{log.stdout[:20000]}\n{log.stderr}")

    @staticmethod
    def staple(path: Path) -> None:
        """Both ask Apple's servers: the ticket can take a moment to be there, and the connection does drop."""
        said = ""
        for attempt in range(TRIES * 2):
            if attempt:
                time.sleep(30)
            for action in ("staple", "validate"):
                done = subprocess.run(["xcrun", "stapler", action, str(path)], text=True, capture_output=True)
                if done.returncode:
                    said = f"{action}: {done.stdout[-400:]}{done.stderr[-400:]}"
                    print(f"STAPLE retry {attempt + 1}: {action} ({done.returncode})", flush=True)
                    break
            else:
                print(f"STAPLED {path.name}", flush=True)
                return
        raise SystemExit(f"could not staple {path}\n{said}")


def try_it(app: Path) -> None:
    """The signed Python really runs under the hardened runtime, and running it leaves the bundle as it was signed. On a
    copy: a broken seal here must not reach the release."""
    with tempfile.TemporaryDirectory(prefix="mac-try-") as temp:
        copy = Path(temp) / app.name
        run("ditto", app, copy)
        run("node", "test/local-runtime-smoke.js", copy / "Contents/Resources/local-runtime", cwd=HERE.parent)
        run("codesign", "--verify", "--deep", "--strict", "--verbose=1", copy)
    print("SIGNED_RUNTIME_OK", flush=True)


def app_path(directory: Path, arch: str) -> Path:
    app = directory / ("mac-arm64" if arch == "arm64" else "mac") / APP_NAME
    if not app.is_dir():
        raise SystemExit(f"Missing packaged app: {app}")
    return app


def do_app(directory: Path, version: str, arch: str) -> None:
    app = app_path(directory, arch)
    if not (app / "Contents/Resources/app-update.yml").is_file():
        raise SystemExit("No app-update.yml in the app: it could not update itself (build/after-pack.js writes it)")
    precompile(app)
    with Signer() as signer:
        signer.sign_app(app)
        try_it(app)
        with tempfile.TemporaryDirectory(prefix="mac-zip-") as temp:
            upload = Path(temp) / "notarize.zip"
            run("ditto", "-c", "-k", "--keepParent", app, upload)
            signer.notarize(upload)
        signer.staple(app)
    run("spctl", "--assess", "--type", "execute", "-vv", app)
    # what a running app updates itself from (Squirrel.Mac wants the app in a zip)
    zipped = directory / f"my-mate-geny-{version}-macos-{arch}.zip"
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zipped)
    print(f"APP_SIGNED {zipped} ({zipped.stat().st_size} bytes)", flush=True)


def do_dmg(directory: Path, version: str, arch: str) -> None:
    dmg = directory / f"my-mate-geny-{version}-macos-{arch}.dmg"
    if not dmg.is_file():
        raise SystemExit(f"Missing image: {dmg}")
    with Signer() as signer:
        signer.sign(dmg, entitlements=False)
        signer.notarize(dmg)
        signer.staple(dmg)
    run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmg)
    print(f"DMG_SIGNED {dmg}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("what", choices=("app", "dmg"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", required=True, choices=("arm64", "x64"))
    parser.add_argument("--directory", type=Path, default=Path("dist"))
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("Signing requires macOS")
    (do_app if args.what == "app" else do_dmg)(args.directory.resolve(), args.version, args.arch)
