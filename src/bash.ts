import { Type } from "@mariozechner/pi-ai";
import { createBashToolDefinition, type BashOperations, type BashToolDetails } from "@mariozechner/pi-coding-agent";
import { getRemoteSshStateDir } from "./config.js";
import { renderArgsWithRemoteCommand } from "./remote-render.js";
import { SessionManager, type RuntimeSession } from "./session-manager.js";
import { runRemoteSh, shellQuote, type SpawnSsh, type SshRunResult } from "./ssh.js";

export interface RemoteBashDetails extends BashToolDetails {
	remote?: boolean;
	session?: string;
	target?: string;
	cwd?: string;
	socket?: "available" | "unavailable";
}

export interface CreateRemoteBashToolOptions {
	managerFactory?: () => SessionManager;
	spawnSsh?: SpawnSsh;
	localBashTool?: ReturnType<typeof createBashToolDefinition>;
}

interface BashParams {
	command: string;
	timeout?: number;
	session?: string;
}

interface ExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

export function createRemoteAwareBashTool(cwd: string, options: CreateRemoteBashToolOptions = {}) {
	const localBashTool = options.localBashTool ?? createBashToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	const spawnSsh = options.spawnSsh;

	return {
		...localBashTool,
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path. Omit for unchanged local bash behavior." })),
		}),
		renderCall(args: Parameters<NonNullable<typeof localBashTool.renderCall>>[0], theme: Parameters<NonNullable<typeof localBashTool.renderCall>>[1], context: Parameters<NonNullable<typeof localBashTool.renderCall>>[2]) {
			return localBashTool.renderCall!(renderArgsWithRemoteCommand(args as BashParams), theme, context);
		},
		async execute(toolCallId: string, params: BashParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localBashTool.execute>[3], ctx: Parameters<typeof localBashTool.execute>[4] = undefined as never) {
			const localParams = params.timeout === undefined ? { command: params.command } : { command: params.command, timeout: params.timeout };
			if (params.session === undefined) {
				return localBashTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			}

			const manager = managerFactory();
			const session = await manager.getSession(params.session);
			const operations = new RemoteBashOperations(manager, session, spawnSsh);
			const remoteBashTool = createBashToolDefinition(cwd, { operations });
			const result = await remoteBashTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			const finalSession = operations.currentSession;
			const details: RemoteBashDetails = {
				...(result.details ?? {}),
				remote: true,
				session: finalSession.path,
				target: finalSession.target,
				socket: operations.socketAvailable ? "available" : "unavailable",
			};
			if (finalSession.remote_cwd !== undefined) details.cwd = finalSession.remote_cwd;
			return { ...result, details };
		},
	};
}

class RemoteBashOperations implements BashOperations {
	currentSession: RuntimeSession;
	socketAvailable = true;
	private resolvedRemoteCwd = false;

	constructor(
		private readonly manager: SessionManager,
		session: RuntimeSession,
		private readonly spawnSsh?: SpawnSsh,
	) {
		this.currentSession = session;
	}

	async exec(command: string, _cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }> {
		const remoteCwd = await this.getRemoteCwd(options.signal, options.timeout);
		const script = `cd ${shellQuote(remoteCwd)} && ${command}`;
		const result = await this.run(script, withoutUndefined(options));
		this.socketAvailable = this.socketAvailable && result.socketAvailable;
		if (result.exitCode === 0) {
			this.currentSession = await this.manager.updateSessionAfterUse(this.currentSession.path, {});
		}
		return { exitCode: result.exitCode };
	}

	private async getRemoteCwd(signal: AbortSignal | undefined, timeout: number | undefined): Promise<string> {
		if (this.currentSession.remote_cwd !== undefined) return this.currentSession.remote_cwd;
		if (this.resolvedRemoteCwd) throw new Error(`SSH session "${this.currentSession.path}" is missing remote_cwd.`);
		this.resolvedRemoteCwd = true;
		const chunks: Buffer[] = [];
		const result = await this.run("printf '%s\\n' \"$HOME\"", withoutUndefined({
			onData: (data) => {
				chunks.push(data);
			},
			signal,
			timeout,
		}));
		this.socketAvailable = this.socketAvailable && result.socketAvailable;
		if (result.exitCode !== 0) throw new Error(`Failed to resolve remote $HOME for SSH session "${this.currentSession.path}".`);
		const home = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n").at(-1)?.trim();
		if (!home?.startsWith("/")) throw new Error(`Resolved remote $HOME for SSH session "${this.currentSession.path}" is not an absolute path.`);
		this.currentSession = await this.manager.updateSessionAfterUse(this.currentSession.path, { remote_cwd: home });
		return home;
	}

	private run(script: string, options: ExecOptions): Promise<SshRunResult> {
		return this.spawnSsh === undefined
			? runRemoteSh(this.currentSession, script, options)
			: runRemoteSh(this.currentSession, script, options, this.spawnSsh);
	}
}

function withoutUndefined(options: { onData: (data: Buffer) => void; signal?: AbortSignal | undefined; timeout?: number | undefined }): ExecOptions {
	const cleaned: ExecOptions = { onData: options.onData };
	if (options.signal !== undefined) cleaned.signal = options.signal;
	if (options.timeout !== undefined) cleaned.timeout = options.timeout;
	return cleaned;
}
