# Higgsfield

Connect a [Higgsfield](https://higgsfield.ai) account and every chat's agent — Claude Code or Codex, in a local or
a remote workspace — can generate images, video, audio and 3D assets with it. The server keeps the login; chats get
the official `higgsfield` CLI already signed in, with a short-lived access token only.

Code: `backend/app/higgsfield/` (`oauth.py` sign-in pieces, `service.py` accounts + tokens + account API, `agent.py`
what a chat gets), `backend/app/routers/higgsfield.py`, the console's `components/providers/Higgsfield*`,
`components/chat/panel/HiggsfieldControls.tsx`, `components/usage/HiggsfieldUsage.tsx`, the desktop app's
`src/oauth-catch.js`.

## Connecting (Settings → Providers → Higgsfield)

Higgsfield signs in only its own CLI's OAuth client (Clerk, PKCE, scopes `email profile offline_access
user:org:read`), and that client's callback is `http://localhost:8765/callback` — a page the server can't receive.
So **Connect** offers two ways:

1. **Sign-in link.** The server makes a PKCE authorize link (valid 15 minutes, one use). Sign in in the new tab; the
   browser then lands on a page that doesn't load, `http://localhost:8765/callback?code=…&state=…`. Copy that whole
   address back into the dialog; the server exchanges the code with its PKCE verifier. In the **desktop app** you
   don't even copy it: while the dialog waits, the app listens on localhost:8765 itself, catches the redirect, shows
   "you can close this tab" and hands the address to the console — whichever server the app is connected to (if
   another program holds port 8765, paste it as above).
2. **credentials.json.** Paste (or choose) the file `higgsfield auth login` writes on a computer
   (`~/.config/higgsfield/credentials.json`). That computer's CLI and this server then share one login, and
   Higgsfield's refresh token may change on every use — whichever refreshes first can sign the other out. Prefer
   the link.

The tab shows each account's email, plan, credit balance, workspace (pick one when the account has several),
whether its login still works, and **Refresh**, **Sign in again**, **Use for chats** (with several accounts: the
default one is what chats use) and **Disconnect**. **Check a price** quotes a job on the account (Higgsfield's own
estimate; nothing is created or spent).

Nothing here buys credits or changes a plan: there is no purchase call anywhere in the code.

### Tokens

- Stored sealed in the vault (`higgsfield:<account id>`, Fernet), `{access, refresh, issued_at, expires_at}`. No API
  answer contains a token; error texts are redacted (`oauth.redact`) before they reach a log, the UI or an
  exception.
- **Only the server refreshes.** Access tokens live about a day; the refresh token may rotate on every use, so a
  second refresher (an agent's CLI) would sign the server out. Refreshes are serialised per account (an asyncio lock;
  the tokens are read again inside it, so of two concurrent callers only one refreshes). A 401 forces one refresh —
  unless another call already replaced that token. A dead refresh token (signed out on higgsfield.ai) marks the
  account **sign in again**.
- Refreshed ahead of time: the server's own calls refresh within the last 10 minutes; a token handed to a chat is
  refreshed when less than 45 minutes are left, so a long `generate --wait` never runs out.

## How agents use it

The official CLI is the tool the Higgsfield skills drive (`higgsfield generate create … --wait`, `model list`,
`generate cost`, `account status`, …), and it works the same for Claude Code and Codex, so every chat gets it:

- **The CLI on PATH.** `<data>/higgsfield/bin/higgsfield` links to the CLI found on the server (`HIGGSFIELD_BINARY`,
  else PATH, `~/.local/bin`, the npm global prefix; the npm package's native binary is used directly). That folder
  goes first on the chat engine's PATH, so a container whose PATH lacks `~/.local/bin` still finds it.
- **Credentials the server controls.** Each chat has `<data>/higgsfield/sessions/<chat>/credentials.json` with the
  account's **access token only** — `{"auth_version": 2, "access_token", "token_type", "scope"}`:
  - no refresh token: the CLI can never rotate the login;
  - no expiry: near an expiry the CLI tries to refresh, and with no refresh token it deletes its credentials file —
    without one it simply uses the token, and the server rewrites the file well before the token expires.

  `HIGGSFIELD_CREDENTIALS_PATH` / `HIGGSFIELD_CONFIG_PATH` (the workspace) point the CLI there — never at the user's
  own `~/.config/higgsfield` — with `HIGGSFIELD_NO_UPDATE_CHECK=1`. The file is written before every turn; while a
  chat's engine lives (Claude keeps one per chat) a keeper refreshes it every 5 minutes as needed; it is removed 15
  minutes after the engine is gone, at once when the chat turns Higgsfield off or the account is disconnected, and
  with its folder when the chat is deleted.
- **Skills.** Claude Code loads the host's `~/.claude/skills/higgsfield-*` (pooled accounts link that folder). A
  server without them can **Install skills**: the official [higgsfield-ai/skills](https://github.com/higgsfield-ai/skills)
  archive goes to `<data>/higgsfield/plugin` (only `higgsfield-*/` files; no links, absolute or `..` paths), which
  Claude chats load with `--plugin-dir`. Codex is pointed at the `SKILL.md` files.
- **A short note.** Claude gets a few lines appended to its system prompt (Codex: in its message, once per thread or
  when the note changes): Higgsfield is connected as which account, the CLI is signed in (never `auth login/logout`,
  never install it, never buy credits), use the skills, quote costly jobs, save results in the workspace and show
  them as a markdown image or link. It has no balances in it, so a chat's engine restarts only when the note really
  changes (turned on/off, a new credit limit, skills installed).
- **Results** are saved into the workspace (`curl -fsSL -o <file> '<result url>'`) and shown with a markdown image or
  link to the file — the chat renders images and opens files through the session's file preview.
- **Remote (SSH) workspaces.** The CLI runs on the server (the agent's own Bash tool, in its local scratch folder);
  the note tells it to put results into the remote workspace with `remote_bash` + `curl` (the remote host needs
  `curl` and internet access). Input media must be on the server for the CLI to upload them.

Mate conversations don't get Higgsfield (their engines are sealed). Avatar Create (docs/avatar-create.md) doesn't
give its agent the CLI either: the SERVER quotes (`/jobs/{jt}/cost`) and runs the jobs itself with the same CLI and an
access-only credentials file per call, and only after the user confirmed the plan.

### Per chat (the session panel's **Higgsfield** section)

- **Use Higgsfield in this chat** — on by default once an account is connected. Off: the chat's credentials file is
  removed at once (a running engine's next CLI call is signed out), the chat's CLI is pointed at an empty
  credentials path (so it never falls back to the user's own login) and the agent is told not to use it.
- **Ask before jobs over N credits** — the agent quotes a job (`higgsfield generate cost …`) and asks first when it
  would cost more. This is an instruction to the agent, not a hard stop: the server doesn't sit between the CLI and
  Higgsfield.
- After a turn that ran the CLI, a line shows the credits it spent (the account's own transactions since the turn
  began, spends minus refunds) and the balance left; it expands to what they were for.

### Usage (Settings → Usage)

A Higgsfield card: plan, credits available, and the latest credit transactions.

## Deployment

- **The CLI must be on the server where chats run.** The Docker image installs `@higgsfield/cli` (best effort). On a
  host install, `npm i -g @higgsfield/cli` (or set `HIGGSFIELD_BINARY`). In a container that mounts the host's home
  at its real path (like this repo's own live deployment), the host user's `~/.local/bin/higgsfield` is found
  through that mount — no compose change needed; the npm package's native binary runs without node.
- Settings (env): `HIGGSFIELD_ROOT` (default `~/.hr-harnessor/higgsfield`), `HIGGSFIELD_BINARY`,
  `HIGGSFIELD_AUTHORIZE_URL` / `HIGGSFIELD_TOKEN_URL` / `HIGGSFIELD_API_BASE` (Higgsfield's endpoints; tests point
  them at a stub), `HIGGSFIELD_SKILLS_URL`.

## Tests

- `backend/tests/test_higgsfield.py` — PKCE link, callback parsing, credentials.json import, refresh serialisation
  (two concurrent refreshes → one call; a 401 refreshes once), dead refresh tokens, redaction, the access-only
  credentials file, the keeper, the session wiring (only when connected and on), the skills archive, and a real
  engine process (the fake Claude CLI) running the CLI with and without Higgsfield.
- `desktop/test/oauth-catch.test.js` — the desktop app's localhost catcher.
- `desktop/test/e2e/higgsfield-browser.js` with `higgsfield-stub.py` — the whole flow in a browser (connect by the
  pasted address, error states, skills, a chat's agent running the real CLI, the switch, Usage), light and dark,
  English and Korean.
