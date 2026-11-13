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
from app.mate.life.days import is_mmdd
from app.mate.store import (DEFAULT_GREETINGS, GENDERS, ICON_FOLDER, MateError, normalize_avatar, takes_frame,
                            with_new_clips)
from app.services._ids import new_id

CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
MAX_ENTRIES = 5000
IMPORT_DIR_RE = re.compile(r"^(pack|l2d|lv)-[0-9a-f]{8,}$")
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
    "greet": "greet", "sleepy": "sleepy", "smirk": "smile", "worried": "worried", "worry": "worried", "anxious": "worried",
    "nervous": "worried",
}
CLIP_KINDS = ("idle", "talk", "listen", "think", "react", "away", "life")
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


# ---- profile pictures: a mate's (her assets, profile/) and the user's (<root>/_profile/) ----

ICON_MAX_BYTES = 8 * 1024 * 1024   # what may come in (the page sends a small square; a phone's photo is bigger)
ICON_EDGE = 512                    # what is kept: a square at most this big
_ICON_FORMATS = {"PNG", "JPEG", "WEBP", "GIF", "BMP"}
_USER_ICON_RE = re.compile(r"^user-icon-[0-9a-f]{12}\.(?:webp|png)$")


def make_icon(data: bytes) -> tuple[bytes, str]:
    """A picture -> (the bytes, the extension) of a square profile picture: what the crop dialog sent, checked and
    written again (a picture's own metadata and anything else in the file stay behind), the middle of a picture that
    isn't square, at most :data:`ICON_EDGE` px. WebP where Pillow writes it, else PNG."""
    import io

    from PIL import Image, ImageOps, UnidentifiedImageError, features

    if not data:
        raise MateError("no picture")
    if len(data) > ICON_MAX_BYTES:
        raise MateError(f"the picture is larger than {ICON_MAX_BYTES // (1024 * 1024)} MB", status=413)
    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format not in _ICON_FORMATS:
                raise MateError("not a picture (PNG, JPEG, WebP, GIF or BMP)")
            if probe.width * probe.height > 50_000_000:
                raise MateError("the picture is too large")
            probe.verify()
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im).convert("RGBA")
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError, SyntaxError) as exc:
        raise MateError("not a picture (PNG, JPEG, WebP, GIF or BMP)") from exc
    side = min(im.size)
    if not side:
        raise MateError("an empty picture")
    left, top = (im.width - side) // 2, (im.height - side) // 2
    im = im.crop((left, top, left + side, top + side))
    if side > ICON_EDGE:
        im = im.resize((ICON_EDGE, ICON_EDGE), Image.LANCZOS)
    out = io.BytesIO()
    if features.check("webp"):
        im.save(out, "WEBP", quality=90, method=4)
        return out.getvalue(), "webp"
    im.save(out, "PNG", optimize=True)
    return out.getvalue(), "png"


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def save_mate_icon(mate_id: str, data: bytes) -> str:
    """Her profile picture among her assets (``profile/icon-<hash>.<ext>``: a new picture, a new URL) -> its URL. The
    one before it goes."""
    icon, ext = make_icon(data)
    digest = hashlib.sha256(icon).hexdigest()[:12]
    name = f"icon-{digest}.{ext}"
    _write(assets_dir(mate_id) / ICON_FOLDER / name, icon)
    drop_mate_icons(mate_id, keep=name)
    # (named by what is in it: the URL is kept for good, and ``?v`` tells the asset route so)
    return f"{asset_url(mate_id, f'{ICON_FOLDER}/{name}')}?v={digest}"


def drop_mate_icons(mate_id: str, keep: str = "") -> None:
    folder = assets_dir(mate_id) / ICON_FOLDER
    if folder.is_dir():
        for p in folder.glob("icon-*"):
            if p.name != keep:
                p.unlink(missing_ok=True)


def user_icon_dir() -> Path:
    return root() / "_profile"


def save_user_icon(data: bytes) -> str:
    """The user's own picture (one for the app) -> its file name; the one before it goes."""
    icon, ext = make_icon(data)
    name = f"user-icon-{hashlib.sha256(icon).hexdigest()[:12]}.{ext}"
    _write(user_icon_dir() / name, icon)
    drop_user_icons(keep=name)
    return name


def drop_user_icons(keep: str = "") -> None:
    folder = user_icon_dir()
    if folder.is_dir():
        for p in folder.glob("user-icon-*"):
            if p.name != keep:
                p.unlink(missing_ok=True)


def resolve_user_icon(name: str) -> Path:
    """The file behind the user's picture URL (KeyError if there is none)."""
    if not _USER_ICON_RE.match(name or ""):
        raise KeyError("no such picture")
    p = user_icon_dir() / name
    if not p.is_file():
        raise KeyError("no such picture")
    return p


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
    return set(re.findall(rf"/api/mates/{re.escape(mate_id)}/assets/((?:pack|l2d|lv)-[0-9a-f]+)/", blob))


def outfit_upload_dir(mate_id: str, oid: str) -> Path:
    """Where the files uploaded for one outfit live (stills and clips, not packs)."""
    return assets_dir(mate_id) / "outfits" / safe_rel(oid)


def avatar_picture(avatar: dict[str, Any], mate_id: str) -> Path | None:
    """The file of a video/photo avatar's base picture (a built-in's or an imported pack's), if it has one."""
    rig = avatar.get("rig") if isinstance(avatar.get("rig"), dict) else {}
    url = str(rig.get("home") or (rig.get("stills") or {}).get("neutral") or "").split("?")[0]
    try:
        if url.startswith("/api/mates/builtin/"):
            key, _, rel = url[len("/api/mates/builtin/"):].partition("/")
            return resolve_builtin(key, rel)
        prefix = f"/api/mates/{mate_id}/assets/"
        return resolve_asset(mate_id, url[len(prefix):]) if url.startswith(prefix) else None
    except MateError:
        return None


