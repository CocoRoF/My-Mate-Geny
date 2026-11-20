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
* **A conversation forwarded from another chat** (+ → 대화 전달, origin
  ``forward``: docs/chat-forward.md) is a transcript file too, but it goes into
  the message itself (``<forwarded_chat>``), whatever the engine: it is what the
  user wants this agent to know, not a file to open if needed.
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
    # what it is, when that is more than its name (one of several screen pictures: "main screen (the one in use)")
    label: str = ""
    # a picture of their screen the app sent along (a share, a trigger's look), not a file the user gave
    screen: bool = False
    # another chat's conversation the user forwarded (its transcript, read from ``path`` into the message)
    forwarded: bool = False

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


FORWARD_CHARS = 80_000  # a forwarded chat's transcript in the message (the file is written within this)


def forwarded_text(a: Attachment) -> str:
    try:
        with open(a.path, encoding="utf-8", errors="replace") as fh:
            text = fh.read(FORWARD_CHARS + 1)
    except OSError:
        return "(the forwarded conversation's file is missing on the server)"
    return text if len(text) <= FORWARD_CHARS else text[:FORWARD_CHARS].rstrip() + "\n…[truncated]"


def forward_note(fwd: list[Attachment]) -> str:
    """Conversations the user forwarded from their other chats, in full, so this agent knows them."""
    if not fwd:
        return ""
    parts = []
    for a in fwd:
        parts.append(
            f'<forwarded_chat id="{a.id}" name="{_file_attr(a.name)}">\n'
            "The user forwarded this conversation from another of their chats so that you know what was said and done "
            "there (oldest first; the other agent's tool use is summarised as 'Actions'). Take it in as context for this "
            "chat; act on it as the user's message says.\n\n"
            f"{forwarded_text(a)}\n</forwarded_chat>")
    return "\n\n".join(parts)


def attachment_note(atts: list[Attachment], *, inline_images: bool) -> str:
    """Plain-text manifest appended to the user's message."""
    atts = [a for a in atts if not a.forwarded]
    if not atts:
        return ""
    lines = ["<attachments>", "The user attached these files to this message:"]
    for a in atts:
        where = f"path: {a.path}"
        if a.remote_path:
            where = f"on the remote host: {a.remote_path} (local copy: {a.path})"
        tag = " [image, shown inline]" if a.is_image and inline_images else ""
        what = f" — {a.label}" if a.label else ""
        lines.append(f"- {a.name} — {a.mime}, {human_size(a.size)}{tag}{what} — {where}")
    lines.append(
        "Open them with your tools when you need their contents (e.g. Read for text, "
        "PDFs and images)."
    )
    lines.append("</attachments>")
    return "\n".join(lines)


def _file_attr(v: str) -> str:
    return v.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace("\n", " ")


def _screen_note(shots: list[Attachment], *, inline_images: bool) -> str:
    """The pictures of their screen the app sent along: what they have in front of them, never something they showed."""
    lines = ["<screen>",
             "Their screen right now, sent along by the app because they share it: not something they sent you, only so "
             "you know what they have in front of them. (To hand it to a chat, pass its id like a file's.)"]
    for a in shots:
        what = "shown to you" if inline_images else "could not be shown to you"
        lines.append(f"- [{a.id}] {what}" + (f" — {a.label}" if a.label else ""))
    lines.append("</screen>")
    return "\n".join(lines)


def inline_note(atts: list[Attachment], *, inline_images: bool) -> str:
    """Manifest for an engine that can't open files (a Mate): ids to forward
    files with, what each one is, and the readable contents. Pictures of their
    screen are told apart (``screen``): the user didn't give those."""
    shots = [a for a in atts if a.screen]
    atts = [a for a in atts if not a.screen and not a.forwarded]
    screen = _screen_note(shots, inline_images=inline_images) if shots else ""
    if not atts:
        return screen
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
        label = f" — {a.label}" if a.label else ""
        lines.append(f"- [{a.id}] {a.name} — {a.mime}, {human_size(a.size)} — {what}{label}")
    lines.append("</attachments>")
    for a in atts:
        if a.extracted is not None:
            lines.append(f'<file id="{a.id}" name="{_file_attr(a.name)}">\n{a.extracted}\n</file>')
    return "\n".join(lines) + (f"\n{screen}" if screen else "")


def compose_text(text: str, atts: list[Attachment], *, inline_images: bool, inline_files: bool = False) -> str:
    note = (inline_note(atts, inline_images=inline_images) if inline_files
            else attachment_note(atts, inline_images=inline_images))
    fwd = [a for a in atts if a.forwarded]
    files = [a for a in atts if not a.screen and not a.forwarded]
    body = text.strip() or (
        "(No message text — the user forwarded the conversation below: take it in, and tell them briefly what you "
        "understood from it and how it bears on this chat.)" if fwd and not files
        else "(No message text — see the attached files.)" if files or fwd else "")
    return "\n\n".join(x for x in (body, forward_note(fwd), note) if x)


def claude_image_block(a: Attachment) -> dict:
    with open(a.inline_path, "rb") as fh:
        data = base64.b64encode(fh.read()).decode()
    return {"type": "image", "source": {"type": "base64", "media_type": a.inline_mime, "data": data}}
