# pi-remote-ssh

Pi extension for named SSH sessions and remote-aware Pi tools.

Current implementation status: Slices 1-3.

Implemented:

- `remote_ssh_create_session`
- `remote_ssh_list`
- `remote_ssh_delete_session`
- Flat registry at `<pi-config-dir>/remote-ssh/sessions.json` (default `~/.pi/remote-ssh/sessions.json`)
- Registry locking with `sessions.lock`, owner metadata, atomic writes, and `0600` registry permissions
- Managed ControlPath derivation under a short socket directory (default `/tmp/prs/<state-hash>`), exposed by `remote_ssh_list` as `socket_path` for direct OpenSSH reuse
- Ordered SSH targets per session, with automatic transport and broken-control-socket failover
- Remote `bash({ session, command })` via SSH with extension-managed ControlMaster/ControlPath and plain SSH fallback
- Remote `read({ session, path })`, `write({ session, path, content })`, and `edit({ session, path, edits })` via SSH and remote `python3` helpers
- Remote `ls({ session, path })`, `grep({ session, pattern, path })`, and `find({ session, pattern, path })` via SSH and remote `python3` helpers
- Local `bash({ command })`, `read({ path })`, `write({ path, content })`, `edit({ path, edits })`, `ls`, `grep`, and `find` delegation unchanged when `session` is omitted
- Local `write({ path, content })` preserves the previous `write-enhanced` behavior: generated-file protection and hashline-prefix stripping
- Remote `write` applies generated-file protection and hashline-prefix stripping where feasible

Not implemented yet:

- Remote/native `apply_patch`

Remote bash notes:

- Exact `bash({ session: "group/host", command })` behavior is unchanged.
- `bash({ session: "group/*", command })` expands direct child sessions locally, runs the command with bounded concurrency, and returns one aggregated tool result with grouped per-session output and `details.batch === true`.
- `bash({ session: "group/**", command })` expands all descendant sessions recursively.
- `bash({ session: "*", command })` expands direct root sessions; `bash({ session: "**", command })` expands all sessions.
- `connect_timeout` overrides the 10-second SSH startup deadline (including stale control sockets), separately from command `timeout`. Once the remote command starts, quiet or long-running bash has no default runtime limit. Uncached `$HOME` discovery is a separate setup helper bounded to 60 seconds (or a tighter positive `timeout`); it does not impose that limit on the requested command.

Remote file tool notes:

- Remote file tools require `python3` on the remote host.
- Remote relative paths are resolved from the session `remote_cwd`; absolute paths are allowed.
- Remote image reads are reported as unsupported; use remote `bash` for image metadata or transfer workflows.
- Each file/search helper, including `$HOME` discovery, has a 60-second deadline across connection attempts and execution. Multi-step tools may run several helpers. Cancellation reaches every helper, including sessions with a cached working directory.

Lifecycle tools never probe remote hosts during create/list. Sessions may point at offline or unreachable hosts and will be saved for future remote use.

Transport failure bounds:

- Every SSH attempt has a 10-second startup deadline by default. OpenSSH also uses one connection attempt and 15-second server-alive probes with three unanswered probes before disconnecting. These probes detect dead connections, not hung remote programs.
- Abort or deadline expiry sends SIGTERM to the local SSH process group, then SIGKILL after 1 second and settles without waiting indefinitely for child closure. Thus a stuck startup normally fails within about 11 seconds, and a stuck file/search helper within about 61 seconds. Event-loop scheduling can add latency.
- If SSH exits but descendants retain its pipes, allow 1 second to drain before the same cleanup (about 2 seconds after exit). Killing local SSH cannot guarantee rollback or termination of remote processes; inspect state before manually retrying a mutation.
- Recognized pre-execution connection/control errors may advance through configured targets, with at most a controlled and a plain attempt per target. Explicit command/helper deadlines cover those retries. A plain retry disables multiplexing even when SSH config enables it.
- Safety options take precedence over conflicting `ssh_args` and SSH config. These bounds apply to extension tools, not independently invoked `scp`, `sftp`, or `ssh`.

Managed socket notes:

- Persistent session definitions live under `PI_REMOTE_SSH_STATE_DIR` / `~/.pi/remote-ssh`.
- OpenSSH ControlPath sockets are runtime-only and default to the much shorter `PI_REMOTE_SSH_SOCKET_DIR` / `/tmp/prs/<state-hash>` so long human-readable session paths fit under Unix socket path limits.
- `remote_ssh_list({ view: "full" })` shows each session's derived `socket_path`; all list views also return it in tool `details`.
- Agents that need direct OpenSSH tools such as `scp`, `sftp`, or plain `ssh` should reuse that managed socket with `-o ControlMaster=auto -o ControlPath=<socket_path>` instead of creating an unrelated control socket or connection.
- Socket files are created lazily on first remote use and may be absent until then; the path is still stable for the saved session unless the Pi remote-ssh state dir changes.
- If `socket_status` is `absent`, agents should prewarm the managed socket with a simple remote command such as `bash({ session: "<session>", command: "echo alive" })` before direct `scp`/`ssh` reuse.
- Socket paths mirror session paths as `<socket-dir>/<session/path>/c` when short enough; very long paths fall back to `<socket-dir>/<session-hash>.s`.

`remote_ssh_create_session` accepts either a single top-level `{ path, targets: ["server.tailnet.ts.net", "203.0.113.10"], ... }` session or `sessions: [...]` for an atomic batch create. Targets are tried in listed order for connection setup failures and broken managed control sockets; each target has its own managed socket. A private startup acknowledgement prevents replay once execution is confirmed, even for silent commands. Local startup/command deadlines and cancellation never retry an uncertain operation. The legacy single `target` field is accepted for existing registries and callers. `remote_ssh_delete_session` accepts either `path` or `paths: [...]` for an atomic batch delete. No additional batch tool names are registered.
