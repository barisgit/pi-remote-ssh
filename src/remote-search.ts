import { Type } from "@mariozechner/pi-ai";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	formatSize,
	truncateHead,
	type FindOperations,
	type GrepToolDetails,
	type LsOperations,
} from "@mariozechner/pi-coding-agent";
import { getRemoteSshStateDir } from "./config.js";
import { annotateRemoteResult, createRemoteContext, remoteDetails, resolveRemotePath, type RemoteContext } from "./remote-files.js";
import { renderArgsWithRemotePath } from "./remote-render.js";
import { SessionManager } from "./session-manager.js";
import type { SpawnSsh } from "./ssh.js";

export interface CreateRemoteSearchToolOptions {
	managerFactory?: () => SessionManager;
	spawnSsh?: SpawnSsh;
	localLsTool?: ReturnType<typeof createLsToolDefinition>;
	localGrepTool?: ReturnType<typeof createGrepToolDefinition>;
	localFindTool?: ReturnType<typeof createFindToolDefinition>;
}

interface LsParams {
	path?: string;
	limit?: number;
	session?: string;
}

interface GrepParams {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
	session?: string;
}

interface FindParams {
	pattern: string;
	path?: string;
	limit?: number;
	session?: string;
}

const DEFAULT_GREP_LIMIT = 100;

export function createRemoteAwareLsTool(cwd: string, options: CreateRemoteSearchToolOptions = {}) {
	const localLsTool = options.localLsTool ?? createLsToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	return {
		...localLsTool,
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path. Omit for unchanged local ls behavior." })),
		}),
		renderCall(args: Parameters<NonNullable<typeof localLsTool.renderCall>>[0], theme: Parameters<NonNullable<typeof localLsTool.renderCall>>[1], context: Parameters<NonNullable<typeof localLsTool.renderCall>>[2]) {
			return localLsTool.renderCall!(renderArgsWithRemotePath(args as LsParams), theme, context);
		},
		async execute(toolCallId: string, params: LsParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localLsTool.execute>[3], ctx: Parameters<typeof localLsTool.execute>[4] = undefined as never) {
			const localParams = withoutSession(params);
			if (params.session === undefined) return localLsTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			const remote = await createRemoteContext(managerFactory(), params.session, options.spawnSsh, signal);
			const ops = new RemoteLsOperations(remote);
			const remoteTool = createLsToolDefinition(remote.cwd, { operations: ops });
			const result = await remoteTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			await remote.markUsed();
			const details = remoteDetails(remote, resolveRemotePath(remote.cwd, params.path ?? "."));
			return { ...annotateRemoteResult(result, details), details: { ...(result.details ?? {}), ...details } };
		},
	};
}

export function createRemoteAwareFindTool(cwd: string, options: CreateRemoteSearchToolOptions = {}) {
	const localFindTool = options.localFindTool ?? createFindToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	return {
		...localFindTool,
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
			path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path. Omit for unchanged local find behavior." })),
		}),
		renderCall(args: Parameters<NonNullable<typeof localFindTool.renderCall>>[0], theme: Parameters<NonNullable<typeof localFindTool.renderCall>>[1], context: Parameters<NonNullable<typeof localFindTool.renderCall>>[2]) {
			return localFindTool.renderCall!(renderArgsWithRemotePath(args as FindParams), theme, context);
		},
		async execute(toolCallId: string, params: FindParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localFindTool.execute>[3], ctx: Parameters<typeof localFindTool.execute>[4] = undefined as never) {
			const localParams = withoutSession(params);
			if (params.session === undefined) return localFindTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			const remote = await createRemoteContext(managerFactory(), params.session, options.spawnSsh, signal);
			const ops = new RemoteFindOperations(remote);
			const remoteTool = createFindToolDefinition(remote.cwd, { operations: ops });
			const result = await remoteTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			await remote.markUsed();
			const details = remoteDetails(remote, resolveRemotePath(remote.cwd, params.path ?? "."));
			return { ...annotateRemoteResult(result, details), details: { ...(result.details ?? {}), ...details } };
		},
	};
}

