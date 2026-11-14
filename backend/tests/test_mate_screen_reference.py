"""While they share their screen (docs/mate.md §4 "Seeing the screen"): its picture is only a glance at what they have in front
of them, never a photo they sent her, and the moments she may speak up on her own say what the moment is, never what to say."""

from __future__ import annotations

from app.mate.trigger.defaults import default_manifest
from app.mate.trigger.fixed import FIXED_CONTENT, FixedPolicy
from app.mate.trigger.runtime import SCREEN_NOTE, SPEAK_UP
from app.providers._attachments import Attachment, compose_text, inline_note


def _att(i: int, *, screen: bool = False, label: str = "") -> Attachment:
    return Attachment(id=f"att_{i}", name=f"f{i}.png", mime="image/png", size=10, kind="image", path=f"/tmp/f{i}.png",
                      label=label, screen=screen)


def test_a_picture_of_their_screen_is_no_photo_they_sent():
    note = inline_note([_att(1, screen=True)], inline_images=True)
    assert note.startswith("<screen>") and "not something they sent you" in note and "attached these files" not in note
    assert "[att_1]" in note  # (she can still hand it to a chat)
    both = inline_note([_att(2), _att(1, screen=True, label="main screen (the one in use)")], inline_images=True)
    assert both.index("The user attached these files") < both.index("[att_2]") < both.index("<screen>")
    assert both.index("<screen>") < both.index("main screen (the one in use)")
    assert compose_text("hi", [_att(1, screen=True)], inline_images=True, inline_files=True).startswith("hi\n\n<screen>")
    assert compose_text("", [_att(1, screen=True)], inline_images=True, inline_files=True).startswith("<screen>")


def test_her_moments_say_what_the_moment_is_never_what_to_talk_about():
    for text in [*FIXED_CONTENT.values(), SPEAK_UP, SCREEN_NOTE]:
        low = text.lower()
        assert "react" not in low and "comment on" not in low and "help" not in low and "도움" not in text, text
    assert "[SILENT]" in SPEAK_UP and "Whether you do is yours" in SPEAK_UP and "never just to fill the silence" in SPEAK_UP
    assert "don't describe it or make it the topic" in SCREEN_NOTE
    p = FixedPolicy(default_manifest(), clock=lambda: 100000, hour=9, screen_active=True)
    text, cat = p._pick_category_and_prompt("s", lambda _: False)
    assert cat.id == "screen_observation" and text == FIXED_CONTENT["screen_observation"] and "TRIGGER" not in text