def _clean_frame(raw: Any) -> dict[str, Any] | None:
    """A set's ``frame`` as a rig carries it: where her face sits, in fractions of the picture."""
    if not isinstance(raw, dict):
        return None
    face = raw.get("face")
    if not (isinstance(face, list) and len(face) == 3 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in face)):
        return None
    if face[2] <= 0:
        return None
    top = raw.get("top") if isinstance(raw.get("top"), (int, float)) else 0.0
    out = {"face": [float(v) for v in face], "top": float(top), "how": "outline" if raw.get("how") == "outline" else "face",
           "for": str(raw.get("for") or "")}
    outline = raw.get("outline")
    if isinstance(outline, list) and len(outline) == 3 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in outline) and outline[2] > 0:
        out["outline"] = [float(v) for v in outline]
    return out


def outline_frame(path: Path) -> dict[str, Any] | None:
    """Where her face sits, estimated from the outline of a cut-out (the same estimate as the pipeline's when it finds no face:
    this server has no face detector). A picture without a transparent background has no outline: None."""
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(path) as im:
            alpha = im.convert("RGBA").getchannel("A").point(lambda v: 255 if v > 25 else 0)
    except (OSError, UnidentifiedImageError):
        return None
    W, H = alpha.size
    box = alpha.getbbox()
    if box is None or box == (0, 0, W, H):
        return None
    left, top, right, bottom = box
    band = alpha.crop((0, top, W, top + max(1, (bottom - top) // 4))).getbbox()
    if band is None:
        return None
    size = max(40.0, (band[2] - band[0]) * 0.55)
    return {"face": [round((band[0] + band[2]) / 2 / W, 4), round((top + size * 0.85) / H, 4), round(size / H, 4)],
            "top": round(top / H, 4), "how": "outline"}


def framed(avatar: Any, mate_id: str) -> Any:
    """A video/photo set always says where her face sits, so it can stand where her default set stands: what it came with while
    that is still about its picture (``for``), else measured here."""
    rig = avatar.get("rig") if isinstance(avatar, dict) and avatar.get("kind") in ("video", "photo") else None
    if not isinstance(rig, dict):
        return avatar
    home = PurePosixPath(str(rig.get("home") or (rig.get("stills") or {}).get("neutral") or "").split("?")[0]).name
    frame = _clean_frame(rig.get("frame"))
    if frame and frame["for"] == home:
        return avatar
    try:
        picture = avatar_picture(avatar, mate_id)
    except KeyError:  # (a picture that isn't there yet)
        picture = None
    measured = outline_frame(picture) if picture else None
    out = {k: v for k, v in rig.items() if k != "frame"}
    if measured:
        out["frame"] = {**measured, "for": home}
    return {**avatar, "rig": out}


def inherit_rig_tuning(avatar: dict[str, Any], base: dict[str, Any]) -> dict[str, Any]:
    """A new outfit set reacts like her default set: its emotion choices carry over (normalize_rig drops the clips
    this set doesn't have)."""
    if avatar.get("kind") != "video" or base.get("kind") != "video":
        return avatar
    rig, old = dict(avatar["rig"]), base["rig"]
    for key in ("emotions", "emotion_stills"):
        if old.get(key):
            rig[key] = {**(rig.get(key) or {}), **old[key]}
    return {**avatar, "rig": rig}


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
    """Unpack an avatar zip -> Avatar document (video/photo pack, Live2D, or a LivLiv package: a ``.livliv`` is a zip)."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise MateError("not a zip file") from exc
    with zf:
        members = _strip_common_root(_zip_members(zf))
        rels = [rel for _, rel in members]
        rig = _shallowest([r for r in rels if r.split("/")[-1] == "rig.json"])
        model = _shallowest([r for r in rels if r.endswith(".model3.json")])
        lv = _shallowest([r for r in rels if r.split("/")[-1] == "model.json"]) if rig is None and model is None else None
        if lv is not None:
            info = next(i for i, r in members if r == lv)
            if info.file_size > LIVLIV_MAX_MODEL_JSON:
                raise MateError("model.json is larger than 4 MB")
            try:
                head = json.loads(zf.read(info).decode("utf-8-sig"))
            except (ValueError, UnicodeDecodeError) as exc:
                raise MateError(f"cannot read model.json: {exc}") from exc
            if not is_livliv_model(head):
                lv = None
        if rig is None and model is None and lv is None:
            raise MateError("no rig.json (video/photo pack), *.model3.json (Live2D) or a LivLiv model.json in the zip")
        prefix = "lv" if lv is not None else "pack" if rig is not None and (model is None or rig.count("/") <= model.count("/")) else "l2d"
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
            if prefix == "lv":
                assert lv is not None
                return build_livliv_avatar(mate_id, dest / lv)
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
        if c.get("doing"):
            clip["doing"] = str(c["doing"])
        small = url(c.get("small"))
        if small:
            clip["small"] = small
        thumb = url(c.get("thumb"))
        if thumb:
            clip["thumb"] = thumb
        if c.get("loop"):
            clip["loop"] = True
        if c.get("disabled"):
            clip["disabled"] = True
        if c.get("fade_in"):  # (it starts on its own face, not her rest one: the stage dissolves into it)
            clip["fade_in"] = True
        if c.get("face"):  # (a mood family's clip: it starts and ends on that mood's face — the stage stays in it while she feels it)
            clip["face"] = str(c["face"])[:32]
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
    frame = _clean_frame(raw.get("frame"))
    if frame:
        rig["frame"] = frame
    if emotions:
        rig["emotions"] = emotions
    es = raw.get("emotion_stills")
    if isinstance(es, dict):
        es = {str(k): v for k, v in es.items() if isinstance(v, str) and (v == "" or v in stills)}
        if es:
            rig["emotion_stills"] = es
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


# ---- LivLiv (a 2.5D character in layers, played by LivLiv Player; its format: FORMAT.md of livliv-dev/player) ----

#: the formats it reads, newest version of each (a newer one is refused, as the player would)
LIVLIV_FORMATS = {"livliv-model": 4, "livemaker-puppet": 3}
#: the player's own limits (src/runtime/format.ts LIMITS): refused here before anyone draws it
LIVLIV_MAX_MODEL_JSON, LIVLIV_MAX_CANVAS, LIVLIV_MAX_LAYERS = 4 * 1024 * 1024, 8192, 512
_LIVLIV_EXPR = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


def is_livliv_model(data: Any) -> bool:
    """A LivLiv ``model.json`` (format 4, or the format 3 before it, which has no ``format`` field)."""
    if not isinstance(data, dict):
        return False
    if "format" in data:
        return data.get("format") in LIVLIV_FORMATS
    return isinstance(data.get("layers"), list) and isinstance(data.get("anchors"), dict)


def build_livliv_avatar(mate_id: str, model_path: Path) -> dict[str, Any]:
    """A LivLiv ``model.json`` inside the mate's assets -> Avatar livliv. Checked as the player would before it draws (a newer
    format, a canvas or layer count past its limits, a layer image that isn't there); what it says about itself is kept: name,
    expressions (standard ids are the same on every model: smile, shy, angry, sad, surprised…), author, licence, the mark it asks
    for, and its cover and avatar pictures."""
    a_root = assets_dir(mate_id).resolve()
    model_path = model_path.resolve()
    if a_root not in model_path.parents:
        raise MateError("model outside the mate's assets")
    if model_path.stat().st_size > LIVLIV_MAX_MODEL_JSON:
        raise MateError("model.json is larger than 4 MB")
    data = _read_json(model_path)
    if not is_livliv_model(data):
        raise MateError("model.json is not a LivLiv model")
    fmt = str(data.get("format") or "livemaker-puppet")
    try:
        version = int(data.get("version") or LIVLIV_FORMATS[fmt])
    except (TypeError, ValueError) as exc:
        raise MateError("model.json: version is not a number") from exc
    if version > LIVLIV_FORMATS[fmt]:
        raise MateError(f"a LivLiv model of format {version}: newer than this app reads")
    canvas = data.get("canvas")
    if (not isinstance(canvas, list) or len(canvas) != 2 or not all(isinstance(v, int) and 16 <= v <= LIVLIV_MAX_CANVAS for v in canvas)):
        raise MateError(f"model.json: canvas must be [width, height], 16–{LIVLIV_MAX_CANVAS} px")
    layers = data.get("layers")
    if not isinstance(layers, list) or not layers or len(layers) > LIVLIV_MAX_LAYERS:
        raise MateError(f"model.json: 1–{LIVLIV_MAX_LAYERS} layers")
    base = model_path.parent

    def in_package(ref: Any, what: str) -> str:
        if not isinstance(ref, str) or not ref:
            raise MateError(f"model.json: {what} names no file")
        rel = safe_rel(ref)
        if not (base / rel).is_file():
            raise MateError(f"the package has no {rel} ({what})")
        return rel

    for layer in layers:
        if not isinstance(layer, dict):
            raise MateError("model.json: a layer is not an object")
        lid = str(layer.get("id") or "?")
        in_package(layer.get("texture"), f"layer {lid}")
        for key in ("mask", "talk", "brow_tex"):
            if layer.get(key) is not None:
                in_package(layer[key], f"layer {lid} {key}")
        for frame in layer.get("frames") or []:
            in_package(frame, f"layer {lid} frames")
    files_ = data.get("files") if isinstance(data.get("files"), dict) else {}

    def picture(key: str) -> str:
        try:
            rel = in_package(files_.get(key), key) if files_.get(key) else ""
        except MateError:
            return ""
        return asset_url(mate_id, (base / rel).relative_to(a_root).as_posix()) if rel else ""

    exprs = [str(e.get("id")) for e in data.get("expressions") or [] if isinstance(e, dict) and _LIVLIV_EXPR.match(str(e.get("id") or ""))]
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    lic = meta.get("license") if isinstance(meta.get("license"), dict) else {}
    out = {
        "model": asset_url(mate_id, model_path.relative_to(a_root).as_posix()),
        "name": str(data.get("name") or "")[:64],
        "canvas": list(canvas),
        "expressions": exprs[:64],
        "cover": picture("cover"),
        "avatar": picture("avatar"),
        "author": str((meta.get("author") or {}).get("name") or "")[:80] if isinstance(meta.get("author"), dict) else "",
        "license": {k: str(lic[k])[:300] for k in ("id", "url") if isinstance(lic.get(k), str)},
        "watermark": str((meta.get("watermark") or {}).get("kind") or "") if isinstance(meta.get("watermark"), dict) else "",
    }
    return {"kind": "livliv", "livliv": out}


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
        if p.suffix.lower() == ".livliv":
            return {"kind": "livliv", "package": p, "name": p.stem}
        if p.name == "model.json" and is_livliv_model(_read_json(p)):
            return {"kind": "livliv", "folder": p.parent, "name": str(_read_json(p).get("name") or p.parent.name)}
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
    if (p / "model.json").is_file() and is_livliv_model(data := _read_json(p / "model.json")):
        return {"kind": "livliv", "folder": p, "name": str(data.get("name") or p.name)}
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


def import_local_livliv(mate_id: str, info: dict[str, Any]) -> dict[str, Any]:
    """A LivLiv package on this server: a ``.livliv`` file (unpacked like an upload) or its folder (copied)."""
    if info.get("package") is not None:
        return import_zip(mate_id, str(info["package"]))
    dest, _ = _new_import_dir(mate_id, "lv")
    try:
        _copy_tree(info["folder"], dest)
        return build_livliv_avatar(mate_id, dest / "model.json")
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


def ailism_persona(doc: dict[str, Any], *, styled: bool = False) -> tuple[str, dict[str, Any]]:
    """An ailism MateDoc -> (name, persona), keeping everything the author
    wrote: profile, appearance, background, relationship, knowledge, world,
    personality, speech + every example exchange, the opening lines, the
    greeting and return lines, interests and the author's note. The persona
    still has ``speech`` / ``address`` (the store moves them into the
    conversation style). ``styled``: today's layout (an import) — the opening
    and return lines join the speech (they are her voice), the interests the
    description, the instructions keep only the author's note; without it, the
    layout bundles had before (legacy_persona compares against that)."""
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
    voice = []  # (lines in her voice)
    if opening:
        voice.append("When you first meet the user you open like this:\n" + "\n".join(opening))
    returning = [fill(x) for x in mate.get("returning") or [] if str(x).strip()]
    if returning:
        voice.append("When the user comes back after a while, you greet them in this spirit:\n"
                     + "\n".join(f"- {x}" for x in returning))
    interests = [str(x).strip() for x in mate.get("interests") or [] if str(x).strip()]
    if styled:
        speech = "\n\n".join(x for x in (speech, *voice) if x)
        if interests:
            description += ("\n\n" if description else "") + "Things you like to talk about:\n" + ", ".join(interests)
    else:
        notes += voice
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


# ---- built-in mates (bundled content: personas/, mates/, assets/, voices/) ----
#
# personas/<key>.json is what the mate is told — English, written from the
# authors' content — plus per-language display data (names, greetings).
# mates/<key>.json is the original content (body, voice) and, mapped by
# legacy_persona(), the persona that was bundled before personas/ existed: the
# first migration compares against it to tell the user's edits from bundled text.

BUILTIN_DIR = Path(__file__).resolve().parent / "builtin"
BUILTIN_ORDER = ("chaerin", "seoa", "mao")  # the first is the default mate on a new install
#: bundled once, no longer shipped: what an install still has of them is settled at startup (MateService._retire_builtins).
#: A key that ships again is left alone (Seoa, 2026-11: a new character under that name, once her pack is there)
RETIRED_BUILTINS = ("estelle", "seoa")
#: bundled characters the user may already have made by hand before they shipped: when one first ships on an install, the
#: user's own mate of her name becomes her (MateService._adopt_builtins: once, only beyond doubt)
ADOPTED_BUILTINS = ("seoa",)
# persona fields a bundle sets for every language (greeting and name are per language) — the character only
BUNDLE_FIELDS = ("description", "personality", "instructions", "gender", "birthday")
#: who a bundled character is when her personas/<key>.json doesn't say (Mao's files are not in the repository)
BUILTIN_GENDERS = {"chaerin": "female", "seoa": "female", "mao": "female"}
#: her birthday (MM-DD) when her personas/<key>.json doesn't say (Mao's: Walpurgis Night, a trainee witch's)
BUILTIN_BIRTHDAYS = {"mao": "04-30"}
# conversation-style fields (prefs) a bundle sets and later updates merge field by field like the persona's; the
# character's own speech level / address (``prefs.defaults``) are bundle data and always follow the bundle
BUNDLE_STYLE_FIELDS = ("speech_style", "address")
# bumped when the way bundles are composed changes (part of builtin_hash: every built-in is merged again once)
BUNDLE_FORMAT = "4"  # (3: persona.gender; 4: persona.birthday)


def _bundled() -> list[str]:
    """Every character with a ``mates/<key>.json``, shipped or still waiting for her pack."""
    keys = [x.stem for x in (BUILTIN_DIR / "mates").glob("*.json")] if (BUILTIN_DIR / "mates").is_dir() else []
    return sorted(keys, key=lambda k: (BUILTIN_ORDER.index(k) if k in BUILTIN_ORDER else len(BUILTIN_ORDER), k))


def builtin_keys() -> list[str]:
    """The bundled characters that ship: those whose pack is complete (builtin_missing)."""
    return [k for k in _bundled() if not builtin_missing(k)]


def builtin_waiting() -> dict[str, list[str]]:
    """Bundled characters that don't ship yet -> what their pack still lacks."""
    return {k: missing for k in _bundled() if (missing := builtin_missing(k))}


def _rig_refs(raw: dict[str, Any]) -> list[str]:
    """Every file a rig names: its home and portrait pictures, its stills, its clips with their small copies and thumbs."""
    refs = [raw.get("home"), raw.get("portrait"), *((raw.get("stills") or {}).values() if isinstance(raw.get("stills"), dict) else [])]
    for c in raw.get("clips") or []:
        if isinstance(c, dict):
            refs += [c.get("src"), c.get("small"), c.get("thumb")]
    return [r.strip() for r in refs if isinstance(r, str) and r.strip()]


def _ref_name(ref: str) -> str:
    """A rig reference as a path in its folder (ailism's ``asset:<pack>/`` dropped)."""
    r = ref[len("asset:"):] if ref.startswith("asset:") else ref
    return r.split("/", 1)[1] if ref.startswith("asset:") and "/" in r else r


def builtin_missing(key: str) -> list[str]:
    """What a bundled character still lacks before she ships, as paths in ``assets/<key>/``: her body — ``live2d.json``, else
    ``rig.json`` with its home picture and every file it names — and each outfit ``outfits.json`` lists, with every file of
    its rig. [] = complete. Nothing half-made shows up: until then she is no built-in (Seoa's pack comes after her text)."""
    folder = BUILTIN_DIR / "assets" / key
    if (folder / "live2d.json").is_file():
        return []
    try:
        raw = _read_json(folder / "rig.json") if (folder / "rig.json").is_file() else \
            (((builtin_doc(key).get("doc") or {}).get("mate") or {}).get("body"))
    except MateError:
        return ["rig.json"]
    if not isinstance(raw, dict) or not (raw.get("home") or (raw.get("stills") or {}).get("neutral")):
        return ["rig.json"]
    missing = [_ref_name(r) for r in _rig_refs(raw) if _ref_rel(r, folder) is None]
    manifest = folder / "outfits.json"
    try:
        items = (_read_json(manifest).get("items") or []) if manifest.is_file() else []
    except (MateError, AttributeError):
        return [*missing, "outfits.json"]
    for item in (i for i in items if isinstance(i, dict)):
        rel = str(item.get("rig") or "")
        try:
            path = (folder / safe_rel(rel)) if rel else None
            sub = _read_json(path) if path is not None and path.is_file() else None
        except MateError:
            sub = None
        if not isinstance(sub, dict):
            missing.append(rel or f"outfits.json: {item.get('id')}")
            continue
        here = path.parent.relative_to(folder).as_posix()
        missing += [f"{here}/{_ref_name(r)}" for r in _rig_refs(sub) if _ref_rel(r, path.parent) is None]
    return list(dict.fromkeys(missing))


def builtin_doc(key: str) -> dict[str, Any]:
    return _read_json(BUILTIN_DIR / "mates" / f"{key}.json")


def legacy_persona(doc: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """(name, persona) as bundled before personas/: the ailism MateDoc mapped by
    ailism_persona(), or our own ``{name, persona}`` doc (Mao). (The old shape: it
    still has ``speech`` / ``address``.)"""
    if isinstance(doc.get("persona"), dict):
        name = str(doc.get("name") or doc.get("key") or "Mate").strip()
        return name, {k: str(v) for k, v in doc["persona"].items() if isinstance(v, (str, int, float))}
    return ailism_persona(doc)


def _lines(v: Any) -> list[str]:
    items = v if isinstance(v, list) else [v] if v else []
    return [str(x).strip() for x in items if str(x).strip()]


def _text(src: dict[str, Any], k: str) -> str:
    v = src.get(k)  # (a list keeps its blank lines: paragraph breaks)
    return "\n".join(str(x).rstrip() for x in v).strip() if isinstance(v, list) else str(v or "").strip()


def compose_persona(src: dict[str, Any]) -> dict[str, str]:
    """A personas/<key>.json document -> the persona fields all languages share: who she is.
    tagline/profile/appearance/background/relationship/knowledge/world (+ interests) -> description;
    personality; the author's note -> instructions; gender (female | male) and birthday (MM-DD) as they are. How she talks is
    compose_style()."""
    sections = [
        ("", _text(src, "tagline")),
        ("", _text(src, "profile")),
        ("Appearance", _text(src, "appearance")),
        ("Background", _text(src, "background")),
        ("Your relationship with the user", _text(src, "relationship")),
        ("What you know", _text(src, "knowledge")),
        ("Your world", _text(src, "world")),
        ("Things you like to talk about", ", ".join(_lines(src.get("interests")))),
    ]
    gender = str(src.get("gender") or "").strip().lower()
    born = str(src.get("birthday") or "").strip()
    return {
        "description": "\n\n".join(f"{t}:\n{x}" if t else x for t, x in sections if x),
        "personality": _text(src, "personality"),
        "instructions": _text(src, "note"),
        "gender": gender if gender in GENDERS else "",
        "birthday": born if is_mmdd(born) else "",
    }


def compose_style(src: dict[str, Any]) -> dict[str, Any]:
    """A personas/<key>.json document -> how she talks: ``speech_style`` (speech habits + the example exchanges +
    her opening and return lines — all in her voice) and ``defaults`` (her own speech level and how she calls the
    user, from the document's structured ``style``: ``formality``, ``address`` per language, ``self_ref``).
    ``address``: a literal address the bundle sets as the user's setting (older bundles; normally empty)."""
    speech = [_text(src, "speech")]
    for k, title in (("examples", "Example exchanges"),
                     ("examples_ko", "The same exchanges as they go in Korean (your own words)")):
        ex = [e for e in src.get(k) or [] if isinstance(e, dict) and str(e.get("content") or "").strip()]
        if ex:
            speech.append(title + ":\n" + "\n".join(
                ("user: " if e.get("speaker") == "user" else "you: ") + str(e["content"]).strip().replace("\n", " / ")
                for e in ex))
    for k, title in (("opening", "When you first meet the user you open like this:"),
                     ("opening_ko", "In Korean:"),
                     ("returning", "When the user comes back after a while, you greet them in this spirit:"),
                     ("returning_ko", "In Korean:")):
        lines = _lines(src.get(k))
        if lines:
            bullet = "- " if k.startswith("returning") else ""
            speech.append(title + "\n" + "\n".join(bullet + x for x in lines))
    st = src.get("style") if isinstance(src.get("style"), dict) else {}
    address = st.get("address")
    return {
        "speech_style": "\n\n".join(x for x in speech if x),
        "address": str(src.get("address") or ""),
        "defaults": {"formality": str(st.get("formality") or ""),
                     "address": _per_lang(address) if isinstance(address, dict) else
                     ({"": str(address)} if isinstance(address, str) and address.strip() else {}),
                     "self_ref": _per_lang(st.get("self_ref")) if isinstance(st.get("self_ref"), dict) else
                     ({"": str(st["self_ref"])} if isinstance(st.get("self_ref"), str) and st["self_ref"].strip()
                      else {})},
    }


def _per_lang(v: Any) -> dict[str, str]:
    if not isinstance(v, dict):
        return {}
    return {str(k).lower(): str(x).strip() for k, x in v.items() if isinstance(x, str) and x.strip()}


def builtin_bundle(key: str, doc: dict[str, Any] | None = None) -> dict[str, Any]:
    """What a built-in is bundled with: ``{language, names, greetings, persona, style}``
    (names/greetings per language code, persona = the BUNDLE_FIELDS, style = compose_style). It is also
    the snapshot kept per built-in mate, so the next update can tell the fields
    the user edited from the ones still as bundled."""
    path = BUILTIN_DIR / "personas" / f"{key}.json"
    if not path.is_file():
        out = legacy_bundle(doc if doc is not None else builtin_doc(key))
    else:
        src = _read_json(path)
        if not isinstance(src, dict):
            raise MateError(f"built-in {key}: personas/{key}.json must be an object")
        names = _per_lang(src.get("names")) or {"en": key}
        out = {"language": str(src.get("language") or "ko"), "names": names,
               "greetings": _per_lang(src.get("greetings")), "persona": compose_persona(src), "style": compose_style(src)}
    out["persona"]["gender"] = out["persona"].get("gender") or BUILTIN_GENDERS.get(key, "")
    out["persona"]["birthday"] = out["persona"].get("birthday") or BUILTIN_BIRTHDAYS.get(key, "")
    return out


def legacy_bundle(doc: dict[str, Any]) -> dict[str, Any]:
    """The bundle as it was before personas/ (one language: the source's)."""
    name, p = legacy_persona(doc)
    lang = str(p.get("language") or "ko")
    return {"language": lang, "names": {lang: name},
            "greetings": {lang: str(p["greeting"])} if p.get("greeting") else {},
            "persona": {k: str(p.get(k) or "") for k in BUNDLE_FIELDS},
            "style": {"speech_style": str(p.get("speech") or "").strip(), "address": str(p.get("address") or ""),
                      "defaults": {"formality": "", "address": {}, "self_ref": {}}}}


def pick_lang(texts: dict[str, str], language: str) -> str:
    """The text for ``language`` ("ko-KR" -> "ko"), else the English one, else any."""
    lang = (language or "").strip().lower().split("-")[0]
    return texts.get(lang) or texts.get("en") or texts.get("") or next(iter(texts.values()), "")


def localized(bundle: dict[str, Any], language: str | None = None) -> tuple[str, dict[str, str]]:
    """(name, persona) of a bundle for a reply language (default: the bundle's own)."""
    lang = language or str(bundle.get("language") or "ko")
    persona = {**bundle["persona"], "greeting": pick_lang(bundle.get("greetings") or {}, lang), "language": lang}
    return pick_lang(bundle.get("names") or {}, lang), persona


def style_defaults(bundle: dict[str, Any], language: str | None = None) -> dict[str, str]:
    """``prefs.defaults`` of a bundle for a reply language: the character's own speech level and address."""
    d = ((upgrade_snapshot(bundle).get("style") or {}).get("defaults")) or {}
    lang = language or str(bundle.get("language") or "ko")
    return {"formality": str(d.get("formality") or ""), "address": pick_lang(d.get("address") or {}, lang),
            "self_ref": pick_lang(d.get("self_ref") or {}, lang)}


def bundle_prefs(bundle: dict[str, Any], language: str | None = None) -> dict[str, Any]:
    """The conversation style a fresh built-in mate starts with (the user's own fields stay at their defaults)."""
    st = upgrade_snapshot(bundle)["style"]
    out: dict[str, Any] = {"speech_style": st.get("speech_style") or "", "defaults": style_defaults(bundle, language)}
    if st.get("address"):
        out["address"] = st["address"]
    return out


def builtin_snapshot(key: str, doc: dict[str, Any]) -> dict[str, Any]:
    """The current bundle of a built-in with its (normalized) avatar."""
    return {**builtin_bundle(key, doc), "avatar": normalize_avatar(builtin_avatar(key, doc) or {"kind": "none"}),
            "outfits": builtin_outfits(key)}


def builtin_outfits(key: str) -> list[dict[str, Any]]:
    """Optional ready-made wardrobe packs, served by the existing built-in asset route."""
    root = (BUILTIN_DIR / "assets" / key).resolve()
    manifest = root / "outfits.json"
    if not manifest.is_file():
        return []
    outfits = []
    for item in _read_json(manifest).get("items", []):
        oid = str(item["id"])
        if not re.fullmatch(r"[a-z0-9_-]{1,60}", oid):
            raise MateError("invalid bundled outfit id")
        rel = safe_rel(item["rig"])
        path = (root / rel).resolve()
        if root not in path.parents:
            raise MateError("bundled outfit outside asset folder")
        folder = path.parent
        avatar = rig_avatar(_read_json(path), folder,
                            lambda ref, folder=folder: builtin_url(key, (folder / ref).relative_to(root).as_posix()))
        need = (item.get("unlock") or {}).get("affinity")
        if need is not None and (not isinstance(need, int) or isinstance(need, bool) or not 1 <= need <= 100):
            raise MateError("invalid bundled outfit unlock: affinity is 1 to 100")
        outfits.append({"id": oid, "name": item["name"], "note": item.get("note", ""),
                        **({"unlock": {"affinity": need}} if need else {}),
                        **({"feel": item["feel"]} if item.get("feel") else {}),
                        **({"indoors": True} if item.get("indoors") is True else {}),  # (only worn at home: life/runtime._dress)
                        "avatar": normalize_avatar(avatar)})
    return outfits


def upgrade_snapshot(snap: dict[str, Any]) -> dict[str, Any]:
    """A snapshot recorded before the conversation style existed kept ``speech`` / ``address`` in its persona: the
    same values, in today's shape (``style``). Today's snapshots come back as they are."""
    if isinstance(snap.get("style"), dict):
        return snap
    persona = dict(snap.get("persona") or {})
    style = {"speech_style": str(persona.pop("speech", "") or "").strip(), "address": str(persona.pop("address", "") or ""),
             "defaults": {"formality": "", "address": {}, "self_ref": {}}}
    return {**snap, "persona": persona, "style": style}


def legacy_snapshot(mate: dict[str, Any], doc: dict[str, Any], avatar: dict[str, Any]) -> dict[str, Any]:
    """What a built-in synced before snapshots existed counts as bundled: all of
    it if the user never edited it; else what the old bundle (the source mapped
    by legacy_persona()) had, and the bundled avatar (its files are unchanged)."""
    if not mate.get("customized"):
        p = mate["persona"]
        s = mate.get("prefs") or {}
        return {"names": {"": mate["name"]}, "greetings": {"": p.get("greeting") or ""},
                "persona": {k: p.get(k) or "" for k in BUNDLE_FIELDS},
                "style": {k: s.get(k) or "" for k in BUNDLE_STYLE_FIELDS}, "avatar": mate["avatar"]}
    return {**legacy_bundle(doc), "avatar": avatar}


def _without_dropped(avatar: dict[str, Any], old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    """A body the user edited keeps the edits, but a clip the bundle took out is gone with its files. (One they put there
    themselves, under the same name, stays.)"""
    rig = avatar.get("rig")
    if not isinstance(rig, dict):
        return avatar
    still = {c.get("id") for c in (new.get("rig") or {}).get("clips") or []}
    gone = {c.get("id"): c.get("src") for c in ((old or {}).get("rig") or {}).get("clips") or [] if c.get("id") not in still}
    clips = [c for c in rig.get("clips") or [] if c.get("id") not in gone or c.get("src") != gone[c.get("id")]]
    return avatar if len(clips) == len(rig.get("clips") or []) else {**avatar, "rig": {**rig, "clips": clips}}


def merge_builtin(mate: dict[str, Any], prev: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """The update a new bundle makes to a built-in mate, field by field: what
    still equals the previous bundle (``prev``: a snapshot) becomes the new
    bundle's, what the user changed stays — persona fields and the bundled
    conversation-style fields (speech habits) alike. The character's own speech
    level / address (``prefs.defaults``) always follow the bundle: they are its
    data, the user's choice is the setting itself (``formality``, ``address``).
    Name and greeting follow the mate's reply language; the language itself (and
    voice, model, memories, default, the user's style settings) is never
    touched. Returns a store patch ({} = nothing to change)."""
    prev, new = upgrade_snapshot(prev), upgrade_snapshot(new)
    p = mate["persona"]
    s = mate.get("prefs") or {}
    lang = p.get("language") or str(new.get("language") or "ko")
    patch: dict[str, Any] = {}
    name = pick_lang(new.get("names") or {}, lang)
    if name and name != mate["name"] and mate["name"] in (prev.get("names") or {}).values():
        patch["name"] = name
    persona: dict[str, str] = {}
    old_greetings = set((prev.get("greetings") or {}).values()) or {""}
    greeting = pick_lang(new.get("greetings") or {}, lang)
    if greeting != (p.get("greeting") or "") and (p.get("greeting") or "") in old_greetings:
        persona["greeting"] = greeting
    for k in BUNDLE_FIELDS:
        cur, was, now = p.get(k) or "", (prev.get("persona") or {}).get(k) or "", new["persona"].get(k) or ""
        if cur == was and now != cur:
            persona[k] = now
    if persona:
        patch["persona"] = persona
    prefs: dict[str, Any] = {}
    for k in BUNDLE_STYLE_FIELDS:
        cur, was, now = s.get(k) or "", (prev.get("style") or {}).get(k) or "", new["style"].get(k) or ""
        if cur == was and now != cur:
            prefs[k] = now
    defaults = style_defaults(new, lang)
    if defaults != {**{"formality": "", "address": "", "self_ref": ""}, **(s.get("defaults") or {})}:
        prefs["defaults"] = defaults
    if prefs:
        patch["prefs"] = prefs
    if "avatar" in new and prev.get("avatar") is not None and mate["avatar"] == prev["avatar"] \
            and new["avatar"] != mate["avatar"]:
        patch["avatar"] = new["avatar"]
    elif "avatar" in new:
        # (a body the user edited: still measured right, and nothing in it the bundle no longer has)
        edited = takes_frame(with_new_clips(_without_dropped(mate["avatar"], prev.get("avatar"), new["avatar"]), prev.get("avatar"), new["avatar"]), new["avatar"])
        if edited != mate["avatar"]:
            patch["avatar"] = edited
    return patch


def localize_patch(mate: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """A PATCH that switches the reply language also swaps the name and greeting
    for that language's bundled version — when they still are bundled ones (a
    built-in's names/greetings, the default Geny greeting); user-written ones stay."""
    p = patch.get("persona")
    if not isinstance(p, dict) or not isinstance(p.get("language"), str):
        return patch
    old, lang = mate["persona"].get("language") or "", p["language"].strip()
    if not lang or lang == old:
        return patch
    names: dict[str, str] = {}
    greetings: dict[str, str] = {}
    key = mate.get("builtin")
    if key:
        try:
            b = builtin_bundle(key) if key in builtin_keys() else {}
        except (MateError, OSError, ValueError):
            b = {}
        names, greetings = b.get("names") or {}, b.get("greetings") or {}
    else:
        greetings = dict(DEFAULT_GREETINGS)
    out = {**patch, "persona": dict(p)}
    name = patch["name"] if isinstance(patch.get("name"), str) else mate["name"]
    if names and name.strip() in names.values() and pick_lang(names, lang):
        out["name"] = pick_lang(names, lang)
    greeting = p["greeting"] if isinstance(p.get("greeting"), str) else mate["persona"].get("greeting") or ""
    if greetings and greeting.strip() in greetings.values() and pick_lang(greetings, lang):
        out["persona"]["greeting"] = pick_lang(greetings, lang)
    if key and b:  # the character's own address is per language too (e.g. “<name> 님” in Korean, the name in English)
        out["prefs"] = {**(patch["prefs"] if isinstance(patch.get("prefs"), dict) else {}),
                        "defaults": style_defaults(b, lang)}
    return out


def builtin_url(key: str, rel: str) -> str:
    return f"/api/mates/builtin/{quote(key)}/{quote(rel)}"


def builtin_avatar(key: str, doc: dict[str, Any]) -> dict[str, Any] | None:
    """The body of a bundled character: ``assets/<key>/live2d.json`` (a Live2D
    model inside that folder), else ``rig.json`` / the doc's ailism body."""
    folder = BUILTIN_DIR / "assets" / key
    if (folder / "live2d.json").is_file():
        return builtin_live2d(key, _read_json(folder / "live2d.json"))
    raw = _read_json(folder / "rig.json") if (folder / "rig.json").is_file() else ((doc.get("doc") or {}).get("mate") or {}).get("body")
    if not folder.is_dir() or not raw:
        return None
    return rig_avatar(raw, folder.resolve(), lambda rel: builtin_url(key, rel))


def builtin_live2d(key: str, cfg: Any) -> dict[str, Any]:
    """``live2d.json`` (fields of the Live2D avatar, ``model`` relative to the
    character's folder) -> Avatar live2d served from /api/mates/builtin/<key>/."""
    if not isinstance(cfg, dict):
        raise MateError("live2d.json must be an object")
    folder = (BUILTIN_DIR / "assets" / key).resolve()
    rel = safe_rel(str(cfg.get("model") or ""))
    model_path = (folder / rel).resolve()
    if folder not in model_path.parents or not model_path.is_file():
        raise MateError(f"built-in {key}: {rel} is missing")
    model3 = _read_json(model_path)
    refs = model3.get("FileReferences") if isinstance(model3, dict) else None
    moc = refs.get("Moc") if isinstance(refs, dict) else None
    if not isinstance(moc, str) or not (model_path.parent / moc).is_file():
        raise MateError(f"built-in {key}: {rel} is not a Cubism model with its .moc3")
    groups = set((refs.get("Motions") or {}) if isinstance(refs.get("Motions"), dict) else {})
    out: dict[str, Any] = {"model": builtin_url(key, rel)}
    for k in ("scale", "x", "y"):
        if isinstance(cfg.get(k), (int, float)) and not isinstance(cfg.get(k), bool):
            out[k] = float(cfg[k])
    idle = str(cfg.get("idle_group") or "")
    out["idle_group"] = idle if idle in groups else ("Idle" if "Idle" in groups else (sorted(groups)[0] if groups else "Idle"))
    emotions = {str(e): v for e, v in (cfg.get("emotions") or {}).items()
                if isinstance(v, (str, int)) and not isinstance(v, bool)}
    if emotions:
        out["emotions"] = emotions
    motions = {str(e): str(g) for e, g in (cfg.get("emotion_motions") or {}).items() if str(g) in groups}
    if motions:
        out["emotion_motions"] = motions
    taps = {}
    for hit, t in (cfg.get("tap_motions") or {}).items():
        if isinstance(t, dict) and str(t.get("group") or "") in groups:
            taps[str(hit)] = {"group": str(t["group"]), **({"index": int(t["index"])} if isinstance(t.get("index"), int) else {})}
    if taps:
        out["tap_motions"] = taps
    if isinstance(cfg.get("hidden_parts"), list) and cfg["hidden_parts"]:
        out["hidden_parts"] = [str(x) for x in cfg["hidden_parts"]]
    return {"kind": "live2d", "live2d": out}


def builtin_voice_dir(key: str) -> Path | None:
    v = BUILTIN_DIR / "voices" / key
    return v if (v / "voice.json").is_file() else None


def builtin_hash(key: str) -> str:
    """Changes when the bundled character changes (persona, body, files)."""
    h = hashlib.sha256(f"format:{BUNDLE_FORMAT}".encode())
    assets = BUILTIN_DIR / "assets" / key
    for f in sorted([BUILTIN_DIR / "mates" / f"{key}.json", BUILTIN_DIR / "personas" / f"{key}.json",
                     *assets.rglob("*"), *(BUILTIN_DIR / "voices" / key).glob("*")]):
        if f.is_file():
            st = f.stat()
            name = str(f.relative_to(assets)) if assets in f.parents else f.name
            h.update(f"{name}:{st.st_size}".encode())
            if f.suffix == ".json":
                h.update(f.read_bytes())
    return h.hexdigest()[:16]


def resolve_builtin(key: str, rel: str) -> Path:
    if not re.match(r"^[a-z0-9_-]{1,40}$", key or "") or not (BUILTIN_DIR / "assets" / key).is_dir():
        raise MateError("asset not found", status=404)
    try:
        rel = safe_rel(rel)
    except MateError as exc:
        raise MateError("asset not found", status=404) from exc
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
