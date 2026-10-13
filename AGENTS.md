# pi-remote-ssh

## Invariants

- Session create/list/delete manipulate the local registry only; they never probe SSH. Omitting `session` delegates to the native local tool unchanged.
- Ordered targets each get a distinct ControlPath. Fail over only on pre-command transport/multiplexing failures. Never replay after output begins or on an arbitrary command timeout: a remote mutation may already have happened.
- Registry mutations use a PID-stamped advisory lock with stale-lock detection and atomic temporary-file rename. Hash-derived socket paths stay within the macOS/BSD 86-byte limit. OpenSSH multiplexing uses a 60-second ControlPersist; control-socket failures retry plain SSH before advancing targets.
- Batch bash expands session patterns with bounded concurrency (eight). Remote nonzero exits retain thrown-error handling for aggregation, even though native Pi 1.x bash returns error results.
- Validate session paths, targets, working directories, ports and SSH arguments; callers must not override managed control-socket options. File edits reject auto-generated content and strip hashline prefixes.
- Session lifecycle renderers keep raw execution data: collapsed list trees are globally bounded, expanded trees retain every leaf and target/socket metadata. Partial results show working and collapsed errors stay one line.
- Tool-output presentation retains collapsed previews, DCP tag sanitization and reminders, host-owned expanded shells, and spacing between compact blocks. Do not replace prototype patches with a static renderer resolver if that loses expansion-dependent shell or parent/sibling spacing semantics.

## Verification

Run `bun test` and `bun run typecheck`. Tests use fake SSH processes; live-host verification needs an explicitly selected session.
