"""This app is the remote access to its sessions: Claude Code's own Remote Control never starts with them,
whatever account (config dir) runs the session."""

from __future__ import annotations

import json

from app.providers.base import TurnRequest
from app.providers.claude_code import ClaudeCodeProvider


def _flag_settings(argv: list[str]) -> dict:
    i = argv.index("--settings")
    return json.loads(argv[i + 1])


def _argv(**kw) -> list[str]:
    return ClaudeCodeProvider()._build_argv(TurnRequest(messages=[{"role": "user", "content": "hi"}], model="", cwd="/tmp", **kw))


def test_remote_control_is_off_for_every_session():
    assert _flag_settings(_argv())["remoteControlAtStartup"] is False
    assert _argv().count("--settings") == 1


def test_the_allowed_tools_still_travel_in_the_same_flag_settings():
    s = _flag_settings(_argv(allow_tools=["mcp__geny__x"]))
    assert s == {"remoteControlAtStartup": False, "permissions": {"allow": ["mcp__geny__x"]}}
