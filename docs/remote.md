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

## Folders on several hosts

A chat's additional folders are *(host, path)* pairs (`app/services/folders.py`, stored in
`sessions.extra_dirs` as `[{path, connection_id|null}]`; old plain-path rows are migrated to the
workspace's host). Whatever the workspace is, a folder can be on this server or on any SSH connection:

- **This server** → real paths for the CLI (`--add-dir` for Claude; listed in the message for Codex):
  the agent's own tools work on them.
- **SSH hosts** → one `remote` MCP server for all of them (`mcp_remote_bridge.py`, same tool names as
  before) whose tools take a `host` argument (the connection's name; default = the workspace's host).
  Each host is allow-listed with only its folders (+ the workspace and the chat's uploads dir there);
  paths are checked on the host after `realpath -m`, so `..` and symlinks can't leave them.
  `remote_bash` starts inside an attached folder; what a shell command then does is up to it.
- The agent gets a short "Folders in this chat" note (Claude: system prompt; Codex: with the message).
- **A connection that is this machine** (e.g. an SSH connection to the server itself) is detected
  (`app/workspaces/this_host.py`: a nonce file read back over SSH, then device + inode per folder):
  its folders that are visible here are used as this server's folders — no SSH hop, no duplicates —
  and the Folder popover offers it as "this server".

`PATCH /api/sessions/{id}` takes `folders` (every folder, with its host); folders being attached are
checked on their host first (404 not found, 403 permission, 502 unreachable). `extra_dirs` (paths on
the workspace's host) is still accepted and returned for older clients. The Explorer, file viewer,
@-mentions, changed files and the Git button follow each folder's host.

## Git on SSH hosts

`/api/sessions/{id}/git` works on the repo's own host (`git_repo_conn`): status, branches, switching,
repos found on every host of the chat. `POST …/git/clone` clones onto this server or any SSH host —
with a Git account (picked from its repos) or anonymously by URL — then connects it. Over SSH the
token goes in on stdin, lives in a 0600 file in a 0700 `mktemp` dir only while `git clone` runs
(`GIT_ASKPASS`), and the dir is removed on exit; `credential.helper` is emptied for that run, so
nothing is written to the repo's config, a credential store or the process list. Pushing from that
host uses its own Git login.

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
