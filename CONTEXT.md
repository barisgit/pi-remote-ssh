# Pi Remote SSH

Pi Remote SSH lets Pi operate on local files/commands by default and opt into remote execution through named SSH sessions.

## Language

**Remote Mode**:
Execution of a normal Pi tool against a named SSH session by passing `session`.
_Avoid_: remote-only tool, mounted mode

**Session**:
A saved SSH session definition with a target host, optional remote cwd, and derived runtime state such as a managed socket.
_Avoid_: active connection, host only, environment

**Local Mode**:
The default behavior of wrapped Pi tools when `session` is omitted.
_Avoid_: default session, implicit remote

**Session Registry**:
Persistent saved session definitions shared across Pi sessions, stored as runtime/user state outside the Pi agent config directory.
_Avoid_: active connection cache, socket state, agent config

**Session Path**:
A slash-separated stable identifier for a saved session using conservative path segments, e.g. `home-vps` or `rpi-lab/pi-03`.
_Avoid_: namespace plus name, folder, profile

**Managed Socket**:
An SSH control socket created and owned by Pi Remote SSH for a saved session.
_Avoid_: user-provided socket, manual ControlPath

**SSH Args**:
Optional saved OpenSSH client argument tokens used to express keys, config files, proxy jumps, or SSH options.
_Avoid_: ssh command string, shell command, command pipeline

**Lifecycle Tool**:
A tool whose only purpose is to list, create, or delete saved sessions.
_Avoid_: remote file tool, overloaded session action

## Relationships

- A **Session** may define a remote cwd; if omitted, remote `$HOME` is resolved on first connect and written back to the **Session Registry**.
- The remote cwd is a default base for relative paths and remote shell commands; it is not a path safety boundary.
- Absolute paths in **Remote Mode** are allowed as remote absolute paths.
- **Local Mode** is used when a wrapped tool call omits `session`.
- **Remote Mode** requires exactly one **Session** per tool call.
- A **Session Registry** stores reusable **Session** definitions, not guaranteed-live connections.
- A **Session Path** identifies exactly one saved **Session** and must be used in full by wrapped tool calls.
- A **Managed Socket** belongs to exactly one **Session Path** and is recreated lazily by the extension on first use.
- **SSH Args** customize how a **Session** connects but must not contain target hosts or shell syntax; target stays a separate field.
- `port` remains a separate common-case field; conflicting port settings between `port` and **SSH Args** are rejected.
- The **Session Registry** is a flat map keyed by full **Session Path**, not a nested hierarchy.
- Runtime/user state lives under the Pi config dir's `remote-ssh/` state directory, defaulting to `~/.pi/remote-ssh/`; nothing remote-ssh-specific belongs under `~/.pi/agent/` unless it is actual Pi extension configuration.
- The **Session Registry** does not store derived socket paths; sockets are derived from **Session Paths**.
- `sessions.json` should be written with `0600` permissions using a lock directory/file and atomic temp-file rename.
- Secrets in `ssh_args` are discouraged but not blocked; once the agent knows a secret, policy must treat it as already exposed.
- `create_session` saves definitions even when the host is offline or unreachable.
- Corrupt session registry JSON fails remote tools clearly and is never silently overwritten.
- Import/export tools are out of v1; `sessions.json` is the import/export surface.
- Registry locking uses an owner metadata file, 30s normal wait timeout, and 5m stale-break threshold; manual lock deletion is acceptable as a rare recovery path, similar to git lock recovery.
- Remote `write`/`edit` should use temp-file + rename on the remote host where this preserves or improves Pi parity, while preserving existing mode and symlink behavior where feasible.
- Remote `apply_patch` has no git behavior; it prevalidates all changes locally, writes remote temp files, renames them over targets, and performs best-effort rollback on rare remote write/rename failure.
- Remote `write` has no `mode` parameter; new files follow remote default umask like normal writes.
- Remote `edit` enforces Pi's exact-text uniqueness and non-overlap rules.
- Remote `read` uses Pi's 1-indexed `offset` and `limit` semantics exactly.
- Lifecycle tool names are `remote_ssh_list`, `remote_ssh_create_session`, and `remote_ssh_delete_session`.
- The extension overrides/routes normal `bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`, and eventually `apply_patch` by optional `session?: string`.
- If remote `python3` is missing, remote file tools fail clearly, while remote `bash` can still work.
- Implementation can ship in slices; registry/lifecycle + remote bash is an acceptable stopping point/MVP before file tools and apply_patch parity.
- Remote-mode tool labels should include **Session Path** and resolved remote path/cwd when practical.
- Unknown **Session Path** errors should include nearest prefix/name suggestions from the registry.
- Managed socket paths mirror **Session Paths** when possible and may be hashed if Unix socket path limits require it.
- Startup cleanup may delete stale files under the extension-owned socket directory after confirming no control master is alive.
- Deleting a **Session** removes its registry entry and closes/removes its managed socket, but does not delete logs/output artifacts.
- File operations use `ssh` transport, not `scp`; Dropbear SSH servers should work with local OpenSSH clients, with fallback/error handling if ControlMaster is unsupported.
- `ssh_args` allow arbitrary OpenSSH option tokens except shell syntax, target-like positional args, and options that conflict with extension-managed sockets/control lifecycle.
- The extension injects its own ControlMaster/ControlPath settings with a default `ControlPersist=60s`.
- If ControlMaster fails, remote operations may retry plain `ssh` and should report socket unavailability in details.
- Remote file tools require `python3`; no shell-utility fallback in v1.
- Remote `bash` runs through deterministic `sh -lc` with a safely quoted `cd "$remote_cwd" && <command>` wrapper, not login-shell magic.
- Remote `ls`, `grep`, and `find` use the selected **Session** `remote_cwd` for relative paths and preserve **Local Mode** behavior when `session` is omitted.
- `remote_ssh_list` never opens network connections; it only reports registry and cheap local socket/control-master status.
- Remote image/attachment reads are explicitly unsupported in v1.
- A **Lifecycle Tool** manages **Sessions** but does not read, write, patch, or run project commands.

