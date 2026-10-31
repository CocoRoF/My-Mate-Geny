"""Chat attachments as the providers see them.

Every attachment is a real file on the runtime host (and, for remote
sessions, also copied to the remote host). How it reaches the model:

* **Images** go inline — Claude gets ``image`` content blocks on the
  stream-json stdin, Codex gets ``--image <path>``. We send the downscaled
  ``model_path`` variant when there is one (API limits: ~5 MB / long edge).
* **Every file** (images included) is also listed in an ``<attachments>``
  note with its paths, so the agent can open it with its own tools (Read a
  PDF, copy a file into the project, unzip an archive, …).
* **Engines without file tools** (a Mate, ``inline_files``) get
  :func:`inline_note` instead: each file's id (to forward it to a chat), what
  it is, and its readable text inline (filled in by
  ``_inline_files.prepare_inline`` before the envelope is built).
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
    # Engines without file tools (Mate): the readable content that goes into
    # the message (None = not readable) and how it was read / what it is.
    extracted: str | None = None
    extract_note: str = ""

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


def _file_attr(v: str) -> str:
    return v.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace("\n", " ")


def inline_note(atts: list[Attachment], *, inline_images: bool) -> str:
    """Manifest for an engine that can't open files (a Mate): ids to forward
    files with, what each one is, and the readable contents."""
    if not atts:
        return ""
    lines = [
        "<attachments>",
        "The user attached these files to this message. You can't open files yourself: images are shown "
        "to you directly and the readable text of other files is included below. To hand files to a chat, "
        "pass their ids in the `attachments` argument of send_to_session / create_session — the chat gets "
        "them exactly like a user upload and can open everything, including what you can't read here.",
    ]
    for a in atts:
        if a.is_image:
            what = "image, shown to you" if inline_images else "image (could not be shown to you)"
        elif a.extracted is not None:
            what = f"{a.extract_note or 'text'}, included below"
        else:
            what = (f"{a.extract_note or 'a binary file'} — its contents are not available to you; "
                    "forward it to a chat if it needs to be opened")
        lines.append(f"- [{a.id}] {a.name} — {a.mime}, {human_size(a.size)} — {what}")
    lines.append("</attachments>")
    for a in atts:
        if a.extracted is not None:
            lines.append(f'<file id="{a.id}" name="{_file_attr(a.name)}">\n{a.extracted}\n</file>')
    return "\n".join(lines)


def compose_text(text: str, atts: list[Attachment], *, inline_images: bool, inline_files: bool = False) -> str:
    note = (inline_note(atts, inline_images=inline_images) if inline_files
            else attachment_note(atts, inline_images=inline_images))
    body = text.strip() or ("(No message text — see the attached files.)" if atts else "")
    return f"{body}\n\n{note}" if note else body


def claude_image_block(a: Attachment) -> dict:
    with open(a.inline_path, "rb") as fh:
        data = base64.b64encode(fh.read()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": a.inline_mime, "data": data}}
