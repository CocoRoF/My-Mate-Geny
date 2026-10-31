"""Per-mate files: assets, avatar imports, the Live2D Cubism Core.

Layout (``settings.mates_root``, default ``~/.hr-harnessor/mates``)::

    <root>/<mate_id>/assets/<path>          served at /api/mates/<id>/assets/<path>
    <root>/<mate_id>/assets/pack-<x>/…      an imported video/photo pack (rig.json + files)
    <root>/<mate_id>/assets/l2d-<x>/…       an imported Live2D model
    <root>/<mate_id>/home/                  the mate engine's cwd (nothing else lives there)
    <root>/_runtime/live2dcubismcore.min.js the Cubism Core, once the user installed it
    <root>/_cache/tts/<hash>.<ext>          synthesized speech

Every path that comes from outside (upload ``path``, zip member names, refs
inside rig.json / model3.json) goes through :func:`safe_rel`: relative, no
``..``, no hidden components, no backslashes or control characters. Zips are
also bounded (entry count, unpacked size, actual bytes written) and symlink
members are refused.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

from app.config import settings
from app.mate.store import MateError
from app.services._ids import new_id

CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
MAX_ENTRIES = 5000
IMPORT_DIR_RE = re.compile(r"^(pack|l2d)-[0-9a-f]{8,}$")
_MATE_ID_RE = re.compile(r"^mate_[0-9a-f]{8,32}$")

# Served inline with these types; anything else is application/octet-stream
# (never HTML/SVG/JS from an avatar pack: they would run on our origin).
_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".opus": "audio/ogg",
    ".json": "application/json", ".moc3": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
}

# Geny / geny-avatar emotion names -> the mate's emotion tags (docs/mate.md §3).
_EMOTION_ALIASES = {
    "anger": "angry", "angry": "angry", "sadness": "sad", "sad": "sad", "surprise": "surprised",
    "surprised": "surprised", "joy": "joy", "happy": "smile", "smile": "smile", "laugh": "laugh",
    "neutral": "neutral", "shy": "shy", "thinking": "thinking", "agree": "agree",
    "greet": "greet", "sleepy": "sleepy", "smirk": "smile",
}
CLIP_KINDS = ("idle", "talk", "listen", "think", "react", "away")
_SIDECARS = ("avatar-editor.json", "avatar.json")


def root() -> Path:
    return settings.mates_root_path


def mate_dir(mate_id: str) -> Path:
    if not _MATE_ID_RE.match(mate_id or ""):
        raise MateError("invalid mate id", status=404)
    return root() / mate_id


def assets_dir(mate_id: str) -> Path:
    return mate_dir(mate_id) / "assets"


def home_dir(mate_id: str) -> Path:
    d = mate_dir(mate_id) / "home"
    d.mkdir(parents=True, exist_ok=True)
    return d


def engine_file(mate_id: str, kind: str, ext: str, content: str, *, keep: int = 8) -> str:
    """A launch file for the mate engine (system prompt, MCP config), named
    by its content: a running engine's file never changes under it. 0600 —
    the MCP config holds the conversation's token. Old ones are pruned once
    no engine can still be using them (engines live at most 12 h)."""
    import hashlib
    import time

    d = mate_dir(mate_id) / "engine"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{kind}-{hashlib.sha256(content.encode()).hexdigest()[:16]}.{ext}"
    if not p.is_file():
        tmp = p.with_name(p.name + ".part")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, p)
    else:
        os.utime(p)
    old = sorted(d.glob(f"{kind}-*.{ext}"), key=lambda x: x.stat().st_mtime, reverse=True)[keep:]
    for x in old:
        if time.time() - x.stat().st_mtime > 13 * 3600:
            x.unlink(missing_ok=True)
    return str(p)


def remove_mate(mate_id: str) -> None:
    shutil.rmtree(mate_dir(mate_id), ignore_errors=True)


def asset_url(mate_id: str, rel: str) -> str:
    return f"/api/mates/{mate_id}/assets/{quote(rel)}"


def safe_rel(path: str) -> str:
    """A clean relative POSIX path, or MateError."""
    if not isinstance(path, str) or not path or len(path) > 500:
        raise MateError("invalid path")
    if any(ord(c) < 32 for c in path) or "\\" in path:
        raise MateError(f"invalid path: {path!r}")
    p = PurePosixPath(path)
    if p.is_absolute() or re.match(r"^[A-Za-z]:", path):
        raise MateError(f"absolute path not allowed: {path}")
    parts = [x for x in p.parts if x not in ("", ".")]
    if not parts or any(x == ".." or x.startswith(".") for x in parts):
        raise MateError(f"invalid path: {path}")
    return "/".join(parts)


def resolve_asset(mate_id: str, rel: str) -> Path:
    """The file behind an asset URL (KeyError if there is none)."""
    try:
        rel = safe_rel(rel)
    except MateError as exc:
        raise KeyError(str(exc)) from exc
    base = assets_dir(mate_id).resolve()
    p = (base / rel).resolve()
    if base not in p.parents or not p.is_file():
        raise KeyError("asset not found")
    return p


def content_type(path: Path) -> str:
    return _TYPES.get(path.suffix.lower()) or "application/octet-stream"


def is_immutable(rel: str) -> bool:
    """Imports land in fresh pack-/l2d- dirs: their URLs never change content."""
    first = rel.split("/", 1)[0]
    return bool(IMPORT_DIR_RE.match(first))


async def save_upload(mate_id: str, rel: str, upload: Any) -> dict[str, Any]:
    """Store one uploaded asset (streamed, size-capped) -> {path, url}."""
    rel = safe_rel(rel)
    if is_immutable(rel):
        raise MateError("pack-/l2d- folders are reserved for imports")
    limit = settings.mate_asset_max_mb * 1024 * 1024
    dest = assets_dir(mate_id) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    size = 0
    try:
        with open(tmp, "wb") as fh:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise MateError(f"file is larger than {settings.mate_asset_max_mb} MB", status=413)
                fh.write(chunk)
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink()
    st = dest.stat()
    return {"path": rel, "url": f"{asset_url(mate_id, rel)}?v={int(st.st_mtime)}", "size": size}


def drop_import_dirs(mate_id: str, keep: set[str]) -> None:
    """Remove imported pack/model folders the avatar no longer uses."""
    base = assets_dir(mate_id)
    if not base.is_dir():
        return
    for d in base.iterdir():
        if d.is_dir() and IMPORT_DIR_RE.match(d.name) and d.name not in keep:
            shutil.rmtree(d, ignore_errors=True)


def import_dirs_of(avatar: dict[str, Any], mate_id: str) -> set[str]:
    """Import folders an avatar document references."""
    blob = json.dumps(avatar)
    return set(re.findall(rf"/api/mates/{re.escape(mate_id)}/assets/((?:pack|l2d)-[0-9a-f]+)/", blob))


# ---- zip import ----

def _limit_bytes() -> int:
    return settings.mate_import_max_mb * 1024 * 1024


def _new_import_dir(mate_id: str, prefix: str) -> tuple[Path, str]:
    name = f"{prefix}-{new_id()[:12]}"
    d = assets_dir(mate_id) / name
    d.mkdir(parents=True, exist_ok=False)
    return d, name


def _zip_members(zf: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, str]]:
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise MateError(f"too many files in the zip (max {MAX_ENTRIES})")
    out: list[tuple[zipfile.ZipInfo, str]] = []
    total = 0
    for info in infos:
        name = info.filename
        if name.endswith("/") or name.startswith("__MACOSX/") or name.split("/")[-1] in (".DS_Store", "Thumbs.db"):
            continue
        mode = (info.external_attr >> 16) & 0o170000
        if mode == stat.S_IFLNK:
            raise MateError(f"symlinks are not allowed in the zip: {name}")
        rel = safe_rel(name)  # raises on traversal / absolute / hidden names
        total += info.file_size
        if total > _limit_bytes():
            raise MateError(f"the zip unpacks to more than {settings.mate_import_max_mb} MB", status=413)
        out.append((info, rel))
    if not out:
        raise MateError("the zip is empty")
    return out


def _strip_common_root(members: list[tuple[zipfile.ZipInfo, str]]) -> list[tuple[zipfile.ZipInfo, str]]:
    """``model/…`` everywhere -> ``…`` (zips of a folder)."""
    firsts = {rel.split("/", 1)[0] for _, rel in members}
    if len(firsts) == 1 and all("/" in rel for _, rel in members):
        cut = len(next(iter(firsts))) + 1
        return [(i, rel[cut:]) for i, rel in members]
    return members


def _shallowest(paths: list[str]) -> str | None:
    return min(paths, key=lambda p: (p.count("/"), len(p))) if paths else None


def import_zip(mate_id: str, zip_path: str) -> dict[str, Any]:
    """Unpack an avatar zip -> Avatar document (video/photo pack or Live2D)."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise MateError("not a zip file") from exc
    with zf:
        members = _strip_common_root(_zip_members(zf))
        rels = [rel for _, rel in members]
        rig = _shallowest([r for r in rels if r.split("/")[-1] == "rig.json"])
        model = _shallowest([r for r in rels if r.endswith(".model3.json")])
        if rig is None and model is None:
            raise MateError("no rig.json (video/photo pack) or *.model3.json (Live2D) in the zip")
        prefix = "pack" if rig is not None and (model is None or rig.count("/") <= model.count("/")) else "l2d"
        dest, name = _new_import_dir(mate_id, prefix)
        try:
            budget = _limit_bytes()
            for info, rel in members:
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as out:
                    while True:  # count real bytes: file_size in the header can lie
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        budget -= len(chunk)
                        if budget < 0:
                            raise MateError(f"the zip unpacks to more than {settings.mate_import_max_mb} MB",
                                            status=413)
                        out.write(chunk)
            if prefix == "pack":
                assert rig is not None
                rig_dir = dest / rig.rsplit("/", 1)[0] if "/" in rig else dest
                raw = _read_json(rig_dir / "rig.json")
                return build_rig_avatar(mate_id, raw, rig_dir)
            assert model is not None
            return build_live2d_avatar(mate_id, dest / model, sidecar=_find_sidecar(dest / model, dest))
        except Exception:
            shutil.rmtree(dest, ignore_errors=True)
            raise


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise MateError(f"cannot read {path.name}: {exc}") from exc


