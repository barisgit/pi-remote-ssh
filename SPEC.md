# SPEC: Pi Remote SSH

## 1. Purpose

`pi-remote-ssh` is a Pi extension that makes Pi's normal tools remote-aware by overriding/wrapping selected built-ins and adding only minimal SSH session lifecycle tools.

The extension should make remote development possible without teaching the agent a second workflow. The model should keep using `read`, `write`, `edit`, `apply_patch`, and `bash`; each tool gains an optional `session` field. When `session` is omitted, behavior stays local and matches Pi. When `session` is provided, relative paths and shell commands are anchored at that SSH session's configured `remote_cwd`.

## 2. Prior art: `cv/pi-ssh-remote`

[`cv/pi-ssh-remote`](https://github.com/cv/pi-ssh-remote) is an existing Pi extension for remote SSH development.

Its design:

- registers Pi flags such as `--ssh-host`, `--ssh-cwd`, `--ssh-port`, `--ssh-command`, `--ssh-no-mount`, and `--ssh-strict-host-key`
- auto-mounts the remote directory with SSHFS into `/tmp/pi-sshfs/...`
- changes Pi's working directory to the SSHFS mount
- overrides the built-in `bash` tool so shell commands run through SSH
- leaves file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) local, relying on SSHFS for remote file access
- ships a `pi-ssh user@host:/path` wrapper that mounts SSHFS, launches Pi from the mount, and unmounts on exit

Useful ideas to reuse:

- wrapper command for fast startup
- CLI flags for simple one-remote sessions
- SSH option handling ideas, but prefer structured argv-style `ssh_args` over shell command strings
- SSHFS as an optional convenience mode
- e2e tests around SSHFS; tmux ideas can inform future async/job support

Reasons this spec still avoids the SSHFS mount-first approach:

- no SSHFS dependency for file tools
- remote cwd is explicit and independent from any mount behavior
- multiple named sessions are possible in one Pi session
- file tool semantics can be tested independently of OS/FUSE behavior
- print mode and cwd timing issues from SSHFS auto-mount are avoided

Unlike the earlier explicit `remote_ssh_read`/`remote_ssh_bash` idea, v1 should minimize tool surface by overriding/wrapping Pi's existing `read`, `write`, `edit`, `apply_patch`, and `bash` tools and adding `session` to their schemas.

`pi-remote-ssh` may add a wrapper/SSHFS convenience mode later, but the core implementation should not depend on SSHFS.

## 3. Goals

- Provide remote-aware variants of Pi's core file and shell tools under the existing tool names.
- Keep tool surface increase minimal: only add SSH session lifecycle tools.
- Keep lifecycle tools slim and explicit.
- Support named SSH sessions backed by extension-managed SSH control sockets.
- Use configured `remote_cwd` as the default directory for relative remote paths and shell commands.
- Preserve Pi semantics for file tools as closely as possible.
- Reuse Pi's normal local `read` behavior for long local output files instead of adding a custom `read_output` tool.
- Keep remote bash behavior aligned with Pi's current bash tool plus optional `session`.

## 4. Non-goals

- Do not implement a generic SSH client UI.
- Do not add remote `ls`/`find`/`grep` tools initially; `bash` with a `session` can run those.
- Do not add `remote_ssh_read_output`; long local output should be saved to a local temp file and inspected with Pi's normal `read`.
- Do not implement a second path permission system; external permission-policy extensions can enforce restrictions.
- Discourage secrets in saved `ssh_args`, but do not try to detect/block every secret value; document that passwords/tokens do not belong in session definitions.

## 5. Tool set

Initial extension adds 3 lifecycle tools and overrides/wraps 5 normal Pi tools.

Added tools:

```ts
remote_ssh_list: {
  prefix?: string,
  depth?: number,              // omitted/null means unlimited
  view?: "compact" | "full"    // default "compact"
}

remote_ssh_create_session: {
  path: string,          // e.g. "home-vps" or "rpi-lab/pi-03"
  target: string,        // user@host or SSH alias
  remote_cwd?: string,       // defaults to remote $HOME on first connect
  port?: number,
  ssh_args?: string[]    // optional OpenSSH client args, no target/shell syntax
}

remote_ssh_delete_session: {
  path: string
}
```

Wrapped/overridden built-in tools:

```ts
bash: {
  command: string,
  timeout?: number,
  session?: string
}

read: {
  path: string,
  offset?: number,
  limit?: number,
  session?: string
}

write: {
  path: string,
  content: string,
  session?: string
}

edit: {
  path: string,
  edits: Array<{
    oldText: string,
    newText: string
  }>,
  session?: string
}

apply_patch: {
  path?: string,
  patch: string,
  session?: string
}
```

`session` is optional on wrapped tools. Omitted means local Pi behavior. Provided means remote execution using the named session's `remote_cwd` for relative paths and shell commands. It must be the full session path; no shorthand or fuzzy resolution in v1.

