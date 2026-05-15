import { Type } from "@mariozechner/pi-ai";
import { createBashToolDefinition, type BashOperations, type BashToolDetails } from "@mariozechner/pi-coding-agent";
import { getRemoteSshStateDir } from "./config.js";
import { renderArgsWithRemoteCommand } from "./remote-render.js";
import { SessionManager, type RuntimeSession } from "./session-manager.js";
import { createHomeResolutionError, createHomeResolutionThrownError, runRemoteSh, shellQuote, type SpawnSsh, type SshRunResult } from "./ssh.js";

export interface RemoteBashDetails extends BashToolDetails {
	remote?: boolean;
	batch?: boolean;
	session?: string;
	target?: string;
	cwd?: string;
	socket?: "available" | "unavailable";
	exitCode?: number | null;
	total?: number;
	succeeded?: number;
	failed?: number;
	results?: BatchBashSessionResult[];
}

interface BatchBashSessionResult {
	session: string;
	target: string;
	ok: boolean;
	exitCode: number | null;
	output: string;
	durationMs: number;
	socket?: "available" | "unavailable";
	cwd?: string;
}

export interface CreateRemoteBashToolOptions {
	managerFactory?: () => SessionManager;
	spawnSsh?: SpawnSsh;
	localBashTool?: ReturnType<typeof createBashToolDefinition>;
}

interface BashParams {
	command: string;
	timeout?: number;
	connect_timeout?: number;
	session?: string;
}

type BashExecute = ReturnType<typeof createBashToolDefinition>["execute"];
type BashOnUpdate = Parameters<BashExecute>[3];
type BashContext = Parameters<BashExecute>[4];

interface ExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	connectTimeout?: number;
}

const BATCH_SESSION_CONCURRENCY = 8;

export function createRemoteAwareBashTool(cwd: string, options: CreateRemoteBashToolOptions = {}) {
	const localBashTool = options.localBashTool ?? createBashToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	const spawnSsh = options.spawnSsh;

	return {
		...localBashTool,
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Command timeout in seconds (optional, no default timeout)" })),
			connect_timeout: Type.Optional(Type.Number({ description: "SSH connection timeout in seconds for remote sessions (optional; distinct from command timeout)" })),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path, or '*' / '**' / 'prefix/*' / 'prefix/**' for batch execution. Omit for unchanged local bash behavior." })),
		}),
		renderCall(args: Parameters<NonNullable<typeof localBashTool.renderCall>>[0], theme: Parameters<NonNullable<typeof localBashTool.renderCall>>[1], context: Parameters<NonNullable<typeof localBashTool.renderCall>>[2]) {
			return localBashTool.renderCall!(renderArgsWithRemoteCommand(args as BashParams), theme, context);
		},
		async execute(toolCallId: string, params: BashParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localBashTool.execute>[3], ctx: Parameters<typeof localBashTool.execute>[4] = undefined as never) {
			validateConnectTimeout(params.connect_timeout);
			const localParams = params.timeout === undefined ? { command: params.command } : { command: params.command, timeout: params.timeout };
			if (params.session === undefined) {
				return localBashTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			}

			const manager = managerFactory();
			if (isBatchSessionPattern(params.session)) {
				return executeBatchRemoteBash({ connectTimeout: params.connect_timeout, cwd, localParams, manager, onUpdate, sessionPattern: params.session, signal, spawnSsh, toolCallId, ctx });
			}

			return executeSingleRemoteBash({ connectTimeout: params.connect_timeout, cwd, localParams, manager, onUpdate, sessionPath: params.session, signal, spawnSsh, toolCallId, ctx });
		},
	};
}

async function executeSingleRemoteBash(input: {
	connectTimeout?: number | undefined;
	cwd: string;
	localParams: { command: string; timeout?: number };
	manager: SessionManager;
	onUpdate?: BashOnUpdate | undefined;
	sessionPath: string;
	signal?: AbortSignal | undefined;
	spawnSsh?: SpawnSsh | undefined;
	toolCallId: string;
	ctx: BashContext;
}) {
	const session = await input.manager.getSession(input.sessionPath);
	const operations = new RemoteBashOperations(input.manager, session, input.spawnSsh, input.connectTimeout);
	const remoteBashTool = createBashToolDefinition(input.cwd, { operations });
	const result = await remoteBashTool.execute(input.toolCallId, input.localParams, input.signal, input.onUpdate, input.ctx);
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
}

async function executeBatchRemoteBash(input: {
	connectTimeout?: number | undefined;
	cwd: string;
	localParams: { command: string; timeout?: number };
	manager: SessionManager;
	onUpdate?: BashOnUpdate | undefined;
	sessionPattern: string;
	signal?: AbortSignal | undefined;
	spawnSsh?: SpawnSsh | undefined;
	toolCallId: string;
	ctx: BashContext;
}) {
	const sessionPaths = await expandBatchSessionPattern(input.manager, input.sessionPattern);
	const results = await mapWithConcurrency(sessionPaths, BATCH_SESSION_CONCURRENCY, (sessionPath) => runBatchSession(input, sessionPath));
	const failed = results.filter((result) => !result.ok).length;
	const succeeded = results.length - failed;
	const details: RemoteBashDetails = {
		remote: true,
		batch: true,
		session: input.sessionPattern,
		exitCode: failed === 0 ? 0 : 1,
		total: results.length,
		succeeded,
		failed,
		results,
	};
	return { content: [{ type: "text" as const, text: renderBatchBashResult(input.sessionPattern, results) }], details };
}

