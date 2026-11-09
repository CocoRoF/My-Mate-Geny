"""Read, Write, Edit, MultiEdit and NotebookEdit.

As in Claude Code: a file that exists is read before it is changed, and changed only if nobody changed it since (the
model would otherwise overwrite what it never saw). Reading shows numbered lines (``cat -n``), images as images, PDFs
as text per page, notebooks cell by cell.
"""

from __future__ import annotations

import base64
import io
import json
import os
from typing import Any

from app.harness.tools.base import Tool, ToolContext, ToolOutput, obj, to_thread

MAX_LINES = 2000
MAX_LINE = 2000
MAX_READ_BYTES = 256 * 1024
IMAGE_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
_IMG_EDGE = 1568
_IMG_BYTES = 3_700_000


def _mtime(path: str) -> int:
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return 0


def _seen(ctx: ToolContext, path: str) -> None:
    ctx.runtime.read_files[path] = _mtime(path)


def _stale(ctx: ToolContext, path: str) -> str | None:
    """Why a file that exists may not be changed now, or None."""
    if not os.path.exists(path):
        return None
    seen = ctx.runtime.read_files.get(path)
    if seen is None:
        return "File has not been read yet. Read it first before writing to it."
    if _mtime(path) != seen:
        return ("File has been modified since it was read (by the user or a linter). Read it again before "
                "changing it.")
    return None


def image_for_model(data: bytes, media_type: str) -> tuple[str, str]:
    """(media type, base64) small enough for every vendor: at most 1568 px on the long edge, under ~3.7 MB."""
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(data))
        if max(img.size) > _IMG_EDGE or len(data) > _IMG_BYTES or media_type not in IMAGE_EXT.values():
            img.thumbnail((_IMG_EDGE, _IMG_EDGE))
            out = io.BytesIO()
            if img.mode in ("RGBA", "LA", "P"):
                img.save(out, "PNG", optimize=True)
                media_type = "image/png"
            else:
                img.convert("RGB").save(out, "JPEG", quality=85)
                media_type = "image/jpeg"
            data = out.getvalue()
    except Exception:  # noqa: BLE001 - send it as it is
        pass
    return media_type, base64.b64encode(data).decode()


def _numbered(lines: list[str], start: int) -> str:
    out = []
    for i, line in enumerate(lines, start):
        line = line.rstrip("\n").rstrip("\r")
        if len(line) > MAX_LINE:
            line = line[:MAX_LINE] + "… [line truncated]"
        out.append(f"{i:>6}\t{line}")
    return "\n".join(out)


def _read_pdf(path: str, pages: str | None) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        return "Reading PDFs needs the pypdf package, which isn't installed."
    reader = PdfReader(path)
    total = len(reader.pages)
    first, last = 1, min(total, 20)
    if pages:
        try:
            a, _, b = str(pages).partition("-")
            first = max(1, int(a))
            last = min(total, int(b) if b else first)
        except ValueError:
            pass
    parts = [f"PDF: {total} page{'s' if total != 1 else ''}; showing {first}-{last}."]
    for n in range(first, last + 1):
        text = (reader.pages[n - 1].extract_text() or "").strip()
        parts.append(f"--- page {n} ---\n{text or '(no text on this page — it may be an image)'}")
    if last < total and not pages:
        parts.append(f"(Use `pages` to read further, e.g. \"{last + 1}-{min(total, last + 20)}\".)")
    return "\n\n".join(parts)