# ---- rig (video / photo) ----

def _ref_rel(ref: Any, base: Path) -> str | None:
    """A rig reference -> path relative to ``base`` if that file exists.
    Understands ailism's ``asset:<pack>/<file>`` refs and plain relative paths."""
    if not isinstance(ref, str) or not ref.strip():
        return None
    r = ref.strip()
    if r.startswith("asset:"):
        r = r[len("asset:"):]
        r = r.split("/", 1)[1] if "/" in r else r  # drop the pack key ("mate-estelle/")
    if r.startswith(("http:", "https:", "data:", "/")):
        return None
    while r.startswith("./"):
        r = r[2:]
    try:
        rel = safe_rel(r)
    except MateError:
        return None
    if (base / rel).is_file():
        return rel
    leaf = rel.split("/")[-1]
    return leaf if (base / leaf).is_file() else None


def build_rig_avatar(mate_id: str, raw: Any, base: Path) -> dict[str, Any]:
    """An ailism-style rig (refs relative to ``base``) -> Avatar video/photo."""
    if not isinstance(raw, dict):
        raise MateError("rig.json must be an object")
    a_root = assets_dir(mate_id).resolve()
    base = base.resolve()
    if base != a_root and a_root not in base.parents:
        raise MateError("rig folder outside the mate's assets")
    prefix = str(base.relative_to(a_root)).replace(os.sep, "/")
    return rig_avatar(raw, base, lambda rel: asset_url(mate_id, f"{prefix}/{rel}" if prefix and prefix != "." else rel))


