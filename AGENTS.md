# pi-remote-ssh

## Invariants

- Session create/list/delete manipulate the local registry only; they never probe SSH. Omitting `session` delegates to the native local tool unchanged.
- Ordered targets each get a distinct ControlPath. Fail over only on pre-command transport/multiplexing failures. Never replay after output begins or on an arbitrary command timeout: a remote mutation may already have happened.
- Registry mutations use a PID-stamped advisory lock with stale-lock detection and atomic temporary-file rename. Hash-derived socket paths stay within the macOS/BSD 86-byte limit. OpenSSH multiplexing uses a 60-second ControlPersist; control-socket failures retry plain SSH before advancing targets.
- Batch bash expands session patterns with bounded concurrency (eight). Remote nonzero exits retain thrown-error handling for aggregation, even though native Pi 1.x bash returns error results.
- Validate session paths, targets, working directories, ports and SSH arguments; callers must not override managed control-socket options. File edits reject auto-generated content and strip hashline prefixes.
- Session lifecycle renderers keep raw execution data: collapsed list trees are globally bounded, expanded trees retain every leaf and target/socket metadata. Partial results show working and collapsed errors stay one line.
- Compact read/search renderers always use the public `renderShell: "self"` contract: collapsed calls stay compact; expanded calls and results share a native-style `Box` with the host's output padding and pending/error/success background. Leave shell selection, display updates, and inter-tool spacing to Pi. The generic text-output preview patch remains because `registerToolRenderer` cannot intercept native fallbacks after renderer exceptions. Preserve the existing head/tail preview and DCP policy on native fallback paths, and sanitize compact-wrapped results.

## Verification

Run `bun test` and `bun run typecheck`. Tests use fake SSH processes; live-host verification needs an explicitly selected session.
