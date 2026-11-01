"""Korean particles (josa) that follow the word before them: 이/가, 은/는, 을/를,
과/와, 아/야, 이랑/랑, 이에요/예요, (으)로.

The same algorithm lives in ``frontend/src/lib/josa.ts``; both are tested
against ``frontend/test/fixtures/josa-cases.json`` (docs/mate-memory-affinity.md §3.2).

* The last *pronounced* character decides: trailing spaces, quotes, brackets
  and ``~!?.,…`` are skipped.
* A Hangul syllable: final consonant (받침) = ``(code - 0xAC00) % 28 != 0``;
  ㄹ is 8 (``(으)로`` takes 로 after it).
* A digit by its Korean reading; a Latin word by its last letter (l → ㄹ,
  m / n / ng → 받침, else none). Anything else is unknown → the written-out
  fallback (``이(가)``).
"""

from __future__ import annotations

from typing import Literal

Sound = Literal["none", "batchim", "rieul"]

_SKIP = set(" \t\n\"'“”‘’「」『』()[]{}<>~!?.,…·-_")
# 0 영 1 일 2 이 3 삼 4 사 5 오 6 육 7 칠 8 팔 9 구
_DIGITS: dict[str, Sound] = {"0": "batchim", "1": "rieul", "2": "none", "3": "batchim", "4": "none", "5": "none",
                             "6": "batchim", "7": "rieul", "8": "rieul", "9": "none"}
# particle (either form) -> (after a final consonant, after a vowel, written-out fallback)
_PAIRS: dict[str, tuple[str, str, str]] = {}
for _a, _b, _fb in (("이", "가", "이(가)"), ("은", "는", "은(는)"), ("을", "를", "을(를)"), ("과", "와", "과(와)"),
                    ("아", "야", ""), ("이랑", "랑", "(이)랑"), ("이에요", "예요", "(이)에요"), ("으로", "로", "(으)로")):
    _PAIRS[_a] = _PAIRS[_b] = (_a, _b, _fb)
_PAIRS["(으)로"] = _PAIRS["으로"]


def is_hangul(ch: str) -> bool:
    return "가" <= ch <= "힣"


def final_sound(word: str) -> Sound | None:
    """How the word ends: no final consonant, a final consonant, ㄹ — or None (can't tell)."""
    s = (word or "").rstrip()
    i = len(s) - 1
    while i >= 0 and s[i] in _SKIP:
        i -= 1
    if i < 0:
        return None
    ch = s[i]
    if is_hangul(ch):
        jong = (ord(ch) - 0xAC00) % 28
        return "none" if jong == 0 else "rieul" if jong == 8 else "batchim"
    if ch in _DIGITS:
        return _DIGITS[ch]
    if ch.isascii() and ch.isalpha():
        j = i
        while j >= 0 and s[j].isascii() and s[j].isalpha():
            j -= 1
        w = s[j + 1:i + 1].lower()
        if w.endswith("ng") or w[-1] in "mn":
            return "batchim"
        if w[-1] == "l":
            return "rieul"
        return "none"
    return None


def particle(word: str, p: str) -> str:
    """Just the particle for ``word`` (``particle("현석", "이") == "이"``)."""
    pair = _PAIRS.get(p)
    if pair is None:
        return p
    with_b, without_b, fallback = pair
    snd = final_sound(word)
    if snd is None:
        return fallback
    if with_b == "으로":
        return "로" if snd in ("none", "rieul") else "으로"
    return without_b if snd == "none" else with_b


def josa(word: str, p: str) -> str:
    """``word`` + its particle (``josa("현석", "을") == "현석을"``)."""
    return f"{word}{particle(word, p)}"


def is_bare_korean_name(address: str, user_name: str) -> bool:
    """A plain Korean personal name (no title): 현석, 지수."""
    a = (address or "").strip()
    return bool(a) and a == (user_name or "").strip() and 1 <= len(a) <= 5 and all(is_hangul(c) for c in a) \
        and not a.endswith("님")


def address_forms(address: str, *, casual: bool) -> dict[str, str]:
    """The forms of how the mate calls the user, for the prompt.

    ``casual`` (반말 + a bare Korean name): the friendly -이 before particles
    after a final consonant (현석 → 현석이가 / 현석이는 / 현석이를) and 아/야 when
    calling (현석아, 지수야). Otherwise the plain particles on the address and
    the address itself when calling (+ 께 after 님)."""
    a = (address or "").strip()
    if not a:
        return {}
    if casual:
        stem = a + ("이" if final_sound(a) in ("batchim", "rieul") else "")
        return {"subject": josa(stem, "가"), "topic": josa(stem, "는"), "object": josa(stem, "를"),
                "with": josa(stem, "랑"), "call": josa(a, "아")}
    out = {"subject": josa(a, "이"), "topic": josa(a, "은"), "object": josa(a, "을"), "with": josa(a, "과"),
           "call": a}
    if a.endswith("님"):
        out["to"] = a + "께"
    return out
