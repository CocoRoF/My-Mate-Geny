"""Chat attachments as the providers see them.

Every attachment is a real file on the runtime host (and, for remote
sessions, also copied to the remote host). How it reaches the model:

* **Images** go inline — Claude gets ``image`` content blocks on the
  stream-json stdin, Codex gets ``--image <path>``. We send the downscaled
  ``model_path`` variant when there is one (API limits: ~5 MB / long edge).
* **Every file** (images included) is also listed in an ``<attachments>``
  note with its paths, so the agent can open it with its own tools (Read a
  PDF, copy a file into the project, unzip an archive, …).
"""

from __future__ import annotations

import base64
from dataclasses import dataclass


@dataclass
class Attachment:
    id: str
    name: str
    mime: str
    size: int
    kind: str                       # image | file
    path: str                       # original, on the runtime host
    model_path: str | None = None   # downscaled image for the model
    model_mime: str | None = None
    remote_path: str | None = None  # copy on the remote host (remote sessions)

    @property
    def is_image(self) -> bool:
        return self.kind == "image"

    @property
    def inline_path(self) -> str:
        return self.model_path or self.path

    @property
    def inline_mime(self) -> str:
        return self.model_mime or self.mime


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def attachment_note(atts: list[Attachment], *, inline_images: bool) -> str:
    """Plain-text manifest appended to the user's message."""
    if not atts:
        return ""
    lines = ["<attachments>", "The user attached these files to this message:"]
    for a in atts:
        where = f"path: {a.path}"
        if a.remote_path:
            where = f"on the remote host: {a.remote_path} (local copy: {a.path})"
        tag = " [image, shown inline]" if a.is_image and inline_images else ""
        lines.append(f"- {a.name} — {a.mime}, {human_size(a.size)}{tag} — {where}")
    lines.append(
        "Open them with your tools when you need their contents (e.g. Read for text, "
        "PDFs and images)."
    )
    lines.append("</attachments>")
    return "\n".join(lines)


def compose_text(text: str, atts: list[Attachment], *, inline_images: bool) -> str:
    note = attachment_note(atts, inline_images=inline_images)
    body = text.strip() or ("(No message text — see the attached files.)" if atts else "")
    return f"{body}\n\n{note}" if note else body


def claude_image_block(a: Attachment) -> dict:
    with open(a.inline_path, "rb") as fh:
        data = base64.b64encode(fh.read()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": a.inline_mime, "data": data}}
