# Repository Atlas: pi-remote-ssh

## Responsibility

A Pi extension package that adds named SSH sessions and remote mode to Pi's ordinary shell and file/search tools while preserving unchanged local behavior.

## Design

Session definitions persist in a locked JSON registry outside Pi's agent directory. Each session carries an ordered `targets` array: runtime route construction gives every target its own OpenSSH ControlPath, and SSH execution advances through those routes only for pre-command transport or multiplexing failures. After output begins, a command is never replayed, preventing uncertain remote mutations.

## Flow

1. The extension entry point registers session lifecycle tools and remote-aware wrappers.
2. A wrapper delegates locally without `session`; with one, it loads a registry session and runs through SSH.
3. SSH tries ordered routes, manages control sockets, and returns the selected route for result metadata.
4. Successful calls persist session use metadata and resolved remote working directories.

## Directory Map

| Directory | Responsibility | Detailed map |
| --- | --- | --- |
| `src/` | Extension implementation: registry, SSH transport/failover, and wrapped Pi tools. | `src/codemap.md` |

## Integration

- Pi extension APIs from `@mariozechner/pi-coding-agent`
- Type schemas from `@mariozechner/pi-ai`
- Local OpenSSH client for all remote transport
- `tests/` provides Bun coverage for registry, SSH/bash, remote file, and remote search behavior
