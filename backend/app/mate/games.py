"""Little games to play with her (docs/mate-games.md): 끝말잇기 (word chain), 스무고개 (twenty questions), 초성 퀴즈 (initial-consonant
quiz) and 가위바위보 (rock-paper-scissors). She plays them as herself, in the conversation; this holds what isn't up to her: the
rules, whose turn it is, the score, and what she keeps secret (so she can't change her answer, and the user can't see it until
the end). The user plays by talking (their message is their word, their question or their guess) or, for 가위바위보, with
buttons. Pure functions over one JSON document per mate (``start``); no I/O.
"""

from __future__ import annotations

import random
import re
import unicodedata
from datetime import datetime
from typing import Any

from app.mate import affinity as A

GAMES = ("wordchain", "twenty", "chosung", "rps")
#: only in Korean (a mate who speaks another language plays the others)
KOREAN_ONLY = ("chosung",)
NAMES = {"wordchain": "word chain (끝말잇기)", "twenty": "twenty questions (스무고개)", "chosung": "the initial-consonant quiz (초성 퀴즈)",
         "rps": "rock-paper-scissors (가위바위보)"}
TWENTY_MAX, CHOSUNG_ROUNDS, CHOSUNG_HINT_AFTER, RPS_TO = 20, 5, 3, 3
WORD_MAX = 12
HISTORY_MAX = 30
HANDS = ("rock", "scissors", "paper")
BEATS = {"rock": "scissors", "scissors": "paper", "paper": "rock"}
_CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
#: 두음법칙: a word may also start with what the last syllable becomes at the head of a word (력 → 역, 녀 → 여, 라 → 나 …)
_DUEUM = {"녀": "여", "뇨": "요", "뉴": "유", "니": "이", "랴": "야", "려": "여", "례": "예", "료": "요", "류": "유", "리": "이",
          "라": "나", "래": "내", "로": "노", "뢰": "뇌", "루": "누", "르": "느"}
_GIVE_UP = re.compile(r"^(졌어|졌다|항복|몰라|모르겠어|포기|나 졌|i give up|i lose|give up|you win)[\s.!~ㅠㅜ]*$", re.I)


def _now_iso(now: datetime) -> str:
    return A._iso(now)


def is_hangul(ch: str) -> bool:
    return "가" <= ch <= "힣"


def clean_word(text: str) -> str:
    """A message as a word: the letters of it, nothing around them (quotes, a full stop, ㅋㅋ)."""
    text = unicodedata.normalize("NFC", str(text or "")).strip()
    text = re.sub(r"[ㄱ-ㅎㅏ-ㅣ]+$", "", text)  # (a trailing ㅋㅋ / ㅎㅎ)
    return re.sub(r"[\s\"'“”‘’!?.,~…\-()\[\]]+", "", text)


def _key(text: str) -> str:
    return clean_word(text).lower()


