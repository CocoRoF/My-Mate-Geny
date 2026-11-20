"""A mate as a file (docs/mate.md "Export and import"): everything that makes her who she is — the character (persona), how she
talks (her conversation style), her temperament, her avatar, her wardrobe, her profile picture, her voice where it can go — out
of one installation and into another.

The package is a zip: ``mate.json`` and ``assets/…``.

- ``mate.json``: {format, version, exported_at, app_version, mate: {name, persona, prefs, avatar, outfits, icon, voice, llm,
  screen}}. Every file of hers is named in it as ``asset:<path>`` — a path under ``assets/`` in the zip — never as this
  installation's URL.
- ``assets/``: her own files (avatar sets, Live2D models, outfits, her profile picture, her voice's reference clip).
- A built-in mate's bundled pictures, videos, models and voice never go into the file: they stay in the app. The package
  names them (``builtin:<key>/<path>``, ``builtin-voice:<key>``), and the importing app uses its own copy of that bundle —
  if it has none, those sets are left empty. What was added to her (outfits made for her, an avatar of her own) goes as any
  mate's files do; her profile picture, cut from her bundled art, stays too.

What stays behind is what is between her and this user, not who she is: memories, conversations, the relationship, how she
feels, her day, other mates, what she thinks they are. The user's own name is theirs, not hers. A built-in mate goes out as
her own mate (her bundled temperament written out with her, her world of days staying with the bundle).

Importing makes a new mate from it, files copied into her own folder. Her voice goes with her only where it can work here:
an engine this installation hasn't set up leaves her with the default voice (``notes`` says so) — the rest of her voice
settings and her reference clip stay, ready for when it is set up.
"""

from __future__ import annotations

import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import unquote

from app.config import settings
from app.mate import files
from app.mate.store import MateError

FORMAT, VERSION = "my-mate-geny.mate", 1
PREFIX = "asset:"
BUILTIN = "builtin:"          # (a bundled file of a built-in mate's: the importing app's own copy)
BUILTIN_VOICE = "builtin-voice:"  # (a built-in mate's bundled voice clip, the same way)
MAX_FILES = 20000
#: what of her prefs is the user's, not hers
NOT_HERS = ("user_name",)
#: voice engines and what each needs here (a key, a server's address, the local voice host)
NEEDS = {"elevenlabs": ("key", "elevenlabs_key"), "openai": ("key", "openai_key"), "google": ("key", "google_key"),
         "http": ("url", "http_tts_url"), "omnivoice": ("url", "omnivoice_url"), "whisper": ("url", "whisper_url"),
         "local": ("local", "")}
_IMPORT_DIR = re.compile(r"^(?:pack|l2d|lv)-[0-9a-f]+$")
_ICON_FOLDER = "profile"  # (store.ICON_FOLDER)


# ---- out ----

def _rewrite(value: Any, fn: Callable[[str], str]) -> Any:
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, list):
        return [_rewrite(v, fn) for v in value]
    if isinstance(value, dict):
        return {k: _rewrite(v, fn) for k, v in value.items()}
    return value


def _temperament(builtin: str | None, custom: Any) -> dict[str, Any] | None:
    """Hers as she is: a built-in's bundled temperament with the user's changes on top, in the shape a mate of her own keeps."""
    from app.mate import state as S
    from app.mate.gss import temperament as T

    bundled = S.TEMPERAMENTS.get(builtin or "") or {}
    if not bundled:
        return custom if isinstance(custom, dict) and custom else None
    raw = {k: v for k, v in bundled.items() if k not in ("loves", "voice")}
    loves = bundled.get("loves")
    if isinstance(loves, str):  # (a bundled one is a pattern: its words)
        raw["loves"] = [w for w in (re.sub(r"\\b|\(\?:|\)|\\", "", x).strip() for x in loves.split("|")) if w][:12]
    out = T.clean({**raw, **(custom if isinstance(custom, dict) else {})})
    return out or None


