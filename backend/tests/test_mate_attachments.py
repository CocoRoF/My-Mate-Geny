"""Attachments in a mate conversation: the mate (no file tools) gets ids +
readable contents inline; send_to_session / create_session forward the
mate's files to a worker chat exactly like a user upload (start and steer).
Real session/engine code against the fake Claude CLI of test_engine."""

from __future__ import annotations

import asyncio
import io
import json
import os
import stat
import sys
import textwrap
import zipfile

from PIL import Image
from starlette.datastructures import Headers, UploadFile

from app.mate.service import MateService
from app.mate.store import MateStore
from app.providers import _inline_files
from app.providers._attachments import Attachment, compose_text
from app.providers._inline_files import prepare_inline
from app.providers.claude_code import ClaudeCodeProvider
from app.services import session_service as ss_mod
from app.services.attachment_service import AttachmentService
from app.services.connection_service import ConnectionService
from app.services.provider_service import ProviderService
from app.services.session_service import SessionService
from app.services.workspace_service import WorkspaceService
from app.vault import SecretVault
from tests.test_engine import FAKE, _until

# the fake CLI also logs every user message it reads
LOGGING_FAKE = FAKE.replace(
    '    content = msg["message"]["content"]\n',
    '    content = msg["message"]["content"]\n'
    '    open(FAKE_DIR + "/stdin.log", "a").write(json.dumps({"pid": os.getpid(), "msg": msg}) + "\\n")\n',
).replace(  # (… including the ones that steer a LONG turn)
    '            if m2 and m2.get("type") == "control_request"',
    '            if m2 and m2.get("type") == "user":\n'
    '                open(FAKE_DIR + "/stdin.log", "a").write(json.dumps({"pid": os.getpid(), "msg": m2}) + "\\n")\n'
    '            if m2 and m2.get("type") == "control_request"',
)


def _setup(db, tmp_path, monkeypatch):
    assert LOGGING_FAKE != FAKE
    fake = tmp_path / "claude"
    fake.write_text(f"#!{sys.executable}\n" + textwrap.dedent(LOGGING_FAKE).replace("__FAKE_DIR__", str(tmp_path)))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(ss_mod, "get_provider", lambda name: ClaudeCodeProvider(binary=str(fake)))
    vault = SecretVault(db)
    atts = AttachmentService(db)
    svc = SessionService(db, ProviderService(db, vault), WorkspaceService(ConnectionService(db, vault)),
                         attachments=atts)
    store = MateStore(db, vault)
    return svc, atts, store, MateService(svc, store)


def _png(w=40, h=30) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 60)).save(buf, "PNG")
    return buf.getvalue()