def rig_avatar(raw: Any, base: Path, url_for: Any) -> dict[str, Any]:
    """Rig refs (relative to ``base``, files that exist) -> Avatar, with
    ``url_for(rel)`` turning a file into its served URL."""
    if not isinstance(raw, dict):
        raise MateError("rig.json must be an object")

    def url(ref: Any) -> str | None:
        rel = _ref_rel(ref, base)
        return None if rel is None else url_for(rel)

    stills = {}
    for k, v in (raw.get("stills") or {}).items():
        u = url(v)
        if u:
            stills[str(k)] = u
    clips = []
    for c in raw.get("clips") or []:
        if not isinstance(c, dict):
            continue
        src = url(c.get("src"))
        if not src or c.get("kind") not in CLIP_KINDS:
            continue
        clip: dict[str, Any] = {"id": str(c.get("id") or f"clip{len(clips) + 1}"), "kind": c["kind"], "src": src}
        if c.get("emotion"):
            clip["emotion"] = str(c["emotion"])
        small = url(c.get("small"))
        if small:
            clip["small"] = small
        if c.get("loop"):
            clip["loop"] = True
        clips.append(clip)
    ids = {c["id"] for c in clips}
    emotions = {}
    for emo, lst in (raw.get("emotions") or {}).items():
        keep = [x for x in (lst or []) if x in ids]
        if keep:
            emotions[str(emo)] = keep
    home = url(raw.get("home")) or stills.get("neutral") or next(iter(stills.values()), None)
    if not home and not clips:
        raise MateError("the rig references no files that exist (stills/clips)")
    aspect = raw.get("aspect")
    if not (isinstance(aspect, list) and len(aspect) == 2 and all(isinstance(x, (int, float)) and x > 0 for x in aspect)):
        aspect = [1, 1]
    rig: dict[str, Any] = {"aspect": aspect, "home": home or "", "stills": stills, "clips": clips}
    if emotions:
        rig["emotions"] = emotions
    if clips:
        rig["packing"] = raw.get("packing") if raw.get("packing") in ("stacked-alpha", "plain") else "plain"
        return {"kind": "video", "rig": rig}
    return {"kind": "photo", "rig": rig}