def _bundled_voice(key: str | None) -> Path | None:
    """A built-in's bundled voice clip (files.ailism_voice copies it into her own folder as voice/<name>)."""
    d = files.builtin_voice_dir(key or "")
    if d is None:
        return None
    try:
        spec = json.loads((d / "voice.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    ref = d / str(spec.get("ref") or "")
    return ref if spec.get("ref") and ref.is_file() else None


def collect(mate: dict[str, Any], raw: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Path]]:
    """(the package's ``mate`` document, {path in the zip: file here}). ``raw``: her stored columns (avatar, outfits, icon…).
    A built-in's bundled files are named, never packed (``BUILTIN``)."""
    mid = mate["id"]
    key = mate.get("builtin") or None
    own = f"/api/mates/{mid}/assets/"
    builtin = "/api/mates/builtin/"
    found: dict[str, Path] = {}
    base = files.assets_dir(mid)
    used_dirs: set[str] = set()

    def out(s: str) -> str:
        url = s.split("?", 1)[0].split("#", 1)[0]
        if url.startswith(own):
            rel = unquote(url[len(own):])
            first = rel.split("/", 1)[0]
            if _IMPORT_DIR.match(first):
                used_dirs.add(first)
            return PREFIX + rel
        if url.startswith(builtin):  # (the app's own: named, not packed)
            return BUILTIN + unquote(url[len(builtin):])
        return s

    doc = {
        "name": mate["name"],
        "persona": raw["persona"],
        "prefs": {k: v for k, v in raw["prefs"].items() if k not in NOT_HERS},
        "avatar": _rewrite(raw["avatar"], out),
        "outfits": _rewrite(raw["outfits"], out),
        "icon": out(raw["icon"]) if raw.get("icon") and not key else "",  # (a built-in's picture is cut from her bundled art)
        "voice": json.loads(json.dumps(raw["voice"])),
        "llm": raw["llm"],
        "screen": raw["screen"],
    }
    temperament = _temperament(key, raw["prefs"].get("temperament"))
    if temperament:
        doc["prefs"]["temperament"] = temperament
    skip: set[str] = set()
    if key:
        skip.add(f"{_ICON_FOLDER}/")  # (folders: everything in them)
        clip = _bundled_voice(key)
        tts = doc["voice"].get("tts") if isinstance(doc["voice"].get("tts"), dict) else {}
        if clip is not None and tts.get("ref") == f"voice/{clip.name}":
            tts["ref"] = f"{BUILTIN_VOICE}{key}"
            skip.add(f"voice/{clip.name}")
    if base.is_dir():  # (her own files: all of them, but import folders no avatar of hers uses any more)
        for f in base.rglob("*"):
            if not f.is_file() or f.is_symlink():
                continue
            rel = f.relative_to(base).as_posix()
            first = rel.split("/", 1)[0]
            if _IMPORT_DIR.match(first) and first not in used_dirs:
                continue
            if rel in skip or any(rel.startswith(x) for x in skip if x.endswith("/")):
                continue
            found[f"assets/{rel}"] = f
    return doc, found


def export(mate: dict[str, Any], raw: dict[str, Any], dest: Path, *, app_version: str = "") -> Path:
    """Write her package to ``dest`` (a .zip). → dest."""
    doc, found = collect(mate, raw)
    manifest = {"format": FORMAT, "version": VERSION, "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "app_version": app_version, "mate": doc}
    with zipfile.ZipFile(dest, "w") as zf:
        zf.writestr("mate.json", json.dumps(manifest, ensure_ascii=False, indent=1), compress_type=zipfile.ZIP_DEFLATED)
        for name, path in sorted(found.items()):
            # (pictures and videos are compressed already; the rest is worth it)
            packed = path.suffix.lower() in (".json", ".txt", ".moc3", ".wav", ".svg")
            zf.write(path, name, compress_type=zipfile.ZIP_DEFLATED if packed else zipfile.ZIP_STORED)
    return dest


def file_name(name: str) -> str:
    """Her package's file name: her name, safe on every system."""
    clean = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "", name).strip().strip(".") or "mate"
    return f"{clean[:60]}.mate.zip"


# ---- in ----

def read(zip_path: str) -> tuple[zipfile.ZipFile, dict[str, Any]]:
    """The package: (its zip, its ``mate`` document). MateError when it isn't one."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise MateError("not a mate file (.mate.zip)") from exc
    try:
        info = zf.getinfo("mate.json")
    except KeyError:
        zf.close()
        raise MateError("not a mate file: it has no mate.json") from None
    if info.file_size > 8 * 1024 * 1024:
        zf.close()
        raise MateError("mate.json is too large")
    try:
        manifest = json.loads(zf.read(info).decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as exc:
        zf.close()
        raise MateError(f"cannot read mate.json: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT or not isinstance(manifest.get("mate"), dict):
        zf.close()
        raise MateError("not a mate file from My Mate Geny")
    if int(manifest.get("version") or 0) > VERSION:
        zf.close()
        raise MateError("this mate file is from a newer version of the app: update the app first")
    return zf, manifest["mate"]


def unpack(zf: zipfile.ZipFile, mate_id: str) -> int:
    """Her files into her own folder (``assets/…`` only, every path checked, the import budget kept). → bytes written."""
    base = files.assets_dir(mate_id)
    budget = settings.mate_import_max_mb * 1024 * 1024
    written = 0
    members = [i for i in zf.infolist() if not i.is_dir() and i.filename.startswith("assets/")]
    if len(members) > MAX_FILES:
        raise MateError(f"too many files in the mate file (more than {MAX_FILES})")
    for info in members:
        rel = files.safe_rel(info.filename[len("assets/"):])
        target = base / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as dst:
            while True:  # (real bytes: a header's size can lie)
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > budget:
                    raise MateError(f"the mate file unpacks to more than {settings.mate_import_max_mb} MB", status=413)
                dst.write(chunk)
    return written


MISSING = "\x00missing"  # (a bundled file this app doesn't have)


def placed(doc: Any, mate_id: str) -> Any:
    """Her documents with each ``asset:<path>`` made this installation's URL of her copy, and each ``builtin:<key>/<path>``
    this app's own bundled file — ``MISSING`` where it has none (``settle``)."""
    def into(s: str) -> str:
        if s.startswith(PREFIX):
            return files.asset_url(mate_id, files.safe_rel(s[len(PREFIX):]))
        if s.startswith(BUILTIN):
            key, _, rel = s[len(BUILTIN):].partition("/")
            try:
                files.resolve_builtin(key, rel)
            except (KeyError, MateError):
                return MISSING
            return f"/api/mates/builtin/{key}/{rel}"
        return s
    return _rewrite(doc, into)


def missing(doc: Any) -> bool:
    """Whether a document names a bundled file this app doesn't have."""
    if isinstance(doc, str):
        return doc == MISSING
    if isinstance(doc, list):
        return any(missing(v) for v in doc)
    if isinstance(doc, dict):
        return any(missing(v) for v in doc.values())
    return False


def voice_clip(voice: dict[str, Any] | None, mate_id: str) -> tuple[dict[str, Any] | None, bool]:
    """A built-in's bundled voice clip named in her voice: this app's own copy of it into her folder (as files.ailism_voice
    does for a built-in), or none. → (voice, whether it was missing)."""
    tts = (voice or {}).get("tts") if isinstance((voice or {}).get("tts"), dict) else None
    ref = str((tts or {}).get("ref") or "")
    if not ref.startswith(BUILTIN_VOICE):
        return voice, False
    clip = _bundled_voice(ref[len(BUILTIN_VOICE):])
    if clip is None:
        tts.update(ref="", ref_text="")
        return voice, True
    dest = files.assets_dir(mate_id) / "voice" / clip.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(clip, dest)
    tts["ref"] = f"voice/{clip.name}"
    return voice, False


def voice_here(voice: Any, usable: Callable[[str], bool]) -> tuple[dict[str, Any] | None, list[str]]:
    """Her voice settings as far as they can work here: an engine this installation hasn't set up gives way to the default
    (the rest stays). → (voice, notes)."""
    if not isinstance(voice, dict):
        return None, []
    out = json.loads(json.dumps(voice))
    notes = []
    for part, default in (("tts", "browser"), ("stt", "browser")):
        cfg = out.get(part) if isinstance(out.get(part), dict) else None
        engine = str((cfg or {}).get("engine") or "")
        if cfg is not None and engine and not usable(engine):
            notes.append(f"{part}:{engine}")
            cfg["engine"] = default
            if part == "tts":
                cfg["voice"] = ""  # (a voice of that service's: nothing without it)
    return out, notes


def usable_here(store: Any, local: Any) -> Callable[[str], bool]:
    """Whether a voice engine works in this installation: a key it needs, a server's address, the local voice host."""
    def ok(engine: str) -> bool:
        need = NEEDS.get(engine)
        if need is None:
            return True  # (browser, off: always)
        kind, name = need
        if kind == "key":
            return bool(store.secret(name))
        if kind == "url":
            return bool(store._setting(name))
        return local is not None
    return ok


def clean_up(mate_id: str) -> None:
    shutil.rmtree(files.mate_dir(mate_id), ignore_errors=True)
