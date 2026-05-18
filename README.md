# pi-remote-ssh

Pi extension for named SSH sessions and remote-aware Pi tools.

Current implementation status: Slices 1-3.

Implemented:

- `remote_ssh_create_session`
- `remote_ssh_list`
- `remote_ssh_delete_session`
- Flat registry at `<pi-config-dir>/remote-ssh/sessions.json` (default `~/.pi/remote-ssh/sessions.json`)
- Registry locking with `sessions.lock`, owner metadata, atomic writes, and `0600` registry permissions
- Managed ControlPath derivation under `<pi-config-dir>/remote-ssh/sockets/`, exposed by `remote_ssh_list` as `socket_path` for direct OpenSSH reuse
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
- `connect_timeout` sets OpenSSH `ConnectTimeout` separately from the overall command `timeout`.

Remote file tool notes:

- Remote file tools require `python3` on the remote host.
- Remote relative paths are resolved from the session `remote_cwd`; absolute paths are allowed.
- Remote image reads are reported as unsupported; use remote `bash` for image metadata or transfer workflows.

Lifecycle tools never probe remote hosts during create/list. Sessions may point at offline or unreachable hosts and will be saved for future remote use.

Managed socket notes:

- `remote_ssh_list({ view: "full" })` shows each session's derived `socket_path`; all list views also return it in tool `details`.
- Agents that need direct OpenSSH tools such as `scp`, `sftp`, or plain `ssh` should reuse that managed socket with `-o ControlMaster=auto -o ControlPath=<socket_path>` instead of creating an unrelated control socket or connection.
- Socket files are created lazily on first remote use and may be absent until then; the path is still stable for the saved session unless the Pi remote-ssh state dir changes.
- If `socket_status` is `absent`, agents should prewarm the managed socket with a simple remote command such as `bash({ session: "<session>", command: "echo alive" })` before direct `scp`/`ssh` reuse.
- Socket paths mirror session paths as `<pi-config-dir>/remote-ssh/sockets/<session/path>/control.sock` when short enough, otherwise they are hashed under `<pi-config-dir>/remote-ssh/sockets/hashed/`.

`remote_ssh_create_session` accepts either a single top-level `{ path, target, ... }` session or `sessions: [...]` for an atomic batch create. `remote_ssh_delete_session` accepts either `path` or `paths: [...]` for an atomic batch delete. No additional batch tool names are registered.
