import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRemoteSshStateDir } from "./config.js";
import { createRemoteAwareBashTool } from "./bash.js";
import { createRemoteAwareEditTool, createRemoteAwareReadTool, createRemoteAwareWriteTool } from "./remote-files.js";
import { createRemoteAwareFindTool, createRemoteAwareGrepTool, createRemoteAwareLsTool } from "./remote-search.js";
import { SessionManager, type ListSessionsInput } from "./session-manager.js";

function createSessionManager(): SessionManager {
	return new SessionManager({ stateDir: getRemoteSshStateDir() });
}

const createSessionTool = defineTool({
	name: "remote_ssh_create_session",
	label: "Create SSH Session",
	description:
		"Create a saved Pi Remote SSH session definition. This only writes the local registry; it never connects to or probes the remote host.",
	promptSnippet: "Create a saved Remote SSH session without connecting to the host",
	promptGuidelines: ["Use remote_ssh_create_session to save a remote SSH target before calling wrapped tools with session."],
	parameters: Type.Object({
		path: Type.String({ description: "Slash-separated session path, e.g. home-vps or rpi-lab/pi-03" }),
		target: Type.String({ description: "OpenSSH target token such as user@host or a configured SSH alias" }),
		remote_cwd: Type.Optional(Type.String({ description: "Absolute remote working directory. If omitted, future remote use resolves $HOME." })),
		port: Type.Optional(Type.Number({ description: "SSH port from 1 to 65535" })),
		ssh_args: Type.Optional(Type.Array(Type.String(), { description: "Additional OpenSSH argv tokens; no shell syntax, target, or control socket options." })),
	}),
	async execute(_toolCallId, params) {
		const manager = createSessionManager();
		const session = await manager.createSession(params);
		return {
			content: [{ type: "text", text: `Created SSH session ${session.path} (${session.target}).` }],
			details: { session, registryPath: manager.registryPath, networkProbed: false },
		};
	},
});

const listTool = defineTool({
	name: "remote_ssh_list",
	label: "List SSH Sessions",
	description:
		"List saved Pi Remote SSH sessions from the local registry. This never connects to or probes remote hosts.",
	promptSnippet: "List saved Remote SSH sessions without probing the network",
	promptGuidelines: ["Use remote_ssh_list to discover session paths; listing sessions never connects to remote hosts."],
	parameters: Type.Object({
		prefix: Type.Optional(Type.String({ description: "Optional full session path prefix to list below" })),
		depth: Type.Optional(Type.Number({ description: "Maximum path levels below prefix; omit/null for unlimited" })),
		view: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("full")], { description: "compact or full; default compact" })),
	}),
	async execute(_toolCallId, params) {
		const manager = createSessionManager();
		const input: ListSessionsInput = { ...params, depth: params.depth ?? null };
		const { entries, view } = await manager.listSessions(input);
		const text = renderList(entries, view);
		return {
			content: [{ type: "text", text }],
			details: { entries, view, registryPath: manager.registryPath, networkProbed: false },
		};
	},
});

const deleteSessionTool = defineTool({
	name: "remote_ssh_delete_session",
	label: "Delete SSH Session",
	description: "Delete a saved Pi Remote SSH session and remove its extension-managed socket file if present.",
	promptSnippet: "Delete a saved Remote SSH session and its managed socket",
	promptGuidelines: ["Use remote_ssh_delete_session only when the saved SSH session path should be removed from the local registry."],
	parameters: Type.Object({
		path: Type.String({ description: "Full session path to delete" }),
	}),
	async execute(_toolCallId, params) {
		const manager = createSessionManager();
		const deleted = await manager.deleteSession(params.path);
		return {
			content: [{ type: "text", text: `Deleted SSH session ${deleted.path}.` }],
			details: { session: deleted, registryPath: manager.registryPath },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(createSessionTool);
	pi.registerTool(listTool);
	pi.registerTool(deleteSessionTool);
	pi.registerTool(createRemoteAwareBashTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(createRemoteAwareReadTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(createRemoteAwareWriteTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(createRemoteAwareEditTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(createRemoteAwareLsTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(createRemoteAwareGrepTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(createRemoteAwareFindTool(process.cwd(), { managerFactory: createSessionManager }));
}

function renderList(entries: Array<{ path: string; type?: "namespace"; target?: string; remote_cwd?: string; socket_status?: string }>, view: "compact" | "full"): string {
	if (entries.length === 0) return "No SSH sessions found.";
	return entries
		.map((entry) => {
			if (entry.type === "namespace") return `${entry.path}/`;
			if (view === "compact") return `${entry.path} -> ${entry.target} (${entry.socket_status ?? "socket unknown"})`;
			return `${entry.path}\n  target: ${entry.target}\n  remote_cwd: ${entry.remote_cwd ?? "<resolve $HOME on first connect>"}\n  socket: ${entry.socket_status ?? "unknown"}`;
		})
		.join("\n");
}

export { createRemoteAwareBashTool } from "./bash.js";
export { createRemoteAwareEditTool, createRemoteAwareReadTool, createRemoteAwareWriteTool } from "./remote-files.js";
export { createRemoteAwareFindTool, createRemoteAwareGrepTool, createRemoteAwareLsTool } from "./remote-search.js";
export { getRemoteSshStateDir } from "./config.js";
export { SessionManager } from "./session-manager.js";
export type { CreateSessionInput, ListedSession, RemoteSshSessionDefinition, RuntimeSession, SessionRegistry } from "./session-manager.js";