def heads(syllable: str) -> list[str]:
    """What a word may start with after a word ending in ``syllable``: itself, or its 두음법칙 form."""
    out = [syllable]
    if is_hangul(syllable):
        code = ord(syllable) - 0xAC00
        lead, vowel, tail = code // 588, (code % 588) // 28, code % 28
        bare = chr(0xAC00 + lead * 588 + vowel * 28)
        if bare in _DUEUM:
            moved = _DUEUM[bare]
            m = ord(moved) - 0xAC00
            out.append(chr(0xAC00 + (m // 588) * 588 + ((m % 588) // 28) * 28 + tail))
    return out


def chosung(word: str) -> str:
    """사과 → ㅅㄱ (anything not a Hangul syllable stays as it is)."""
    return "".join(_CHO[(ord(c) - 0xAC00) // 588] if is_hangul(c) else c for c in word)


def start(game: str, lang: str, now: datetime, *, by: str = "user") -> dict[str, Any]:
    """A new game. ``by``: who wanted it (the user from the menu, or she in the conversation)."""
    if game not in GAMES:
        raise ValueError(f"no such game: {game}")
    if game in KOREAN_ONLY and lang != "ko":
        raise ValueError("that game is in Korean")
    doc: dict[str, Any] = {"game": game, "status": "on", "lang": lang, "started": _now_iso(now), "at": _now_iso(now), "by": by,
                           "score": {"user": 0, "mate": 0}, "result": None, "seen": None, "last": None}
    if game == "wordchain":
        doc |= {"words": [], "turn": "mate"}  # (she opens)
    elif game == "twenty":
        doc |= {"answer": "", "category": "", "asked": 0, "turn": "mate"}  # (she thinks of something first)
    elif game == "chosung":
        doc |= {"answer": "", "hint": "", "round": 1, "tries": 0, "turn": "mate", "past": []}
    else:
        doc |= {"rounds": [], "turn": "user"}
    return doc


def _end(doc: dict[str, Any], result: str, now: datetime) -> None:
    doc["status"], doc["result"], doc["at"], doc["turn"] = "done", result, _now_iso(now), None


def next_heads(doc: dict[str, Any]) -> list[str]:
    if not doc.get("words"):
        return []
    last = doc["words"][-1]["w"]
    return heads(last[-1]) if doc["lang"] == "ko" else [last[-1].lower()]


def _word_ok(doc: dict[str, Any], word: str) -> str | None:
    """Why this word can't be played (None: it can)."""
    if doc["lang"] == "ko":
        if len(word) < 2 or not all(is_hangul(c) for c in word):
            return "a word of two or more Hangul syllables"
    elif len(word) < 2 or not word.isalpha():
        return "a word of two or more letters"
    if len(word) > WORD_MAX:
        return "a word, not a sentence"
    need = next_heads(doc)
    if need and not any(word.lower().startswith(h) for h in need):
        return "a word starting with " + " or ".join(need)
    if any(_key(w["w"]) == _key(word) for w in doc["words"]):
        return "a word nobody has said yet in this game"
    return None


# ---- the user, by talking ----

def heard(doc: dict[str, Any], text: str, message_id: str, now: datetime) -> dict[str, Any] | None:
    """Their message, in the game (once per message): {what, …} for what she is told, or None when it isn't a move (just talk)."""
    if doc.get("status") != "on" or doc.get("seen") == message_id or doc["game"] == "rps":
        return None
    doc["seen"] = message_id
    raw = str(text or "").strip()
    if _GIVE_UP.match(raw):
        if doc["game"] == "chosung" and doc.get("answer"):
            return _chosung_pass(doc, now)
        _end(doc, "mate", now)
        doc["last"] = {"what": "user_gave_up", "answer": doc.get("answer") or ""}
        return doc["last"]
    if doc["game"] == "wordchain":
        if doc.get("turn") != "user":
            return None
        if len(re.sub(r"[ㄱ-ㅎㅏ-ㅣ]+", " ", raw).split()) != 1:
            return None  # (a sentence: they are talking, not playing a word)
        word = clean_word(raw)
        if not word:
            return None
        why = _word_ok(doc, word)
        if why:
            doc["last"] = {"what": "user_word_bad", "word": word, "why": why}
            return doc["last"]
        doc["words"].append({"w": word, "by": "user"})
        doc["turn"], doc["at"] = "mate", _now_iso(now)
        doc["last"] = {"what": "user_word", "word": word}
        return doc["last"]
    if doc["game"] == "twenty":
        if not doc.get("answer"):
            return None
        if _key(doc["answer"]) and _key(doc["answer"]) in _key(raw):
            doc["score"]["user"] += 1
            _end(doc, "user", now)
            doc["last"] = {"what": "user_guessed", "answer": doc["answer"], "asked": doc["asked"]}
            return doc["last"]
        doc["asked"] += 1
        doc["at"] = _now_iso(now)
        if doc["asked"] >= TWENTY_MAX:
            doc["score"]["mate"] += 1
            _end(doc, "mate", now)
            doc["last"] = {"what": "twenty_out", "answer": doc["answer"]}
            return doc["last"]
        doc["last"] = {"what": "question", "asked": doc["asked"]}
        return doc["last"]
    if doc["game"] == "chosung":
        if not doc.get("answer"):
            return None
        if _key(raw) == _key(doc["answer"]):
            doc["score"]["user"] += 1
            return _chosung_next(doc, now, {"what": "user_correct", "answer": doc["answer"]})
        doc["tries"] += 1
        doc["last"] = {"what": "user_wrong", "guess": clean_word(raw), "tries": doc["tries"]}
        return doc["last"]
    return None


def _chosung_next(doc: dict[str, Any], now: datetime, last: dict[str, Any]) -> dict[str, Any]:
    doc["past"] = [*doc.get("past", []), {"answer": doc["answer"], "won": last["what"] == "user_correct"}]
    doc["answer"], doc["hint"], doc["tries"] = "", "", 0
    if doc["round"] >= CHOSUNG_ROUNDS:
        s = doc["score"]
        _end(doc, "user" if s["user"] > s["mate"] else "mate" if s["mate"] > s["user"] else "draw", now)
    else:
        doc["round"] += 1
        doc["turn"] = "mate"
    doc["at"] = _now_iso(now)
    doc["last"] = last
    return last


def _chosung_pass(doc: dict[str, Any], now: datetime) -> dict[str, Any]:
    doc["score"]["mate"] += 1
    return _chosung_next(doc, now, {"what": "user_passed", "answer": doc["answer"]})


def give_up_user(doc: dict[str, Any], now: datetime) -> dict[str, Any]:
    """The button: they give up this round (초성: pass) or the game."""
    if doc.get("status") != "on":
        return {"what": "over"}
    if doc["game"] == "chosung" and doc.get("answer"):
        return _chosung_pass(doc, now)
    if doc["game"] == "twenty" and doc.get("answer"):
        doc["score"]["mate"] += 1
    _end(doc, "mate" if doc["game"] != "rps" else "quit", now)
    doc["last"] = {"what": "user_gave_up", "answer": doc.get("answer") or ""}
    return doc["last"]


# ---- her, with play_game ----

def act(doc: dict[str, Any], action: str, args: dict[str, Any], now: datetime) -> str:
    """What she does in the game (play_game). -> what she is told back; ValueError when it can't be done (she is told why)."""
    if doc.get("status") != "on":
        raise ValueError("No game is going on.")
    game = doc["game"]
    if action == "give_up":
        if game == "chosung" and doc.get("answer"):
            raise ValueError("In this quiz they are the one guessing: give a hint instead, or wait.")
        if game == "twenty" and doc.get("answer"):
            raise ValueError("They are the one guessing: answer their question, or wait for them to give up.")
        doc["score"]["user"] += 1
        _end(doc, "user", now)
        doc["last"] = {"what": "mate_gave_up"}
        return "You gave up: they win this one. Say so in your own way."
    if action == "stop":
        _end(doc, "quit", now)
        doc["last"] = {"what": "stopped"}
        return "The game is over."
    if game == "wordchain" and action == "move":
        if doc.get("turn") != "mate":
            raise ValueError("It is their turn: wait for their word.")
        word = clean_word(str(args.get("word") or ""))
        why = _word_ok(doc, word)
        if why:
            raise ValueError(f"“{word}” can't be played: it must be {why}. Pick another, or give_up if you can't think of one.")
        doc["words"].append({"w": word, "by": "mate"})
        doc["turn"], doc["at"] = "user", _now_iso(now)
        doc["last"] = {"what": "mate_word", "word": word}
        return f"Played “{word}”. Now say it in your reply; their word must start with {' or '.join(next_heads(doc))}."
    if game == "wordchain" and action == "reject":
        mine = doc["words"][-1] if doc["words"] else None
        if not mine or mine["by"] != "user" or doc.get("turn") != "mate":
            raise ValueError("There is no word of theirs to reject.")
        doc["words"].pop()
        doc["turn"] = "user"
        doc["last"] = {"what": "mate_rejected", "word": mine["w"], "why": " ".join(str(args.get("reason") or "").split())[:80]}
        return f"Rejected “{mine['w']}”: they try another word. Tell them why, in your own way."
    if game in ("twenty", "chosung") and action == "secret":
        if doc.get("answer"):
            raise ValueError("You already have one: it can't change now.")
        answer = " ".join(str(args.get("answer") or "").split())[:30]
        if not clean_word(answer):
            raise ValueError("The answer needs to be a word or name.")
        if game == "chosung" and not all(is_hangul(c) for c in clean_word(answer)):
            raise ValueError("For 초성 퀴즈 it must be a Korean word, in Hangul.")
        if game == "chosung" and any(_key(p["answer"]) == _key(answer) for p in doc.get("past", [])):
            raise ValueError("You used that one already: pick another.")
        doc["answer"] = answer
        if game == "twenty":
            doc["category"] = " ".join(str(args.get("category") or "").split())[:20]
        else:
            doc["hint"] = ""
        doc["turn"], doc["at"] = "user", _now_iso(now)
        doc["last"] = {"what": "mate_secret"}
        if game == "chosung":
            return f"Set. They see “{chosung(clean_word(answer))}”; never say the answer unless they get it or pass."
        return "Set. Never say it or change it; answer their questions truthfully about it with yes, no or maybe."
    if game == "chosung" and action == "hint":
        if not doc.get("answer"):
            raise ValueError("Pick a word first (secret).")
        doc["hint"] = " ".join(str(args.get("text") or "").split())[:60]
        doc["last"] = {"what": "mate_hint"}
        return "The hint shows on their screen. Say it too, in your own way."
    raise ValueError(f"“{action}” isn't a move in {NAMES[game]}.")


# ---- 가위바위보, with buttons ----

def throw(doc: dict[str, Any], hand: str, rng: random.Random, now: datetime) -> dict[str, Any]:
    """A round: their hand, hers by chance. First to RPS_TO wins. -> the round."""
    if doc.get("status") != "on" or doc["game"] != "rps":
        raise ValueError("no game of 가위바위보 is going on")
    if hand not in HANDS:
        raise ValueError("rock, scissors or paper")
    hers = rng.choice(HANDS)
    win = "draw" if hand == hers else "user" if BEATS[hand] == hers else "mate"
    if win != "draw":
        doc["score"][win] += 1
    r = {"user": hand, "mate": hers, "win": win}
    doc["rounds"] = [*doc["rounds"], r][-30:]
    doc["at"] = _now_iso(now)
    if win != "draw" and doc["score"][win] >= RPS_TO:
        _end(doc, win, now)
    doc["last"] = {"what": "round", **r}
    return r


# ---- what she is told, what the user sees ----

def told(doc: dict[str, Any] | None) -> str:
    """The game, in her <context>: where it stands and what is hers to do now."""
    if not doc:
        return ""
    game, last = doc["game"], doc.get("last") or {}
    s = doc["score"]
    head = f"You are playing {NAMES[game]} with them (you {s['mate']} – them {s['user']})."
    if doc["status"] != "on":
        res = {"user": "they won", "mate": "you won", "draw": "it was a draw", "quit": "it was stopped"}.get(doc.get("result") or "", "it ended")
        extra = f" The answer was “{doc['answer']}”." if doc.get("answer") and game in ("twenty", "chosung") else ""
        how = {"user_gave_up": " They gave up.", "mate_gave_up": " You gave up.", "user_guessed": " They guessed it.",
               "twenty_out": " They ran out of questions."}.get(last.get("what") or "", "")
        return f"The game of {NAMES[game]} just ended: {res}.{how}{extra} React to it in your own way; you may offer another."
    if game == "wordchain":
        chain = " → ".join(w["w"] for w in doc["words"][-8:])
        if last.get("what") == "user_word_bad":
            return (f"{head} Words so far: {chain or '(none yet)'}. Their “{last['word']}” doesn't count: it must be {last['why']}. "
                    "Tell them, playfully, and let them try again.")
        if doc["turn"] == "mate":
            need = " or ".join(next_heads(doc))
            return (f"{head} Words so far: {chain or '(none yet: you open with any word)'}. Your move"
                    + (f": a word starting with {need}" if need else "")
                    + ". Call play_game(action=\"move\", word=…) first, then say it; if it isn't a real word of theirs, "
                      "play_game(action=\"reject\"); if you can't think of one, play_game(action=\"give_up\").")
        return f"{head} Words so far: {chain}. Their turn: wait for their word."
    if game == "twenty":
        if not doc.get("answer"):
            return (f"{head} You think of something for them to guess: call play_game(action=\"secret\", answer=…, category=…) "
                    "before you reply, then tell them the category and that they can start asking.")
        base = (f"{head} Your secret answer is “{doc['answer']}” ({doc.get('category') or 'no category'}); never say it unless they "
                f"guess it or give up. They have asked {doc['asked']} of {TWENTY_MAX}.")
        if last.get("what") == "question":
            return base + " Answer their question about it truthfully: yes, no, or sort of, in your own voice, short; no clues beyond that."
        return base
    if game == "chosung":
        if not doc.get("answer"):
            done = "; ".join(f"“{p['answer']}” ({'they got it' if p['won'] else 'they passed'})" for p in doc.get("past", []))
            what = {"user_correct": "They got the last one!", "user_passed": "They passed on the last one."}.get(last.get("what") or "", "")
            return (f"{head} {what} Round {doc['round']} of {CHOSUNG_ROUNDS}"
                    + (f" (so far: {done})" if done else "")
                    + ": pick a Korean word they would know, call play_game(action=\"secret\", answer=…) before you reply, then tell "
                      "them it's ready (the initials show on their screen).")
        base = (f"{head} Round {doc['round']} of {CHOSUNG_ROUNDS}: your word is “{doc['answer']}”, they see "
                f"“{chosung(clean_word(doc['answer']))}”" + (f", hint so far: {doc['hint']}" if doc.get("hint") else "") + ". Never say it.")
        if last.get("what") == "user_wrong":
            more = " Give them a hint with play_game(action=\"hint\", text=…)." if doc["tries"] >= CHOSUNG_HINT_AFTER and not doc.get("hint") else ""
            return base + f" Their guess “{last['guess']}” is wrong ({doc['tries']} tries).{more}"
        return base
    rounds = doc.get("rounds") or []
    if rounds:
        r = rounds[-1]
        return f"{head} Last round: they threw {r['user']}, you threw {r['mate']} ({'a draw' if r['win'] == 'draw' else 'they won it' if r['win'] == 'user' else 'you won it'})."
    return head


def view(doc: dict[str, Any] | None, history: list[dict[str, Any]]) -> dict[str, Any]:
    """For the 놀이 window: the game as the user may see it (what she keeps secret only once it is over)."""
    record = {g: {"user": sum(1 for h in history if h["game"] == g and h["result"] == "user"),
                  "mate": sum(1 for h in history if h["game"] == g and h["result"] == "mate")} for g in GAMES}
    if not doc:
        return {"game": None, "record": record}
    out = {k: doc.get(k) for k in ("game", "status", "lang", "started", "at", "score", "result", "turn", "by")}
    out["last"] = {k: v for k, v in (doc.get("last") or {}).items() if k != "answer" or doc["status"] != "on"}
    if doc["game"] == "wordchain":
        out |= {"words": doc["words"], "next": next_heads(doc)}
    elif doc["game"] == "twenty":
        out |= {"category": doc.get("category") or "", "asked": doc["asked"], "max": TWENTY_MAX, "ready": bool(doc.get("answer")),
                "answer": doc.get("answer") if doc["status"] != "on" else ""}
    elif doc["game"] == "chosung":
        out |= {"initials": chosung(clean_word(doc["answer"])) if doc.get("answer") else "", "hint": doc.get("hint") or "",
                "round": doc["round"], "rounds": CHOSUNG_ROUNDS, "tries": doc["tries"], "ready": bool(doc.get("answer")),
                "past": doc.get("past", [])}
    else:
        out |= {"throws": doc["rounds"], "to": RPS_TO}
    return {"game": out, "record": record}
