import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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
const DEFAULT_CONNECT_TIMEOUT = 10;
const TERMINATION_GRACE_MS = 1000;
const SSH_SERVER_ALIVE_INTERVAL = 15;
const SSH_SERVER_ALIVE_COUNT_MAX = 3;

export async function runRemoteSh(session: RuntimeSession, script: string, options: SshRunOptions = {}, spawnSsh: SpawnSsh = defaultSpawn): Promise<SshRunResult> {
	// One command budget covers all routes and control-socket fallback attempts.
	const deadline = options.timeout !== undefined && options.timeout > 0 ? performance.now() + options.timeout * 1000 : undefined;
	for (const route of session.routes) {
		assertCanRun(options, deadline);
		const routeSession = { ...session, target: route.target, socket_path: route.socket_path };
		const result = await runSingleRoute(routeSession, script, options, spawnSsh, deadline);
		if (isRouteFailure(result.raw) && route !== session.routes.at(-1)) continue;
		deliverBufferedOutput(result.raw, options);
		return { exitCode: result.raw.exitCode, socketAvailable: result.socketAvailable, target: route.target, session: routeSession };
	}
	throw new Error(`SSH session "${session.path}" has no targets.`);
}

function assertCanRun(options: SshRunOptions, deadline: number | undefined): void {
	if (options.signal?.aborted) throw new Error("aborted");
	if (deadline !== undefined && performance.now() >= deadline) throw new Error(`timeout:${options.timeout}`);
}

async function runSingleRoute(session: RuntimeSession, script: string, options: SshRunOptions, spawnSsh: SpawnSsh, deadline: number | undefined): Promise<{ raw: RawSshResult; socketAvailable: boolean }> {
	await mkdir(dirname(session.socket_path), { recursive: true });
	const run = (useControlSocket: boolean) => {
		assertCanRun(options, deadline);
		const marker = `\x1epi-ssh-ready:${randomUUID()}\x1f`;
		return runSshProcess(buildSshArgs(session, useControlSocket, script, options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT, marker), options, spawnSsh, marker, deadline);
	};
	const controlled = await run(true);
	const staleMultiplexFailure = !controlled.started && isStaleMultiplexFailureOutput(controlled.output);
	if (staleMultiplexFailure) await invalidateManagedSocket(session.socket_path);
	if (!shouldRetryWithoutControl(controlled) || controlled.streamedChunks.length > 0) return { raw: controlled, socketAvailable: !staleMultiplexFailure };
	const plain = await run(false);
	return { raw: plain, socketAvailable: false };
}

async function invalidateManagedSocket(socketPath: string): Promise<void> {
	await rm(socketPath, { force: true });
}

function deliverBufferedOutput(result: RawSshResult, options: SshRunOptions): void {
	for (const chunk of result.bufferedChunks) options.onData?.(chunk);
	for (const chunk of result.bufferedStderrChunks) options.onStderr?.(chunk);
}

function buildSshArgs(session: RuntimeSession, useControlSocket: boolean, script: string, connectTimeout: number, marker: string): string[] {
	// OpenSSH uses the first value: safety options must precede user args/config.
	const args = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil(connectTimeout))}`, "-o", "ConnectionAttempts=1"];
	args.push("-o", `ServerAliveInterval=${SSH_SERVER_ALIVE_INTERVAL}`, "-o", `ServerAliveCountMax=${SSH_SERVER_ALIVE_COUNT_MAX}`);
	if (useControlSocket) {
		args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${session.socket_path}`, "-o", "ControlPersist=60s");
	} else {
		// Merely omitting ControlPath still permits ~/.ssh/config multiplexing.
		args.push("-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no");
	}
	args.push(...(session.ssh_args ?? []));
	if (session.port !== undefined) args.push("-p", String(session.port));
	// Mark remote execution before invoking the login shell. A quiet long-running
	// command is not a stalled connection, and must never be replayed after this.
	const bootstrap = `printf '%s' ${shellQuote(marker)} >&2; exec sh -lc "$1"`;
	args.push("--", session.target, "sh", "-c", shellQuote(bootstrap), "sh", shellQuote(script));
	return args;
}

interface RawSshResult {
	started: boolean;
	exitCode: number | null;
	output: string;
	chunks: Buffer[];
	stdoutChunks: Buffer[];
	stderrChunks: Buffer[];
	bufferedChunks: Buffer[];
	bufferedStderrChunks: Buffer[];
	streamedChunks: Buffer[];
}