def _zip(parts: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in parts.items():
            zf.writestr(name, data)
    return buf.getvalue()


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
DOCX = _zip({"word/document.xml": f'<w:document {W}><w:body><w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p>'
                                   f'<w:p><w:r><w:t>Ship the </w:t></w:r><w:r><w:t>composer</w:t></w:r></w:p>'
                                   '</w:body></w:document>'})
PPTX = _zip({"ppt/slides/slide2.xml": f'<p:sld {A} xmlns:p="p"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
             "ppt/slides/slide1.xml": f'<p:sld {A} xmlns:p="p"><a:p><a:r><a:t>Title slide</a:t></a:r></a:p></p:sld>'})
XLSX = _zip({
    "xl/workbook.xml": f'<workbook {S}><sheets><sheet name="Costs"/></sheets></workbook>',
    "xl/sharedStrings.xml": f'<sst {S}><si><t>item</t></si><si><t>usd</t></si><si><t>tokens</t></si></sst>',
    "xl/worksheets/sheet1.xml": f'<worksheet {S}><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
                                f'<row><c t="s"><v>2</v></c><c><v>0.42</v></c></row></sheetData></worksheet>',
})


def _att(tmp_path, name: str, data: bytes, mime: str, kind: str = "file") -> Attachment:
    p = tmp_path / name
    p.write_bytes(data)
    return Attachment(id=f"att_{name.replace('.', '_')}", name=name, mime=mime, size=len(data), kind=kind,
                      path=str(p))


def test_inline_contents_of_text_office_and_binary_files(tmp_path, monkeypatch):
    md = _att(tmp_path, "notes.md", "# Plan\n\n- fix the caret\n".encode(), "text/markdown")
    csv = _att(tmp_path, "costs.csv", b"a,b\n1,2\n", "text/csv")
    code = _att(tmp_path, "main.py", b"print('hi')\n", "application/octet-stream")  # by extension
    docx = _att(tmp_path, "plan.docx", DOCX, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    pptx = _att(tmp_path, "deck.pptx", PPTX, "application/vnd.openxmlformats-officedocument.presentationml.presentation")
    xlsx = _att(tmp_path, "sheet.xlsx", XLSX, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    blob = _att(tmp_path, "data.bin", b"\x00\x01\x02binary", "application/octet-stream")
    broken = _att(tmp_path, "bad.docx", b"not a zip", "application/octet-stream")
    img = _att(tmp_path, "shot.png", _png(), "image/png", kind="image")
    atts = prepare_inline([md, csv, code, docx, pptx, xlsx, blob, broken, img])

    assert md.extracted.startswith("# Plan") and md.extract_note == "text"
    assert csv.extracted == "a,b\n1,2\n" and code.extracted == "print('hi')\n"
    assert docx.extracted == "Quarterly plan\nShip the composer"
    assert pptx.extracted.index("Title slide") < pptx.extracted.index("Second slide")  # slides in order
    assert "## Costs" in xlsx.extracted and "item\tusd" in xlsx.extracted and "tokens\t0.42" in xlsx.extracted
    assert blob.extracted is None and blob.extract_note == "a binary file"
    assert broken.extracted is None and "could not read" in broken.extract_note
    assert img.extracted is None

    text = compose_text("what do you think?", atts, inline_images=True, inline_files=True)
    assert text.startswith("what do you think?\n\n<attachments>")
    assert "- [att_shot_png] shot.png — image/png" in text and "image, shown to you" in text
    assert "- [att_data_bin] data.bin" in text and "not available to you; forward it" in text
    assert '<file id="att_notes_md" name="notes.md">\n# Plan' in text
    assert '<file id="att_plan_docx" name="plan.docx">\nQuarterly plan' in text
    assert "send_to_session" in text
    assert str(tmp_path) not in text  # no paths for an engine that can't open them
    # the regular (tool-using) note is unchanged: paths, no contents
    plain = compose_text("x", atts, inline_images=True)
    assert str(tmp_path) in plain and "<file id=" not in plain


def test_inline_budget_truncates_and_pdf_without_pdftotext(tmp_path, monkeypatch):
    big = _att(tmp_path, "big.txt", ("line of text\n" * 3000).encode(), "text/plain")
    small = _att(tmp_path, "small.txt", b"tiny", "text/plain")
    late = _att(tmp_path, "late.txt", b"after the budget", "text/plain")
    prepare_inline([big, small, late], per_file=1000, total=1004)
    assert len(big.extracted) < 1100 and big.extracted.endswith("…[truncated]")
    assert "truncated: the first 1,000 of 39,000 characters" in big.extract_note
    assert small.extracted == "tiny"
    assert late.extracted is None and "budget is used up" in late.extract_note

    monkeypatch.setattr(_inline_files.shutil, "which", lambda name: None)
    pdf = _att(tmp_path, "r.pdf", b"%PDF-1.4\n...", "application/pdf")
    prepare_inline([pdf])
    assert pdf.extracted is None and "text extraction is not available" in pdf.extract_note


def _pdf(text: str) -> bytes:
    stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (i, o)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % off for off in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return out


def test_pdf_text_via_pdftotext(tmp_path):
    import shutil

    import pytest

    if not shutil.which("pdftotext"):
        pytest.skip("pdftotext (poppler) not installed")
    pdf = _att(tmp_path, "r.pdf", _pdf("Invoice total 42 USD"), "application/pdf")
    prepare_inline([pdf])
    assert pdf.extracted and "Invoice total 42 USD" in pdf.extracted and "PDF" in pdf.extract_note


def test_mate_envelope_has_image_blocks_ids_and_contents(tmp_path):
    md = _att(tmp_path, "a.md", b"hello md", "text/markdown")
    img = _att(tmp_path, "s.png", _png(), "image/png", kind="image")
    prepare_inline([md, img])
    env = json.loads(ClaudeCodeProvider._envelope("look", [img, md], inline_files=True))
    content = env["message"]["content"]
    assert content[0]["type"] == "image" and content[-1]["type"] == "text"
    assert "[att_s_png]" in content[-1]["text"] and '<file id="att_a_md" name="a.md">\nhello md' in content[-1]["text"]


async def _upload(atts: AttachmentService, sid: str, name: str, data: bytes, mime: str) -> dict:
    up = UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": mime}))
    return await atts.save(sid, up)


def _stdin(tmp_path):
    p = tmp_path / "stdin.log"
    return [json.loads(line)["msg"] for line in open(p)] if p.exists() else []


def _text_of(msg) -> str:
    c = msg["message"]["content"]
    return c if isinstance(c, str) else c[-1]["text"]


def _ended(m):
    return m["type"] == "run.state" and not m["data"]["running"]


async def test_mate_sees_contents_and_forwards_files_to_a_worker(db, tmp_path, monkeypatch):
    svc, atts, store, mates = _setup(db, tmp_path, monkeypatch)
    proj = tmp_path / "proj"
    proj.mkdir()
    worker = svc.create(provider="claude", model="w1", workspace_path=str(proj), title="proj")["id"]
    other = svc.create(provider="claude", model="w1", workspace_path=str(proj), title="other")["id"]
    mate = store.create(name="Geny", llm={"model": "m1"})
    msid = mates.conversation(mate["id"])["session_id"]
    ctx = mates.token_info(mates._token(mate["id"], msid))
    qm, qw = svc.subscribe(msid), svc.subscribe(worker)
    try:
        img = await _upload(atts, msid, "pasted-20261031-101010.png", _png(), "image/png")
        md = await _upload(atts, msid, "bug.md", b"# Bug\nThe caret blinks in bubbles.\n", "text/markdown")
        foreign = await _upload(atts, other, "x.txt", b"not yours", "text/plain")

        # 1. the user sends both to the mate: image block + ids + the markdown inline
        svc.start_turn(msid, "please look", [img["id"], md["id"]])
        seen = await _until(qm, _ended)
        um = next(m for m in seen if m["type"] == "user.message")["data"]
        assert [a["id"] for a in um["attachments"]] == [img["id"], md["id"]]
        sent = _stdin(tmp_path)[-1]
        assert sent["message"]["content"][0]["type"] == "image"
        body = _text_of(sent)
        assert body.startswith("<context>\nNow: ")  # (the per-turn context block, then the message)
        body = body.split("</context>\n\n", 1)[1]
        assert body.startswith("please look") and f"[{img['id']}]" in body and f"[{md['id']}]" in body
        assert f'<file id="{md["id"]}" name="bug.md">\n# Bug\nThe caret blinks' in body
        assert str(atts.session_dir(msid)) not in body  # ids, not paths

        # 2. bad ids are refused (unknown, or another chat's file)
        text, err = await mates.call_tool(ctx, "send_to_session",
                                          {"session_id": worker, "message": "fix", "attachments": ["att_nope"]})
        assert err and "no attachment 'att_nope'" in text
        text, err = await mates.call_tool(ctx, "send_to_session",
                                          {"session_id": worker, "message": "fix", "attachments": [foreign["id"]]})
        assert err and not svc.messages(worker)

        # 3. forward: the worker gets copies, like a user upload, on the "via" message
        text, err = await mates.call_tool(ctx, "send_to_session", {
            "session_id": worker, "message": "fix what the screenshot shows",
            "attachments": [f"[{img['id']}]", md["id"]]})
        assert not err and "with 2 files (pasted-20261031-101010.png, bug.md)" in text, text
        wseen = await _until(qw, _ended)
        wum = next(m for m in wseen if m["type"] == "user.message")["data"]
        assert wum["via"]["name"] == "Geny"
        got = wum["attachments"]
        assert [a["name"] for a in got] == ["pasted-20261031-101010.png", "bug.md"]
        assert {a["id"] for a in got}.isdisjoint({img["id"], md["id"]})
        assert got[0]["kind"] == "image" and (got[0]["width"], got[0]["height"]) == (40, 30)
        stored = svc.messages(worker)[0]
        assert stored["meta"]["via"]["name"] == "Geny" and [a["id"] for a in stored["attachments"]] == [a["id"] for a in got]
        rows = [atts.get(a["id"]) for a in got]
        assert all(r["session_id"] == worker and os.path.exists(r["path"]) for r in rows)
        assert all(str(atts.session_dir(worker)) in r["path"] for r in rows)
        wmsg = [m for m in _stdin(tmp_path) if "fix what the screenshot" in _text_of(m)][-1]
        assert wmsg["message"]["content"][0]["type"] == "image"
        wbody = _text_of(wmsg)  # a worker has tools: the regular note with paths
        assert "<attachments>" in wbody and rows[1]["path"] in wbody and "<file id=" not in wbody
        # the mate's own files stay where they are
        assert os.path.exists(atts.get(img["id"])["path"]) and atts.get(img["id"])["session_id"] == msid
        await _until(qm, _ended)  # (the delegation result turn)

        # 4. steering a running worker turn carries the files too
        svc.start_turn(worker, "LONG build")
        await _until(qw, lambda m: m["type"] == "tool.use")
        text, err = await mates.call_tool(ctx, "send_to_session",
                                          {"session_id": worker, "message": "also this", "attachments": [md["id"]]})
        assert not err and "added to the turn" in text
        steer = (await _until(qw, lambda m: m["type"] == "user.steer"))[-1]["data"]
        assert [a["name"] for a in steer["attachments"]] == ["bug.md"]
        svc.stop(worker)
        await _until(qw, _ended)
        await _until(qm, _ended)

        # 5. create_session: files need a message; then they go with the first one
        text, err = await mates.call_tool(ctx, "create_session",
                                          {"workspace_path": str(proj), "attachments": [img["id"]]})
        assert err and "go with a message" in text
        before = {s["id"] for s in svc.list_all()}
        text, err = await mates.call_tool(ctx, "create_session", {
            "workspace_path": str(proj), "message": "look at this", "attachments": [img["id"]]})
        assert not err and "with 1 file (pasted-20261031-101010.png)" in text
        new = next(s["id"] for s in svc.list_all() if s["id"] not in before)
        for _ in range(100):
            if svc.messages(new) and not svc.is_running(new):
                break
            await asyncio.sleep(0.05)
        first = svc.messages(new)[0]
        assert first["meta"]["via"]["name"] == "Geny" and [a["name"] for a in first["attachments"]] == [img["name"]]

        # read_session shows which messages carried files
        text, err = await mates.call_tool(ctx, "read_session", {"session_id": worker})
        assert not err and json.loads(text)["messages"][0]["files"] == ["pasted-20261031-101010.png", "bug.md"]
    finally:
        await svc.shutdown()


async def test_mate_steer_with_attachments_inlines_contents(db, tmp_path, monkeypatch):
    svc, atts, store, mates = _setup(db, tmp_path, monkeypatch)
    mate = store.create(name="Geny", llm={"model": "m1"})
    msid = mates.conversation(mate["id"])["session_id"]
    q = svc.subscribe(msid)
    try:
        svc.start_turn(msid, "LONG talk")
        await _until(q, lambda m: m["type"] == "tool.use")
        f = await _upload(atts, msid, "todo.txt", b"buy milk", "text/plain")
        assert await svc.steer(msid, "and this", [f["id"]])
        steer = (await _until(q, lambda m: m["type"] == "user.steer"))[-1]["data"]
        assert steer["attachments"][0]["name"] == "todo.txt"
        assert f'<file id="{f["id"]}" name="todo.txt">\nbuy milk' in _text_of(_stdin(tmp_path)[-1])
        svc.stop(msid)
        await _until(q, _ended)
    finally:
        await svc.shutdown()
