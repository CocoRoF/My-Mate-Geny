"""Readable contents of attachments, for engines without file tools (Mate).

A mate engine runs with ``--tools ""``: it can't Read a file. So for mate
conversations the content goes into the message itself (see
``_attachments.inline_note``): text/code/markdown/CSV/JSON… as is, the text of
docx/pptx/xlsx/odt pulled out of their XML (stdlib only), PDF text via
``pdftotext`` (poppler) when the server has it. Everything is bounded (per
file, per message) and cut with a note. :func:`prepare_inline` blocks (file
reads, a subprocess): call it in a thread.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import zipfile
from xml.etree import ElementTree

from app.providers._attachments import Attachment

INLINE_FILE_CHARS = 20_000    # per file
INLINE_TOTAL_CHARS = 60_000   # per message
_READ_BYTES = 256 * 1024      # read at most this much of a text file
_XML_MAX_BYTES = 24 * 1024 * 1024  # an unpacked docx/pptx/xlsx part we are willing to parse
_PDF_PAGES = 40
_TEXT_MIMES = ("text/", "application/json", "application/xml", "application/javascript",
               "application/x-javascript", "application/x-yaml", "application/yaml", "application/toml",
               "application/x-sh", "application/x-python", "application/sql", "application/x-ndjson",
               "application/ld+json", "application/x-subrip", "image/svg+xml")
_TEXT_EXTS = {
    "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg",
    "conf", "env", "xml", "html", "htm", "css", "scss", "less", "svg", "log", "sql", "py", "js", "mjs", "cjs",
    "ts", "tsx", "jsx", "java", "kt", "kts", "go", "rs", "rb", "php", "c", "h", "cc", "cpp", "hpp", "cs", "swift",
    "m", "mm", "sh", "bash", "zsh", "fish", "ps1", "bat", "lua", "r", "pl", "dart", "scala", "vue", "svelte",
    "gradle", "properties", "gitignore", "dockerfile", "makefile", "tex", "srt", "vtt", "diff", "patch", "graphql",
    "proto", "tf", "hcl", "nix", "ex", "exs", "erl", "hs", "clj", "elm", "zig", "gd", "tscn", "tres", "ipynb",
}
_OFFICE = {"docx": "Word document", "pptx": "PowerPoint deck", "xlsx": "Excel workbook",
           "odt": "OpenDocument text", "odp": "OpenDocument presentation", "ods": "OpenDocument spreadsheet"}


def _ext(name: str) -> str:
    base = name.lower().rsplit("/", 1)[-1]
    if base in ("dockerfile", "makefile", ".gitignore", ".env"):
        return base.lstrip(".")
    return base.rsplit(".", 1)[-1] if "." in base else ""


def _is_text(a: Attachment) -> bool:
    return (a.mime or "").lower().startswith(_TEXT_MIMES) or _ext(a.name) in _TEXT_EXTS


def _read_text(path: str) -> tuple[str | None, bool]:
    """-> (text, cut). None when it doesn't look like text (NUL bytes)."""
    with open(path, "rb") as fh:
        raw = fh.read(_READ_BYTES + 1)
    cut = len(raw) > _READ_BYTES
    raw = raw[:_READ_BYTES]
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return raw.decode("utf-16"), cut
        except UnicodeDecodeError:
            pass
    if b"\x00" in raw[:8192]:
        return None, False
    return raw.decode("utf-8", errors="replace"), cut


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xml_text(data: bytes, para: set[str], text: set[str], tab: frozenset[str] = frozenset()) -> str:
    """Visible text of an OOXML part: the contents of ``text`` elements (runs,
    no children), a newline after each ``para`` element, a tab/newline for
    ``tab`` elements (``br`` = newline)."""
    out: list[str] = []
    for ev, el in ElementTree.iterparse(io.BytesIO(data), events=("start", "end")):
        name = _local(el.tag)
        if ev == "start":
            if name in tab:
                out.append("\n" if name == "br" else "\t")
            continue
        if name in text and el.text:
            out.append(el.text)
        if name in para:
            out.append("\n")
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()


def _odf_text(data: bytes) -> str:
    """Visible text of an ODF content.xml: one line per paragraph/heading."""
    out: list[str] = []
    for _ev, el in ElementTree.iterparse(io.BytesIO(data), events=("end",)):
        if _local(el.tag) in ("p", "h"):
            out.append("".join(el.itertext()))
            el.clear()
    return "\n".join(out).strip()


def _member(zf: zipfile.ZipFile, name: str) -> bytes | None:
    try:
        info = zf.getinfo(name)
    except KeyError:
        return None
    if info.file_size > _XML_MAX_BYTES:
        return None
    return zf.read(info)


def _numbered(names: list[str], pattern: str) -> list[str]:
    rx = re.compile(pattern)
    hits = [(int(m.group(1)), n) for n in names if (m := rx.fullmatch(n))]
    return [n for _, n in sorted(hits)]