# ---- Live2D ----

def _find_sidecar(model_path: Path, top: Path | None = None) -> dict[str, Any] | None:
    """geny-avatar's ``avatar-editor.json`` next to the model, one folder up,
    or at the top of the import."""
    dirs = [model_path.parent, model_path.parent.parent]
    if top is not None:
        dirs.append(top)
    for d in dirs:
        for name in _SIDECARS:
            p = d / name
            if p.is_file():
                try:
                    data = json.loads(p.read_text(encoding="utf-8-sig"))
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict):
                    return data
    return None


def _registry_entry(model_path: Path) -> dict[str, Any] | None:
    """Geny's ``live2d-models/model_registry.json`` entry for this model (when
    importing from a Geny checkout): display/emotion tuning."""
    for d in list(model_path.parents)[:4]:
        reg = d / "model_registry.json"
        if not reg.is_file():
            continue
        try:
            data = json.loads(reg.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        for m in data.get("models") or []:
            if isinstance(m, dict) and str(m.get("url") or "").endswith("/" + model_path.name):
                return m
        return None
    return None


def build_live2d_avatar(mate_id: str, model_path: Path, *, sidecar: dict[str, Any] | None = None,
                        registry: dict[str, Any] | None = None) -> dict[str, Any]:
    """A ``*.model3.json`` inside the mate's assets -> Avatar live2d. Empty
    motion-group keys (pixi-live2d-display can't play group "") are renamed
    in our copy of the model file."""
    a_root = assets_dir(mate_id).resolve()
    model_path = model_path.resolve()
    if a_root not in model_path.parents:
        raise MateError("model outside the mate's assets")
    model3 = _read_json(model_path)
    if not isinstance(model3, dict) or not isinstance(model3.get("FileReferences"), dict):
        raise MateError(f"{model_path.name} is not a Cubism model3.json")
    refs = model3["FileReferences"]
    moc = refs.get("Moc")
    if not isinstance(moc, str) or not (model_path.parent / moc).is_file():
        raise MateError(f"{model_path.name}: the .moc3 file it names is missing")

    cfg = (sidecar or {}).get("animationConfig") or sidecar or {}
    reg = registry or {}
    idle = cfg.get("idleMotionGroupName") or reg.get("idleMotionGroupName") or ""

    motions = refs.get("Motions") if isinstance(refs.get("Motions"), dict) else {}
    renamed = None
    if any(not str(k).strip() for k in motions):
        named = {k: v for k, v in motions.items() if str(k).strip()}
        renamed = "Idle" if not idle and "Idle" not in named else "Motion"
        n = 2
        while renamed in named:
            renamed, n = f"Motion{n}", n + 1
        merged = [e for k, v in motions.items() if not str(k).strip() and isinstance(v, list) for e in v]
        named[renamed] = merged
        refs["Motions"] = motions = named
        model_path.write_text(json.dumps(model3, ensure_ascii=False, indent=2), encoding="utf-8")
    groups = list(motions)
    if not idle:
        idle = "Idle" if "Idle" in groups else (groups[0] if groups else "Idle")

    def group_name(g: Any) -> str:
        g = str(g or "")
        return renamed if (not g.strip() and renamed) else g

    rel = str(model_path.relative_to(a_root)).replace(os.sep, "/")
    out: dict[str, Any] = {"model": asset_url(mate_id, rel), "idle_group": idle}
    display = cfg.get("display") or {}
    for key, src_keys in (("scale", ("kScale",)), ("x", ("initialXshift",)), ("y", ("initialYshift",))):
        for sk in src_keys:
            v = display.get(sk, cfg.get(sk, reg.get(sk)))
            if isinstance(v, (int, float)):
                out[key] = float(v)
                break

    emotions: dict[str, Any] = {}
    for emo, val in (cfg.get("emotionMap") or reg.get("emotionMap") or {}).items():
        if isinstance(val, (str, int)) and not isinstance(val, bool):
            tag = _EMOTION_ALIASES.get(str(emo).lower(), str(emo))
            emotions.setdefault(tag, val)
    if emotions:
        out["emotions"] = emotions
    emo_motions = {str(k): group_name(v) for k, v in (cfg.get("emotionMotionMap") or reg.get("emotionMotionMap")
                                                      or {}).items() if isinstance(v, str)}
    if emo_motions:
        out["emotion_motions"] = emo_motions

    taps: dict[str, Any] = {}
    for hit, choice in (cfg.get("tapMotions") or reg.get("tapMotions") or {}).items():
        if isinstance(choice, dict) and "group" in choice:  # geny-avatar: {group, index}
            taps[hit] = {"group": group_name(choice["group"]), "index": int(choice.get("index") or 0)}
        elif isinstance(choice, dict) and choice:  # Geny registry: {group: index}
            g, i = next(iter(choice.items()))
            taps[hit] = {"group": group_name(g), "index": int(i) if isinstance(i, (int, float)) else 0}
    if not taps:
        active = next((g for g in groups if g != idle), idle if groups else None)
        for h in model3.get("HitAreas") or []:
            if isinstance(h, dict) and h.get("Id") and active:
                taps[str(h["Id"])] = {"group": active}
    if taps:
        out["tap_motions"] = taps
    hidden = cfg.get("hiddenParts") or reg.get("hiddenParts")
    if isinstance(hidden, list) and hidden:
        out["hidden_parts"] = [str(x) for x in hidden]
    return {"kind": "live2d", "live2d": out}


# ---- import from a folder on this server ----

def _copy_tree(src: Path, dest: Path) -> None:
    """Copy regular files (no symlinks, no hidden files), bounded."""
    budget, count = _limit_bytes(), 0
    for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "node_modules"]
        for f in filenames:
            if f.startswith("."):
                continue
            sp = Path(dirpath) / f
            if sp.is_symlink() or not sp.is_file():
                continue
            count += 1
            budget -= sp.stat().st_size
            if count > MAX_ENTRIES or budget < 0:
                raise MateError(f"that folder is too large to import (max {settings.mate_import_max_mb} MB, "
                                f"{MAX_ENTRIES} files)", status=413)
            dp = dest / sp.relative_to(src)
            dp.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(sp, dp)