## Example dialogue

> **Dev:** "Can multiple **Sessions** be open while the model still uses normal `read` and `bash`?"
> **Domain expert:** "Yes — the tool enters **Remote Mode** when the call includes `session`; otherwise it stays local."

## Flagged ambiguities

- "Both" goals are required: minimal tool surface and multi-session support are compatible because normal tools accept an optional `session` field.
- `session` is optional on wrapped tools: omitted means **Local Mode**, expected to be the common path.
- Unlike the original opencode plugin, users should not provide SSH control socket paths; Pi Remote SSH owns **Managed Socket** paths and lifecycle.
- Saved **Sessions** reconnect lazily on first use, not eagerly on Pi startup.
- Many saved **Sessions** are organized by **Session Path** prefixes; examples include `rpi-lab/pi-01` through `rpi-lab/pi-30`.
- **Session Path** segments allow letters, numbers, `.`, `_`, and `-`; `/` separates segments.
- Session listing uses prefix + optional depth + compact/full view, not a separate namespace listing mode; omitted depth means unlimited.
- Creating a **Session** fails on duplicate **Session Path**; changing cwd or other saved fields is explicit delete then create.
- `/` is an allowed remote cwd for non-production Raspberry Pi/device sessions.
- Remote writes/edits/patches do not get extra extension-level confirmation merely because the **Session** remote cwd is `/`; visibility should come from tool labels/output.
- Tmux is intentionally out of v1; `bash` is Pi's normal bash schema plus `session?: string`.
- Tool parity with Pi built-ins is the highest priority: local calls must delegate without behavior changes, and remote calls should match built-in semantics as closely as possible.
- Remote `read` directory behavior, `write` parent directory behavior, and `apply_patch` grammar should match Pi when feasible.
- `apply_patch` is first-class owned behavior in Pi Remote SSH, replacing the user's separate custom `~/.pi/agent/extensions/apply-patch` extension.
- `apply_patch` keeps the current auto-generated file guard and fuzzy matching tolerance.
- `apply_patch` debug logs belong under `~/.pi/...`, not `~/.pi/agent/...`, because agent dir is mostly configuration.
- Remote `apply_patch` uses a local TypeScript parser/planner with remote reads, remote temp-file writes, rename over targets, and best-effort rollback on rare remote write/rename failure; this accepts small extra network cost to avoid reimplementing patch parsing in Python.
- Remote image/attachment reads are out of v1 and should return a clear unsupported-in-v1 error.
- Remote tool results preserve Pi's normal visible result shape and add remote metadata only in details.
- Remote `bash` visible stdout/stderr behavior matches Pi bash; only preserve separate stdout/stderr details if Pi already does.
- Remote binary file handling should match Pi detection where feasible; otherwise reject clearly.
