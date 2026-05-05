import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, RegistryParseError, RegistryLockError } from "../src/session-manager.js";

let stateDir: string;
let manager: SessionManager;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "pi-remote-ssh-test-"));
	manager = new SessionManager({ stateDir, lockWaitMs: 500, staleLockMs: 60_000 });
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
});

describe("slice 1 session registry and lifecycle", () => {
	test("create, list, and delete session works without connecting", async () => {
		const created = await manager.createSession({
			path: "rpi-lab/pi-03",
			target: "pi@example.invalid",
			remote_cwd: "/home/pi",
			port: 2222,
			ssh_args: ["-i", "~/.ssh/rpi_key"],
		});

		expect(created.path).toBe("rpi-lab/pi-03");
		expect(created.socket_path).toContain("sockets");
		expect(created.socket_path.endsWith("control.sock") || created.socket_path.endsWith(".sock")).toBe(true);

		const compact = await manager.listSessions();
		expect(compact.entries).toHaveLength(1);
		expect(compact.entries[0]).toMatchObject({
			path: "rpi-lab/pi-03",
			target: "pi@example.invalid",
			remote_cwd: "/home/pi",
			socket_status: "absent",
		});

		const full = await manager.listSessions({ prefix: "rpi-lab", depth: null, view: "full" });
		expect(full.entries.map((entry) => entry.path)).toEqual(["rpi-lab/pi-03"]);

		const deleted = await manager.deleteSession("rpi-lab/pi-03");
		expect(deleted.path).toBe("rpi-lab/pi-03");
		expect((await manager.listSessions()).entries).toEqual([]);
	});

	test("duplicate paths fail and do not overwrite existing registry entry", async () => {
		await manager.createSession({ path: "home-vps", target: "first.example.invalid", remote_cwd: "/home/first" });
		await expect(manager.createSession({ path: "home-vps", target: "second.example.invalid", remote_cwd: "/home/second" })).rejects.toThrow(/already exists/);

		const registry = JSON.parse(await readFile(manager.registryPath, "utf8"));
		expect(registry["home-vps"].target).toBe("first.example.invalid");
		expect(registry["home-vps"].remote_cwd).toBe("/home/first");
	});

	test("invalid session paths and invalid remote_cwd fail", async () => {
		const invalidPaths = ["", "/abs", "../x", "a//b", "a/../b", "~/x", "a\\b", "bad space", "bad:colon", "a/." as string];
		for (const path of invalidPaths) {
			await expect(manager.createSession({ path, target: "host", remote_cwd: "/tmp" })).rejects.toThrow(/Invalid session path|Session path is required/);
		}
		await expect(manager.createSession({ path: "ok", target: "host", remote_cwd: "relative" })).rejects.toThrow(/remote_cwd must be an absolute path/);
	});

	test("ssh_args rejects shell syntax, positional targets, and control/socket conflicts", async () => {
		await expect(manager.createSession({ path: "bad-shell", target: "host", ssh_args: ["-i", "key;rm"] })).rejects.toThrow(/shell syntax/);
		await expect(manager.createSession({ path: "bad-target", target: "host", ssh_args: ["user@example.invalid"] })).rejects.toThrow(/positional/);
		await expect(manager.createSession({ path: "bad-socket", target: "host", ssh_args: ["-S", "/tmp/socket"] })).rejects.toThrow(/conflicts/);
		await expect(manager.createSession({ path: "bad-control", target: "host", ssh_args: ["-o", "ControlPath=/tmp/socket"] })).rejects.toThrow(/conflicts/);
		await expect(manager.createSession({ path: "bad-port", target: "host", port: 22, ssh_args: ["-p", "2222"] })).rejects.toThrow(/Conflicting port/);
	});

	test("registry writes are locked, atomic, chmod 0600, and duplicate is rechecked after waiting", async () => {
		await manager.ensureStateDir();
		await mkdirLock(manager.lockPath);
		const owner = JSON.parse(await readFile(join(manager.lockPath, "owner.json"), "utf8"));
		expect(owner.pid).toBe(999999);
		expect(owner.hostname).toBe("test-host");

		await mkdir(join(manager.socketsDir, "orphan"), { recursive: true });
		const orphanSocket = join(manager.socketsDir, "orphan", "control.sock");
		await writeFile(orphanSocket, "stale socket placeholder");

		const pending = manager.createSession({ path: "serialized", target: "offline.example.invalid" });
		await Bun.sleep(50);
		expect(await stat(orphanSocket)).toBeTruthy();
		await rm(manager.lockPath, { recursive: true, force: true });
		await pending;
		await expect(stat(orphanSocket)).rejects.toThrow();

		const mode = (await stat(manager.registryPath)).mode & 0o777;
		expect(mode).toBe(0o600);
		const files = await readdir(stateDir);
		expect(files.some((file) => file.startsWith(".sessions.") && file.endsWith(".tmp"))).toBe(false);

		await mkdirLock(manager.lockPath);
		const duplicateAfterWait = manager.createSession({ path: "serialized", target: "other.example.invalid" });
		await Bun.sleep(50);
		await rm(manager.lockPath, { recursive: true, force: true });
		await expect(duplicateAfterWait).rejects.toThrow(/already exists/);
	});

	test("lock timeout fails clearly", async () => {
		const shortWait = new SessionManager({ stateDir, lockWaitMs: 50, staleLockMs: 60_000 });
		await shortWait.ensureStateDir();
		await mkdirLock(shortWait.lockPath);
		await expect(shortWait.createSession({ path: "blocked", target: "host" })).rejects.toBeInstanceOf(RegistryLockError);
	});

	test("lock metadata write failure does not leak sessions.lock", async () => {
		class FailingMetadataSessionManager extends SessionManager {
			protected override async writeLockMetadata(): Promise<void> {
				throw new Error("metadata write failed");
			}
		}
		const failing = new FailingMetadataSessionManager({ stateDir, lockWaitMs: 50, staleLockMs: 60_000 });
		await expect(failing.createSession({ path: "metadata-failure", target: "host" })).rejects.toThrow(/metadata write failed/);
		await expect(stat(failing.lockPath)).rejects.toThrow();

		await manager.createSession({ path: "after-failure", target: "host" });
		const listed = await manager.listSessions();
		expect(listed.entries.map((entry) => entry.path)).toEqual(["after-failure"]);
	});

	test("corrupt registry fails clearly and is not overwritten", async () => {
		await manager.ensureStateDir();
		await writeFile(manager.registryPath, "{ definitely not json", { mode: 0o600 });
		await expect(manager.listSessions()).rejects.toBeInstanceOf(RegistryParseError);
		await expect(manager.createSession({ path: "new", target: "host" })).rejects.toBeInstanceOf(RegistryParseError);
		expect(await readFile(manager.registryPath, "utf8")).toBe("{ definitely not json");
	});

	test("managed socket paths are derived and delete removes only extension-owned socket", async () => {
		const created = await manager.createSession({ path: "lab/pi-01", target: "host" });
		await mkdir(dirname(created.socket_path), { recursive: true });
		await writeFile(created.socket_path, "socket placeholder");
		expect((await manager.listSessions()).entries[0]).toMatchObject({ socket_status: "present" });
		await manager.deleteSession("lab/pi-01");
		await expect(stat(created.socket_path)).rejects.toThrow();
	});

	test("create/list save unreachable hosts and perform no network probe", async () => {
		await manager.createSession({ path: "offline", target: "offline.invalid", remote_cwd: "/" });
		const listed = await manager.listSessions({ view: "full" });
		expect(listed.entries[0]).toMatchObject({ path: "offline", target: "offline.invalid", remote_cwd: "/" });
	});
});

async function mkdirLock(lockPath: string): Promise<void> {
	await rm(lockPath, { recursive: true, force: true });
	await mkdir(lockPath, { recursive: false });
	await writeFile(
		join(lockPath, "owner.json"),
		JSON.stringify({ pid: 999999, hostname: "test-host", created_at: new Date().toISOString() }, null, 2),
		{ mode: 0o600 },
	);
}