def _find_model3(folder: Path, depth: int = 3) -> Path | None:
    best: Path | None = None
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        rel_depth = len(Path(dirpath).relative_to(folder).parts)
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "node_modules"] if rel_depth < depth else []
        for f in filenames:
            if f.endswith(".model3.json"):
                cand = Path(dirpath) / f
                if best is None or len(cand.parts) < len(best.parts):
                    best = cand
    return best


def classify_local(path: str) -> dict[str, Any]:
    """What a server-side path holds: an ailism content mate, a rig pack or
    a Live2D model. -> {kind: ailism|pack|live2d, ...}"""
    p = Path(os.path.expanduser(path or "")).resolve()
    if not p.exists():
        raise MateError(f"not found: {p}", status=404)
    if p.is_file():
        if p.name.endswith(".model3.json"):
            return {"kind": "live2d", "model": p}
        if p.name == "rig.json":
            return {"kind": "pack", "folder": p.parent}
        if p.suffix == ".json":
            data = _read_json(p)
            if isinstance(data, dict) and isinstance(data.get("doc"), dict) and data["doc"].get("character"):
                key = str(data.get("key") or p.stem)
                assets = p.parent.parent / "assets" / key
                return {"kind": "ailism", "doc": data, "key": key, "assets": assets if assets.is_dir() else None,
                        "voice_dir": ailism_voice_dir(p.parent.parent, key)}
        raise MateError(f"{p.name}: not an ailism mate (.json), rig.json or *.model3.json")
    if (p / "rig.json").is_file():
        return {"kind": "pack", "folder": p}
    model = _find_model3(p)
    if model is not None:
        return {"kind": "live2d", "model": model}
    # an ailism content folder (or its mates/ folder): every character in it
    mates_dir = p / "mates" if (p / "mates").is_dir() else (p if p.name == "mates" else None)
    if mates_dir is not None:
        many = [classify_local(str(x)) for x in sorted(mates_dir.glob("*.json"))]
        many = [m for m in many if m["kind"] == "ailism"]
        if many:
            return {"kind": "ailism_many", "items": many}
    raise MateError(f"{p}: no rig.json, *.model3.json or ailism mate found")


