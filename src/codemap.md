# src/

## Responsibility

Pi extension that adds named SSH sessions and remote-aware tool variants. Lets agents run bash, read, write, edit, grep, find, and ls on remote hosts by passing `session: "path"` to any wrapped tool. Sessions are local-only registry entries; no connection happens until a tool actually executes.

## Design

**Ordered targets with failover.** A session stores `targets: string[]` (ordered SSH destinations). At runtime `toRuntimeSession` builds one `RuntimeSessionRoute` per target, each with its own ControlPath socket. `runRemoteSh` iterates routes in order; on connection/socket failure it advances to the next target, giving transparent failover across Tailscale, public IP, VPN, etc.

**File-based registry with advisory locking.** `SessionManager` persists sessions in `sessions.json` under the state directory (`~/.pi/remote-ssh/`). All mutations go through `withLock()` which uses a PID-stamped lock file with stale-lock detection (default 5 min). Registry writes are atomic (write-tmp then rename). Socket paths are derived via SHA-256 to respect the 86-byte Unix socket path limit on macOS/BSD.

**Remote-aware tool wrappers.** Each wrapped tool (bash, read, write, edit, ls, grep, find) follows the same pattern: if `params.session` is undefined, delegate to the local tool unchanged; otherwise resolve the session, build a `RemoteContext`, and execute via SSH. The wrappers extend the base tool's parameter schema with an optional `session` field.

**Lifecycle-tool rendering.** The create, list, and delete session tools in `index.ts` use Pi's standard padded shell and delegate call/result presentation to `tool-render.ts`. Calls show the operation and relevant paths/filter; partial results show `working`; errors show a single truncated line. List results remain hierarchical: collapsed mode reveals leaves from small groups within a global line limit, while expanded mode shows every leaf with target and socket metadata. Create/delete use compact mutation summaries and expanded raw details.

**Control socket management.** SSH uses OpenSSH multiplexing (`ControlMaster=auto`, `ControlPersist=60s`). On exit code 255 with control-socket errors, it retries without the control socket. Each route gets a distinct socket path so failover between targets uses separate connections.

## Flow

1. **Create/list/delete lifecycle** — `index.ts` validates lifecycle inputs, mutates or reads the local registry, and returns raw text plus structured details; `tool-render.ts` formats the custom TUI call/result views without changing execution data. No lifecycle operation probes the network.
2. **Execute tool** — Wrapped tool checks for `session` param. If present:
   - `SessionManager.getSession()` loads definition, builds `RuntimeSession` with routes
   - `createRemoteContext()` resolves remote $HOME if needed, establishing the first working route
   - Tool-specific operations (e.g. `RemoteReadOperations`) run shell commands via `runRemoteSh()`
   - On success, `updateSessionAfterUse()` persists resolved `remote_cwd` and `last_used_at`
3. **Failover** — `runRemoteSh()` loops through `session.routes`; `isRouteFailure()` detects connection failures (timeout, refused, no route, DNS, broken pipe, dead mux) and continues to the next route. First route with output or non-255 exit wins.
4. **Batch bash** — Session path patterns (`*`, `**`, `/*`, `/**`) expand to multiple sessions and execute with bounded concurrency (8).

## Files

- `index.ts` — Extension entry point. Registers 10 tools (3 session CRUD + 7 remote-aware wrappers), wires custom rendering for the three session lifecycle tools, and installs tool-output-visibility patches.
- `tool-render.ts` — Custom TUI rendering for create/list/delete calls and results: compact operation labels, mutation summaries, bounded collapsed trees, metadata-rich expanded trees, partial `working` state, and truncated error state.
- `session-manager.ts` — `SessionManager` class: CRUD, registry I/O, locking, socket path derivation, route building. Defines all session types (`RemoteSshSessionDefinition`, `RuntimeSession`, `RuntimeSessionRoute`).
- `ssh.ts` — SSH process spawning, multi-route failover (`runRemoteSh`), control socket retry logic, output buffering/streaming, connection-failure detection, shell quoting.
- `bash.ts` — `createRemoteAwareBashTool`: wraps Pi's bash tool. Handles remote $HOME resolution, batch session patterns, connect timeout. `RemoteBashOperations` implements the `BashOperations` interface over SSH.
- `remote-files.ts` — Wraps read/write/edit tools. Builds `RemoteContext`, runs commands via SSH. Uses `assertLocalEditableFile` / `assertRemoteEditableContent` to block edits on auto-generated files. Handles hashline prefix stripping.
- `remote-search.ts` — Wraps ls/grep/find tools. Grep and find run Python helpers on the remote host for performance; ls shells out to `ls` + `stat`.
- `config.ts` — State directory resolution (`~/.pi/remote-ssh/` or `PI_REMOTE_SSH_STATE_DIR`), socket directory (SHA-256 hash of state dir under `/tmp/prs/`).
- `path-safety.ts` — Input validation for session paths (`[a-zA-Z0-9._-]` segments), remote cwd, ports, ssh_args (blocks dangerous options like `-S`, `-M`, control socket args), and SSH targets (blocks shell metacharacters).
- `write-enhancements.ts` — Auto-generated file detection (header markers + filename patterns), hashline prefix stripping for LLM-edited content.
- `remote-render.ts` — Tiny helpers to annotate rendered tool calls with `[session: path]`.
- `tool-output-visibility.ts` — Patches Pi TUI for compact tool output, DCP tag sanitization, collapsible preview panels.

## Integration

- **Pi extension API** — `index.ts` exports a default function that receives `ExtensionAPI` and registers tools.
- **Peer dependencies** — `@mariozechner/pi-coding-agent` (tool definitions, `defineTool`, base read/write/edit/find/grep/ls/bash tools) and `@mariozechner/pi-ai` (Type schema). Custom lifecycle views return `Text` nodes from `@mariozechner/pi-tui`.
- **OpenSSH** — All remote execution shells out to `ssh`; no libssh or JS SSH library. Relies on system SSH config, keys, agent forwarding.
- **State layout** — `~/.pi/remote-ssh/sessions.json` (registry), `sessions.lock` (advisory lock), `sockets/` (mirrored socket paths), `logs/` (reserved).
