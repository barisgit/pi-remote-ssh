# pi-remote-ssh

Pi extension for named SSH sessions and remote-aware Pi tools.

Current implementation status: Slices 1-2.

Implemented:

- `remote_ssh_create_session`
- `remote_ssh_list`
- `remote_ssh_delete_session`
- Flat registry at `<pi-config-dir>/remote-ssh/sessions.json` (default `~/.pi/remote-ssh/sessions.json`)
- Registry locking with `sessions.lock`, owner metadata, atomic writes, and `0600` registry permissions
- Managed ControlPath derivation under `<pi-config-dir>/remote-ssh/sockets/`
- Remote `bash({ session, command })` via SSH with extension-managed ControlMaster/ControlPath and plain SSH fallback
- Local `bash({ command })` delegation unchanged when `session` is omitted

Not implemented yet:

- Remote file tools (`read`, `write`, `edit`)
- Remote/native `apply_patch`

Lifecycle tools never probe remote hosts during create/list. Sessions may point at offline or unreachable hosts and will be saved for future remote use.