def import_folder_pack(mate_id: str, folder: Path, fallback_rig: dict[str, Any] | None = None) -> dict[str, Any]:
    dest, _ = _new_import_dir(mate_id, "pack")
    try:
        _copy_tree(folder, dest)
        raw = _read_json(dest / "rig.json") if (dest / "rig.json").is_file() else fallback_rig
        if raw is None:
            raise MateError(f"{folder}: no rig.json")
        return build_rig_avatar(mate_id, raw, dest)
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise


def import_folder_live2d(mate_id: str, model: Path) -> dict[str, Any]:
    src_dir = model.parent
    dest, _ = _new_import_dir(mate_id, "l2d")
    try:
        _copy_tree(src_dir, dest)
        sidecar = _find_sidecar(model)
        return build_live2d_avatar(mate_id, dest / model.name, sidecar=sidecar,
                                   registry=None if sidecar else _registry_entry(model))
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise


def ailism_persona(doc: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """An ailism MateDoc -> (name, persona), keeping everything the author
    wrote: profile, appearance, background, relationship, knowledge, world,
    personality, speech + every example exchange, the opening lines, the
    greeting and return lines, interests and the author's note."""
    d = doc.get("doc") or {}
    ch = d.get("character") or {}
    mate = d.get("mate") or {}
    lang = str(d.get("language") or "ko")
    address = str(mate.get("address") or "")
    user = address or ("사용자" if lang == "ko" else "the user")
    char = str(ch.get("name") or "")

    def fill(text: Any) -> str:
        return str(text or "").replace("{{user}}", user).replace("{{char}}", char).strip()

    def said(line: Any) -> str:
        # ailism lines are "Name | text"
        t = fill(line)
        return t.split("|", 1)[1].strip() if "|" in t else t

    sections = [
        ("", fill(ch.get("tagline") or d.get("tagline"))),
        ("", fill(ch.get("profile"))),
        ("Appearance", fill(ch.get("appearance"))),
        ("Background", fill(ch.get("background"))),
        ("Your relationship with the user", fill(ch.get("relationship"))),
        ("What you know", fill(ch.get("knowledge"))),
        ("Your world", fill(d.get("world"))),
    ]
    description = "\n\n".join(f"{title}:\n{text}" if title else text for title, text in sections if text)
    speech = fill(ch.get("speech"))
    examples = [e for e in ch.get("examples") or [] if isinstance(e, dict) and e.get("content")]
    if examples:
        lines = []
        for e in examples[:40]:
            who = "user" if e.get("speaker") == "user" else "you"
            lines.append(f"{who}: " + fill(e["content"]).replace("\n", " / "))
        speech += ("\n\n" if speech else "") + "Example exchanges:\n" + "\n".join(lines)
    opening = [said(x) for x in str(d.get("opening") or "").splitlines() if x.strip()]
    greeting = fill(mate.get("greeting")) or " ".join(opening[:3])
    notes = []
    if fill(d.get("instructions")):
        notes.append(fill(d.get("instructions")))
    if opening:
        notes.append("When you first meet the user you open like this:\n" + "\n".join(opening))
    returning = [fill(x) for x in mate.get("returning") or [] if str(x).strip()]
    if returning:
        notes.append("When the user comes back after a while, you greet them in this spirit:\n"
                     + "\n".join(f"- {x}" for x in returning))
    interests = [str(x).strip() for x in mate.get("interests") or [] if str(x).strip()]
    if interests:
        notes.append("Things you like to talk about: " + ", ".join(interests))
    persona = {
        "description": description,
        "personality": fill(ch.get("personality")),
        "speech": speech,
        "greeting": greeting,
        "address": address,
        "language": lang,
        "instructions": "\n\n".join(notes),
    }
    name = str(ch.get("name") or d.get("title") or doc.get("key") or "Mate").strip()
    return name, persona


def ailism_voice_dir(content: Path, key: str) -> Path | None:
    """The character's voice folder (ailism-desktop-mate ``voices/<key>/voice.json``)
    next to the content folder or a parent of it."""
    for base in [content, *list(content.parents)[:3]]:
        v = base / "voices" / key
        if (v / "voice.json").is_file():
            return v
    return None


def ailism_voice(doc: dict[str, Any], voice_dir: Path | None, mate_id: str) -> dict[str, Any] | None:
    """The character's voice -> a voice patch: an ElevenLabs voice id from the
    service content, or the desktop app's OmniVoice voice (a reference clip
    + its line, or a voice-design instruction). The engine stays as it is
    (the browser voice) until the user picks one in Mate settings."""
    d = doc.get("doc") or {}
    tts: dict[str, Any] = {}
    el = (d.get("character") or {}).get("voice") or {}
    if isinstance(el, dict) and el.get("id"):
        tts.update(voice=str(el["id"]), model=str(el.get("model") or ""))
    if voice_dir is not None:
        try:
            spec = json.loads((voice_dir / "voice.json").read_text("utf-8"))
        except (OSError, ValueError):
            spec = {}
        if spec.get("instruct"):
            tts["instruct"] = str(spec["instruct"])
        ref = voice_dir / str(spec.get("ref") or "")
        if spec.get("ref") and ref.is_file() and ref.stat().st_size <= 20 * 1024 * 1024:
            dest = assets_dir(mate_id) / "voice" / ref.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ref, dest)
            tts.update(ref=f"voice/{ref.name}", ref_text=str(spec.get("text") or ""))
        if spec.get("language"):
            tts["language"] = str(spec["language"])
    return {"tts": tts} if tts else None


