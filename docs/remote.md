# Remote workspaces

Goal: the runtime stays on the server that runs My Mate Geny, but an agent can
operate a folder on a remote SSH host. Design (`app/workspaces/remote_ssh.py` + `mcp_remote_bridge.py`):

- The agent starts in a small **local scratch dir** (`resolve_cwd`) containing a
  generated `CLAUDE.md` that tells it the remote target and to use the remote
  tools. It never cd's into the remote filesystem.
- All remote I/O goes through an **SSH-backed MCP bridge** (`mcp_config` →
  `mcp_remote_bridge.py`, a stdio MCP server) exposing:
  `remote_bash` (run a command), `remote_read`, `remote_write`, `remote_list`.
  Paths resolve against the chosen remote workspace path; transport is the
  system `ssh` with the connection's key.

This replaced an earlier sshfs-mount approach: sshfs/fuse is brittle inside
containers (mount-namespace visibility), while the MCP-tools approach is
dependency-free and works identically on host and in Docker.

Browsing (`list_dir`) uses SFTP directly (asyncssh) — no mount needed.

## Connections

Register a host in the UI (**Connections** tab) or via API:

```
POST /api/connections
{ "name": "build-box", "host": "build.example.com", "port": 22,
  "username": "deploy", "private_key_pem": "-----BEGIN ...", "default_path": "." }
```

The private key is stored **encrypted in the vault**; the public connection
record only carries `has_key: true`. `GET /api/connections/{id}/status` probes
reachability (asyncssh) and reports whether `sshfs` is available on the runtime.

## Requirements

- Only an SSH key authorized on the remote host. No sshfs/fuse needed.
- Either a key pasted in **Connections** (stored in the vault) or the runtime
  user's own `~/.ssh` key authorized on the remote host.

## Status

Working end-to-end (host run and Docker): asyncssh reachability, SFTP browse,
and agent turns using `remote_bash`, `remote_write` + `remote_read`.

Remaining hardening: pin `known_hosts` (currently `StrictHostKeyChecking=no` /
`known_hosts=None`); add `remote_glob`/`remote_grep` convenience tools.