function runSshProcess(args: string[], options: SshRunOptions, spawnSsh: SpawnSsh, marker: string, deadline: number | undefined): Promise<RawSshResult> {
	return new Promise((resolve, reject) => {
		assertCanRun(options, deadline);
		const child = spawnSsh("ssh", args, {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let stopping: Error | undefined;
		let started = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let connectHandle: NodeJS.Timeout | undefined;
		let killHandle: NodeJS.Timeout | undefined;
		let closeHandle: NodeJS.Timeout | undefined;
		const pending = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		const readyMarker = Buffer.from(marker);
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
			clearTimeout(timeoutHandle);
			clearTimeout(connectHandle);
			clearTimeout(killHandle);
			clearTimeout(closeHandle);
			options.signal?.removeEventListener("abort", onAbort);
			child.stdout.removeListener("data", onStdout);
			child.stderr.removeListener("data", onStderr);
			fn();
		};
		const killChild = (signal: NodeJS.Signals) => {
			// Kill the detached group, including ProxyCommand children. `killed`
			// only means a signal was sent, not that the child actually exited.
			if (process.platform !== "win32" && child.pid !== undefined) {
				try { process.kill(-child.pid, signal); return; } catch { /* Group may already be gone. */ }
			}
			try { child.kill(signal); } catch { /* Already gone. */ }
		};
		const stop = (error: Error) => {
			if (settled || stopping) return;
			stopping = error;
			clearTimeout(closeHandle);
			clearTimeout(timeoutHandle);
			clearTimeout(connectHandle);
			killChild("SIGTERM");
			// Do not depend on close: descendants can retain pipes after SSH exits.
			// Keep the escalation even if the direct child closes during the grace.
			killHandle = setTimeout(() => {
				killChild("SIGKILL");
				child.stdout.destroy?.();
				child.stderr.destroy?.();
				finish(() => reject(stopping));
			}, TERMINATION_GRACE_MS);
		};
		const onAbort = () => stop(new Error("aborted"));
		const emitStdout = (data: Buffer) => {
			if (data.length === 0 || settled || stopping) return;
			stdoutChunks.push(data);
			chunks.push(data);
			streamedStdout = true;
			streamedChunks.push(data);
			try {
				options.onStdout?.(data);
				options.onData?.(data);
			} catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
		};
		const emitStderr = (data: Buffer) => {
			if (data.length === 0 || settled || stopping) return;
			stderrChunks.push(data);
			chunks.push(data);
			if (streamedStdout) {
				streamedChunks.push(data);
				options.onStderr?.(data);
				options.onData?.(data);
			} else {
				bufferedStderrChunks.push(data);
				bufferedChunks.push(data);
			}
		};
		const receive = (stream: "stdout" | "stderr", data: Buffer) => {
			if (settled || stopping) return;
			const emit = stream === "stdout" ? emitStdout : emitStderr;
			try {
				if (started) { emit(data); return; }
				// A forced PTY merges remote stderr into stdout. Recognize the
				// acknowledgement on either stream without changing PTY behavior.
				const buffered = Buffer.concat([pending[stream], data]);
				const index = buffered.indexOf(readyMarker);
				if (index >= 0) {
					started = true;
					clearTimeout(connectHandle);
					pending[stream] = Buffer.alloc(0);
					emitStdout(pending.stdout);
					emitStderr(pending.stderr);
					pending.stdout = pending.stderr = Buffer.alloc(0);
					emit(buffered.subarray(0, index));
					emit(buffered.subarray(index + readyMarker.length));
				} else {
					// Retain only a possible split marker, not arbitrary output.
					let retained = Math.min(buffered.length, readyMarker.length - 1);
					while (retained > 0 && !buffered.subarray(-retained).equals(readyMarker.subarray(0, retained))) retained--;
					pending[stream] = buffered.subarray(buffered.length - retained);
					emit(buffered.subarray(0, buffered.length - retained));
				}
			} catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
		};
		const onStdout = (data: Buffer) => receive("stdout", data);
		const onStderr = (data: Buffer) => receive("stderr", data);

		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.on("error", (error) => { if (!stopping) stop(error); });
		child.on("exit", () => {
			if (settled || stopping) return;
			// SSH has exited; remaining pipes can only be draining or inherited by
			// descendants. This is not a limit on the remote command runtime.
			closeHandle = setTimeout(() => stop(new Error("SSH exited but output streams did not close.")), TERMINATION_GRACE_MS);
		});
		child.on("close", (code) => {
			if (settled || stopping) return;
			try { emitStdout(pending.stdout); emitStderr(pending.stderr); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); return; }
			if (stopping) return;
			finish(() => resolve({ started, exitCode: code, output: Buffer.concat(chunks).toString("utf8"), chunks, stdoutChunks, stderrChunks, bufferedChunks, bufferedStderrChunks, streamedChunks }));
		});

		const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
		connectHandle = setTimeout(() => stop(new Error(`SSH connection timed out after ${connectTimeout} seconds (remote startup not confirmed).`)), connectTimeout * 1000);
		if (deadline !== undefined) {
			timeoutHandle = setTimeout(() => stop(new Error(`timeout:${options.timeout}`)), Math.max(0, deadline - performance.now()));
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

function shouldRetryWithoutControl(result: RawSshResult): boolean {
	if (result.started || result.exitCode !== 255) return false;
	return /ControlMaster|ControlPath|Control socket connect|mux\/control socket unavailable|Bad configuration option/i.test(result.output);
}

function isRouteFailure(result: RawSshResult): boolean {
	if (result.started || result.exitCode !== 255 || result.stdoutChunks.length > 0 || result.streamedChunks.length > 0) return false;
	return isConnectionFailureOutput(result.output) || /mux_client_request_session: read from master failed|master is dead|Broken pipe|Connection reset by peer/i.test(result.output);
}

function isStaleMultiplexFailureOutput(output: string): boolean {
	return /Control socket connect|mux_client_request_session: master is dead|mux_client_request_session: read from master failed/i.test(output);
}
