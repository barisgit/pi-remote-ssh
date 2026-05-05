import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeSession } from "./session-manager.js";

export interface SshRunOptions {
	onData?: (data: Buffer) => void;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

export interface SshRunResult {
	exitCode: number | null;
	socketAvailable: boolean;
}

export type SpawnSsh = (command: string, args: string[], options: { detached: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const defaultSpawn: SpawnSsh = (command, args, options) => nodeSpawn(command, args, options) as unknown as ChildProcessWithoutNullStreams;

export async function runRemoteSh(session: RuntimeSession, script: string, options: SshRunOptions = {}, spawnSsh: SpawnSsh = defaultSpawn): Promise<SshRunResult> {
	await mkdir(dirname(session.socket_path), { recursive: true });
	const controlArgs = buildSshArgs(session, true, script);
	const controlled = await runSshProcess(controlArgs, options, spawnSsh, { streamOutput: false });
	if (!shouldRetryWithoutControl(controlled)) {
		for (const chunk of controlled.stdoutChunks) options.onStdout?.(chunk);
		for (const chunk of controlled.stderrChunks) options.onStderr?.(chunk);
		for (const chunk of controlled.chunks) options.onData?.(chunk);
		return { exitCode: controlled.exitCode, socketAvailable: true };
	}

	const plainArgs = buildSshArgs(session, false, script);
	const plain = await runSshProcess(plainArgs, options, spawnSsh, { streamOutput: true });
	return { exitCode: plain.exitCode, socketAvailable: false };
}

function buildSshArgs(session: RuntimeSession, useControlSocket: boolean, script: string): string[] {
	const args = [...(session.ssh_args ?? [])];
	if (session.port !== undefined) args.push("-p", String(session.port));
	args.push("-o", "BatchMode=yes");
	if (useControlSocket) {
		args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${session.socket_path}`, "-o", "ControlPersist=60s");
	}
	args.push("--", session.target, "sh", "-lc", script);
	return args;
}

interface RawSshResult {
	exitCode: number | null;
	output: string;
	chunks: Buffer[];
	stdoutChunks: Buffer[];
	stderrChunks: Buffer[];
}

function runSshProcess(args: string[], options: SshRunOptions, spawnSsh: SpawnSsh, processOptions: { streamOutput: boolean }): Promise<RawSshResult> {
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
				options.onStdout?.(data);
				options.onData?.(data);
			}
		};
		const onStderr = (data: Buffer) => {
			stderrChunks.push(data);
			chunks.push(data);
			if (processOptions.streamOutput) {
				options.onStderr?.(data);
				options.onData?.(data);
			}
		};

		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => {
			finish(() => {
				if (options.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
				else resolve({ exitCode: code, output: Buffer.concat(chunks).toString("utf8"), chunks, stdoutChunks, stderrChunks });
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
	return /ControlMaster|ControlPath|control socket|mux|Bad configuration option/i.test(result.output);
}
