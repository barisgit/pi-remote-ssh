import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRemoteSshSocketDir, getRemoteSshStateDir } from "./config.js";
import { createRemoteAwareBashTool } from "./bash.js";
import { createRemoteAwareEditTool, createRemoteAwareReadTool, createRemoteAwareWriteTool } from "./remote-files.js";
import { createRemoteAwareFindTool, createRemoteAwareGrepTool, createRemoteAwareLsTool } from "./remote-search.js";
import { SessionManager, type CreateSessionInput, type ListSessionsInput } from "./session-manager.js";
import { installToolOutputVisibility, withCompactHiddenResult } from "./tool-output-visibility.js";
import { renderRemoteSshCall, renderRemoteSshResult } from "./tool-render.js";

function createSessionManager(): SessionManager {
	const stateDir = getRemoteSshStateDir();
	return new SessionManager({ stateDir, socketDir: getRemoteSshSocketDir(stateDir) });
}

function renderTargets(session: CreateSessionInput): string {
	return session.targets?.join(" -> ") ?? session.target ?? "unknown";
}

const createSessionTool = defineTool({
	name: "remote_ssh_create_session",
	label: "Create SSH Session",
	renderCall: (args, theme) => renderRemoteSshCall("create", args, theme),
	renderResult: (result, options, theme, context) => renderRemoteSshResult("create", result, options, theme, context),
	description:
		"Create a saved Pi Remote SSH session definition. This only writes the local registry; it never connects to or probes the remote host.",
	promptSnippet: "Create a saved Remote SSH session without connecting to the host",
	promptGuidelines: ["Use remote_ssh_create_session to save a remote SSH target before calling wrapped tools with session."],
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Slash-separated session path, e.g. home-vps or rpi-lab/pi-03. Use for single create." })),
		targets: Type.Optional(Type.Array(Type.String(), { description: "Ordered OpenSSH targets such as user@host, Tailscale names, or public IPs. Each is tried in order on connection/socket failure." })),
		target: Type.Optional(Type.String({ description: "Legacy single OpenSSH target. Prefer targets[] for new sessions." })),
		remote_cwd: Type.Optional(Type.String({ description: "Absolute remote working directory. If omitted, future remote use resolves $HOME." })),
		port: Type.Optional(Type.Number({ description: "SSH port from 1 to 65535" })),
		ssh_args: Type.Optional(Type.Array(Type.String(), { description: "Additional OpenSSH argv tokens; no shell syntax, target, or control socket options." })),
		sessions: Type.Optional(
			Type.Array(
				Type.Object({
					path: Type.String({ description: "Slash-separated session path, e.g. home-vps or rpi-lab/pi-03" }),
					targets: Type.Optional(Type.Array(Type.String(), { description: "Ordered OpenSSH targets tried in order on connection/socket failure" })),
					target: Type.Optional(Type.String({ description: "Legacy single OpenSSH target. Prefer targets[]." })),
					remote_cwd: Type.Optional(Type.String({ description: "Absolute remote working directory. If omitted, future remote use resolves $HOME." })),
					port: Type.Optional(Type.Number({ description: "SSH port from 1 to 65535" })),
					ssh_args: Type.Optional(Type.Array(Type.String(), { description: "Additional OpenSSH argv tokens; no shell syntax, target, or control socket options." })),
				}),
				{ description: "Batch of SSH sessions to create atomically. Use instead of top-level path/target." },
			),
		),
	}),
	async execute(_toolCallId, params) {
		const manager = createSessionManager();
		const sessions = getCreateSessionInputs(params);
		const created = await manager.createSessions({ sessions });
		return {
			content: [{ type: "text", text: renderCreatedSessions(created) }],
			details: { sessions: created, session: created[0], registryPath: manager.registryPath, networkProbed: false },
		};
	},
});

const listTool = defineTool({
	name: "remote_ssh_list",
	label: "List SSH Sessions",
	renderCall: (args, theme) => renderRemoteSshCall("list", args, theme),
	renderResult: (result, options, theme, context) => renderRemoteSshResult("list", result, options, theme, context),
	description:
		"List saved Pi Remote SSH sessions from the local registry. This never connects to or probes remote hosts.",
	promptSnippet: "List saved Remote SSH sessions without probing the network",
	promptGuidelines: [
		"Use remote_ssh_list to discover session paths and their managed ControlPath socket paths; listing sessions never connects to remote hosts.",
		"For direct OpenSSH commands such as scp/sftp/ssh outside Pi tools, prefer the listed socket_path with -o ControlPath=<socket_path> -o ControlMaster=auto instead of opening an unrelated connection.",
		"If socket_status is absent, prewarm the managed socket first with bash({ session: \"<session>\", command: \"echo alive\" })."
	],
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
	renderCall: (args, theme) => renderRemoteSshCall("delete", args, theme),
	renderResult: (result, options, theme, context) => renderRemoteSshResult("delete", result, options, theme, context),
	description: "Delete a saved Pi Remote SSH session and remove its extension-managed socket file if present.",
	promptSnippet: "Delete a saved Remote SSH session and its managed socket",
	promptGuidelines: ["Use remote_ssh_delete_session only when the saved SSH session path should be removed from the local registry."],
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Full session path to delete. Use for single delete." })),
		paths: Type.Optional(Type.Array(Type.String(), { description: "Batch of full session paths to delete atomically." })),
	}),
	async execute(_toolCallId, params) {
		const manager = createSessionManager();
		const paths = getDeleteSessionPaths(params);
		const deleted = await manager.deleteSessions({ paths });
		return {
			content: [{ type: "text", text: renderDeletedSessions(deleted) }],
			details: { sessions: deleted, session: deleted[0], registryPath: manager.registryPath },
		};
	},
});

