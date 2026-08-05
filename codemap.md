# Repository Atlas: pi-remote-ssh

## Responsibility

A Pi extension package that adds named SSH sessions and remote mode to Pi's ordinary shell and file/search tools while preserving unchanged local behavior.

## Design

Session definitions persist in a locked JSON registry outside Pi's agent directory. Each session carries an ordered `targets` array: runtime route construction gives every target its own OpenSSH ControlPath, and SSH execution advances through those routes only for pre-command transport or multiplexing failures. After output begins, a command is never replayed, preventing uncertain remote mutations.

The three session lifecycle tools use custom self-rendering hooks wired by `src/index.ts` to `src/tool-render.ts`: compact calls identify the operation and subject, compact successful results show mutation summaries or a collapsed path tree, expanded results retain raw details, partial results show `working`, and errors collapse to a truncated single line.

## Flow

1. The extension entry point registers session lifecycle tools and remote-aware wrappers, and attaches custom call/result rendering to create, list, and delete.
2. A lifecycle call executes against the local registry; its raw content and structured details feed the custom compact/expanded renderer.
3. A wrapper delegates locally without `session`; with one, it loads a registry session and runs through SSH.
4. SSH tries ordered routes, manages control sockets, and returns the selected route for result metadata.
5. Successful calls persist session use metadata and resolved remote working directories.

## System Entry Points

- `src/index.ts`: Extension registration, session lifecycle execution, and rendering-hook wiring.
- `src/tool-render.ts`: Custom TUI call/result renderer for lifecycle tools.
- `package.json`: Package metadata, Pi extension export, and typecheck/test scripts.

## Directory Map

| Directory | Responsibility | Detailed map |
| --- | --- | --- |
| `src/` | Extension implementation: registry, SSH transport/failover, and wrapped Pi tools. | `src/codemap.md` |

## Integration

- Pi extension APIs from `@mariozechner/pi-coding-agent`
- Type schemas from `@mariozechner/pi-ai`
- TUI `Text` rendering from `@mariozechner/pi-tui`
- Local OpenSSH client for all remote transport
- `tests/` provides Bun coverage for registry, SSH/bash, remote file, and remote search behavior