## 6. Session model

A session is a saved definition plus derived runtime state:

```ts
interface RemoteSshSessionDefinition {
  path: string;
  target: string;
  remoteCwd?: string;
  port?: number;
  sshArgs?: string[];
  createdAt: string;
  lastUsedAt: string;
}

interface RuntimeSession extends RemoteSshSessionDefinition {
  socketPath: string; // derived/managed, never persisted
} 
```

### `remote_ssh_create_session`

Create/register a saved session definition.

Required behavior:

- validate `path` as slash-separated conservative segments: `[a-zA-Z0-9._-]+`
- reject leading `/`, `..`, empty segments, `~`, backslash, and control characters
- fail on duplicate `path`; replacement/update requires explicit delete then create unless future spec adds an update tool
- validate `path` as the stable identifier; do not accept separate `name`
- if provided, validate `remote_cwd` is absolute on the remote host; `/` is allowed and expected for device-style sessions
- if omitted, resolve remote `$HOME` on first connect and write the resolved value back to the session registry
- derive a managed socket path under the extension state directory, mirroring the session path when possible and hashing when path length risks Unix socket limits
- clean up stale files under the extension-owned socket directory after confirming no control master is alive
- save the session definition to the registry
- create or reuse the SSH control master socket lazily on first use
- do not verify SSH connectivity during `create_session`; v1 saves definitions even when hosts are offline or unreachable
- verify resolved `remote_cwd` exists and is a directory only when connecting/verifying
- store the session definition in the registry

### `remote_ssh_list`

List saved sessions or namespaces.

Behavior:

- list saved sessions as a tree, optionally filtered by `prefix`
- omitted `prefix` lists from registry root
- omitted or null `depth` lists the full subtree below `prefix`
- numeric `depth` limits how many path levels are shown below `prefix`
- `view: "compact"` shows path tree plus brief status
- `view: "full"` shows target, remote cwd, port, ssh args summary, socket status, created/last-used timestamps
- never open network connections while listing; only use registry data and cheap local socket/control-master status
- no glob support in v1

Session output should include:

- path
- target
- remote cwd
- saved/socket status summary when cheap; do not probe remote reachability over the network

It should not accept a `name` parameter.

### `remote_ssh_delete_session`

Delete a saved session definition.

Required behavior:

- remove the named session path from the registry
- always close/delete the managed SSH control socket for that session if present

## 7. Path behavior

Wrapped file tools use the selected session's `remote_cwd` as the default base when `session` is provided.

Rules:

- relative remote paths are resolved against `remote_cwd`
- absolute remote paths are allowed as absolute paths on the remote host
- do not add a second root-containment permission system in this extension
- rely on Pi permission-policy style extensions or SSH/user permissions for additional restrictions
- tool output should show normalized remote paths

Preferred implementation: use small remote Python helpers for path normalization and file mutation, because Python can do atomic writes and exact text handling reliably on the remote host. Remote file tools require `python3` in v1; if missing, return a clear error instead of falling back to shell utilities.

## 8. File tool parity

Wrapped file tools should match Pi built-ins semantically. For local calls, delegate to Pi's normal implementation. For remote calls, use remote operations with the same observable behavior.

### `read`

Mirror Pi `read` for text files when `session` is provided:

- `path`, optional `offset`, optional `limit`
- same 1-indexed `offset` and `limit` semantics exactly
- line-limited output for large files
- clear truncation/continuation message
- support directory behavior only to the same extent Pi's `read` supports it; otherwise reject clearly and suggest `bash({ session, command: "ls ..." })`

Remote image/attachment reads are explicitly unsupported in v1 and should return a clear unsupported-in-v1 error.

### `write`

Mirror Pi `write` when `session` is provided:

- create parent directories only if Pi `write` does so; otherwise keep exact Pi behavior
- overwrite existing file
- write content exactly
- use atomic temp-file + rename on the remote host where this preserves or improves Pi parity
- preserve existing file mode and symlink-following behavior where feasible to match Pi/local filesystem expectations

Do not include a `mode` parameter initially; Pi's built-in `write` does not expose one. New file permissions follow the remote default umask.

### `edit`

Mirror Pi `edit` when `session` is provided:

- each `oldText` must match exactly once
- edits must be non-overlapping
- all matches are evaluated against original file content
- enforce the same exact-text uniqueness and non-overlap rules as Pi local edit
- if validation fails, no changes are written
- write via atomic temp-file + rename on the remote host where this preserves or improves Pi parity
- preserve existing file mode and symlink-following behavior where feasible to match Pi/local filesystem expectations
- preserve exact bytes/text style as much as possible
- return a concise summary of replacements

### `apply_patch`