def _read_notebook(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        nb = json.load(fh)
    out = []
    for i, cell in enumerate(nb.get("cells") or []):
        src = "".join(cell.get("source") or [])
        cid = cell.get("id") or str(i)
        out.append(f"<cell id=\"{cid}\" type=\"{cell.get('cell_type')}\">\n{src}\n</cell>")
        for o in cell.get("outputs") or []:
            text = "".join(o.get("text") or []) or "".join((o.get("data") or {}).get("text/plain") or [])
            if text:
                out.append(f"<output>\n{text[:4000]}\n</output>")
    return "\n".join(out) or "(empty notebook)"


class Read(Tool):
    name = "Read"
    description = (
        "Read a file by its absolute path. Text comes back with line numbers (cat -n style), up to 2000 lines from "
        "`offset` (a line number) — pass `offset` and `limit` for long files. Images are shown to you, PDFs come back "
        "as text per page (`pages`, e.g. \"1-5\"), notebooks cell by cell. Read a file before you Edit or Write it. "
        "You can read several files at once by calling Read more than once in one answer."
    )
    schema = obj({
        "file_path": {"type": "string", "description": "Absolute path of the file"},
        "offset": {"type": "number", "description": "Line number to start at"},
        "limit": {"type": "number", "description": "How many lines"},
        "pages": {"type": "string", "description": "PDF pages, e.g. \"1-5\""},
    }, ["file_path"])
    read_only = True
    parallel = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        path = ctx.path(args.get("file_path", ""))
        return await to_thread(self._read, path, args, ctx)

    def _read(self, path: str, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        if os.path.isdir(path):
            return ToolOutput.error(f"{path} is a directory. Use Bash `ls` or Glob to list it.")
        if not os.path.exists(path):
            return ToolOutput.error(f"File does not exist: {path}")
        ext = os.path.splitext(path)[1].lower()
        try:
            if ext in IMAGE_EXT:
                with open(path, "rb") as fh:
                    media, data = image_for_model(fh.read(), IMAGE_EXT[ext])
                _seen(ctx, path)
                return ToolOutput(f"Image: {path}", images=[{"media_type": media, "data": data}])
            if ext == ".pdf":
                _seen(ctx, path)
                return ToolOutput(_read_pdf(path, args.get("pages")))
            if ext == ".ipynb":
                _seen(ctx, path)
                return ToolOutput(_read_notebook(path))
            with open(path, "rb") as fh:
                head = fh.read(8192)
            if b"\x00" in head:
                return ToolOutput.error(f"{path} is a binary file; it can't be shown as text.")
            offset = max(1, int(args.get("offset") or 1))
            limit = max(1, min(int(args.get("limit") or MAX_LINES), 10_000))
            lines: list[str] = []
            total = 0
            with open(path, encoding="utf-8", errors="replace") as fh:
                for n, line in enumerate(fh, 1):
                    total = n
                    if offset <= n < offset + limit:
                        lines.append(line)
            _seen(ctx, path)
            if total == 0:
                return ToolOutput("<system-reminder>The file exists but is empty.</system-reminder>")
            if not lines:
                return ToolOutput(f"<system-reminder>The file has {total} lines; offset {offset} is past its end."
                                  "</system-reminder>")
            text = _numbered(lines, offset)
            if len(text.encode()) > MAX_READ_BYTES:
                return ToolOutput.error(f"That part of {path} is too large to show at once "
                                        f"({len(text.encode())} bytes). Read fewer lines with offset and limit.")
            end = offset + len(lines) - 1
            if end < total:
                text += f"\n\n(lines {offset}-{end} of {total}; use offset/limit for more)"
            return ToolOutput(text)
        except (OSError, ValueError) as exc:
            return ToolOutput.error(f"Could not read {path}: {exc}")


def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.hrh-tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.write(content)
    try:
        os.chmod(tmp, os.stat(path).st_mode & 0o7777)
    except OSError:
        pass
    os.replace(tmp, path)


def _snippet(content: str, needle: str, context: int = 4) -> str:
    idx = content.find(needle) if needle else -1
    lines = content.splitlines()
    if idx < 0:
        return _numbered(lines[: min(len(lines), 2 * context + 1)], 1)
    line_no = content.count("\n", 0, idx)
    span = needle.count("\n")
    a = max(0, line_no - context)
    b = min(len(lines), line_no + span + context + 1)
    return _numbered(lines[a:b], a + 1)


class Write(Tool):
    name = "Write"
    description = ("Write a file (absolute path), replacing what is there. An existing file must have been read "
                   "first. Prefer Edit for changes to an existing file; don't create documentation files unless asked.")
    schema = obj({
        "file_path": {"type": "string", "description": "Absolute path of the file"},
        "content": {"type": "string", "description": "The whole new content"},
    }, ["file_path", "content"])

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        path = ctx.path(args.get("file_path", ""))
        why = _stale(ctx, path)
        if why:
            return ToolOutput.error(why)
        existed = os.path.exists(path)
        try:
            await to_thread(_write, path, str(args.get("content") or ""))
        except OSError as exc:
            return ToolOutput.error(f"Could not write {path}: {exc}")
        _seen(ctx, path)
        return ToolOutput(f"The file {path} has been updated." if existed else f"File created successfully at: {path}")


def _apply(content: str, old: str, new: str, replace_all: bool) -> tuple[str | None, str]:
    if old == new:
        return None, "old_string and new_string are the same; nothing to change."
    n = content.count(old)
    if n == 0:
        return None, "String to replace not found in file. It must match exactly, including whitespace."
    if n > 1 and not replace_all:
        return None, (f"Found {n} matches of the string to replace, but replace_all is false. Add surrounding lines "
                      "to make it unique, or set replace_all to replace every one.")
    return (content.replace(old, new) if replace_all else content.replace(old, new, 1)), ""


class Edit(Tool):
    name = "Edit"
    description = (
        "Replace text in a file (absolute path): `old_string` must match the file exactly — whitespace and indentation "
        "included, without the line-number prefix Read shows — and only once, unless `replace_all` is set. Read the "
        "file first. An empty `old_string` on a file that doesn't exist creates it with `new_string`."
    )
    schema = obj({
        "file_path": {"type": "string", "description": "Absolute path of the file"},
        "old_string": {"type": "string", "description": "The exact text to replace"},
        "new_string": {"type": "string", "description": "What to put there instead"},
        "replace_all": {"type": "boolean", "description": "Replace every occurrence"},
    }, ["file_path", "old_string", "new_string"])

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        path = ctx.path(args.get("file_path", ""))
        old, new = str(args.get("old_string") or ""), str(args.get("new_string") or "")
        if not os.path.exists(path):
            if old:
                return ToolOutput.error(f"File does not exist: {path}")
            await to_thread(_write, path, new)
            _seen(ctx, path)
            return ToolOutput(f"File created successfully at: {path}")
        why = _stale(ctx, path)
        if why:
            return ToolOutput.error(why)
        try:
            content = await to_thread(lambda: open(path, encoding="utf-8", newline="").read())
        except (OSError, UnicodeDecodeError) as exc:
            return ToolOutput.error(f"Could not read {path}: {exc}")
        if not old:
            return ToolOutput.error("old_string is empty but the file exists; use Write to replace the whole file.")
        updated, err = _apply(content, old, new, bool(args.get("replace_all")))
        if updated is None:
            return ToolOutput.error(err)
        await to_thread(_write, path, updated)
        _seen(ctx, path)
        return ToolOutput(f"The file {path} has been updated. Here's the result of running `cat -n` on a snippet of "
                          f"the edited file:\n{_snippet(updated, new)}")


class MultiEdit(Tool):
    name = "MultiEdit"
    description = ("Several Edits to one file (absolute path), applied in order, all or none. Each edit is "
                   "{old_string, new_string, replace_all?} with Edit's rules, against the file as the edits before it "
                   "left it. Read the file first.")
    schema = obj({
        "file_path": {"type": "string", "description": "Absolute path of the file"},
        "edits": {"type": "array", "items": obj({
            "old_string": {"type": "string"},
            "new_string": {"type": "string"},
            "replace_all": {"type": "boolean"},
        }, ["old_string", "new_string"]), "description": "The edits, in order"},
    }, ["file_path", "edits"])

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        path = ctx.path(args.get("file_path", ""))
        edits = args.get("edits") or []
        if not isinstance(edits, list) or not edits:
            return ToolOutput.error("No edits given.")
        creating = not os.path.exists(path)
        if not creating:
            why = _stale(ctx, path)
            if why:
                return ToolOutput.error(why)
            content = await to_thread(lambda: open(path, encoding="utf-8", newline="").read())
        else:
            content = ""
        for i, e in enumerate(edits, 1):
            old, new = str(e.get("old_string") or ""), str(e.get("new_string") or "")
            if creating and i == 1 and not old:
                content = new
                continue
            updated, err = _apply(content, old, new, bool(e.get("replace_all")))
            if updated is None:
                return ToolOutput.error(f"Edit {i}: {err} No edits were applied.")
            content = updated
        await to_thread(_write, path, content)
        _seen(ctx, path)
        return ToolOutput(f"Applied {len(edits)} edit{'s' if len(edits) != 1 else ''} to {path}.")


class NotebookEdit(Tool):
    name = "NotebookEdit"
    description = ("Change one cell of a Jupyter notebook (absolute path): replace its source, insert a new cell "
                   "after it (or at the start without `cell_id`), or delete it.")
    schema = obj({
        "notebook_path": {"type": "string", "description": "Absolute path of the .ipynb file"},
        "cell_id": {"type": "string", "description": "The cell's id (or its index)"},
        "new_source": {"type": "string", "description": "The cell's new source"},
        "cell_type": {"type": "string", "enum": ["code", "markdown"]},
        "edit_mode": {"type": "string", "enum": ["replace", "insert", "delete"]},
    }, ["notebook_path", "new_source"])

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        path = ctx.path(args.get("notebook_path", ""))
        why = _stale(ctx, path) if os.path.exists(path) else f"Notebook does not exist: {path}"
        if why:
            return ToolOutput.error(why)
        with open(path, encoding="utf-8") as fh:
            nb = json.load(fh)
        cells = nb.setdefault("cells", [])
        mode = args.get("edit_mode") or "replace"
        cid = args.get("cell_id")
        idx = None
        if cid is not None:
            for i, c in enumerate(cells):
                if c.get("id") == cid:
                    idx = i
            if idx is None and str(cid).isdigit() and int(cid) < len(cells):
                idx = int(cid)
            if idx is None:
                return ToolOutput.error(f"No cell with id {cid}.")
        source = str(args.get("new_source") or "")
        if mode == "delete":
            if idx is None:
                return ToolOutput.error("Which cell? Give cell_id.")
            cells.pop(idx)
        elif mode == "insert":
            kind = args.get("cell_type") or "code"
            cell = {"cell_type": kind, "metadata": {}, "source": source.splitlines(True)}
            if kind == "code":
                cell.update(outputs=[], execution_count=None)
            cells.insert(0 if idx is None else idx + 1, cell)
        else:
            if idx is None:
                return ToolOutput.error("Which cell? Give cell_id.")
            cells[idx]["source"] = source.splitlines(True)
            if args.get("cell_type"):
                cells[idx]["cell_type"] = args["cell_type"]
        await to_thread(_write, path, json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
        _seen(ctx, path)
        return ToolOutput(f"Notebook {path}: cell {mode}d.")
