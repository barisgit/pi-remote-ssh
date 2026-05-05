# pi-remote-ssh

Pi extension for named SSH sessions and remote-aware Pi tools.

Current implementation status: Slices 1-3.

Implemented:

- `remote_ssh_create_session`
- `remote_ssh_list`
- `remote_ssh_delete_session`
- Flat registry at `<pi-config-dir>/remote-ssh/sessions.json` (default `~/.pi/remote-ssh/sessions.json`)
- Registry locking with `sessions.lock`, owner metadata, atomic writes, and `0600` registry permissions
- Managed ControlPath derivation under `<pi-config-dir>/remote-ssh/sockets/`
- Remote `bash({ session, command })` via SSH with extension-managed ControlMaster/ControlPath and plain SSH fallback
- Remote `read({ session, path })`, `write({ session, path, content })`, and `edit({ session, path, edits })` via SSH and remote `python3` helpers
- Remote `ls({ session, path })`, `grep({ session, pattern, path })`, and `find({ session, pattern, path })` via SSH and remote `python3` helpers
- Local `bash({ command })`, `read({ path })`, `write({ path, content })`, `edit({ path, edits })`, `ls`, `grep`, and `find` delegation unchanged when `session` is omitted
- Local `write({ path, content })` preserves the previous `write-enhanced` behavior: generated-file protection and hashline-prefix stripping
- Remote `write` applies generated-file protection and hashline-prefix stripping where feasible

Not implemented yet:

- Remote/native `apply_patch`

Remote file tool notes:

- Remote file tools require `python3` on the remote host.
- Remote relative paths are resolved from the session `remote_cwd`; absolute paths are allowed.
- Remote image reads are reported as unsupported; use remote `bash` for image metadata or transfer workflows.

Lifecycle tools never probe remote hosts during create/list. Sessions may point at offline or unreachable hosts and will be saved for future remote use.