# ---- built-in mates (bundled ailism content: mates/, assets/, voices/) ----

BUILTIN_DIR = Path(__file__).resolve().parent / "builtin"
BUILTIN_ORDER = ("estelle", "chaerin", "seoa")  # the first is the default mate


def builtin_keys() -> list[str]:
    keys = [x.stem for x in (BUILTIN_DIR / "mates").glob("*.json")] if (BUILTIN_DIR / "mates").is_dir() else []
    return sorted(keys, key=lambda k: (BUILTIN_ORDER.index(k) if k in BUILTIN_ORDER else len(BUILTIN_ORDER), k))


def builtin_doc(key: str) -> dict[str, Any]:
    return _read_json(BUILTIN_DIR / "mates" / f"{key}.json")


def builtin_url(key: str, rel: str) -> str:
    return f"/api/mates/builtin/{quote(key)}/{quote(rel)}"


def builtin_avatar(key: str, doc: dict[str, Any]) -> dict[str, Any] | None:
    folder = BUILTIN_DIR / "assets" / key
    raw = _read_json(folder / "rig.json") if (folder / "rig.json").is_file() else ((doc.get("doc") or {}).get("mate") or {}).get("body")
    if not folder.is_dir() or not raw:
        return None
    return rig_avatar(raw, folder.resolve(), lambda rel: builtin_url(key, rel))


