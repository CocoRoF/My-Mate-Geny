FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# System deps:
#  - sshfs/fuse3/openssh-client : remote workspace mounting + bash bridge
#  - nodejs/npm : the Claude Code CLI is a Node package
#  - curl : healthcheck + nodesource bootstrap
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       sshfs openssh-client fuse3 curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Provider CLIs. Both are wired; auth is mounted in at runtime (~/.claude, ~/.codex).
RUN npm install -g @anthropic-ai/claude-code @openai/codex

RUN pip install --no-cache-dir uv
COPY pyproject.toml /app/
COPY app/ /app/app/
RUN uv pip install --system --no-cache .

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
