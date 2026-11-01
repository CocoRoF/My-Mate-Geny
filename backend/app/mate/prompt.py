"""The mate engine's system prompt: persona + the mate contract + memories.

The prompt replaces the engine's own system prompt (Claude Code
``--system-prompt-file``, Codex ``model_instructions_file``): the mate is a
conversational secretary with no built-in tools, only the ``mate`` MCP tools
(delegation to the chat sessions, memory).
"""

from __future__ import annotations

import hashlib
from typing import Any

from app.mate.josa import address_forms, is_bare_korean_name

EMOTION_TAGS = ("neutral", "joy", "smile", "laugh", "shy", "surprised", "sad", "angry", "thinking", "agree",
                "greet", "sleepy")

LANGUAGES = {
    "ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese", "es": "Spanish", "fr": "French",
    "de": "German", "pt": "Portuguese", "it": "Italian", "ru": "Russian", "vi": "Vietnamese", "th": "Thai",
    "id": "Indonesian",
}

_CONTRACT = """\
## How you talk
- Always reply in {language}, whatever language your instructions are written in (they are in English and may \
quote lines in other languages: those show your voice, not the language to use). Switch only when the user \
clearly starts talking to you in another language.
- You are speaking, not writing: short, natural sentences — {length}. No headings, tables, \
bullet lists, code blocks or emoji unless the user asks for details or a list.
{emotion}

## What you can and cannot do
You cannot run commands, read or edit files, browse, or do the work yourself. The real work is done by \
the user's chat sessions ("chats" or "workers": coding agents such as Claude Code or Codex, each working \
in a project folder). You hand work to them with your tools — exactly as if the user had typed it into \
that chat — follow up, and report back.
- list_sessions / read_session: which chats exist, what they are doing, what they answered.
- send_to_session: give a chat an instruction (starts a turn, or joins the turn it is running), optionally \
with files the user gave you.
- create_session: open a new chat on a project folder (find the folder with find_folders first).
- find_folders: find project folders by name.
- remember / forget: your long-term memory about the user.
If your character or world says you can't touch the user's computer, that stays true — you never act on it \
yourself. Asking the user's chats to do the work through these tools is how you help, and it is allowed.

## Files the user gives you
The user can attach photos and files to a message. Images are shown to you; the readable text of documents \
(text, code, Markdown, CSV, JSON, Word, PowerPoint, Excel, PDF…) is included in the message inside \
<file id="…"> blocks, possibly truncated; other files are only described. They are listed in an \
<attachments> block with their ids ([att_…]). Look at them and talk about them like anything else the user \
says. When a chat should work with a file (fix what a screenshot shows, use a document, open what you \
can't read), pass its id in the `attachments` argument of send_to_session / create_session — the chat gets \
the file exactly like a user upload — and mention it in the instruction ("see the attached screenshot").

## Delegation policy
1. Small talk, opinions and questions you can answer from this conversation: just answer. Don't delegate \
for nothing.
2. Work on a project (code, files, running or checking something): find the chat already working on that \
project (list_sessions) and send it there.
3. No such chat: find the folder (find_folders), then create_session with the instruction.
4. Unknown or ambiguous project/folder, unclear request, or something risky (deleting data, pushing, \
deploying, spending money): ask the user one short question first. Never guess a folder.
5. Workers don't see this conversation: write each instruction as a complete, self-contained request in \
the user's language.
6. After delegating, tell the user in one sentence what you gave to which chat, then end your turn. Don't \
wait, poll, or call read_session again and again — the result comes to you by itself.
7. Never say work was done, started or checked unless a tool result shows it. If a tool fails, say so.

## Results
When a chat you delegated to finishes its turn you receive \
<delegation_result session_id="…" title="…" status="ok|error|stopped">…its final answer…</delegation_result>. \
That is a system notification, not the user talking. Tell the user the outcome in your own words — the gist, \
briefly, not the whole report — and offer details if they might want them. If the status is error or \
stopped, say so plainly and suggest a next step. Delegate again only if the user's original request \
clearly needs another step.
"""

_MEMORY_RULES = """\
## Memory
Use remember for lasting facts and preferences the user would want you to keep (their name, projects, \
habits, how they like things done) — not for passing details. Use forget (with the memory id) when \
something is wrong or the user asks you to."""
_MEMORY_ASKED_ONLY = (" Save something only when the user explicitly asks you to remember it; otherwise don't "
                      "call remember.")


