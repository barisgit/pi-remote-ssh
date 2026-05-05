import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteAwareFindTool, createRemoteAwareGrepTool, createRemoteAwareLsTool } from "../src/remote-search.js";
import { SessionManager } from "../src/session-manager.js";
import type { SpawnSsh } from "../src/ssh.js";

let stateDir: string;
let manager: SessionManager;
let workspace: string;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "pi-remote-ssh-search-test-"));
	workspace = await mkdtemp(join(tmpdir(), "pi-remote-ssh-workspace-"));
	manager = new SessionManager({ stateDir, lockWaitMs: 500, staleLockMs: 60_000 });
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

describe("remote ls grep find", () => {
	test("local ls/grep/find delegate unchanged and preserve tool metadata", async () => {
		const calls: unknown[][] = [];
		const localTool = (name: string) => ({
			name,
			label: name,
			description: "local",
			promptSnippet: `${name} snippet`,
			parameters: {},
			renderCall: () => undefined as never,
			renderResult: () => undefined as never,
			execute: async (...args: unknown[]) => {
				calls.push(args);
				return { content: [{ type: "text" as const, text: `${name} local` }] };
			},
		});

		const ls = createRemoteAwareLsTool(workspace, { managerFactory: () => manager, localLsTool: localTool("ls") as never });
		const grep = createRemoteAwareGrepTool(workspace, { managerFactory: () => manager, localGrepTool: localTool("grep") as never });
		const find = createRemoteAwareFindTool(workspace, { managerFactory: () => manager, localFindTool: localTool("find") as never });
		const ctx = { model: undefined } as never;

		expect(ls.promptSnippet).toBe("ls snippet");
		expect(typeof ls.renderCall).toBe("function");
		await ls.execute("ls-id", { path: "." }, undefined, undefined, ctx);
		await grep.execute("grep-id", { pattern: "needle", path: "." }, undefined, undefined, ctx);
		await find.execute("find-id", { pattern: "*.ts", path: "." }, undefined, undefined, ctx);

		expect(calls).toEqual([
			["ls-id", { path: "." }, undefined, undefined, ctx],
			["grep-id", { pattern: "needle", path: "." }, undefined, undefined, ctx],
			["find-id", { pattern: "*.ts", path: "." }, undefined, undefined, ctx],
		]);
	});

	test("remote helpers ignore ssh stderr noise when parsing JSON", async () => {
		await manager.createSession({ path: "box", target: "host", remote_cwd: "/srv/app" });
		const spawn = createMockSpawn(({ args }) => {
			const request = decodeRequest(args.at(-1) ?? "");
			if (request.op === "stat_is_dir") return { stdout: JSON.stringify({ exists: true, is_dir: true }), stderr: "ControlSocket /tmp/noise already exists\n", code: 0 };
			if (request.op === "glob_files") return { stdout: JSON.stringify({ paths: ["/srv/app/src/index.ts"] }), stderr: "ControlSocket /tmp/noise already exists\n", code: 0 };
			return { stderr: `Unknown op: ${request.op}\n`, code: 1 };
		});
		const find = createRemoteAwareFindTool(workspace, { managerFactory: () => manager, spawnSsh: spawn });

		const result = await find.execute("id", { session: "box", path: "src", pattern: "*.ts", limit: 5 }, undefined, undefined);

		expect(textContent(result)).toContain("index.ts");
	});

	test("remote ls/find/grep anchor relative paths at remote_cwd", async () => {
		await manager.createSession({ path: "box", target: "host", remote_cwd: "/srv/app" });
		const remote = createRemoteSearchFs();

		const ls = createRemoteAwareLsTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });
		const find = createRemoteAwareFindTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });
		const grep = createRemoteAwareGrepTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });

		const lsResult = await ls.execute("id", { session: "box", path: "src" }, undefined, undefined);
		const findResult = await find.execute("id", { session: "box", path: "src", pattern: "*.ts", limit: 10 }, undefined, undefined);
		const grepResult = await grep.execute("id", { session: "box", path: "src", pattern: "needle", literal: true }, undefined, undefined);

		expect(textContent(lsResult)).toContain("index.ts");
		expect(textContent(findResult)).toContain("index.ts");
		expect(textContent(grepResult)).toContain("index.ts:1: const needle = true;");
		expect(remote.ops.map((op) => op.path)).toContain("/srv/app/src");
		expect((grepResult.details as any).remote).toBe(true);
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
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function createRemoteSearchFs() {
	const ops: Array<{ op: string; path?: string }> = [];
	const spawn = createMockSpawn(({ args }) => {
		const request = decodeRequest(args.at(-1) ?? "");
		ops.push({ op: request.op, path: request.path });
		if (request.op === "stat_is_dir") return { stdout: JSON.stringify({ exists: true, is_dir: true }), code: 0 };
		if (request.op === "list_dir") return { stdout: JSON.stringify({ entries: ["index.ts", "nested"] }), code: 0 };
		if (request.op === "glob_files") return { stdout: JSON.stringify({ paths: ["/srv/app/src/index.ts"] }), code: 0 };
		if (request.op === "grep_files") return { stdout: JSON.stringify({ output: "index.ts:1: const needle = true;", matchLimitReached: null }), code: 0 };
		return { stderr: `Unknown op: ${request.op}\n`, code: 1 };
	});
	return { ops, spawn };
}

function decodeRequest(script: string): any {
	const match = /python3 - '([^']+)'/.exec(script);
	if (!match) throw new Error(`Expected remote python helper script, got: ${script}`);
	return JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8"));
}

function createMockSpawn(respond: (call: MockCall) => MockResponse): SpawnSsh & { calls: MockCall[] } {
	const calls: MockCall[] = [];
	const spawn = ((command: string, args: string[]) => {
		const call = { command, args };
		calls.push(call);
		const child = new MockChild();
		queueMicrotask(() => {
			const response = respond(call);
			if (response.stdout) child.stdout.emit("data", Buffer.from(response.stdout));
			if (response.stderr) child.stderr.emit("data", Buffer.from(response.stderr));
			child.emit("close", response.code);
		});
		return child as never;
	}) as unknown as SpawnSsh & { calls: MockCall[] };
	spawn.calls = calls;
	return spawn;
}

class MockChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(): boolean {
		this.killed = true;
		queueMicrotask(() => this.emit("close", null));
		return true;
	}
}
