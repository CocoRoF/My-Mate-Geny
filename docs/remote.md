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

## Durable remote commands

`remote_bash` commands run under a small Python 3.8+ supervisor on the SSH host,
independently of the SSH control connection and the agent CLI. The former
`subprocess.run(timeout=300)` command cap is no longer used for shells. Each
control request is bounded. Execution has a generous default limit: 2 hours with
`run_in_background`, where nobody waits for the command, and 24 hours otherwise. A wait
loop whose condition can never come true (the file it watches was deleted) therefore
ends by itself instead of showing as running for ever. An explicit `timeout_ms` replaces
the default; reaching the limit terminates the command's process group, and the task
says why.

Short commands keep their previous plain-output response. Longer ones yield an
opaque `job_id`; `remote_poll(job_id, offset, wait_ms)` continues the **same**
execution with bounded output chunks and its actual exit status. `next_offset`
continues the output without replay or broken UTF-8 boundaries. Never submit a
second command because the first one is waiting or SSH disconnected. Native
background auto-turn guidance is explicitly scoped: SSH foreground jobs use
`remote_poll`; `run_in_background` is for work the user actually wants left
running. `remote_stop` cancels the process group (TERM followed by KILL when
needed), including background children of a shell that already exited.

The backend independently monitors jobs, caches their complete output and
publishes the existing `task.state` events. They appear in the task drawer as
remote commands, with live output and the same Stop button. Reconnects use the
existing ID and durable byte offset. An execution claim prevents retries of a
lost start response from running a command twice. Backend/CLI restarts retain
these jobs and recover their metadata; ordinary native tasks still use the old
engine lifecycle. Active remote job IDs and how long each has run are included in the
next agent turn's message (not the folder note, which is part of the engine's
fingerprint: a job starting or ending must not restart the engine), with a reminder to
stop what it no longer needs. Turn Stop requests cancellation of foreground remote jobs; an
explicit background job has its own Stop button. Deleting a session cancels its
remaining jobs and removes their private artifacts after cancellation is confirmed.

Registry paths are private sibling directories of the application's SQLite DB
(`harnessor.remote-jobs`); metadata/commands/output use owner-only permissions.
Remote state lives in `~/.cache/my-mate-geny/remote-jobs/<session>/`, outside the
project. Decrypted keys are referenced by their existing protected file paths,
never duplicated into job manifests. Command input travels on stdin, and output
is not printed into application error logs. The short-lived command request file
is removed after execution; full output remains available until session cleanup.
The SSH host must be POSIX/Unix and have Python 3.8+; missing support is reported without installing
anything or running the command through an unsafe fallback.

SSH tools and Git-control commands reuse a per-connection ControlMaster socket
(with a 60-second idle lifetime), pinned host-key policy and keepalives. Connect,
control and file-transfer timeouts remain finite. The shared provider turn limit
(default 600 seconds for both local and remote work) is separate from command
lifetime: an SSH job survives the end of that model turn and is recoverable by ID.
Git/CI commands may still contain their own explicit `timeout` or waits; these are
honored. Duration labels represent the whole command, including GitHub/CI waits,
and round minutes correctly instead of displaying “1 minute 60 seconds”.

Tests: `test_remote_jobs.py` runs actual supervisor subprocesses for idempotence,
UTF-8 chunks, lost responses, process-group cancellation, timeout, default limits, a dead
supervisor, restart, and session cleanup. `remote-jobs.cjs` connects real Electron/API/MCP to an isolated
SSH fixture and checks live output, completion without collapsing output, and
Stop against the actual remote process group. No user's project is modified.
