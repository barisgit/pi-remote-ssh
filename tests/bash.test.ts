import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRemoteAwareBashTool } from "../src/bash.js";
import { SessionManager } from "../src/session-manager.js";
import type { SpawnSsh } from "../src/ssh.js";

let stateDir: string;
let manager: SessionManager;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "pi-remote-ssh-bash-test-"));
	manager = new SessionManager({ stateDir, lockWaitMs: 500, staleLockMs: 60_000 });
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
});

describe("slice 2 remote bash", () => {
	test("omitted session delegates to local bash unchanged", async () => {
		const calls: unknown[] = [];
		const localBashTool = {
			name: "bash",
			label: "bash",
			description: "local",
			parameters: {},
			execute: async (...args: unknown[]) => {
				calls.push(args);
				return { content: [{ type: "text" as const, text: "local result" }], details: { local: true } };
			},
		};
		const tool = createRemoteAwareBashTool(process.cwd(), { managerFactory: () => manager, localBashTool: localBashTool as never });
		const result = await tool.execute("id", { command: "pwd", timeout: 3 }, undefined, undefined);

		expect(textContent(result)).toBe("local result");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["id", { command: "pwd", timeout: 3 }, undefined, undefined]);
	});

	test("remote bash runs through ssh sh -lc in remote_cwd", async () => {
		await manager.createSession({ path: "box", target: "me@example.invalid", remote_cwd: "/srv/app", port: 2222, ssh_args: ["-i", "~/.ssh/key"] });
		const spawn = createMockSpawn(({ args }) => ({ stdout: "remote ok\n", code: 0 }));
		const tool = createRemoteAwareBashTool(process.cwd(), { managerFactory: () => manager, spawnSsh: spawn });
		const result = await tool.execute("id", { session: "box", command: "printf ok" }, undefined, undefined);

		expect(textContent(result)).toContain("remote ok");
		expect(result.details).toMatchObject({ remote: true, session: "box", target: "me@example.invalid", cwd: "/srv/app", socket: "available" });
		expect(spawn.calls).toHaveLength(1);
		const firstCall = spawn.calls[0]!;
		expect(firstCall.command).toBe("ssh");
		expect(firstCall.args).toContain("-i");
		expect(firstCall.args).toContain("-p");
		expect(firstCall.args).toContain("ControlMaster=auto");
		expect(firstCall.args.slice(-5)).toEqual(["--", "me@example.invalid", "sh", "-lc", "cd '/srv/app' && printf ok"]);
	});

	test("missing remote_cwd resolves remote HOME and writes it back", async () => {
		await manager.createSession({ path: "home", target: "host" });
		const spawn = createMockSpawn(({ args }) => {
			const script = args.at(-1);
			if (script === "printf '%s\\n' \"$HOME\"") return { stdout: "/home/tester\n", code: 0 };
			return { stdout: "cwd ok\n", code: 0 };
		});
		const tool = createRemoteAwareBashTool(process.cwd(), { managerFactory: () => manager, spawnSsh: spawn });
		const result = await tool.execute("id", { session: "home", command: "pwd" }, undefined, undefined);

		expect(textContent(result)).toContain("cwd ok");
		expect(spawn.calls.map((call) => call.args.at(-1))).toEqual(["printf '%s\\n' \"$HOME\"", "cd '/home/tester' && pwd"]);
		const registry = JSON.parse(await readFile(manager.registryPath, "utf8"));
		expect(registry.home.remote_cwd).toBe("/home/tester");
	});

	test("creates managed ControlPath parent directories before invoking ssh", async () => {
		const shortStateDir = await mkdtemp(join("/tmp", "pirs-socket-test-"));
		const shortManager = new SessionManager({ stateDir: shortStateDir, lockWaitMs: 500, staleLockMs: 60_000 });
		try {
			await shortManager.createSession({ path: "lab/pi-03", target: "host", remote_cwd: "/tmp" });
			await shortManager.createSession({ path: Array.from({ length: 20 }, (_, index) => `segment-${index}`).join("/"), target: "host", remote_cwd: "/tmp" });
			const spawn = createMockSpawn(({ args }) => {
				const socketPath = controlPathFromArgs(args);
				if (socketPath === undefined) throw new Error("expected ControlPath");
				expect(existsSync(dirname(socketPath))).toBe(true);
				return { stdout: "ok\n", code: 0 };
			});
			const tool = createRemoteAwareBashTool(process.cwd(), { managerFactory: () => shortManager, spawnSsh: spawn });

			await tool.execute("id", { session: "lab/pi-03", command: "true" }, undefined, undefined);
			await tool.execute("id", { session: Array.from({ length: 20 }, (_, index) => `segment-${index}`).join("/"), command: "true" }, undefined, undefined);

			expect(spawn.calls).toHaveLength(2);
			expect(controlPathFromArgs(spawn.calls[0]!.args)).toContain(join("lab", "pi-03", "control.sock"));
			expect(controlPathFromArgs(spawn.calls[1]!.args)).toContain(join("hashed", ""));
		} finally {
			await rm(shortStateDir, { recursive: true, force: true });
		}
	});

	test("large remote output uses Pi-like truncation and fullOutputPath", async () => {
		await manager.createSession({ path: "large", target: "host", remote_cwd: "/tmp" });
		const largeOutput = `${"x".repeat(70_000)}\nlast line\n`;
		const spawn = createMockSpawn(() => ({ stdout: largeOutput, code: 0 }));
		const tool = createRemoteAwareBashTool(process.cwd(), { managerFactory: () => manager, spawnSsh: spawn });
		const result = await tool.execute("id", { session: "large", command: "big" }, undefined, undefined);

		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.details?.fullOutputPath).toBeString();
		expect(textContent(result)).toContain("Full output:");
		const fullOutputPath = result.details?.fullOutputPath;
		if (fullOutputPath === undefined) throw new Error("expected fullOutputPath");
		const fullOutput = await readFile(fullOutputPath, "utf8");
		expect(fullOutput).toBe(largeOutput);
	});

	test("abort kills the local ssh subprocess", async () => {
		await manager.createSession({ path: "abort", target: "host", remote_cwd: "/tmp" });
		const spawn = createMockSpawn(() => ({ stdout: "", code: 0, hang: true }));
		const tool = createRemoteAwareBashTool(process.cwd(), { managerFactory: () => manager, spawnSsh: spawn });
		const controller = new AbortController();
		const pending = tool.execute("id", { session: "abort", command: "sleep 999" }, controller.signal, undefined);
		await Bun.sleep(10);
		controller.abort();

		await expect(pending).rejects.toThrow(/aborted/);
		expect(spawn.children[0]!.killedWith).toBe("SIGTERM");
	});

	test("ControlMaster failure retries plain ssh and reports socket unavailable without leaking mux output", async () => {
		await manager.createSession({ path: "fallback", target: "host", remote_cwd: "/tmp" });
		const plainOutput = `${"y".repeat(70_000)}\nplain ok\n`;
		const spawn = createMockSpawn(({ args }) => {
			if (args.includes("ControlMaster=auto")) return { stderr: "mux/control socket unavailable\n", code: 255 };
			return { stdout: plainOutput, code: 0 };
		});
		const tool = createRemoteAwareBashTool(process.cwd(), { managerFactory: () => manager, spawnSsh: spawn });
		const result = await tool.execute("id", { session: "fallback", command: "true" }, undefined, undefined);

		expect(spawn.calls).toHaveLength(2);
		expect(spawn.calls[1]!.args).not.toContain("ControlMaster=auto");
		expect(result.details).toMatchObject({ socket: "unavailable" });
		expect(textContent(result)).toContain("plain ok");
		expect(textContent(result)).not.toContain("mux/control socket unavailable");
		const fullOutputPath = result.details?.fullOutputPath;
		if (fullOutputPath === undefined) throw new Error("expected fullOutputPath");
		const fullOutput = await readFile(fullOutputPath, "utf8");
		expect(fullOutput).toBe(plainOutput);
		expect(fullOutput).not.toContain("mux/control socket unavailable");
	});
});

interface MockCall {
	command: string;
	args: string[];
}

interface MockResponse {
	stdout?: string;
	stderr?: string;
	code: number | null;
	hang?: boolean;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function controlPathFromArgs(args: string[]): string | undefined {
	return args.find((arg) => arg.startsWith("ControlPath="))?.slice("ControlPath=".length);
}

function createMockSpawn(respond: (call: MockCall) => MockResponse): SpawnSsh & { calls: MockCall[]; children: MockChild[] } {
	const calls: MockCall[] = [];
	const children: MockChild[] = [];
	const spawn = ((command: string, args: string[]) => {
		const call = { command, args };
		calls.push(call);
		const child = new MockChild();
		children.push(child);
		queueMicrotask(() => {
			const response = respond(call);
			if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
			if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr));
			if (!response.hang) child.emit("close", response.code);
		});
		return child as never;
	}) as unknown as SpawnSsh & { calls: MockCall[]; children: MockChild[] };
	spawn.calls = calls;
	spawn.children = children;
	return spawn;
}

class MockChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;
	killedWith: string | undefined;

	kill(signal?: NodeJS.Signals): boolean {
		this.killed = true;
		this.killedWith = signal;
		queueMicrotask(() => this.emit("close", null));
		return true;
	}
}
