import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
	assertValidPort,
	assertValidRemoteCwd,
	assertValidSessionPath,
	assertValidSshArgs,
	assertValidTarget,
} from "./path-safety.js";

export interface RemoteSshSessionDefinition {
	target: string;
	remote_cwd?: string;
	port?: number;
	ssh_args?: string[];
	created_at: string;
	last_used_at: string;
}

export interface RuntimeSession extends RemoteSshSessionDefinition {
	path: string;
	socket_path: string;
}

export type SessionRegistry = Record<string, RemoteSshSessionDefinition>;

export interface CreateSessionInput {
	path: string;
	target: string;
	remote_cwd?: string;
	port?: number;
	ssh_args?: string[];
}

export interface CreateSessionsInput {
	sessions: CreateSessionInput[];
}

export interface DeleteSessionsInput {
	paths: string[];
}

export interface ListSessionsInput {
	prefix?: string;
	depth?: number | null;
	view?: "compact" | "full";
}

export interface ListedSession {
	path: string;
	target: string;
	remote_cwd?: string;
	port?: number;
	ssh_args?: string[];
	created_at: string;
	last_used_at: string;
	socket_path: string;
	socket_status: "absent" | "present";
}

export interface ListedNamespace {
	path: string;
	type: "namespace";
}

export class RegistryReadError extends Error {
	constructor(registryPath: string, cause: unknown) {
		super(`Failed to read SSH session registry at ${registryPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "RegistryReadError";
	}
}

export class RegistryParseError extends Error {
	constructor(registryPath: string, cause: unknown) {
		super(`Failed to parse SSH session registry at ${registryPath}. The file is corrupt and was not overwritten: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "RegistryParseError";
	}
}

export class RegistryLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegistryLockError";
	}
}

export interface SessionManagerOptions {
	stateDir: string;
	lockWaitMs?: number;
	staleLockMs?: number;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
}

interface LockMetadata {
	pid: number;
	hostname: string;
	created_at: string;
}

const DEFAULT_LOCK_WAIT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const SOCKET_PATH_LIMIT = 100;

