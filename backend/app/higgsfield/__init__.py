"""Higgsfield as a provider (docs/higgsfield.md).

- :mod:`.oauth`    the official CLI's OAuth client (Clerk, PKCE), pasted callbacks, credentials.json, redaction
- :mod:`.service`  accounts (tokens sealed in the vault), the only token refresher, the account API
- :mod:`.agent`    what a chat's agent gets: the `higgsfield` CLI on PATH with a server-written, access-token-only
  credentials file, the skills, a short prompt note, and the credits a turn spent
"""