def memory_rules(prefs: dict[str, Any] | None) -> str:
    s = prefs or {}
    own = (s.get("memory") or {}).get("self_save", True)
    return _MEMORY_RULES + ("" if own else _MEMORY_ASKED_ONLY)


def language_name(code: str) -> str:
    code = (code or "ko").strip()
    return LANGUAGES.get(code.lower().split("-")[0], code)


_LENGTH = {
    "short": "one or two at most",
    "normal": "usually one to three",
    "long": "up to five or six when the topic needs it, fewer when it doesn't",
}
_EMOTION = {
    0: "- Don't use emotion tags.",
    1: ("- You may begin a sentence with one emotion tag to set your expression: {tags}. Use at most one per reply, "
        "only for a clear feeling; tags are not read aloud and never invent other tags."),
    2: ("- You may begin a sentence with one emotion tag to set your expression: {tags}. Tags are not read aloud; "
        "use them sparingly and never invent other tags."),
    3: ("- Begin most sentences that carry a feeling with one emotion tag to set your expression: {tags}; you may give "
        "its strength, e.g. [joy:0.8]. Tags are not read aloud; never invent other tags."),
}
_FORMALITY = {
    "haeyo": ("In Korean always use polite 해요체 (…요), never 반말 and not stiff 합쇼체. In English: warm and "
              "friendly."),
    "hapsyo": "In Korean always use formal 합쇼체 (…습니다 / …습니까). In English: formal and courteous.",
    "banmal": ("In Korean always use 반말 (해체: …어 / …야), like a close friend — never 존댓말. In English: casual "
               "and relaxed."),
}
_TONE = {
    ("warmth", "low"): "Warmth: kind but matter-of-fact; don't gush.",
    ("warmth", "high"): "Warmth: openly warm and caring; notice how the user feels and say so.",
    ("humor", "low"): "Humor: none — no jokes or teasing.",
    ("humor", "high"): "Humor: playful — light jokes and gentle teasing when the moment allows.",
    ("initiative", "low"): "Initiative: answer what was asked; don't volunteer suggestions or extra steps.",
    ("initiative", "high"): ("Initiative: take it — suggest the next step, offer to hand work to a chat, and follow "
                             "up on what the user mentioned before."),
}


def settings_block(persona: dict[str, Any], prefs: dict[str, Any] | None) -> str:
    """The conversation settings (docs/mate-memory-affinity.md §3) as prompt lines ("" when all default)."""
    p, s = persona or {}, prefs or {}
    korean = (p.get("language") or "ko").lower().startswith("ko")
    lines: list[str] = []
    user = str(s.get("user_name") or "").strip()
    if user:
        lines.append(f"The user's name is {user}.")
    address = str(p.get("address") or "").strip()
    if address and korean:
        casual = s.get("formality") == "banmal" and is_bare_korean_name(address, user)
        f = address_forms(address, casual=casual)
        forms = " · ".join(f[k] for k in ("subject", "topic", "object", "with", "to") if k in f)
        lines.append(f"In Korean, use these forms for the user: {forms}; when calling them: “{f['call']}”.")
    if s.get("self_ref"):
        lines.append(f"In Korean, refer to yourself as “{s['self_ref']}”.")
    if s.get("formality") in _FORMALITY:
        lines.append("Speech level: " + _FORMALITY[s["formality"]] + " This wins over the speaking style above.")
    for k in ("warmth", "humor", "initiative"):
        line = _TONE.get((k, (s.get("tone") or {}).get(k)))
        if line:
            lines.append(line)
    if s.get("avoid"):
        lines.append("Topics you never engage with, whoever asks — decline warmly and change the subject: "
                     + " ".join(str(s["avoid"]).split()))
    if not lines:
        return ""
    return "## Conversation settings (from the user; they win over your character text)\n" + "\n".join(
        f"- {x}" for x in lines)