export class SessionManager {
	readonly stateDir: string;
	readonly registryPath: string;
	readonly lockPath: string;
	readonly socketsDir: string;
	readonly logsDir: string;
	private readonly lockWaitMs: number;
	private readonly staleLockMs: number;
	private readonly now: () => Date;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: SessionManagerOptions) {
		this.stateDir = options.stateDir;
		this.registryPath = join(this.stateDir, "sessions.json");
		this.lockPath = join(this.stateDir, "sessions.lock");
		this.socketsDir = join(this.stateDir, "sockets");
		this.logsDir = join(this.stateDir, "logs");
		this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
		this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
		this.now = options.now ?? (() => new Date());
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async ensureStateDir(): Promise<void> {
		await mkdir(this.socketsDir, { recursive: true });
		await mkdir(this.logsDir, { recursive: true });
	}

	async readRegistry(): Promise<SessionRegistry> {
		await this.ensureStateDir();
		try {
			await access(this.registryPath, constants.F_OK);
		} catch {
			return {};
		}

		let raw: string;
		try {
			raw = await readFile(this.registryPath, "utf8");
		} catch (error) {
			throw new RegistryReadError(this.registryPath, error);
		}

		try {
			const parsed = JSON.parse(raw) as unknown;
			return normalizeRegistry(parsed);
		} catch (error) {
			throw new RegistryParseError(this.registryPath, error);
		}
	}

	async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
		const [session] = await this.createSessions({ sessions: [input] });
		return session!;
	}

	async createSessions(input: CreateSessionsInput): Promise<RuntimeSession[]> {
		validateCreateSessionsInput(input);
		const createdAt = this.now().toISOString();
		const sessions = input.sessions.map((createInput) => ({ path: createInput.path, definition: toSessionDefinition(createInput, createdAt) }));

		await this.withLock(async () => {
			const registry = await this.readRegistry();
			await this.cleanupUnreferencedSocketFilesForRegistry(registry);
			for (const { path } of sessions) {
				if (registry[path] !== undefined) {
					throw new Error(`SSH session "${path}" already exists. Delete it before creating a replacement.`);
				}
			}
			for (const { path, definition } of sessions) {
				registry[path] = definition;
			}
			await this.writeRegistryAtomic(registry);
		});

		return sessions.map(({ path, definition }) => this.toRuntimeSession(path, definition));
	}

	async listSessions(input: ListSessionsInput = {}): Promise<{ entries: Array<ListedSession | ListedNamespace>; view: "compact" | "full" }> {
		const view = input.view ?? "compact";
		if (view !== "compact" && view !== "full") throw new Error("view must be 'compact' or 'full'.");
		const prefix = input.prefix;
		if (prefix !== undefined && prefix !== "") assertValidSessionPath(prefix);
		const depth = input.depth ?? null;
		if (depth !== null && (!Number.isInteger(depth) || depth < 0)) throw new Error("depth must be a non-negative integer or null.");

		const registry = await this.readRegistry();
		const entries: Array<ListedSession | ListedNamespace> = [];
		const namespaces = new Set<string>();
		const prefixWithSlash = prefix ? `${prefix}/` : "";

		for (const [path, definition] of Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))) {
			if (prefix && path !== prefix && !path.startsWith(prefixWithSlash)) continue;
			const relative = prefix ? (path === prefix ? "" : path.slice(prefixWithSlash.length)) : path;
			const levelsBelowPrefix = relative === "" ? 0 : relative.split("/").length;
			if (depth !== null && levelsBelowPrefix > depth) {
				const namespaceSegments = path.split("/").slice(0, (prefix ? prefix.split("/").length : 0) + depth);
				if (namespaceSegments.length > 0) namespaces.add(namespaceSegments.join("/"));
				continue;
			}
			entries.push(await this.toListedSession(path, definition));
		}

		for (const namespace of [...namespaces].sort()) {
			entries.push({ path: namespace, type: "namespace" });
		}
		entries.sort((a, b) => a.path.localeCompare(b.path));
		return { entries, view };
	}

	async getSession(path: string): Promise<RuntimeSession> {
		assertValidSessionPath(path);
		const registry = await this.readRegistry();
		const session = registry[path];
		if (session === undefined) throw new Error(`SSH session "${path}" does not exist.`);
		return this.toRuntimeSession(path, session);
	}

	async updateSessionAfterUse(path: string, updates: { remote_cwd?: string }): Promise<RuntimeSession> {
		assertValidSessionPath(path);
		let updated: RemoteSshSessionDefinition | undefined;
		await this.withLock(async () => {
			const registry = await this.readRegistry();
			const current = registry[path];
			if (current === undefined) throw new Error(`SSH session "${path}" does not exist.`);
			updated = { ...current, last_used_at: this.now().toISOString() };
			if (updates.remote_cwd !== undefined) {
				assertValidRemoteCwd(updates.remote_cwd);
				updated.remote_cwd = updates.remote_cwd;
			}
			registry[path] = updated;
			await this.writeRegistryAtomic(registry);
		});
		return this.toRuntimeSession(path, updated!);
	}

	async deleteSession(path: string): Promise<RuntimeSession> {
		const [deleted] = await this.deleteSessions({ paths: [path] });
		return deleted!;
	}

	async deleteSessions(input: DeleteSessionsInput): Promise<RuntimeSession[]> {
		validateDeleteSessionsInput(input);
		const deleted: Array<{ path: string; definition: RemoteSshSessionDefinition }> = [];
		await this.withLock(async () => {
			const registry = await this.readRegistry();
			for (const path of input.paths) {
				const definition = registry[path];
				if (definition === undefined) throw new Error(`SSH session "${path}" does not exist.`);
				deleted.push({ path, definition });
			}
			for (const path of input.paths) {
				delete registry[path];
			}
			await this.writeRegistryAtomic(registry);
		});
		const runtimes = deleted.map(({ path, definition }) => this.toRuntimeSession(path, definition));
		await Promise.all(runtimes.map((runtime) => this.removeManagedSocket(runtime.socket_path)));
		return runtimes;
	}

	toRuntimeSession(path: string, definition: RemoteSshSessionDefinition): RuntimeSession {
		return { path, socket_path: this.deriveSocketPath(path), ...definition };
	}

	deriveSocketPath(sessionPath: string): string {
		assertValidSessionPath(sessionPath);
		const mirrored = join(this.socketsDir, ...sessionPath.split("/"), "control.sock");
		if (Buffer.byteLength(mirrored, "utf8") <= SOCKET_PATH_LIMIT) return mirrored;
		const digest = createHash("sha256").update(sessionPath).digest("hex").slice(0, 32);
		return join(this.socketsDir, "hashed", `${digest}.sock`);
	}

	async cleanupUnreferencedSocketFiles(): Promise<void> {
		await this.withLock(async () => {
			const registry = await this.readRegistry();
			await this.cleanupUnreferencedSocketFilesForRegistry(registry);
		});
	}

	private async cleanupUnreferencedSocketFilesForRegistry(registry: SessionRegistry): Promise<void> {
		const liveSocketPaths = new Set(Object.keys(registry).map((path) => this.deriveSocketPath(path)));
		await this.walkSocketFiles(this.socketsDir, async (filePath) => {
			if (!liveSocketPaths.has(filePath)) await rm(filePath, { force: true });
		});
	}

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensureStateDir();
		const started = Date.now();
		while (true) {
			try {
				await mkdir(this.lockPath);
				try {
					await this.writeLockMetadata();
				} catch (error) {
					await rm(this.lockPath, { recursive: true, force: true });
					throw error;
				}
				break;
			} catch (error: any) {
				if (error?.code !== "EEXIST") throw error;
				const age = await this.getLockAgeMs();
				if (age !== undefined && age > this.staleLockMs && (await this.isLockOwnerDeadOrUnknown())) {
					await rm(this.lockPath, { recursive: true, force: true });
					continue;
				}
				if (Date.now() - started > this.lockWaitMs) {
					throw new RegistryLockError(`Timed out waiting for ${this.lockPath}. If no pi-remote-ssh process is active, remove this lock manually.`);
				}
				await this.sleep(25);
			}
		}

		try {
			return await fn();
		} finally {
			await rm(this.lockPath, { recursive: true, force: true });
		}
	}

	private async writeRegistryAtomic(registry: SessionRegistry): Promise<void> {
		await mkdir(dirname(this.registryPath), { recursive: true });
		const tmpPath = join(dirname(this.registryPath), `.sessions.${process.pid}.${randomUUID()}.tmp`);
		const data = `${JSON.stringify(registry, null, 2)}\n`;
		const handle = await open(tmpPath, "wx", 0o600);
		try {
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await chmod(tmpPath, 0o600);
		await rename(tmpPath, this.registryPath);
		await chmod(this.registryPath, 0o600);
	}

	protected async writeLockMetadata(): Promise<void> {
		const metadata: LockMetadata = {
			pid: process.pid,
			hostname: hostname(),
			created_at: this.now().toISOString(),
		};
		await writeFile(join(this.lockPath, "owner.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
	}

	private async getLockAgeMs(): Promise<number | undefined> {
		try {
			const raw = await readFile(join(this.lockPath, "owner.json"), "utf8");
			const metadata = JSON.parse(raw) as LockMetadata;
			return Date.now() - new Date(metadata.created_at).getTime();
		} catch {
			return undefined;
		}
	}

	private async isLockOwnerDeadOrUnknown(): Promise<boolean> {
		try {
			const raw = await readFile(join(this.lockPath, "owner.json"), "utf8");
			const metadata = JSON.parse(raw) as LockMetadata;
			if (metadata.hostname !== hostname()) return true;
			try {
				process.kill(metadata.pid, 0);
				return false;
			} catch {
				return true;
			}
		} catch {
			return true;
		}
	}

	private async toListedSession(path: string, definition: RemoteSshSessionDefinition): Promise<ListedSession> {
		const socketPath = this.deriveSocketPath(path);
		return {
			path,
			target: definition.target,
			...(definition.remote_cwd !== undefined ? { remote_cwd: definition.remote_cwd } : {}),
			...(definition.port !== undefined ? { port: definition.port } : {}),
			...(definition.ssh_args !== undefined ? { ssh_args: [...definition.ssh_args] } : {}),
			created_at: definition.created_at,
			last_used_at: definition.last_used_at,
			socket_path: socketPath,
			socket_status: (await fileExists(socketPath)) ? "present" : "absent",
		};
	}

	private async removeManagedSocket(socketPath: string): Promise<void> {
		await rm(socketPath, { force: true });
		await pruneEmptyParents(dirname(socketPath), this.socketsDir);
	}

	private async walkSocketFiles(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(root, entry);
			const info = await stat(path).catch(() => undefined);
			if (!info) continue;
			if (info.isDirectory()) await this.walkSocketFiles(path, visit);
			else await visit(path);
		}
	}
}

function validateCreateSessionInput(input: CreateSessionInput): void {
	assertValidSessionPath(input.path);
	assertValidTarget(input.target);
	assertValidRemoteCwd(input.remote_cwd);
	assertValidPort(input.port);
	assertValidSshArgs(input.ssh_args, input.port);
}

function validateCreateSessionsInput(input: CreateSessionsInput): void {
	if (!Array.isArray(input.sessions) || input.sessions.length === 0) throw new Error("sessions must be a non-empty array.");
	const seenPaths = new Set<string>();
	for (const session of input.sessions) {
		validateCreateSessionInput(session);
		if (seenPaths.has(session.path)) throw new Error(`Duplicate SSH session path "${session.path}" in batch.`);
		seenPaths.add(session.path);
	}
}

function validateDeleteSessionsInput(input: DeleteSessionsInput): void {
	if (!Array.isArray(input.paths) || input.paths.length === 0) throw new Error("paths must be a non-empty array.");
	const seenPaths = new Set<string>();
	for (const path of input.paths) {
		assertValidSessionPath(path);
		if (seenPaths.has(path)) throw new Error(`Duplicate SSH session path "${path}" in batch.`);
		seenPaths.add(path);
	}
}

function toSessionDefinition(input: CreateSessionInput, createdAt: string): RemoteSshSessionDefinition {
	const session: RemoteSshSessionDefinition = {
		target: input.target,
		created_at: createdAt,
		last_used_at: createdAt,
	};
	if (input.remote_cwd !== undefined) session.remote_cwd = input.remote_cwd;
	if (input.port !== undefined) session.port = input.port;
	if (input.ssh_args !== undefined) session.ssh_args = [...input.ssh_args];
	return session;
}

function normalizeRegistry(parsed: unknown): SessionRegistry {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("registry root must be an object keyed by session path");
	}
	const result: SessionRegistry = {};
	for (const [path, value] of Object.entries(parsed)) {
		assertValidSessionPath(path);
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`registry entry ${path} must be an object`);
		}
		const entry = value as Partial<RemoteSshSessionDefinition>;
		if (typeof entry.target !== "string") throw new Error(`registry entry ${path} is missing target`);
		assertValidTarget(entry.target);
		assertValidRemoteCwd(entry.remote_cwd);
		assertValidPort(entry.port);
		assertValidSshArgs(entry.ssh_args, entry.port);
		const createdAt = typeof entry.created_at === "string" ? entry.created_at : new Date(0).toISOString();
		const lastUsedAt = typeof entry.last_used_at === "string" ? entry.last_used_at : createdAt;
		result[path] = {
			target: entry.target,
			created_at: createdAt,
			last_used_at: lastUsedAt,
		};
		if (entry.remote_cwd !== undefined) result[path].remote_cwd = entry.remote_cwd;
		if (entry.port !== undefined) result[path].port = entry.port;
		if (entry.ssh_args !== undefined) result[path].ssh_args = [...entry.ssh_args];
	}
	return result;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function pruneEmptyParents(path: string, stopAt: string): Promise<void> {
	let current = path;
	while (current.startsWith(stopAt) && current !== stopAt) {
		try {
			await rmdirIfEmpty(current);
		} catch {
			return;
		}
		current = dirname(current);
	}
}

async function rmdirIfEmpty(path: string): Promise<void> {
	const entries = await readdir(path);
	if (entries.length === 0) await rm(path, { recursive: false });
}
