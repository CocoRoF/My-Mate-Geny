"""The Mate: an avatar secretary that hands work to the chat sessions.

See docs/mate.md (the contract). Pieces:

* :mod:`app.mate.store`      — mates / memories / global settings (SQLite + vault)
* :mod:`app.mate.files`      — per-mate files: assets, imports, Live2D Cubism Core
* :mod:`app.mate.prompt`     — the mate engine's system prompt
* :mod:`app.mate.service`    — conversation (a ``kind='mate'`` session), engine
  config, the delegation tools and delegation results
* :mod:`app.mate.mcp_bridge` — stdio MCP server the mate engine talks to
* :mod:`app.mate.voice`      — speech synthesis / transcription providers
"""
