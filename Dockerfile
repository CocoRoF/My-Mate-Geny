# My Mate Geny — one image: the FastAPI backend serves the built web console
# (single origin, so the login gate covers the UI too), plus the Claude Code
# and Codex CLIs the engines drive.
#
#   docker compose up -d          # see docker-compose.yml / docs/deploy.md
#
# Build args:
#   GENY_UID / GENY_GID  uid/gid of the in-container user (default 1000). Match
#                        your host user if you bind-mount host folders, so the
#                        agent can write to them.

# ---------------------------------------------------------------- web console
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/vendor ./vendor
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# git: repo clones + per-turn change snapshots; openssh-client: remote
# workspaces (SSH-backed MCP bridge); nodejs: the provider CLIs; tini: reaps
# the CLI subprocesses.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git openssh-client curl ca-certificates gnupg tini \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Provider CLIs. Logins are made from the console (Providers / Accounts) or by
# mounting an existing ~/.claude / ~/.codex — nothing is baked into the image.
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force
# Higgsfield's CLI (docs/higgsfield.md): the chats' agents generate images / videos with it once an account is
# connected in Settings → Providers → Higgsfield (the server signs it in). Optional: a failed download only means
# chats can't use Higgsfield until it is installed (or HIGGSFIELD_BINARY names one).
RUN (npm install -g @higgsfield/cli && npm cache clean --force) \
    || echo "warning: @higgsfield/cli was not installed; chats can't use Higgsfield until it is"

WORKDIR /app
RUN pip install --no-cache-dir uv
COPY backend/pyproject.toml /app/
COPY backend/app/ /app/app/
RUN uv pip install --system --no-cache .
COPY --from=web /web/dist /app/static

# Non-root: the Claude CLI refuses its permissive modes when run as root.
ARG GENY_UID=1000
ARG GENY_GID=1000
RUN groupadd -g "${GENY_GID}" geny \
    && useradd -m -u "${GENY_UID}" -g "${GENY_GID}" -s /bin/bash geny \
    && mkdir -p /workspaces /home/geny/.hr-harnessor \
    && chown -R geny:geny /workspaces /home/geny
USER geny
ENV HOME=/home/geny \
    STATIC_DIR=/app/static \
    DB_PATH=/home/geny/.hr-harnessor/harnessor.db \
    MATE_SEARCH_ROOTS=/workspaces \
    DISABLE_AUTOUPDATER=1

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