def _xlsx_text(zf: zipfile.ZipFile, budget: int) -> str:
    shared: list[str] = []
    data = _member(zf, "xl/sharedStrings.xml")
    if data:
        for si in ElementTree.fromstring(data):
            shared.append("".join(t.text or "" for t in si.iter() if _local(t.tag) == "t"))
    names: dict[int, str] = {}
    wb = _member(zf, "xl/workbook.xml")
    if wb:
        sheets = [x for x in ElementTree.fromstring(wb).iter() if _local(x.tag) == "sheet"]
        names = {i + 1: (sh.get("name") or f"Sheet{i + 1}") for i, sh in enumerate(sheets)}
    parts: list[str] = []
    size = 0
    for n, sheet in enumerate(_numbered(zf.namelist(), r"xl/worksheets/sheet(\d+)\.xml"), 1):
        data = _member(zf, sheet)
        if not data:
            continue
        rows: list[str] = [f"## {names.get(n, f'Sheet{n}')}"]
        for row in (x for x in ElementTree.fromstring(data).iter() if _local(x.tag) == "row"):
            cells: list[str] = []
            for c in row:
                if _local(c.tag) != "c":
                    continue
                t = c.get("t")
                v = next((x.text for x in c if _local(x.tag) == "v"), None)
                if t == "s" and v is not None and v.isdigit() and int(v) < len(shared):
                    val = shared[int(v)]
                elif t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter() if _local(x.tag) == "t")
                else:
                    val = v or ""
                cells.append(val.replace("\t", " ").replace("\n", " "))
            line = "\t".join(cells).rstrip("\t")
            if line:
                rows.append(line)
                size += len(line) + 1
            if size > budget:
                break
        parts.append("\n".join(rows))
        if size > budget:
            break
    return "\n\n".join(parts)


def _office_text(path: str, ext: str, budget: int) -> str | None:
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        return None
    with zf:
        if ext == "docx":
            data = _member(zf, "word/document.xml")
            return _xml_text(data, {"p"}, {"t"}, frozenset({"tab", "br"})) if data else None
        if ext == "pptx":
            out: list[str] = []
            for i, name in enumerate(_numbered(zf.namelist(), r"ppt/slides/slide(\d+)\.xml"), 1):
                data = _member(zf, name)
                out.append(f"## Slide {i}\n{_xml_text(data, {'p'}, {'t'}) if data else ''}".rstrip())
                if sum(map(len, out)) > budget:
                    break
            return "\n\n".join(out) or None
        if ext == "xlsx":
            return _xlsx_text(zf, budget) or None
        data = _member(zf, "content.xml")  # odt / odp / ods
        return _odf_text(data) if data else None


def _pdf_text(path: str) -> tuple[str | None, str]:
    exe = shutil.which("pdftotext")
    if not exe:
        return None, "a PDF (text extraction is not available on this server)"
    try:
        res = subprocess.run([exe, "-q", "-enc", "UTF-8", "-l", str(_PDF_PAGES), path, "-"],
                             capture_output=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None, "a PDF (could not extract its text)"
    text = res.stdout.decode("utf-8", errors="replace").replace("\f", "\n").strip()
    if res.returncode != 0 or not text:
        return None, "a PDF without extractable text (scanned?)"
    return text, f"text extracted from the PDF (up to {_PDF_PAGES} pages)"


def extract(a: Attachment, budget: int = INLINE_FILE_CHARS * 2) -> tuple[str | None, str]:
    """-> (text or None, how it was read / what it is). Never raises."""
    ext = _ext(a.name)
    try:
        if a.is_image:
            return None, "image"
        if ext in _OFFICE:
            txt = _office_text(a.path, ext, budget)
            return (txt, f"text extracted from the {_OFFICE[ext]}") if txt else (
                None, f"a {_OFFICE[ext]} (could not read its text)")
        if ext == "pdf" or a.mime == "application/pdf":
            return _pdf_text(a.path)
        if _is_text(a):
            txt, cut = _read_text(a.path)
            if txt is not None:
                return txt, ("text (only its first 256 KB were read)" if cut else "text")
    except Exception as exc:  # noqa: BLE001 - a broken file is "unreadable", never a failed turn
        return None, f"a file that could not be read ({type(exc).__name__})"
    return None, "a binary file"


def prepare_inline(atts: list[Attachment], *, per_file: int = INLINE_FILE_CHARS,
                   total: int = INLINE_TOTAL_CHARS) -> list[Attachment]:
    """Fill ``extracted`` / ``extract_note`` of each non-image attachment."""
    left = total
    for a in atts:
        if a.is_image:
            continue
        if not os.path.exists(a.path):
            a.extracted, a.extract_note = None, "the file is missing on the server"
            continue
        text, how = extract(a, per_file * 2)
        if text is None or not text.strip():
            a.extracted, a.extract_note = None, (how if text is None else f"{how}, but empty")
            continue
        if left <= 0:
            a.extracted, a.extract_note = None, f"{how} — not included: this message's text budget is used up"
            continue
        limit = min(per_file, left)
        left -= min(len(text), limit)
        if len(text) > limit:
            a.extract_note = f"{how}; truncated: the first {limit:,} of {len(text):,} characters"
            text = text[:limit].rstrip() + "\n…[truncated]"
        else:
            a.extract_note = how
        a.extracted = text
    return atts