`apply_patch` is first-class owned behavior in this package. It should replace the user's separate custom `~/.pi/agent/extensions/apply-patch` extension while adding remote support. Mirror the current custom extension and Pi expectations when `session` is omitted, and provide equivalent remote behavior when `session` is provided:

- accept unified diff patches
- support optional `path` for single-file patches
- prevalidate all target changes locally before writing; any invalid/unmatched hunk aborts before remote mutation
- execute remote writes via temp-file + rename where this preserves or improves Pi parity
- if a rare remote write/rename failure occurs after mutation begins, attempt best-effort rollback from backups/temp contents
- no git behavior: do not invoke git or perform repository-specific operations
- allow absolute remote paths; external permission policy handles path restrictions
- support the same patch grammar as the current custom extension/Pi usage, including unified diffs, single-file context diffs with `path`, and structured `*** Begin Patch` envelopes
- keep the current auto-generated file guard
- keep the current fuzzy matching tolerance
- keep debug logging for local and remote apply-patch under a package-owned path below `~/.pi/`, not below `~/.pi/agent/`

## 9. Bash behavior

`bash` executes shell commands remotely when `session` is provided. Without `session`, it delegates to Pi's normal local bash.

Default behavior:

- run commands through deterministic `sh -lc` with a safely quoted `cd "$remote_cwd" && <command>` wrapper
- return stdout/stderr and exit code
- support `timeout` in seconds
- stream/truncate output like Pi bash where practical
- if output is too large, save full output to a local temp file and report the path; normal Pi `read` can inspect it

Tmux is not part of v1. Future async/job support may use tmux internally if a dedicated job API is added.

## 10. SSH execution

Implementation should use local subprocess execution of `ssh`.

Expected shape:

```ts
ssh [...ssh_args] [port/options] -S <managed-socket-path> <target> -- <remote command>
```

Requirements:

- use local OpenSSH `ssh` as the only transport in v1; do not use `scp`
- avoid shell injection by passing argv where possible
- validate `ssh_args` as argument tokens; allow arbitrary OpenSSH option tokens but reject target-like positional args and shell syntax
- reject `ssh_args` options that conflict with extension-managed socket/control lifecycle, including `-S`, `-M`, `-O`, `-N`, `-f`, and `RemoteCommand`/`-o RemoteCommand=...`
- keep `target` as a required separate field
- keep `port` as a separate common-case field; reject conflicting port values from `port` and `ssh_args`
- inject extension-owned ControlMaster/ControlPath settings with default `ControlPersist=60s`
- quote remote commands deliberately when shell execution is required
- if ControlMaster/ControlPath is unsupported by a remote setup, retry plain `ssh` when practical and report `socket: "unavailable"` in details, or return a clear error
- propagate cancellation via Pi's tool abort signal
- kill local subprocesses on abort/timeout
- update `lastUsedAt` on successful tool use

## 11. Output persistence

No `remote_ssh_read_output` tool.

For large remote `bash` output:

- write full combined or separated output to a local temp file, e.g. `/tmp/pi-remote-ssh-*.log`
- return truncated tail plus `fullOutputPath`
- users/agents inspect that path with normal Pi `read`

This matches Pi's existing bash pattern and avoids a redundant remote-specific output tool.

## 12. Permissions and safety

Initial implementation relies on normal Pi tool invocation policy plus conservative tool behavior.

Safety requirements:

- no password prompting inside tools
- no private key management
- no extension-owned path allowlist/denylist in v1
- no destructive session delete beyond deleting the saved session and closing its managed socket
- clear command labels in tool output: session, target, cwd, command

Future option: integrate with a Pi permission-policy extension for session lifecycle tools and remote-mode calls to wrapped built-ins.

## 13. Package direction and location

This should be designed as a public Pi extension package, not a one-off private plugin. The custom behavior is still generally useful if it is framed as: normal Pi tools plus optional SSH sessions.

Public-package requirements:

- document that the package overrides/wraps `read`, `write`, `edit`, `apply_patch`, and `bash`
- local behavior must delegate to Pi built-ins where available and remain byte/behavior compatible when `session` is omitted
- `apply_patch` is the exception: this package owns native apply-patch behavior so the old custom extension can be removed
- remote behavior must be explicit through the `session` field
- reuse Pi internal tool factories/operations where available for local behavior and parity
- avoid user-specific host defaults in package code
- allow local private config/examples outside the package for personal hosts

Session registry shape:

```json
{
  "rpi-lab/pi-03": {
    "target": "pi@10.0.0.23",
    "remote_cwd": "/home/pi",
    "port": 22,
    "ssh_args": ["-i", "~/.ssh/rpi_key"]
  }
}
```

The registry is a flat map keyed by full session path, not a nested hierarchy.

Create as a standalone Pi extension project:

```text
~/Programming_local/Projects/pi-extensions/pi-remote-ssh/
  package.json
  SPEC.md
  README.md
  src/
    index.ts
    session-manager.ts
    ssh.ts
    remote-scripts.ts
    path-safety.ts
  tests/
```

Runtime/debug state layout:

```text
<pi-config-dir>/remote-ssh/   # defaults to ~/.pi/remote-ssh/
  sessions.json          # persistent flat registry, chmod 0600
  sessions.lock          # registry write lock
  sockets/               # managed ControlPath files, derived from session path
  logs/                  # debug logs such as apply-patch-debug.jsonl
```

Remote-ssh runtime/user state should not live under `~/.pi/agent/`; that directory is primarily Pi agent configuration. State should follow Pi's config directory when possible, defaulting to `~/.pi/remote-ssh/`. The registry should not store derived socket paths.

Registry rules:

- `create_session` writes the saved definition immediately, even if the host is offline or unreachable
- no import/export tools in v1; `sessions.json` is the import/export surface
- corrupt `sessions.json` fails remote tools with a clear parse error and is never silently overwritten
- writes acquire `sessions.lock` using a simple dependency-free exclusive lock directory/file approach
- lock metadata records pid, hostname, and createdAt
- concurrent writers serialize through the lock
- duplicate creates are rechecked after waiting and fail if another process created the same path
- writes use temp-file + rename atomically
- normal lock wait timeout is 30 seconds
- stale-break threshold is 5 minutes when owner is dead or strongly inferred stale
- lock timeout returns a clear error and may suggest manual lock deletion as rare recovery, similar to git lock recovery
- reads may be lock-free or wait briefly if a write is active

Remote apply-patch execution model:

- local TypeScript parses and plans patches using the native package implementation
- remote helpers read target files
- local TypeScript computes final contents and prevalidates every target before any remote mutation
- remote helpers write new contents to temp files, then rename over targets where this preserves or improves Pi parity
- if a rare remote write/rename failure happens after mutation begins, attempt best-effort rollback from backups/temp contents
- this uses more network round-trips than a full remote Python patcher, but avoids duplicating patch parser/fuzzy matching logic in Python
- no git behavior: never invoke git or perform repository-specific operations

## 14. Rendering and errors

Remote-mode tool results should preserve Pi's normal visible content shape and add remote metadata only in details:

```ts
details: {
  ...piLikeDetails,
  remote: true,
  session: "rpi-lab/pi-03",
  target: "pi@10.0.0.23",
  path: "/boot/firmware/config.txt"
}
```

Remote `bash` should match Pi's visible stdout/stderr behavior; preserve separate stdout/stderr details only if Pi already does.

Remote binary file handling should match Pi detection where feasible; otherwise reject with a clear binary/text error.

Remote-mode tool render labels should include session path and resolved remote path/cwd when practical:

```text
read [rpi-lab/pi-03:/boot/firmware/config.txt]
bash [rpi-lab/pi-03:/home/pi] npm test
```

Unknown session errors should include nearest prefix/name suggestions from the registry.

```text
Unknown SSH session "rpi-lab/pi-3". Did you mean "rpi-lab/pi-03"?
```

## 15. Implementation slices

The implementation can ship incrementally:

1. Registry, locking, lifecycle tools, managed socket derivation/cleanup.
2. Remote `bash` with optional `session?: string`; this is an acceptable MVP stopping point if enough.
3. Remote `read`, `write`, and `edit` parity using `python3` helpers.
4. Native `apply_patch` parity, replacing the current custom extension.

If remote `python3` is missing, remote file tools fail clearly, while remote `bash` can still work.

## 16. Verification plan

Minimum tests:

- session create rejects bad paths and duplicate paths
- session list returns saved sessions according to prefix/depth/view
- session delete removes saved sessions and handles missing sessions clearly
- relative path resolution anchors at `remote_cwd`; absolute paths are preserved as remote absolute paths
- omitted `session` calls for read/write/edit/bash pass through to Pi built-ins unchanged, verified with mocks/spies
- read supports `offset`/`limit`
- write is atomic and preserves exact content
- edit rejects zero/multiple matches and applies all valid edits atomically
- apply_patch rejects unmatched hunks, supports custom extension grammar, blocks auto-generated files as current custom extension does, preserves fuzzy matching behavior, and preserves remote path semantics
- bash returns exit code/stdout/stderr like Pi bash and writes large output to local temp file

Manual integration check:

1. Start a local SSH target or test container with sshd.
2. Create a session with `remote_cwd` at a temp remote directory.
3. Run `write`, `read`, `edit`, and `apply_patch` with `session` against test files.
4. Run `bash` with `session` for short output and large output.
5. Inspect large output via normal Pi `read`.
6. Delete the session.

## 17. Open questions

No high-priority open questions remain for v1. Lower-priority future questions can be handled during implementation.
