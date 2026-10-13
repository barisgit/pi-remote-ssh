import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type RuntimeSession } from "../src/session-manager.ts";
import { runRemoteSh, shellQuote, type SpawnSsh } from "../src/ssh.ts";

let stateDir: string;
let session: RuntimeSession;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "pi-ssh-transport-"));
	const manager = new SessionManager({ stateDir });
	await manager.createSession({ path: "offline", targets: ["offline.invalid", "backup.invalid"], remote_cwd: "/tmp" });
	session = await manager.getSession("offline");
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;
	signals: string[] = [];
	kill(signal: string): boolean {
		this.killed = true;
		this.signals.push(signal);
		return true; // Deliberately never emits close, even after SIGKILL.
	}
}

function fakeSsh(respond?: (child: FakeChild, args: string[], attempt: number) => void) {
	let spawned!: () => void;
	const ready = new Promise<void>((resolve) => { spawned = resolve; });
	const children: FakeChild[] = [];
	const calls: string[][] = [];
	const spawn: SpawnSsh = (_command, args) => {
		calls.push(args);
		const child = new FakeChild();
		children.push(child);
		queueMicrotask(() => respond?.(child, args, calls.length));
		spawned();
		return child as never;
	};
	return { spawn, children, calls, ready };
}

// A watchdog makes a regression fail deterministically instead of hanging the test runner.
async function outcome(run: Promise<unknown>, ms = 1600): Promise<string> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			run.then(() => "resolved", (error: Error) => error.message),
			new Promise<string>((resolve) => { timer = setTimeout(() => resolve("HUNG"), ms); }),
		]);
	} finally {
		clearTimeout(timer!);
	}
}

