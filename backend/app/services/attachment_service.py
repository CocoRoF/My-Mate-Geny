"""Chat attachments: storage, image processing, and linking to messages.

Lifecycle (mirrors claude.ai): a file is uploaded as soon as it's added to
the composer (``message_id`` NULL), can be removed while pending, and is
linked to the user message when the chat is sent.

Layout on the runtime host::

    <uploads_root>/<session_id>/<attachment_id>/<original name>
    <uploads_root>/<session_id>/<attachment_id>/model.jpg|png   (images only)

``model.*`` is the image the model actually receives: downscaled to a long
edge of 1568 px and kept under ~3.75 MB so it fits the API's per-image limit
once base64-encoded. It doubles as the lightweight chat thumbnail.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import re
import shutil
import unicodedata
from pathlib import Path
from typing import Any

from fastapi import UploadFile

from app.config import settings
from app.db import Database
from app.providers._attachments import Attachment
from app.services._ids import new_id, now_iso

_CHUNK = 1024 * 1024
_MODEL_MAX_EDGE = 1568
_MODEL_MAX_BYTES = 3_750_000
_MODEL_MIMES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

# Magic-byte sniffing beats trusting the browser's content-type (clipboard
# pastes often arrive as "image.png" with an empty or generic type).
_MAGIC: list[tuple[bytes, int, str]] = [
    (b"\x89PNG\r\n\x1a\n", 0, "image/png"),
    (b"\xff\xd8\xff", 0, "image/jpeg"),
    (b"GIF87a", 0, "image/gif"),
    (b"GIF89a", 0, "image/gif"),
    (b"WEBP", 8, "image/webp"),
    (b"BM", 0, "image/bmp"),
    (b"%PDF-", 0, "application/pdf"),
]


class AttachmentError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _safe_name(name: str | None) -> str:
    name = unicodedata.normalize("NFC", os.path.basename((name or "").replace("\\", "/")))
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip().lstrip(".")
    if not name:
        name = "file"
    # Filesystems cap names at 255 BYTES; Hangul is 3 bytes/char in UTF-8.
    limit = 180
    if len(name.encode()) > limit:
        stem, ext = os.path.splitext(name)
        ext = ext if len(ext.encode()) <= 20 else ""
        budget = limit - len(ext.encode())
        stem = stem.encode()[:budget].decode(errors="ignore")
        name = (stem or "file") + ext
    return name


def _sniff(head: bytes) -> str | None:
    for magic, offset, mime in _MAGIC:
        if head[offset: offset + len(magic)] == magic:
            return mime
    return None


def _process_image(path: str, mime: str) -> dict[str, Any] | None:
    """Open with Pillow; return dims + an optional model-sized variant.
    ``None`` means "not a raster image we can handle" (treat as a file)."""
    try:
        from PIL import Image, ImageOps
    except ImportError:  # pragma: no cover - Pillow is a declared dependency
        return None
    try:
        with Image.open(path) as im:
            im.load()
            width, height = im.size
            fmt_mime = Image.MIME.get(im.format or "", mime)
            needs_variant = (
                fmt_mime not in _MODEL_MIMES
                or max(width, height) > _MODEL_MAX_EDGE
                or os.path.getsize(path) > _MODEL_MAX_BYTES
                or getattr(im, "is_animated", False)  # first frame only for the model
            )
            out: dict[str, Any] = {"width": width, "height": height, "mime": fmt_mime}
            if not needs_variant:
                return out
            frame = ImageOps.exif_transpose(im) or im
            frame.thumbnail((_MODEL_MAX_EDGE, _MODEL_MAX_EDGE))
            has_alpha = frame.mode in ("RGBA", "LA") or (frame.mode == "P" and "transparency" in frame.info)
            base = os.path.dirname(path)
            if has_alpha:
                variant, vmime = os.path.join(base, "model.png"), "image/png"
                frame.convert("RGBA").save(variant, "PNG", optimize=True)
            else:
                variant, vmime = os.path.join(base, "model.jpg"), "image/jpeg"
                frame.convert("RGB").save(variant, "JPEG", quality=88, optimize=True)
            # Still too heavy (huge alpha PNG)? Fall back to a flattened JPEG.
            if os.path.getsize(variant) > _MODEL_MAX_BYTES:
                os.unlink(variant)
                variant, vmime = os.path.join(base, "model.jpg"), "image/jpeg"
                frame.convert("RGB").save(variant, "JPEG", quality=80, optimize=True)
            out.update(model_path=variant, model_mime=vmime)
            return out
    except Exception:  # noqa: BLE001 - corrupt / unsupported => plain file
        return None


class AttachmentService:
    def __init__(self, db: Database) -> None:
        self._db = db

    # ---- paths ----

    @staticmethod
    def session_dir(sid: str) -> Path:
        return settings.uploads_root_path / sid

    # ---- write ----

    async def save(self, sid: str, upload: UploadFile) -> dict[str, Any]:
        name = _safe_name(upload.filename)
        aid = new_id("att_")
        folder = self.session_dir(sid) / aid
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / name
        limit = settings.upload_max_mb * 1024 * 1024
        size = 0
        head = b""
        try:
            with open(dest, "wb") as fh:
                while True:
                    chunk = await upload.read(_CHUNK)
                    if not chunk:
                        break
                    if len(head) < 32:
                        head += chunk[: 32 - len(head)]
                    size += len(chunk)
                    if size > limit:
                        raise AttachmentError(
                            f"'{name}' is larger than the {settings.upload_max_mb} MB limit", status=413
                        )
                    fh.write(chunk)
            if size == 0:
                raise AttachmentError(f"'{name}' is empty")
        except BaseException:
            shutil.rmtree(folder, ignore_errors=True)
            raise

        declared = (upload.content_type or "").split(";")[0].strip().lower()
        mime = (
            _sniff(head)
            or (declared if declared and declared != "application/octet-stream" else None)
            or mimetypes.guess_type(name)[0]
            or "application/octet-stream"
        )

        kind, width, height, model_path, model_mime = "file", None, None, None, None
        if mime.startswith("image/") and mime != "image/svg+xml":
            info = await asyncio.to_thread(_process_image, str(dest), mime)
            if info is not None:
                kind = "image"
                width, height = info["width"], info["height"]
                mime = info["mime"]
                model_path, model_mime = info.get("model_path"), info.get("model_mime")

        self._db.execute(
            """
            INSERT INTO attachments
                (id, session_id, message_id, name, mime, size, kind, width, height,
                 path, model_path, model_mime, created_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (aid, sid, name, mime, size, kind, width, height, str(dest), model_path, model_mime, now_iso()),
        )
        return self.out(self.get(aid))

    async def save_bytes(self, sid: str, name: str, mime: str, data: bytes, *, tag: str) -> dict[str, Any]:
        """Store bytes the agent produced (e.g. an image a tool returned) as an
        artifact: same storage/serving as uploads, linked to ``tag`` instead of
        a message so it never shows up as a pending composer attachment."""
        name = _safe_name(name)
        aid = new_id("att_")
        folder = self.session_dir(sid) / aid
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / name
        await asyncio.to_thread(dest.write_bytes, data)
        mime = _sniff(data[:32]) or mime or "application/octet-stream"
        kind, width, height, model_path, model_mime = "file", None, None, None, None
        if mime.startswith("image/") and mime != "image/svg+xml":
            info = await asyncio.to_thread(_process_image, str(dest), mime)
            if info is not None:
                kind, width, height = "image", info["width"], info["height"]
                mime = info["mime"]
                model_path, model_mime = info.get("model_path"), info.get("model_mime")
        self._db.execute(
            """
            INSERT INTO attachments
                (id, session_id, message_id, name, mime, size, kind, width, height,
                 path, model_path, model_mime, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (aid, sid, tag, name, mime, len(data), kind, width, height, str(dest), model_path, model_mime, now_iso()),
        )
        return self.out(self.get(aid))

    # ---- read ----

    def get(self, aid: str) -> dict[str, Any] | None:
        row = self._db.query_one("SELECT * FROM attachments WHERE id = ?", (aid,))
        return dict(row) if row else None

    @staticmethod
    def out(row: dict[str, Any]) -> dict[str, Any]:
        """Public shape (no filesystem paths)."""
        return {
            "id": row["id"],
            "name": row["name"],
            "mime": row["mime"],
            "size": row["size"],
            "kind": row["kind"],
            "width": row["width"],
            "height": row["height"],
            "url": f"/api/attachments/{row['id']}/content",
            "preview_url": f"/api/attachments/{row['id']}/content?variant=preview",
            "created_at": row["created_at"],
        }

    def pending(self, sid: str, ids: list[str]) -> list[dict[str, Any]]:
        """Validate composer attachments for a send: exist, same session, unsent."""
        if len(ids) > settings.upload_max_files:
            raise AttachmentError(f"at most {settings.upload_max_files} files per message")
        rows: list[dict[str, Any]] = []
        for aid in dict.fromkeys(ids):  # dedupe, keep order
            row = self.get(aid)
            if row is None or row["session_id"] != sid:
                raise AttachmentError(f"attachment not found: {aid}", status=404)
            if row["message_id"] is not None:
                raise AttachmentError(f"attachment already sent: {row['name']}")
            if not os.path.exists(row["path"]):
                raise AttachmentError(f"attachment file is missing on disk: {row['name']}", status=410)
            rows.append(row)
        return rows

    def by_message(self, sid: str) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {}
        for r in self._db.query(
            "SELECT * FROM attachments WHERE session_id = ? AND message_id IS NOT NULL "
            "AND message_id NOT LIKE 'artifact:%' ORDER BY created_at",
            (sid,),
        ):
            out.setdefault(r["message_id"], []).append(self.out(dict(r)))
        return out

    @staticmethod
    def to_provider(row: dict[str, Any]) -> Attachment:
        return Attachment(
            id=row["id"],
            name=row["name"],
            mime=row["mime"],
            size=row["size"],
            kind=row["kind"],
            path=row["path"],
            model_path=row["model_path"],
            model_mime=row["model_mime"],
        )

    # ---- link / delete ----

    def link(self, ids: list[str], message_id: str) -> None:
        for aid in ids:
            self._db.execute(
                "UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL",
                (message_id, aid),
            )

    def delete_pending(self, aid: str) -> bool:
        row = self.get(aid)
        if row is None or row["message_id"] is not None:
            return False
        self._db.execute("DELETE FROM attachments WHERE id = ?", (aid,))
        shutil.rmtree(os.path.dirname(row["path"]), ignore_errors=True)
        return True

    def purge_abandoned(self, max_age_s: int = 24 * 3600) -> int:
        """Composer uploads never sent (message_id NULL) older than a day."""
        from datetime import datetime, timedelta, timezone

        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max_age_s)).isoformat()
        rows = self._db.query(
            "SELECT id, path FROM attachments WHERE message_id IS NULL AND created_at < ?", (cutoff,))
        for r in rows:
            self._db.execute("DELETE FROM attachments WHERE id = ?", (r["id"],))
            shutil.rmtree(os.path.dirname(r["path"]), ignore_errors=True)
        return len(rows)

    def purge_session(self, sid: str) -> None:
        shutil.rmtree(self.session_dir(sid), ignore_errors=True)

    def disk_usage(self) -> int:
        total = 0
        for root, _dirs, files in os.walk(settings.uploads_root_path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return total