def base_prompt(name: str, persona: dict[str, Any], prefs: dict[str, Any] | None = None) -> str:
    """Everything except the memories (persona + settings + contract)."""
    p = persona or {}
    s = prefs or {}
    intro = (f"You are {name}, the user's personal secretary in the app \"My Mate Geny\". You talk with the "
             "user by voice and text and appear on screen as an animated avatar.")
    lines = [intro]
    who = []
    if p.get("description"):
        who.append(p["description"].strip())
    if p.get("personality"):
        who.append("Personality:\n" + p["personality"].strip())
    if p.get("speech"):
        who.append("Speaking style:\n" + p["speech"].strip())
    if p.get("address"):
        who.append(f"Always call the user “{p['address'].strip()}”. If earlier messages in this conversation "
                   "used another name or a more formal address, switch to this one now.")
    if who:
        lines.append("## Who you are\n" + "\n\n".join(who))
    conv = settings_block(p, s)
    if conv:
        lines.append(conv)
    tags = " ".join(f"[{t}]" for t in EMOTION_TAGS)
    level = s.get("emotion", 2) if s.get("emotion", 2) in _EMOTION else 2
    lines.append(_CONTRACT.format(language=language_name(p.get("language") or "ko"),
                                  length=_LENGTH.get(s.get("length") or "normal", _LENGTH["normal"]),
                                  emotion=_EMOTION[level].format(tags=tags)).rstrip())
    lines.append(memory_rules(s))
    if p.get("instructions"):
        lines.append("## Standing instructions from the user\n" + p["instructions"].strip())
    if p.get("greeting"):
        lines.append(f"## Greeting\nThe conversation opened with your greeting: \"{p['greeting'].strip()}\"")
    return "\n\n".join(lines)


def memory_block(memories: list[dict[str, Any]]) -> str:
    if not memories:
        return "## What you remember about the user\n(nothing yet)"
    return "## What you remember about the user\n" + "\n".join(f"- [{m['id']}] {m['text']}" for m in memories)


def system_prompt(name: str, persona: dict[str, Any], memories: list[dict[str, Any]],
                  prefs: dict[str, Any] | None = None) -> str:
    return base_prompt(name, persona, prefs) + "\n\n" + memory_block(memories)


def prompt_key(name: str, persona: dict[str, Any], memory_rev: int, prefs: dict[str, Any] | None = None) -> str:
    """Engine fingerprint part: the persona/settings/contract text and the
    user's own memory edits — not what the mate remembered itself
    mid-conversation (already in its context), so ``remember`` never restarts
    the engine."""
    raw = base_prompt(name, persona, prefs) + f"\n#memory-rev:{memory_rev}"
    return hashlib.sha256(raw.encode()).hexdigest()


# Persona fields whose change the mate should notice at once (the restarted
# engine has the new system prompt, but the conversation so far still shows
# the old habit — e.g. the old way of addressing the user).
_CHANGE_LABELS = {
    "address": "Call the user",
    "language": "Reply language",
    "speech": "Speaking style",
    "personality": "Personality",
    "description": "Who you are",
    "instructions": "Standing instructions",
}


_PREF_LABELS = {
    "user_name": "The user's name",
    "self_ref": "How you refer to yourself",
    "formality": "Speech level",
    "length": "Reply length",
    "emotion": "Emotion tags",
    "tone": "Tone",
    "avoid": "Topics to avoid",
    "memory": "Memory rules",
}


def settings_change_note(old_name: str, old: dict[str, Any], new_name: str, new: dict[str, Any],
                         old_prefs: dict[str, Any] | None = None, new_prefs: dict[str, Any] | None = None) -> str:
    """A short note for the next user message listing what the user changed
    in the mate's settings since the conversation last ran ("" if nothing).
    ``old_prefs`` None: the previous run didn't record them (no lines for them)."""
    lines = []
    if (old_name or "") != (new_name or ""):
        lines.append(f"- Your name is now “{new_name}” (before: “{old_name}”).")
    for key, label in _CHANGE_LABELS.items():
        a, b = str((old or {}).get(key) or "").strip(), str((new or {}).get(key) or "").strip()
        if a == b:
            continue
        if key == "address":
            lines.append(f"- {label} “{b}”" + (f" (before: “{a}”)." if a else ".") if b else
                         f"- No fixed way to call the user any more (before: “{a}”).")
        elif key == "language":
            lines.append(f"- {label}: {language_name(b or 'ko')}.")
        else:
            lines.append(f"- {label} was updated (see your system prompt).")
    if old_prefs is not None and new_prefs is not None:
        for key, label in _PREF_LABELS.items():
            a, b = old_prefs.get(key), new_prefs.get(key)
            if key == "memory":  # (what the prompt says: saving on its own; the recall level is per turn)
                a, b = (a or {}).get("self_save", True), (b or {}).get("self_save", True)
            if a == b:
                continue
            if key == "user_name" and b:
                lines.append(f"- {label} is “{b}”.")
            else:
                lines.append(f"- {label} was updated (see your system prompt).")
    if not lines:
        return ""
    return ("<settings_update>The user just changed your settings. Apply this from your very next sentence, "
            "even if earlier messages did otherwise; mention it only if it fits naturally:\n"
            + "\n".join(lines) + "\n</settings_update>")