export default function (pi: ExtensionAPI) {
	installToolOutputVisibility();
	pi.registerTool(createSessionTool);
	pi.registerTool(listTool);
	pi.registerTool(deleteSessionTool);
	pi.registerTool(createRemoteAwareBashTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(withCompactHiddenResult(createRemoteAwareReadTool(process.cwd(), { managerFactory: createSessionManager })));
	pi.registerTool(createRemoteAwareWriteTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(createRemoteAwareEditTool(process.cwd(), { managerFactory: createSessionManager }));
	pi.registerTool(withCompactHiddenResult(createRemoteAwareLsTool(process.cwd(), { managerFactory: createSessionManager })));
	pi.registerTool(withCompactHiddenResult(createRemoteAwareGrepTool(process.cwd(), { managerFactory: createSessionManager })));
	pi.registerTool(withCompactHiddenResult(createRemoteAwareFindTool(process.cwd(), { managerFactory: createSessionManager })));
}

function getCreateSessionInputs(params: Partial<CreateSessionInput> & { sessions?: CreateSessionInput[] }): CreateSessionInput[] {
	if (params.sessions !== undefined) {
		if (params.path !== undefined || params.target !== undefined || params.targets !== undefined || params.remote_cwd !== undefined || params.port !== undefined || params.ssh_args !== undefined) {
			throw new Error("Use either sessions[] or top-level path/targets fields, not both.");
		}
		return params.sessions;
	}
	return [params as CreateSessionInput];
}

function getDeleteSessionPaths(params: { path?: string; paths?: string[] }): string[] {
	if (params.paths !== undefined) {
		if (params.path !== undefined) throw new Error("Use either paths[] or path, not both.");
		return params.paths;
	}
	if (params.path === undefined) throw new Error("path or paths[] is required.");
	return [params.path];
}

function renderCreatedSessions(sessions: CreateSessionInput[]): string {
	const [first] = sessions;
	if (sessions.length === 1 && first !== undefined) return `Created SSH session ${first.path} (${renderTargets(first)}).`;
	return [`Created ${sessions.length} SSH sessions:`, ...sessions.map((session) => `- ${session.path} (${renderTargets(session)})`)].join("\n");
}

function renderDeletedSessions(sessions: Array<{ path: string }>): string {
	const [first] = sessions;
	if (sessions.length === 1 && first !== undefined) return `Deleted SSH session ${first.path}.`;
	return [`Deleted ${sessions.length} SSH sessions:`, ...sessions.map((session) => `- ${session.path}`)].join("\n");
}

function renderList(entries: Array<{ path: string; type?: "namespace"; target?: string; targets?: string[]; remote_cwd?: string; socket_path?: string; socket_status?: string }>, view: "compact" | "full"): string {
	if (entries.length === 0) return "No SSH sessions found.";
	return entries
		.map((entry) => {
			if (entry.type === "namespace") return `${entry.path}/`;
			const targets = entry.targets?.join(" -> ") ?? entry.target ?? "unknown";
			if (view === "compact") return `${entry.path} -> ${targets} (${entry.socket_status ?? "socket unknown"})`;
			return `${entry.path}\n  targets: ${targets}\n  remote_cwd: ${entry.remote_cwd ?? "<resolve $HOME on first connect>"}\n  socket_status: ${entry.socket_status ?? "unknown"}\n  socket_path: ${entry.socket_path ?? "unknown"}`;
		})
		.join("\n");
}

export { createRemoteAwareBashTool } from "./bash.js";
export { createRemoteAwareEditTool, createRemoteAwareReadTool, createRemoteAwareWriteTool } from "./remote-files.js";
export { createRemoteAwareFindTool, createRemoteAwareGrepTool, createRemoteAwareLsTool } from "./remote-search.js";
export { getRemoteSshSocketDir, getRemoteSshStateDir } from "./config.js";
export { SessionManager } from "./session-manager.js";
export type { CreateSessionInput, ListedSession, RemoteSshSessionDefinition, RuntimeSession, SessionRegistry } from "./session-manager.js";
