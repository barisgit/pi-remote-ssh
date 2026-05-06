import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteAwareEditTool, createRemoteAwareReadTool, createRemoteAwareWriteTool } from "../src/remote-files.js";
import { SessionManager } from "../src/session-manager.js";
import type { SpawnSsh } from "../src/ssh.js";

let stateDir: string;
let manager: SessionManager;
let workspace: string;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "pi-remote-ssh-files-state-"));
	workspace = await mkdtemp(join(tmpdir(), "pi-remote-ssh-files-work-"));
	manager = new SessionManager({ stateDir, lockWaitMs: 500, staleLockMs: 60_000 });
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

describe("slice 3 remote file tools", () => {
	test("local write preserves write-enhanced hashline stripping", async () => {
		const calls: unknown[] = [];
		const localWriteTool = {
			name: "write",
			label: "write",
			description: "local",
			parameters: {},
			execute: async (...args: unknown[]) => {
				calls.push(args);
				return { content: [{ type: "text" as const, text: "wrote" }] };
			},
		};
		const tool = createRemoteAwareWriteTool(workspace, { managerFactory: () => manager, localWriteTool: localWriteTool as never });
		const result = await tool.execute("id", { path: "new.txt", content: "1 # ZP: hello\n2 # MQ: world\n" }, undefined, undefined);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["id", { path: "new.txt", content: " hello\n world\n" }, undefined, undefined]);
		expect(textContent(result)).toContain("auto-stripped hashline");
	});

	test("local write blocks generated files before delegating", async () => {
		await writeFile(join(workspace, "generated.ts"), "// @generated\nexport const value = 1;\n", "utf8");
		let called = false;
		const localWriteTool = {
			name: "write",
			label: "write",
			description: "local",
			parameters: {},
			execute: async () => {
				called = true;
				return { content: [{ type: "text" as const, text: "wrote" }] };
			},
		};
		const tool = createRemoteAwareWriteTool(workspace, { managerFactory: () => manager, localWriteTool: localWriteTool as never });

		await expect(tool.execute("id", { path: "generated.ts", content: "manual" }, undefined, undefined)).rejects.toThrow(/auto-generated file/);
		expect(called).toBe(false);
	});

	test("remote edit renderCall shows session without invoking local preview renderer", () => {
		let localRenderCalls = 0;
		const localEditTool = {
			name: "edit",
			label: "edit",
			description: "local",
			parameters: {},
			renderCall: () => {
				localRenderCalls += 1;
				return undefined as never;
			},
			execute: async () => ({ content: [{ type: "text" as const, text: "edited" }] }),
		};
		const tool = createRemoteAwareEditTool(workspace, { managerFactory: () => manager, localEditTool: localEditTool as never });
		const theme = fakeTheme();
		const localResult = tool.renderCall({ path: "local.txt", edits: [] } as never, theme as never, { lastComponent: undefined } as never);
		const remoteResult = tool.renderCall({ session: "box", path: "/tmp/file.txt", edits: [] } as never, theme as never, { lastComponent: undefined } as never);

		expect(localResult).toBeUndefined();
		expect(localRenderCalls).toBe(1);
		expect(remoteResult.render(120).join("\n")).toContain("[session: box]");
		expect(localRenderCalls).toBe(1);
	});

	test("remote read uses remote_cwd for relative paths and Pi offset\/limit formatting", async () => {
		await manager.createSession({ path: "box", target: "host", remote_cwd: "/srv/app" });
		const remote = createRemoteFs({ "/srv/app/file.txt": "line1\nline2\nline3\n" });
		const tool = createRemoteAwareReadTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });
		const result = await tool.execute("id", { session: "box", path: "file.txt", offset: 2, limit: 1 }, undefined, undefined);

		expect(textContent(result)).toContain("line2");
		expect(textContent(result)).not.toContain("line1");
		expect(result.details).toMatchObject({ remote: true, session: "box", target: "host", cwd: "/srv/app", path: "/srv/app/file.txt" });
		expect(remote.ops.map((op) => op.op)).toEqual(["access_read", "read_file"]);
	});

	test("remote write applies generated-file protection and hashline stripping", async () => {
		await manager.createSession({ path: "box", target: "host", remote_cwd: "/srv/app" });
		const remote = createRemoteFs({ "/srv/app/generated.ts": "// @generated\nexport const old = 1;\n" });
		const tool = createRemoteAwareWriteTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });

		await expect(tool.execute("id", { session: "box", path: "generated.ts", content: "manual" }, undefined, undefined)).rejects.toThrow(/auto-generated file/);
		expect(remote.files.get("/srv/app/generated.ts")).toContain("@generated");

		const result = await tool.execute("id", { session: "box", path: "manual.ts", content: "1 # ZP: export const value = 1;\n" }, undefined, undefined);
		expect(remote.files.get("/srv/app/manual.ts")).toBe(" export const value = 1;\n");
		expect(textContent(result)).toContain("auto-stripped hashline");
		expect(result.details).toMatchObject({ remote: true, path: "/srv/app/manual.ts" });
	});

	test("remote absolute write edit read persists at the same path", async () => {
		await manager.createSession({ path: "box", target: "host", remote_cwd: "/srv/app" });
		const remote = createRemoteFs({});
		const write = createRemoteAwareWriteTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });
		const edit = createRemoteAwareEditTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });
		const read = createRemoteAwareReadTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });

		await write.execute("id", { session: "box", path: "/tmp/pi-remote-all-tools-test.txt", content: "alpha\n" }, undefined, undefined);
		await edit.execute("id", { session: "box", path: "/tmp/pi-remote-all-tools-test.txt", edits: [{ oldText: "alpha", newText: "beta" }] }, undefined, undefined);
		const result = await read.execute("id", { session: "box", path: "/tmp/pi-remote-all-tools-test.txt", offset: 1, limit: 5 }, undefined, undefined);

		expect(remote.files.get("/tmp/pi-remote-all-tools-test.txt")).toBe("beta\n");
		expect(textContent(result)).toContain("beta");
		expect(result.details).toMatchObject({ remote: true, path: "/tmp/pi-remote-all-tools-test.txt" });
	});

	test("remote edit delegates exact replacement semantics and writes atomically through helper", async () => {
		await manager.createSession({ path: "box", target: "host", remote_cwd: "/srv/app" });
		const remote = createRemoteFs({ "/srv/app/file.txt": "one two one\n" });
		const tool = createRemoteAwareEditTool(workspace, { managerFactory: () => manager, spawnSsh: remote.spawn });

		await expect(tool.execute("id", { session: "box", path: "file.txt", edits: [{ oldText: "one", newText: "ONE" }] }, undefined, undefined)).rejects.toThrow(/multiple|unique/i);
		const result = await tool.execute("id", { session: "box", path: "file.txt", edits: [{ oldText: "two", newText: "TWO" }] }, undefined, undefined);

		expect(remote.files.get("/srv/app/file.txt")).toBe("one TWO one\n");
		expect(textContent(result)).toContain("Successfully replaced 1 block");
		expect(result.details).toMatchObject({ remote: true, path: "/srv/app/file.txt" });
		expect(remote.ops.map((op) => op.op)).toContain("write_file");
	});

	test("remote file tools fail clearly when python3 is missing", async () => {
		await manager.createSession({ path: "box", target: "host", remote_cwd: "/srv/app" });
		const spawn = createMockSpawn(() => ({ stderr: "pi-remote-ssh remote file tools require python3 on the remote host.\n", code: 127 }));
		const tool = createRemoteAwareReadTool(workspace, { managerFactory: () => manager, spawnSsh: spawn });

		await expect(tool.execute("id", { session: "box", path: "file.txt" }, undefined, undefined)).rejects.toThrow(/require python3/);
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

interface RemoteOp {
	op: string;
	path?: string;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function fakeTheme() {
	return {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
	};
}

function createRemoteFs(initialFiles: Record<string, string>) {
	const files = new Map(Object.entries(initialFiles));
	const ops: RemoteOp[] = [];
	const spawn = createMockSpawn(({ args }) => {
		const request = decodeRequest(args.at(-1) ?? "");
		ops.push({ op: request.op, path: request.path });
		if (request.op === "access_read" || request.op === "access_edit") {
			if (!files.has(request.path)) return { stderr: `ENOENT: ${request.path}\n`, code: 1 };
			return { stdout: JSON.stringify({ ok: true }), code: 0 };
		}
		if (request.op === "read_file") {
			const content = files.get(request.path);
			if (content === undefined) return { stderr: `ENOENT: ${request.path}\n`, code: 1 };
			return { stdout: JSON.stringify({ data: Buffer.from(content, "utf8").toString("base64") }), code: 0 };
		}
		if (request.op === "read_prefix") {
			const content = files.get(request.path);
			if (content === undefined) return { stdout: JSON.stringify({ exists: false, data: "" }), code: 0 };
			const prefix = content.slice(0, Number(request.bytes ?? 1024));
			return { stdout: JSON.stringify({ exists: true, data: Buffer.from(prefix, "utf8").toString("base64") }), code: 0 };
		}
		if (request.op === "mkdir") return { stdout: JSON.stringify({ ok: true }), code: 0 };
		if (request.op === "write_file") {
			files.set(request.path, Buffer.from(request.content, "base64").toString("utf8"));
			return { stdout: JSON.stringify({ ok: true, atomic: true }), code: 0 };
		}
		return { stderr: `Unknown op: ${request.op}\n`, code: 1 };
	});
	return { files, ops, spawn };
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
