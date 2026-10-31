# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: open the repository's **Security** tab →
**Report a vulnerability** (private vulnerability reporting). Include what you
found, how to reproduce it, the version / commit, and the impact you expect.

You should get an acknowledgement within a week. Fixes land on `main`; there
are no long-term support branches, so please run a recent version.

## Scope and threat model

My Mate Geny runs coding agents **with a real shell** on the machine (or the
SSH hosts) you connect. Anyone who can sign in can make the agents read,
change and execute anything the server user can. Treat a login as shell
access and deploy accordingly:

- Change the default login (`admin` / `geny-admin`) immediately; see
  [docs/auth.md](docs/auth.md).
- Serve it over HTTPS (the login cookie is then `Secure`; `COOKIE_SECURE=true`
  forces that) or keep it on localhost / a private network. The quick-start
  compose binds to 127.0.0.1.
- Run it as an unprivileged user (the Docker image does) and mount only the
  folders the agents need.
- Back up and protect `~/.hr-harnessor/vault.key` and `session.key`; anyone
  with the vault key and the database can decrypt stored OAuth tokens, API keys
  and SSH keys.

In scope: authentication/session bypass, privilege or secret disclosure through
the API/WebSocket (e.g. reading the vault, `.env`, CLI credentials through the
file viewer), cross-site attacks on the console, injection into the
provider/SSH command lines, path traversal in uploads, mate imports or file
endpoints.

Out of scope: what a signed-in user makes an agent do (that is the product),
vulnerabilities in Claude Code / Codex / third-party services themselves
(report to their vendors), and setups that expose the console over plain http
on a public network.

## Known limitations

- Remote SSH workspaces do not pin host keys yet (`StrictHostKeyChecking=no`);
  use them on networks you trust.
- Forwarded client-IP headers (`X-Forwarded-For`, `CF-Connecting-IP`) are
  trusted from private-network peers, which includes Docker's port-forwarding
  gateway. If the published port is reachable directly from untrusted
  networks, per-IP login bans can be evaded; put a proxy or tunnel in front
  and keep the port bound to 127.0.0.1.
- Agents run with pre-approved tool permissions so that chats don't stall on
  prompts; the container user boundary is the sandbox.