async function runBatchSession(
	input: {
		connectTimeout?: number | undefined;
		cwd: string;
		localParams: { command: string; timeout?: number };
		manager: SessionManager;
		signal?: AbortSignal | undefined;
		spawnSsh?: SpawnSsh | undefined;
		toolCallId: string;
		ctx: BashContext;
	},
	sessionPath: string,
): Promise<BatchBashSessionResult> {
	const startedAt = Date.now();
	try {
		const result = await executeSingleRemoteBash({ ...input, onUpdate: undefined, sessionPath });
		const details = result.details as RemoteBashDetails | undefined;
		return {
			session: sessionPath,
			target: details?.target ?? "",
			ok: true,
			exitCode: 0,
			output: getTextContent(result),
			durationMs: Date.now() - startedAt,
			...(details?.socket !== undefined ? { socket: details.socket } : {}),
			...(details?.cwd !== undefined ? { cwd: details.cwd } : {}),
		};
	} catch (error) {
		if (input.signal?.aborted) throw error;
		const session = await input.manager.getSession(sessionPath);
		return {
			session: sessionPath,
			target: session.target,
			ok: false,
			exitCode: exitCodeFromError(error),
			output: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - startedAt,
			...(session.remote_cwd !== undefined ? { cwd: session.remote_cwd } : {}),
		};
	}
}

class RemoteBashOperations implements BashOperations {
	currentSession: RuntimeSession;
	socketAvailable = true;
	private resolvedRemoteCwd = false;

	constructor(
		private readonly manager: SessionManager,
		session: RuntimeSession,
		private readonly spawnSsh?: SpawnSsh,
		private readonly connectTimeout?: number,
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
		})).catch((error: unknown) => {
			throw createHomeResolutionThrownError(this.currentSession.path, this.currentSession.target, error);
		});
		this.socketAvailable = this.socketAvailable && result.socketAvailable;
		if (result.exitCode !== 0) throw createHomeResolutionError(this.currentSession.path, this.currentSession.target, Buffer.concat(chunks).toString("utf8"));
		const home = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n").at(-1)?.trim();
		if (!home?.startsWith("/")) throw new Error(`Resolved remote $HOME for SSH session "${this.currentSession.path}" is not an absolute path.`);
		this.currentSession = await this.manager.updateSessionAfterUse(this.currentSession.path, { remote_cwd: home });
		return home;
	}

	private run(script: string, options: ExecOptions): Promise<SshRunResult> {
		const runOptions = this.connectTimeout === undefined ? options : { ...options, connectTimeout: this.connectTimeout };
		return this.spawnSsh === undefined
			? runRemoteSh(this.currentSession, script, runOptions)
			: runRemoteSh(this.currentSession, script, runOptions, this.spawnSsh);
	}
}

function withoutUndefined(options: { onData: (data: Buffer) => void; signal?: AbortSignal | undefined; timeout?: number | undefined }): ExecOptions {
	const cleaned: ExecOptions = { onData: options.onData };
	if (options.signal !== undefined) cleaned.signal = options.signal;
	if (options.timeout !== undefined) cleaned.timeout = options.timeout;
	return cleaned;
}

function isBatchSessionPattern(session: string): boolean {
	return session.includes("*");
}

async function expandBatchSessionPattern(manager: SessionManager, pattern: string): Promise<string[]> {
	const { prefix, recursive } = parseBatchSessionPattern(pattern);
	const { entries } = await manager.listSessions({ ...(prefix !== undefined ? { prefix } : {}), depth: recursive ? null : 1 });
	const paths = entries
		.filter((entry) => !("type" in entry && entry.type === "namespace"))
		.map((entry) => entry.path)
		.filter((path) => path !== prefix);
	if (paths.length === 0) throw new Error(`No SSH sessions match "${pattern}".`);
	return paths;
}

function parseBatchSessionPattern(pattern: string): { prefix?: string; recursive: boolean } {
	if (pattern === "*") return { recursive: false };
	if (pattern === "**") return { recursive: true };
	if (pattern.endsWith("/**")) return { prefix: pattern.slice(0, -3), recursive: true };
	if (pattern.endsWith("/*")) return { prefix: pattern.slice(0, -2), recursive: false };
	throw new Error("Batch SSH session patterns only support '*', '**', trailing '/*', or trailing '/**'.");
}

function validateConnectTimeout(connectTimeout: number | undefined): void {
	if (connectTimeout === undefined) return;
	if (!Number.isInteger(connectTimeout) || connectTimeout <= 0) throw new Error("connect_timeout must be a positive integer number of seconds.");
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, map: (item: T) => Promise<U>): Promise<U[]> {
	const results = new Array<U>(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			results[index] = await map(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

function renderBatchBashResult(pattern: string, results: BatchBashSessionResult[]): string {
	const failed = results.filter((result) => !result.ok).length;
	const succeeded = results.length - failed;
	const summary = failed === 0
		? `Batch bash succeeded: ${succeeded} succeeded across ${pattern}.`
		: `Batch bash failed: ${succeeded} succeeded, ${failed} failed across ${pattern}.`;
	return [summary, ...results.map(renderBatchSessionResult)].join("\n\n");
}

function renderBatchSessionResult(result: BatchBashSessionResult): string {
	const status = result.ok ? `exit ${result.exitCode}` : result.exitCode === null ? "failed" : `exit ${result.exitCode}`;
	const output = result.output.trimEnd();
	return output ? `[${result.session}] ${status}\n${output}` : `[${result.session}] ${status}`;
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function exitCodeFromError(error: unknown): number | null {
	if (!(error instanceof Error)) return null;
	const match = error.message.match(/Command exited with code (\d+)/);
	return match ? Number(match[1]) : null;
}
