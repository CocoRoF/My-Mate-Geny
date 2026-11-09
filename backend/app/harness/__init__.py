"""The app's own agent harness: Anthropic, OpenAI and Google models through their APIs (docs/api-engines.md).

Claude Code and Codex are CLIs that run their own agent loop; for a model reached with an API key this package is that
loop. It speaks to the model (``llm``), runs the tools the model calls (``tools``), keeps the conversation so it can be
continued, forked and rewound (``transcript``), and turns all of it into the same normalized events the CLIs' turns
produce (``engine``), so a chat on an API key looks and behaves like one on Claude Code or Codex.
"""
