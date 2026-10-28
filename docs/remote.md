# Remote workspaces (2222 / 2224)

Goal: the runtime stays on **2223**, but an agent can operate a folder on a
remote SSH host. Two moving parts (`app/workspaces/remote_ssh.py`):

1. **Files — sshfs mount.** `resolve_cwd(path)` mounts the remote folder onto
   2223 at `<MOUNT_ROOT>/<connection_id>/<hash>` and returns that path as the
   agent's `cwd`. The provider CLI's built-in Read/Write/Edit/Glob/Grep then
   operate on remote files transparently.
2. **Commands — remote-bash MCP bridge.** `mcp_config(path)` attaches
   `mcp_remote_bridge.py` (a stdio MCP server) so the agent's shell commands run
   on the remote host over SSH instead of on 2223.

Browsing (`list_dir`) uses SFTP directly — no mount needed to pick a folder.

## Connections

Register a host in the UI (**Connections** tab) or via API:

```
POST /api/connections
{ "name": "prod-2222", "host": "<server-ip>", "port": 2222,
  "username": "hrjang", "private_key_pem": "-----BEGIN ...", "default_path": "." }
```

The private key is stored **encrypted in the vault**; the public connection
record only carries `has_key: true`. `GET /api/connections/{id}/status` probes
reachability (asyncssh) and reports whether `sshfs` is available on the runtime.

## Requirements on the runtime host

- `sshfs` + `fuse3` (the backend Docker image installs these; for host runs:
  `apt-get install sshfs`).
- In Docker, the backend needs `cap_add: SYS_ADMIN`, `/dev/fuse`, and
  `apparmor:unconfined` to mount — see `docker-compose.yml`.

## Status

**Working, verified end-to-end against 2222 and 2224** (2026-10-28):

- `sshfs` installed on the 2223 runtime; the server's key (`~/.ssh/id_ed25519`)
  is authorized on both remote hosts.
- Connections for `srv-2222` / `srv-2224` registered (keys encrypted in the vault).
- Proven live: asyncssh reachability, SFTP folder browse, sshfs mount, the agent's
  built-in Write tool landing a file on the remote host (confirmed by independent
  `ssh cat`), and `mcp__remote__remote_bash` executing commands on the remote
  (returned the remote hostname).

Remaining hardening: pin `known_hosts` (currently `StrictHostKeyChecking=no` /
`known_hosts=None`), and unmount stale sshfs mounts on a schedule.
