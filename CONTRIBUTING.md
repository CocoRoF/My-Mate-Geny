# Contributing to My Mate Geny

Thanks for helping. Bug reports, fixes, docs and new providers are all welcome.

## Before you start

- **Bugs**: open an issue with steps to reproduce, what you expected, what
  happened, and your setup (Docker or host run, browser / app, engine).
  Remove tokens, hostnames and personal paths from logs.
- **Features / larger changes**: open an issue first so we can agree on the
  shape before you spend time on it.
- **Security issues**: never in public issues — see [SECURITY.md](SECURITY.md).

## Development setup

See [README.md → Development](README.md#development). In short:

```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
cp .env.example .env            # COOKIE_SECURE=false for http://localhost
uvicorn app.main:app --reload --port 8080

cd frontend && npm ci && npm run dev
```

The full stack in Docker: `docker compose up -d --build`.

## Checks (run before opening a PR)

```bash
cd backend && pytest -q           # all tests must pass; they don't need real CLIs
cd backend && ruff check <changed files>   # lint new code (older code has some lint debt)
cd frontend && npx tsc -p . --noEmit && npm run build
docker compose config -q          # if you touched compose files
```

CI runs the backend tests and the frontend typecheck/build on every PR.

## Pull requests

- One topic per PR; keep unrelated refactors out.
- Add or update tests for behaviour changes (`backend/tests/`).
- Update the docs when you change behaviour, settings (`backend/app/config.py`
  ⇄ `backend/.env.example` must stay in sync) or APIs (`docs/*.md`).
- Commit messages: short imperative subject with a scope, e.g.
  `fix(ws): resume after reconnect`, `feat(mate): ...`, `docs: ...`.
- Don't commit secrets, `.env` files, databases, Cubism Core files, model
  weights or personal paths / hostnames.

## Adding a provider (engine)

Subclass `app/providers/base.py::Provider`, register it in
`app/providers/registry.py`, normalize its output to the event schema
(`docs/providers.md`), and add tests with a fake CLI like the existing ones.

## Content and assets

Code contributions are accepted under the [Apache-2.0](LICENSE) licence
(inbound = outbound): by opening a PR you confirm you have the right to submit
it under that licence. Artwork, characters, voices and models follow their own
terms ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)); only add content you
own or that is licensed for redistribution, and record it there.