test("offline SSH startup is bounded even when OpenSSH never closes", async () => {
	const fake = fakeSsh();
	const result = await outcome(runRemoteSh(session, "true", { connectTimeout: 0.02 }, fake.spawn));
	expect(result).toContain("SSH connection timed out");
	expect(fake.calls).toHaveLength(1); // A local deadline must not replay an uncertain mutation.
	expect(fake.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("pre-aborted execution never spawns SSH", async () => {
	const fake = fakeSsh();
	const controller = new AbortController();
	controller.abort();
	const run = runRemoteSh(session, "true", { signal: controller.signal }, fake.spawn);
	expect(await outcome(run)).toBe("aborted");
	expect(fake.calls).toHaveLength(0);
});

test("command deadline escalates and settles without a close event", async () => {
	const fake = fakeSsh();
	const result = await outcome(runRemoteSh(session, "sleep 999", { timeout: 0.02 }, fake.spawn));
	expect(result).toBe("timeout:0.02");
	expect(fake.calls).toHaveLength(1);
	expect(fake.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

function readiness(args: string[]): Buffer {
	const marker = args.join(" ").match(/\x1epi-ssh-ready:[^\x1f]+\x1f/)?.[0];
	if (!marker) throw new Error("Missing remote startup marker");
	return Buffer.from(marker);
}

test("split readiness marker is hidden and quiet commands outlive the connect deadline", async () => {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const fake = fakeSsh((child, args) => {
		child.stderr.emit("data", Buffer.from("banner ü\n"));
		for (const byte of readiness(args)) child.stderr.emit("data", Buffer.from([byte]));
		child.stderr.emit("data", Buffer.from("warning é\n"));
		setTimeout(() => {
			child.stdout.emit("data", Buffer.from("result\n"));
			child.emit("close", 0);
		}, 80);
	});
	const result = await runRemoteSh(session, "sleep 999", {
		connectTimeout: 0.02,
		onStdout: (data) => stdout.push(data),
		onStderr: (data) => stderr.push(data),
	}, fake.spawn);
	expect(result.exitCode).toBe(0);
	expect(Buffer.concat(stdout).toString()).toBe("result\n");
	expect(Buffer.concat(stderr).toString()).toBe("banner ü\nwarning é\n");
	expect(fake.children[0]!.signals).toEqual([]);
});

test("silent commands are not replayed after remote execution was confirmed", async () => {
	const fake = fakeSsh((child, args) => {
		child.stderr.emit("data", readiness(args));
		child.stderr.emit("data", Buffer.from("Control socket connect: Connection reset by peer\n"));
		child.emit("close", 255);
	});
	expect((await runRemoteSh(session, "mutate", {}, fake.spawn)).exitCode).toBe(255);
	expect(fake.calls).toHaveLength(1);
});

test("safety options precede user overrides and plain fallback disables configured multiplexing", async () => {
	session.ssh_args = ["-o", "ConnectTimeout=999", "-o", "ServerAliveInterval=0", "-o", "BatchMode=no"];
	const fake = fakeSsh((child, _args, attempt) => {
		if (attempt === 1) child.stderr.emit("data", Buffer.from("ControlPath unsupported\n"));
		child.emit("close", attempt === 1 ? 255 : 0);
	});
	await runRemoteSh(session, "true", {}, fake.spawn);
	expect(fake.calls).toHaveLength(2);
	for (const args of fake.calls) {
		expect(args.indexOf("ConnectTimeout=10")).toBeLessThan(args.indexOf("ConnectTimeout=999"));
		expect(args.indexOf("ServerAliveInterval=15")).toBeLessThan(args.indexOf("ServerAliveInterval=0"));
		expect(args.indexOf("BatchMode=yes")).toBeLessThan(args.indexOf("BatchMode=no"));
		expect(args).toContain("ConnectionAttempts=1");
	}
	expect(fake.calls[1]).toContain("ControlMaster=no");
	expect(fake.calls[1]).toContain("ControlPath=none");
	expect(fake.calls[1]).toContain("ControlPersist=no");
});

test("one deadline covers control fallback and route failover", async () => {
	const fake = fakeSsh((child, _args, attempt) => {
		if (attempt > 2) return;
		setTimeout(() => {
			child.stderr.emit("data", Buffer.from(attempt === 1 ? "ControlPath unsupported\n" : "Connection refused\n"));
			child.emit("close", 255);
		}, 250);
	});
	const start = performance.now();
	expect(await outcome(runRemoteSh(session, "true", { timeout: 0.6 }, fake.spawn), 2500)).toBe("timeout:0.6");
	expect(fake.calls).toHaveLength(3);
	expect(performance.now() - start).toBeLessThan(1900);
});

test("abort after startup ignores late output and escalates even after child close", async () => {
	const controller = new AbortController();
	const output: string[] = [];
	const fake = fakeSsh((child, args) => child.stderr.emit("data", readiness(args)));
	const run = runRemoteSh(session, "sleep 999", { signal: controller.signal, onData: (data) => output.push(data.toString()) }, fake.spawn);
	await fake.ready;
	controller.abort();
	const child = fake.children[0]!;
	child.emit("close", null);
	child.stdout.emit("data", Buffer.from("late output"));
	expect(await outcome(run)).toBe("aborted");
	expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(output).toEqual([]);
	expect(child.stdout.listenerCount("data")).toBe(0);
	expect(child.stderr.listenerCount("data")).toBe(0);
});

test("aborting between routes prevents the next spawn", async () => {
	const controller = new AbortController();
	const fake = fakeSsh((child) => {
		child.stderr.emit("data", Buffer.from("Connection refused\n"));
		child.emit("close", 255);
		controller.abort();
	});
	expect(await outcome(runRemoteSh(session, "true", { signal: controller.signal }, fake.spawn))).toBe("aborted");
	expect(fake.calls).toHaveLength(1);
});

test("callback errors terminate SSH rather than escaping and leaving a live child", async () => {
	const fake = fakeSsh((child) => child.stdout.emit("data", Buffer.from("hello")));
	expect(await outcome(runRemoteSh(session, "true", { onData: () => { throw new Error("consumer failed"); } }, fake.spawn))).toBe("consumer failed");
	expect(fake.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("asynchronous spawn errors settle without close", async () => {
	const fake = fakeSsh((child) => child.emit("error", new Error("spawn ssh ENOENT")));
	expect(await outcome(runRemoteSh(session, "true", {}, fake.spawn))).toBe("spawn ssh ENOENT");
	expect(fake.calls).toHaveLength(1);
});

test("an exited SSH with inherited pipes cannot hang indefinitely", async () => {
	const fake = fakeSsh((child, args) => {
		child.stderr.emit("data", readiness(args));
		child.emit("exit", 0);
	});
	expect(await outcome(runRemoteSh(session, "true", {}, fake.spawn), 2600)).toContain("output streams did not close");
	expect(fake.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("PTY-merged stdout readiness is stripped and quiet commands outlive startup", async () => {
	const chunks: Buffer[] = [];
	const fake = fakeSsh((child, args) => {
		for (const byte of readiness(args)) child.stdout.emit("data", Buffer.from([byte]));
		setTimeout(() => { child.stdout.emit("data", Buffer.from("done\r\n")); child.emit("close", 0); }, 80);
	});
	session.ssh_args = ["-tt"];
	expect(await outcome(runRemoteSh(session, "sleep 1", { connectTimeout: 0.02, onData: (data) => chunks.push(data) }, fake.spawn))).toBe("resolved");
	expect(Buffer.concat(chunks).toString()).toBe("done\r\n");
	expect(fake.children[0]!.signals).toEqual([]);
});

test("bootstrap executes locally with shell quoting and separate output intact", async () => {
	// Execute only the remote argv tail locally: no SSH connection or host writes.
	const spawn: SpawnSsh = (_command, args, options) => nodeSpawn("/bin/sh", ["-c", args.slice(args.indexOf("--") + 2).join(" ")], options) as never;
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const expected = "space ' quote $HOME `false`\nsecond line";
	const result = await runRemoteSh(session, `printf '%s' ${shellQuote(expected)}; printf '%s' warning >&2`, {
		onStdout: (data) => stdout.push(data),
		onStderr: (data) => stderr.push(data),
	}, spawn);
	expect(result.exitCode).toBe(0);
	expect(Buffer.concat(stdout).toString()).toBe(expected);
	expect(Buffer.concat(stderr).toString()).toBe("warning");
});
