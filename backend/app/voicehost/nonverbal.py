"""Laughs, sighs and yawns in a line (docs/local-voice.md "Laughs, sighs and yawns").

People write the sounds they make — 헤헤, ㅋㅋ, 하암~, 후우…, 헉!, 흥 — and a model that reads them as words says the
syllables. :func:`find` picks them out, with the tags a person may write instead ([웃음], (한숨), [laugh], an engine's
own [laughter]); :func:`render` gives each to an engine the way that engine makes the sound. The recipes were measured
per engine — an AudioSet classifier for whether a laugh, a sigh or a gasp happens, Whisper for whether the words are all
still there (tools/nonverbal_bench.py) — and the measurements are in the docs.

Two rules came out of them for every engine with tags: the tag goes *before* the written sound and the sound stays (a
tag alone, without syllables to carry it, comes out as a breath, and a tag in place of the words can swallow the words
after it); and nothing is added that wasn't written (a laugh only where they laughed).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

KINDS = ("laugh", "giggle", "sigh", "yawn", "gasp", "wow", "pout", "sob", "breath")

# -- what people write ---------------------------------------------------------------------------------------------
# A sound is a whole word (휴가, 흥미, 하키 are words): runs of letters, and runs of bare jamo (ㅋㅋ, ㅠㅠ) on their own.
_WORD = re.compile(r"[가-힣A-Za-z\u3040-\u30ff]+|[ㄱ-ㅎㅏ-ㅣ]+")
_TRAIL = re.compile(r"[~!?.…♡♥,]*")
_PAUSE = re.compile(r"\s*(?:…|\.{2,})")

_WRITTEN: tuple[tuple[str, re.Pattern[str]], ...] = tuple((k, re.compile(p)) for k, p in (
    ("yawn", r"[하흐후]아*아암+|하암+|아함+"),
    ("sigh", r"후우+|후유+|하아+|휴우*|에휴+|아휴+|어휴+|[はハ]ぁ+"),
    ("gasp", r"헉+|허억+|히익+|흐익+|힉|헙"),
    ("wow", r"우와+|와아+"),
    ("pout", r"흥칫뿡|흥+|칫|쳇|치잇"),
    ("sob", r"흑흑+|흐윽+|훌쩍+|[ㅠㅜ]+"),
    ("laugh", r"ㅋ+|(?i:(?:ha){2,}h?|ah(?:ha)+|lol|lmao)|[あア][はハ]{2,}|[はハ]{3,}|[わワ][はハ]{2,}"),
    ("giggle", r"ㅎ{2,}|(?i:he(?:he)+|hihi|tee-?hee)|[えエ][へヘ]{2,}|[うウ][ふフ]{2,}|[ふフ]{2,}"),
))
# a laugh in syllables, however it is mixed (하하에헤, 아하하, 푸하하, 에헤헤, 흐흐흐, 깔깔): only laugh syllables, and one of
# them twice (아하 is "I see", 하아 a sigh, 하키 hockey)
_LAUGH_SYL = set("하헤히호후흐크키깔낄껄킥큭푸풉핫헷힛캬에아으우오")
_CORE = set("하헤히호후흐크키깔낄껄킥큭푸핫헷힛캬")
_SOFT = set("헤히후흐킥헷힛")  # (a giggle more than a laugh)


def _laugh_word(w: str) -> str:
    if len(w) < 2 or not set(w) <= _LAUGH_SYL:
        return ""
    cores = [c for c in w if c in _CORE]
    if len(cores) < 2 or len(set(cores)) == len(cores):
        return ""
    return "giggle" if sum(c in _SOFT for c in cores) * 2 > len(cores) else "laugh"


def _kind_of(word: str, text: str, end: int) -> str:
    for kind, pat in _WRITTEN:
        if pat.fullmatch(word):
            return kind
    if word in ("하", "후") and _PAUSE.match(text, end):
        return "sigh"   # 하… / 후…
    if word == "와" and text[end:end + 1] in ("!", "~"):
        return "wow"    # 와! (이리 와 is a word)
    return _laugh_word(word)


# a tag a person writes for a sound: [웃음] (한숨) *하품* [laugh] — and the engines' own ([laughter], [sigh] …)
_TAG_WORDS = {
    "laugh": ("웃음", "웃으며", "웃는다", "웃음소리", "깔깔", "폭소", "laugh", "laughs", "laughing", "laughter", "chuckle",
              "chuckles", "笑"),
    "giggle": ("킥킥", "키득", "키득키득", "피식", "giggle", "giggles", "giggling"),
    "sigh": ("한숨", "한숨을 쉬며", "한숨 쉬며", "sigh", "sighs", "sighing", "exhale", "exhales"),
    "yawn": ("하품", "하품하며", "yawn", "yawns", "yawning"),
    "gasp": ("헉", "숨을 들이켜며", "gasp", "gasps", "surprise-ah", "surprise-oh", "surprise-yo", "quick_breath"),
    "wow": ("감탄", "와", "surprise-wa"),
    "pout": ("흥", "삐짐", "dissatisfaction-hnn", "pout", "pouts", "huff", "huffs"),
    "sob": ("울음", "훌쩍", "흐느끼며", "sob", "sobs", "crying", "cries"),
    "breath": ("숨", "숨소리", "심호흡", "breath", "breathes", "inhale", "inhales"),
}
_TAG_KIND = {w.lower(): k for k, ws in _TAG_WORDS.items() for w in ws}
# the engines' other tags: theirs to keep, nobody else's to read out
OMNI_TAGS = frozenset({"laughter", "sigh", "confirmation-en", "question-en", "question-ah", "question-oh", "question-ei",
                       "question-yi", "surprise-ah", "surprise-oh", "surprise-wa", "surprise-yo", "dissatisfaction-hnn"})
COSY_TAGS = frozenset({"breath", "noise", "laughter", "cough", "clucking", "accent", "quick_breath", "hissing", "sigh",
                       "vocalized-noise", "lipsmack", "mn"})
_OTHER_TAGS = (OMNI_TAGS | COSY_TAGS) - set(_TAG_KIND)
_TAG_RE = re.compile(r"[\[(（*]\s*([^\[\]()（）*\n]{1,16}?)\s*[\])）*]")
_SPACE = re.compile(r"[ \t]+")


@dataclass
class Sound:
    kind: str
    start: int
    end: int
    said: str = ""     # what was written for it (헤헤), "" for a tag
    tag: str = ""      # the tag as written ([웃음] → 웃음)

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "said": self.said or f"[{self.tag}]"}


def find(text: str) -> list[Sound]:
    """the sounds written in a line, in order (a tag right before the sound it names is one sound: [웃음] 헤헤)"""
    out: list[Sound] = []
    for m in _TAG_RE.finditer(text):
        word = m.group(1).strip().lower()
        kind = _TAG_KIND.get(word)
        if kind is None and word in _OTHER_TAGS:
            kind = ""  # (an engine's tag with no sound of ours: kept for that engine, dropped elsewhere)
        if kind is None:
            continue
        out.append(Sound(kind, m.start(), m.end(), tag=word))
    taken = [(s.start, s.end) for s in out]
    for m in _WORD.finditer(text):
        if any(a < m.end() and m.start() < b for a, b in taken):
            continue
        kind = _kind_of(m.group(), text, m.end())
        if kind:
            end = _TRAIL.match(text, m.end()).end()  # (its punctuation goes with it: 헉! [surprise-ah])
            out.append(Sound(kind, m.start(), end, said=text[m.start():end]))
    out.sort(key=lambda s: s.start)
    merged: list[Sound] = []
    for s in out:
        prev = merged[-1] if merged else None
        if prev and prev.tag and not prev.said and s.said and not text[prev.end:s.start].strip():
            prev.said, prev.end = s.said, s.end
            prev.kind = prev.kind or s.kind
            continue
        merged.append(s)
    return merged


# -- what each engine is given -------------------------------------------------------------------------------------
# (said: what was written, respelled where the letters themselves aren't speech — ㅋㅋ → 크크; a bare tag gets the
# sound's usual syllables, since the tag needs syllables to carry it)
_DEFAULT_SAID = {"laugh": "하하하", "giggle": "헤헤", "sigh": "하아…", "yawn": "하아암~", "gasp": "헉", "wow": "우와",
                 "pout": "흥", "sob": "흑흑", "breath": ""}

# engine → kind → template ({said}); a kind not listed: the syllables alone. Measured (docs/local-voice.md): OmniVoice's
# tags help (a laugh in 38% of lines, a sigh, a gasp); CosyVoice3's tags change nothing in its cloning mode (only
# its syllables are given — and its own tags a person writes, kept); Qwen3-TTS has none (a tag is read out: "라우터").
RECIPES: dict[str, dict[str, str]] = {
    "omnivoice": {"laugh": "[laughter] {said}", "giggle": "[laughter] {said}", "sigh": "[sigh] {said}",
                  "yawn": "[sigh] {said}", "gasp": "{said} [surprise-ah]", "wow": "[surprise-wa] {said}",
                  "pout": "{said} [dissatisfaction-hnn]"},
    "cosyvoice3": {},
    "qwen3_tts": {},
    # ElevenLabs v3 / v4 (eleven_v3*, eleven_v4*): audio tags (a tag needs words after it: alone it is refused)
    "elevenlabs": {"laugh": "[laughs] {said}", "giggle": "[giggles] {said}", "sigh": "[sighs] {said}",
                   "yawn": "[yawns] {said}", "gasp": "[gasps] {said}", "wow": "[excited] {said}",
                   "pout": "[annoyed] {said}", "sob": "[crying] {said}", "breath": "[inhales deeply] {said}"},
}
NATIVE = {"omnivoice": OMNI_TAGS, "cosyvoice3": COSY_TAGS}


def _spoken(s: Sound) -> str:
    """the syllables a sound is said with"""
    said = s.said
    if not said:
        return _DEFAULT_SAID.get(s.kind, "")
    word = _WORD.match(said)
    w = word.group() if word else said
    rest = said[len(w):]
    if w[0] == "ㅋ":
        return "크" * max(2, min(4, len(w))) + rest
    if w[0] == "ㅎ":
        return "흐" * max(2, min(3, len(w))) + rest
    if w[0] in "ㅠㅜ":
        return ""
    if w.lower() in ("lol", "lmao"):
        return "haha" + rest
    return said


@dataclass
class Rendered:
    text: str
    sounds: list[dict[str, str]]


def render(text: str, engine: str, *, on: bool = True) -> Rendered:
    """the line for an engine: its sounds as that engine makes them (``on`` False: as written, but letters that are no
    speech — ㅋㅋ, ㅠㅠ, a tag of another engine — still not read out)"""
    sounds = find(text)
    if not sounds:
        return Rendered(text, [])
    recipe = RECIPES.get(engine, {}) if on else {}
    native = NATIVE.get(engine, frozenset())
    out, at, made = [], 0, []
    for s in sounds:
        out.append(text[at:s.start])
        at = s.end
        if s.tag and s.tag in native and on:
            out.append(text[s.start:s.end].replace(f"({s.tag})", f"[{s.tag}]"))  # (theirs: as it was)
            made.append(s.to_dict())
            continue
        if not s.kind:
            continue  # (another engine's tag: nothing to say here)
        said = _spoken(s) if (on or s.said) else ""
        tpl = recipe.get(s.kind)
        piece = tpl.format(said=said).strip() if tpl else said
        if piece:
            out.append(piece)
        if on and (tpl or not s.said):
            made.append(s.to_dict())
    out.append(text[at:])
    return Rendered(_SPACE.sub(" ", "".join(out)).strip(), made)


# -- a line in parts: words to say, and sounds to put in (a voice's own laugh: app/voicehost/sounds.py) ----------------
# the sounds a clip of the voice stands in for, when it has one (its 의성어 clips: voices.SOUNDS; a giggle takes a
# laugh's) — a sound it has no clip of is made by the engine as written
SPLICED = ("laugh", "giggle", "sigh", "yawn", "gasp", "sob")
# the fewest syllables a part may be said with: CosyVoice3 makes up words for a line of two or three ("왜 그래" came out
# as "잠시만요" in 2 of 6 takes) — a laugh that would leave so short a part beside it stays in the line
MIN_PART = {"cosyvoice3": 5}
_SYLLABLE = re.compile(r"[가-힣A-Za-z0-9\u3040-\u30ff\u4e00-\u9fff]")


def parts(text: str, engine: str, clips: set[str] | frozenset[str] = frozenset(), *, on: bool = True
          ) -> tuple[list[tuple[str, str]], list[dict[str, str]]]:
    """The line as ("say", text) and ("sound", kind) parts: a sound with a clip of the voice (``clips``: the kinds it
    has; a giggle takes a laugh's clip) becomes a part of its own, the rest is rendered for the engine. → parts, the
    sounds made (as :func:`render`'s)."""
    if not on:
        r = render(text, engine, on=False)
        return ([("say", r.text)] if r.text else []), []
    out: list[tuple[str, str]] = []
    made: list[dict[str, str]] = []
    at = 0
    least = MIN_PART.get(engine, 1)
    found = find(text)
    for i, s in enumerate(found):
        kind = s.kind if s.kind in clips else "laugh" if s.kind == "giggle" and "laugh" in clips else ""
        if s.kind not in SPLICED or not kind:
            continue
        after = text[s.end:found[i + 1].start] if i + 1 < len(found) else text[s.end:]
        if least > 1 and any(0 < len(_SYLLABLE.findall(x)) < least for x in (text[at:s.start], after)):
            continue
        before = render(text[at:s.start], engine)
        if before.text.strip():
            out.append(("say", before.text.strip()))
        made += before.sounds
        laughs = kind == "laugh"
        out.append(("sound", "giggle" if laughs and (s.kind == "giggle" or _short(s)) else kind))
        made.append({**s.to_dict(), "clip": "1"})
        at = s.end
    rest = render(text[at:], engine)
    if rest.text.strip():
        out.append(("say", rest.text.strip()))
    made += rest.sounds
    if not any(p[0] == "sound" for p in out):
        return ([("say", rest.text)] if rest.text else []) if at == 0 else out, made
    return out, made


def _short(s: Sound) -> bool:
    """a short laugh: two syllables (하하, 헤헤), three letters (ㅋㅋㅋ)"""
    w = _WORD.match(s.said or "")
    return bool(w) and len(w.group()) <= (3 if w.group()[0] in "ㅋㅎ" else 2)


# what a voice's own laugh is made from, per engine (the best of several takes is kept: app/voicehost/sounds.py)
BANK_TEXTS: dict[str, dict[str, tuple[tuple[str, str], ...]]] = {
    "omnivoice": {"laugh": (("[laughter] 아하하하", "ko"), ("[laughter] 하하하하", "ko"), ("[laughter] hahaha", "en"))},
    "cosyvoice3": {"laugh": (("[laughter] 아하하하", "ko"), ("하하하하하", "ko"))},
    "qwen3_tts": {"laugh": (("아하하하하!", "ko"), ("하하하하.", "ko"))},
    # (measured with a trained voice: 아하하하하! 0.12 – 0.23, Hahahaha! up to 0.24, 하하하하하. up to 0.14)
    "voxcpm": {"laugh": (("아하하하하!", "ko"), ("Hahahaha!", "en"), ("하하하하하.", "ko"))},
}
