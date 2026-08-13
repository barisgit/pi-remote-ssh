import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeSession } from "./session-manager.js";

export interface SshRunOptions {
	onData?: (data: Buffer) => void;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	connectTimeout?: number;
}

export interface SshRunResult {
	exitCode: number | null;
	socketAvailable: boolean;
	target: string;
	session: RuntimeSession;
}

export function createHomeResolutionError(sessionPath: string, target: string, output: string): Error {
	if (isUnacceptedHostKeyOutput(output)) {
		return new Error(`SSH host key is not trusted for session "${sessionPath}" (${target}). Manually verify and accept the host key, for example: ssh ${target} true`);
	}
	if (isConnectionFailureOutput(output)) return createHomeConnectionError(sessionPath, target, connectionFailureReason(output));
	return new Error(`Failed to resolve remote $HOME for SSH session "${sessionPath}".`);
}

export function createHomeResolutionThrownError(sessionPath: string, target: string, error: unknown): Error {
	if (error instanceof Error && error.message.startsWith("timeout:")) {
		return createHomeConnectionError(sessionPath, target, `SSH connection timed out after ${error.message.slice("timeout:".length)} seconds`);
	}
	return error instanceof Error ? error : new Error(String(error));
}

function createHomeConnectionError(sessionPath: string, target: string, reason: string): Error {
	return new Error(`Failed to connect to SSH session "${sessionPath}" (${target}) while resolving remote $HOME. ${reason}.`);
}

function isUnacceptedHostKeyOutput(output: string): boolean {
	return /The authenticity of host .*can't be established/i.test(output)
		|| /Are you sure you want to continue connecting/i.test(output)
		|| /Host key verification failed/i.test(output)
		|| /No ED25519 host key is known for/i.test(output)
		|| /No .* host key is known for/i.test(output);
}

function isConnectionFailureOutput(output: string): boolean {
	return /Connection timed out/i.test(output)
		|| /Operation timed out/i.test(output)
		|| /Connection refused/i.test(output)
		|| /No route to host/i.test(output)
		|| /Network is unreachable/i.test(output)
		|| /Could not resolve hostname/i.test(output)
		|| /Name or service not known/i.test(output)
		|| /Temporary failure in name resolution/i.test(output)
		|| /Connection closed by/i.test(output)
		|| /kex_exchange_identification/i.test(output)
		|| /Control socket connect/i.test(output);
}

function connectionFailureReason(output: string): string {
	const line = output.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0);
	return line ?? "SSH connection failed";
}

