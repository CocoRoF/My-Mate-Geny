"""Avatar Create (docs/avatar-create.md): an agent in the Mate window that designs a video avatar with Higgsfield.

* :mod:`app.avatar.presets`  — stills, clips, presets, the prompt templates (from the official mates' pipeline)
* :mod:`app.avatar.plan`     — the plan, its price, the spending gate (pure)
* :mod:`app.avatar.generator` — Higgsfield quotes (free) and jobs (the CLI, access-only credentials)
* :mod:`app.avatar.pipeline` — the picture/video processing (its own venv: numpy, scipy, OpenCV, Pillow, ffmpeg)
* :mod:`app.avatar.deps`     — that venv, memory-capped and serialized runs
* :mod:`app.avatar.store`    — projects (DB row + folder)
* :mod:`app.avatar.service`  — the agent's conversation and tools, user actions, the runner, apply / restore
* :mod:`app.avatar.mcp_bridge` — the agent's stdio MCP server
"""