def builtin_voice_dir(key: str) -> Path | None:
    v = BUILTIN_DIR / "voices" / key
    return v if (v / "voice.json").is_file() else None


def builtin_hash(key: str) -> str:
    """Changes when the bundled character changes (persona, rig, files)."""
    h = hashlib.sha256()
    for f in sorted([BUILTIN_DIR / "mates" / f"{key}.json", *(BUILTIN_DIR / "assets" / key).glob("*"),
                     *(BUILTIN_DIR / "voices" / key).glob("*")]):
        if f.is_file():
            st = f.stat()
            h.update(f"{f.name}:{st.st_size}".encode())
            if f.suffix == ".json":
                h.update(f.read_bytes())
    return h.hexdigest()[:16]


def resolve_builtin(key: str, rel: str) -> Path:
    root_dir = (BUILTIN_DIR / "assets" / key).resolve()
    p = (root_dir / rel).resolve()
    if root_dir not in p.parents or not p.is_file():
        raise MateError("asset not found", status=404)
    return p


# ---- Live2D Cubism Core ----

def core_path() -> Path:
    return root() / "_runtime" / "live2dcubismcore.min.js"


def core_status() -> dict[str, Any]:
    p = core_path()
    if p.is_file():
        return {"installed": True, "size": p.stat().st_size, "source": CORE_URL}
    return {"installed": False, "source": CORE_URL}


def store_core(body: bytes) -> dict[str, Any]:
    if not (10_000 <= len(body) <= 8 * 1024 * 1024) or b"Live2DCubismCore" not in body:
        raise MateError("the download is not the Live2D Cubism Core script", status=502)
    p = core_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".part")
    tmp.write_bytes(body)
    os.replace(tmp, p)
    return core_status()


def guess_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"