export type SpawnSsh = (command: string, args: string[], options: { detached: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const defaultSpawn: SpawnSsh = (command, args, options) => nodeSpawn(command, args, options) as unknown as ChildProcessWithoutNullStreams;
const SSH_SERVER_ALIVE_INTERVAL = 15;
const SSH_SERVER_ALIVE_COUNT_MAX = 3;

export async function runRemoteSh(session: RuntimeSession, script: string, options: SshRunOptions = {}, spawnSsh: SpawnSsh = defaultSpawn): Promise<SshRunResult> {
	for (const route of session.routes) {
		const routeSession = { ...session, target: route.target, socket_path: route.socket_path };
		const result = await runSingleRoute(routeSession, script, options, spawnSsh);
		if (isRouteFailure(result.raw) && route !== session.routes.at(-1)) continue;
		deliverBufferedOutput(result.raw, options);
		return { exitCode: result.raw.exitCode, socketAvailable: result.socketAvailable, target: route.target, session: routeSession };
	}
	throw new Error(`SSH session "${session.path}" has no targets.`);
}

async function runSingleRoute(session: RuntimeSession, script: string, options: SshRunOptions, spawnSsh: SpawnSsh): Promise<{ raw: RawSshResult; socketAvailable: boolean }> {
	await mkdir(dirname(session.socket_path), { recursive: true });
	const controlled = await runSshProcess(buildSshArgs(session, true, script, options.connectTimeout), options, spawnSsh, { streamOutput: true, streamStderrAfterStdout: true });
	const staleMultiplexFailure = isStaleMultiplexFailureOutput(controlled.output);
	if (staleMultiplexFailure) await invalidateManagedSocket(session.socket_path);
	if (!shouldRetryWithoutControl(controlled) || controlled.streamedChunks.length > 0) return { raw: controlled, socketAvailable: !staleMultiplexFailure };
	const plain = await runSshProcess(buildSshArgs(session, false, script, options.connectTimeout), options, spawnSsh, { streamOutput: true, streamStderrAfterStdout: true });
	return { raw: plain, socketAvailable: false };
}

async function invalidateManagedSocket(socketPath: string): Promise<void> {
	await rm(socketPath, { force: true });
}

function deliverBufferedOutput(result: RawSshResult, options: SshRunOptions): void {
	for (const chunk of result.bufferedChunks) options.onData?.(chunk);
	for (const chunk of result.bufferedStderrChunks) options.onStderr?.(chunk);
}

function buildSshArgs(session: RuntimeSession, useControlSocket: boolean, script: string, connectTimeout: number | undefined): string[] {
	const args = [...(session.ssh_args ?? [])];
	if (session.port !== undefined) args.push("-p", String(session.port));
	args.push("-o", "BatchMode=yes");
	args.push("-o", `ServerAliveInterval=${SSH_SERVER_ALIVE_INTERVAL}`, "-o", `ServerAliveCountMax=${SSH_SERVER_ALIVE_COUNT_MAX}`);
	if (connectTimeout !== undefined) args.push("-o", `ConnectTimeout=${connectTimeout}`);
	if (useControlSocket) {
		args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${session.socket_path}`, "-o", "ControlPersist=60s");
	}
	args.push("--", session.target, "sh", "-lc", shellQuote(script));
	return args;
}

interface RawSshResult {
	exitCode: number | null;
	output: string;
	chunks: Buffer[];
	stdoutChunks: Buffer[];
	stderrChunks: Buffer[];
	bufferedChunks: Buffer[];
	bufferedStderrChunks: Buffer[];
	streamedChunks: Buffer[];
}

function runSshProcess(args: string[], options: SshRunOptions, spawnSsh: SpawnSsh, processOptions: { streamOutput: boolean; streamStderrAfterStdout?: boolean }): Promise<RawSshResult> {
	return new Promise((resolve, reject) => {
		const child = spawnSsh("ssh", args, {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		const chunks: Buffer[] = [];
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const bufferedChunks: Buffer[] = [];
		const bufferedStderrChunks: Buffer[] = [];
		const streamedChunks: Buffer[] = [];
		let streamedStdout = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const killChild = () => {
			if (!child.killed) child.kill("SIGTERM");
		};
		const onAbort = () => {
			killChild();
		};
		const onStdout = (data: Buffer) => {
			stdoutChunks.push(data);
			chunks.push(data);
			if (processOptions.streamOutput) {
				streamedStdout = true;
				streamedChunks.push(data);
				options.onStdout?.(data);
				options.onData?.(data);
			}
		};
		const onStderr = (data: Buffer) => {
			stderrChunks.push(data);
			chunks.push(data);
			if (processOptions.streamOutput && (!processOptions.streamStderrAfterStdout || streamedStdout)) {
				streamedChunks.push(data);
				options.onStderr?.(data);
				options.onData?.(data);
			} else {
				bufferedStderrChunks.push(data);
				bufferedChunks.push(data);
			}
		};

		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => {
			finish(() => {
				if (options.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
				else resolve({ exitCode: code, output: Buffer.concat(chunks).toString("utf8"), chunks, stdoutChunks, stderrChunks, bufferedChunks, bufferedStderrChunks, streamedChunks });
			});
		});

		if (options.timeout !== undefined && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killChild();
			}, options.timeout * 1000);
		}
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function shouldRetryWithoutControl(result: RawSshResult): boolean {
	if (result.exitCode !== 255) return false;
	return /ControlMaster|ControlPath|Control socket connect|mux\/control socket unavailable|Bad configuration option/i.test(result.output);
}

function isRouteFailure(result: RawSshResult): boolean {
	if (result.exitCode !== 255 || result.stdoutChunks.length > 0 || result.streamedChunks.length > 0) return false;
	return isConnectionFailureOutput(result.output) || /mux_client_request_session: read from master failed|master is dead|Broken pipe|Connection reset by peer/i.test(result.output);
}

function isStaleMultiplexFailureOutput(output: string): boolean {
	return /Control socket connect|mux_client_request_session: master is dead|mux_client_request_session: read from master failed/i.test(output);
}