export function createRemoteAwareGrepTool(cwd: string, options: CreateRemoteSearchToolOptions = {}) {
	const localGrepTool = options.localGrepTool ?? createGrepToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	return {
		...localGrepTool,
		parameters: Type.Object({
			pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
			path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
			glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
			literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
			context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path. Omit for unchanged local grep behavior." })),
		}),
		renderCall(args: Parameters<NonNullable<typeof localGrepTool.renderCall>>[0], theme: Parameters<NonNullable<typeof localGrepTool.renderCall>>[1], context: Parameters<NonNullable<typeof localGrepTool.renderCall>>[2]) {
			return localGrepTool.renderCall!(renderArgsWithRemotePath(args as GrepParams), theme, context);
		},
		async execute(toolCallId: string, params: GrepParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localGrepTool.execute>[3], ctx: Parameters<typeof localGrepTool.execute>[4] = undefined as never) {
			const localParams = withoutSession(params);
			if (params.session === undefined) return localGrepTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			const remote = await createRemoteContext(managerFactory(), params.session, options.spawnSsh, signal);
			const remotePath = resolveRemotePath(remote.cwd, params.path ?? ".");
			const helper = await remote.runPython("grep_files", {
				path: remotePath,
				pattern: params.pattern,
				glob: params.glob,
				ignoreCase: params.ignoreCase ?? false,
				literal: params.literal ?? false,
				context: params.context ?? 0,
				limit: params.limit ?? DEFAULT_GREP_LIMIT,
			}, signal) as { output: string; matchLimitReached?: number | null };
			await remote.markUsed();
			if (!helper.output) {
				const details = { ...remoteDetails(remote, remotePath) } as GrepToolDetails & ReturnType<typeof remoteDetails>;
				return annotateRemoteResult({ content: [{ type: "text" as const, text: "No matches found" }], details }, details);
			}
			const truncation = truncateHead(helper.output, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: GrepToolDetails & ReturnType<typeof remoteDetails> = { ...remoteDetails(remote, remotePath) };
			const notices: string[] = [];
			if (helper.matchLimitReached) {
				notices.push(`${helper.matchLimitReached} matches limit reached. Use limit=${helper.matchLimitReached * 2} for more, or refine pattern`);
				details.matchLimitReached = helper.matchLimitReached;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(truncation.maxBytes)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return annotateRemoteResult({ content: [{ type: "text" as const, text: output }], details }, details);
		},
	};
}

class RemoteLsOperations implements LsOperations {
	constructor(private readonly remote: RemoteContext) {}
	async exists(absolutePath: string): Promise<boolean> {
		const result = await this.remote.runPython("stat_is_dir", { path: absolutePath }) as { exists: boolean };
		return result.exists;
	}
	async stat(absolutePath: string): Promise<{ isDirectory: () => boolean }> {
		const result = await this.remote.runPython("stat_is_dir", { path: absolutePath }) as { exists: boolean; is_dir: boolean };
		if (!result.exists) throw new Error(`Path not found: ${absolutePath}`);
		return { isDirectory: () => result.is_dir };
	}
	async readdir(absolutePath: string): Promise<string[]> {
		const result = await this.remote.runPython("list_dir", { path: absolutePath }) as { entries: string[] };
		return result.entries;
	}
}

class RemoteFindOperations implements FindOperations {
	constructor(private readonly remote: RemoteContext) {}
	async exists(absolutePath: string): Promise<boolean> {
		const result = await this.remote.runPython("stat_is_dir", { path: absolutePath }) as { exists: boolean };
		return result.exists;
	}
	async glob(pattern: string, cwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
		const result = await this.remote.runPython("glob_files", { path: cwd, pattern, ignore: options.ignore, limit: options.limit }) as { paths: string[] };
		return result.paths;
	}
}

function withoutSession<T extends { session?: string }>(params: T): Omit<T, "session"> {
	const { session: _session, ...rest } = params;
	return rest;
}
