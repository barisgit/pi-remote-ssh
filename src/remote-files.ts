import { Type } from "@mariozechner/pi-ai";
import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type ReadOperations,
	type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { getRemoteSshStateDir } from "./config.js";
import { SessionManager, type RuntimeSession } from "./session-manager.js";
import { runRemoteSh, shellQuote, type SpawnSsh, type SshRunOptions } from "./ssh.js";
import { assertLocalEditableFile, assertRemoteEditableContent, stripHashlinePrefixes } from "./write-enhancements.js";

export interface CreateRemoteFileToolOptions {
	managerFactory?: () => SessionManager;
	spawnSsh?: SpawnSsh;
	localReadTool?: ReturnType<typeof createReadToolDefinition>;
	localWriteTool?: ReturnType<typeof createWriteToolDefinition>;
	localEditTool?: ReturnType<typeof createEditToolDefinition>;
}

interface ReadParams {
	path: string;
	offset?: number;
	limit?: number;
	session?: string;
}

interface WriteParams {
	path: string;
	content: string;
	session?: string;
}

interface EditParams {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
	session?: string;
}

export interface RemoteDetails {
	remote: true;
	session: string;
	target: string;
	path?: string;
	cwd?: string;
}

const REMOTE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

export function createRemoteAwareReadTool(cwd: string, options: CreateRemoteFileToolOptions = {}) {
	const localReadTool = options.localReadTool ?? createReadToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	return {
		...localReadTool,
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path. Omit for unchanged local read behavior." })),
		}),
		async execute(toolCallId: string, params: ReadParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localReadTool.execute>[3], ctx: Parameters<typeof localReadTool.execute>[4] = undefined as never) {
			const localParams = withoutSession(params);
			if (params.session === undefined) return localReadTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			const remote = await createRemoteContext(managerFactory(), params.session, options.spawnSsh, signal);
			const ops = new RemoteReadOperations(remote);
			const remoteTool = createReadToolDefinition(remote.cwd, { operations: ops });
			const result = await remoteTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			await remote.markUsed();
			const details = remoteDetails(remote, resolveRemotePath(remote.cwd, params.path));
			return { ...annotateRemoteResult(result, details), details: { ...(result.details ?? {}), ...details } };
		},
	};
}

export function createRemoteAwareWriteTool(cwd: string, options: CreateRemoteFileToolOptions = {}) {
	const localWriteTool = options.localWriteTool ?? createWriteToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	return {
		...localWriteTool,
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to write" }),
			content: Type.String({ description: "Content to write to the file" }),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path. Omit for unchanged local write behavior." })),
		}),
		async execute(toolCallId: string, params: WriteParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localWriteTool.execute>[3], ctx: Parameters<typeof localWriteTool.execute>[4] = undefined as never) {
			const { text: cleanContent, stripped } = stripHashlinePrefixes(params.content);
			if (params.session === undefined) {
				const absolutePath = path.resolve(cwd, params.path);
				await assertLocalEditableFile(absolutePath, params.path);
				const result = await localWriteTool.execute(toolCallId, { path: params.path, content: cleanContent }, signal, onUpdate, ctx);
				return appendHashlineNote(result, stripped);
			}

			const remote = await createRemoteContext(managerFactory(), params.session, options.spawnSsh, signal);
			const remotePath = resolveRemotePath(remote.cwd, params.path);
			const existingPrefix = await remoteExistingPrefix(remote, remotePath);
			assertRemoteEditableContent(remotePath, existingPrefix);
			const ops = new RemoteWriteOperations(remote);
			const remoteTool = createWriteToolDefinition(remote.cwd, { operations: ops });
			const result = await remoteTool.execute(toolCallId, { path: params.path, content: cleanContent }, signal, onUpdate, ctx);
			await remote.markUsed();
			const withNote = appendHashlineNote(result, stripped);
			const details = remoteDetails(remote, remotePath);
			return { ...annotateRemoteResult(withNote, details), details: { ...((withNote as any).details ?? {}), ...details } };
		},
	};
}

export function createRemoteAwareEditTool(cwd: string, options: CreateRemoteFileToolOptions = {}) {
	const localEditTool = options.localEditTool ?? createEditToolDefinition(cwd);
	const managerFactory = options.managerFactory ?? (() => new SessionManager({ stateDir: getRemoteSshStateDir() }));
	return {
		...localEditTool,
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to edit" }),
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
			session: Type.Optional(Type.String({ description: "Optional Pi Remote SSH session path. Omit for unchanged local edit behavior." })),
		}),
		async execute(toolCallId: string, params: EditParams, signal?: AbortSignal, onUpdate?: Parameters<typeof localEditTool.execute>[3], ctx: Parameters<typeof localEditTool.execute>[4] = undefined as never) {
			const localParams = withoutSession(params);
			if (params.session === undefined) return localEditTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			const remote = await createRemoteContext(managerFactory(), params.session, options.spawnSsh, signal);
			const remotePath = resolveRemotePath(remote.cwd, params.path);
			const ops = new RemoteEditOperations(remote);
			const remoteTool = createEditToolDefinition(remote.cwd, { operations: ops });
			const result = await remoteTool.execute(toolCallId, localParams, signal, onUpdate, ctx);
			await remote.markUsed();
			const remoteMetadata = remoteDetails(remote, remotePath);
			const details = { ...(result.details as EditToolDetails), ...remoteMetadata };
			return { ...annotateRemoteResult(result, remoteMetadata), details };
		},
	};
}

export class RemoteContext {
	constructor(
		readonly manager: SessionManager,
		public session: RuntimeSession,
		readonly spawnSsh: SpawnSsh | undefined,
		readonly cwd: string,
	) {}

	async runPython(op: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const payload = Buffer.from(JSON.stringify({ op, ...args }), "utf8").toString("base64");
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const script = `command -v python3 >/dev/null 2>&1 || { printf 'pi-remote-ssh remote file tools require python3 on the remote host.\\n' >&2; exit 127; }; python3 - ${shellQuote(payload)} <<'PY'\n${REMOTE_PYTHON_HELPER}\nPY`;
		const runOptions = sshOptions({ onStdout: (data) => { stdoutChunks.push(data); }, onStderr: (data) => { stderrChunks.push(data); }, signal });
		const result = this.spawnSsh === undefined
			? await runRemoteSh(this.session, script, runOptions)
			: await runRemoteSh(this.session, script, runOptions, this.spawnSsh);
		const stdout = Buffer.concat(stdoutChunks).toString("utf8");
		const stderr = Buffer.concat(stderrChunks).toString("utf8");
		if (result.exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `Remote python3 helper failed with exit code ${result.exitCode}.`);
		try {
			return JSON.parse(stdout);
		} catch (error: any) {
			const noise = stderr.trim();
			throw new Error(`Remote python3 helper returned invalid JSON${noise ? ` (stderr: ${noise})` : ""}: ${error.message}`);
		}
	}

	async markUsed(): Promise<void> {
		this.session = await this.manager.updateSessionAfterUse(this.session.path, {});
	}
}

class RemoteReadOperations implements ReadOperations {
	constructor(private readonly remote: RemoteContext) {}
	async access(absolutePath: string): Promise<void> {
		await this.remote.runPython("access_read", { path: absolutePath });
	}
	async readFile(absolutePath: string): Promise<Buffer> {
		const result = await this.remote.runPython("read_file", { path: absolutePath }) as { data: string };
		return Buffer.from(result.data, "base64");
	}
	async detectImageMimeType(absolutePath: string): Promise<string | null> {
		if (REMOTE_IMAGE_EXTENSIONS.has(path.posix.extname(absolutePath).toLowerCase())) {
			throw new Error("Remote image reads are unsupported in pi-remote-ssh v1. Use bash({ session, command }) to inspect or copy image metadata.");
		}
		return null;
	}
}

class RemoteWriteOperations implements WriteOperations {
	constructor(private readonly remote: RemoteContext) {}
	async mkdir(dir: string): Promise<void> {
		await this.remote.runPython("mkdir", { path: dir });
	}
	async writeFile(absolutePath: string, content: string): Promise<void> {
		await this.remote.runPython("write_file", { path: absolutePath, content: Buffer.from(content, "utf8").toString("base64") });
	}
}

class RemoteEditOperations implements EditOperations {
	constructor(private readonly remote: RemoteContext) {}
	async access(absolutePath: string): Promise<void> {
		await this.remote.runPython("access_edit", { path: absolutePath });
	}
	async readFile(absolutePath: string): Promise<Buffer> {
		const result = await this.remote.runPython("read_file", { path: absolutePath }) as { data: string };
		return Buffer.from(result.data, "base64");
	}
	async writeFile(absolutePath: string, content: string): Promise<void> {
		await this.remote.runPython("write_file", { path: absolutePath, content: Buffer.from(content, "utf8").toString("base64") });
	}
}

export async function createRemoteContext(manager: SessionManager, sessionPath: string, spawnSsh: SpawnSsh | undefined, signal?: AbortSignal): Promise<RemoteContext> {
	let session = await manager.getSession(sessionPath);
	if (session.remote_cwd === undefined) {
		const chunks: Buffer[] = [];
		const runOptions = sshOptions({ onStdout: (data) => { chunks.push(data); }, signal });
		const result = spawnSsh === undefined
			? await runRemoteSh(session, "printf '%s\\n' \"$HOME\"", runOptions)
			: await runRemoteSh(session, "printf '%s\\n' \"$HOME\"", runOptions, spawnSsh);
		if (result.exitCode !== 0) throw new Error(`Failed to resolve remote $HOME for SSH session "${session.path}".`);
		const home = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n").at(-1)?.trim();
		if (!home?.startsWith("/")) throw new Error(`Resolved remote $HOME for SSH session "${session.path}" is not an absolute path.`);
		session = await manager.updateSessionAfterUse(session.path, { remote_cwd: home });
	}
	const remoteCwd = session.remote_cwd;
	if (remoteCwd === undefined) throw new Error(`SSH session "${session.path}" is missing remote_cwd.`);
	return new RemoteContext(manager, session, spawnSsh, remoteCwd);
}

async function remoteExistingPrefix(remote: RemoteContext, remotePath: string): Promise<string | undefined> {
	try {
		const result = await remote.runPython("read_prefix", { path: remotePath, bytes: 1024 }) as { data: string; exists: boolean };
		return result.exists ? Buffer.from(result.data, "base64").toString("utf8") : undefined;
	} catch (error: any) {
		if (String(error?.message ?? error).includes("ENOENT")) return undefined;
		throw error;
	}
}

export function resolveRemotePath(remoteCwd: string, inputPath: string): string {
	return path.posix.normalize(inputPath.startsWith("/") ? inputPath : path.posix.join(remoteCwd, inputPath));
}

export function remoteDetails(remote: RemoteContext, remotePath: string): RemoteDetails {
	return { remote: true, session: remote.session.path, target: remote.session.target, cwd: remote.cwd, path: remotePath };
}

export function annotateRemoteResult<T extends { content?: Array<{ type: string; text?: string }> }>(result: T, details: RemoteDetails): T {
	const firstText = result.content?.find((item) => item.type === "text" && typeof item.text === "string");
	if (firstText) firstText.text += `\n\n[remote: ${details.session} -> ${details.target}, cwd: ${details.cwd ?? "<unknown>"}]`;
	return result;
}

function withoutSession<T extends { session?: string }>(params: T): Omit<T, "session"> {
	const { session: _session, ...rest } = params;
	return rest;
}

function sshOptions(options: Omit<SshRunOptions, "timeout" | "signal"> & { signal?: AbortSignal | undefined }): SshRunOptions {
	const result: SshRunOptions = {};
	if (options.onData !== undefined) result.onData = options.onData;
	if (options.onStdout !== undefined) result.onStdout = options.onStdout;
	if (options.onStderr !== undefined) result.onStderr = options.onStderr;
	if (options.signal !== undefined) result.signal = options.signal;
	return result;
}

function appendHashlineNote<T extends { content?: Array<{ type: string; text?: string }> }>(result: T, stripped: boolean): T {
	if (!stripped || !result.content) return result;
	const firstText = result.content.find((item) => item.type === "text" && typeof item.text === "string");
	if (firstText) firstText.text += "\nNote: auto-stripped hashline display prefixes from content before writing.";
	return result;
}

const REMOTE_PYTHON_HELPER = String.raw`
import base64, json, os, stat, sys, tempfile

request = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
op = request["op"]

def reply(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))

def fail(message, code=1):
    sys.stderr.write(str(message) + "\n")
    sys.exit(code)

def require_file(path):
    if not os.path.exists(path):
        fail("ENOENT: " + path)
    if os.path.isdir(path):
        fail("Path is a directory: " + path)

def access_read(path):
    require_file(path)
    if not os.access(path, os.R_OK):
        fail("File is not readable: " + path)
    reply({"ok": True})

def access_edit(path):
    require_file(path)
    if not os.access(path, os.R_OK | os.W_OK):
        fail("File is not readable and writable: " + path)
    reply({"ok": True})

def read_file(path):
    require_file(path)
    with open(path, "rb") as f:
        reply({"data": base64.b64encode(f.read()).decode("ascii")})

def read_prefix(path):
    if not os.path.exists(path):
        reply({"exists": False, "data": ""})
        return
    if os.path.isdir(path):
        fail("Path is a directory: " + path)
    with open(path, "rb") as f:
        reply({"exists": True, "data": base64.b64encode(f.read(int(request.get("bytes", 1024)))).decode("ascii")})

def mkdir(path):
    os.makedirs(path, exist_ok=True)
    reply({"ok": True})

def write_file(path):
    data = base64.b64decode(request["content"])
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    if os.path.islink(path):
        with open(path, "wb") as f:
            f.write(data)
        reply({"ok": True, "atomic": False})
        return
    existing_mode = None
    if os.path.exists(path):
        existing_mode = stat.S_IMODE(os.stat(path).st_mode)
    fd = None
    tmp = None
    try:
        for _ in range(100):
            tmp = os.path.join(parent, ".pi-remote-ssh-" + next(tempfile._get_candidate_names()) + ".tmp")
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
                break
            except FileExistsError:
                continue
        if fd is None:
            fail("Could not create temporary file in " + parent)
        with os.fdopen(fd, "wb") as f:
            fd = None
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if existing_mode is not None:
            os.chmod(tmp, existing_mode)
        os.replace(tmp, path)
        reply({"ok": True, "atomic": True})
    finally:
        if fd is not None:
            os.close(fd)
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass

def stat_is_dir(path):
    if not os.path.exists(path):
        reply({"exists": False, "is_dir": False})
        return
    reply({"exists": True, "is_dir": os.path.isdir(path)})

def list_dir(path):
    if not os.path.exists(path):
        fail("ENOENT: " + path)
    if not os.path.isdir(path):
        fail("Not a directory: " + path)
    reply({"entries": os.listdir(path)})

def glob_files(path):
    import fnmatch
    pattern = request.get("pattern", "*")
    limit = int(request.get("limit", 1000))
    ignore = request.get("ignore", [])
    results = []
    if not os.path.exists(path):
        fail("ENOENT: " + path)
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
        names = files + dirs
        for name in names:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, path).replace(os.sep, "/")
            if any(fnmatch.fnmatch(rel, pat) for pat in ignore):
                continue
            target = rel + ("/" if os.path.isdir(full) else "")
            if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(target, pattern):
                results.append(full)
                if len(results) >= limit:
                    reply({"paths": results})
                    return
    reply({"paths": results})

def grep_files(path):
    import fnmatch, re
    pattern = request.get("pattern", "")
    file_glob = request.get("glob")
    ignore_case = bool(request.get("ignoreCase", False))
    literal = bool(request.get("literal", False))
    context = max(0, int(request.get("context", 0) or 0))
    limit = max(1, int(request.get("limit", 100) or 100))
    if not os.path.exists(path):
        fail("ENOENT: " + path)
    flags = re.IGNORECASE if ignore_case else 0
    regex = None if literal else re.compile(pattern, flags)
    def matches(text):
        if literal:
            return pattern.lower() in text.lower() if ignore_case else pattern in text
        return regex.search(text) is not None
    roots = []
    if os.path.isdir(path):
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, path).replace(os.sep, "/")
                if file_glob and not fnmatch.fnmatch(rel, file_glob):
                    continue
                roots.append((full, rel))
    else:
        roots.append((path, os.path.basename(path)))
    output = []
    match_count = 0
    limit_reached = False
    for full, rel in roots:
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                lines = f.read().replace("\r\n", "\n").replace("\r", "\n").split("\n")
        except Exception:
            continue
        for idx, line in enumerate(lines, start=1):
            if not matches(line):
                continue
            match_count += 1
            start = max(1, idx - context) if context else idx
            end = min(len(lines), idx + context) if context else idx
            for current in range(start, end + 1):
                sep = ":" if current == idx else "-"
                output.append(f"{rel}{sep}{current}{sep} {lines[current - 1]}")
            if match_count >= limit:
                limit_reached = True
                reply({"output": "\n".join(output), "matchLimitReached": limit if limit_reached else None})
                return
    reply({"output": "\n".join(output), "matchLimitReached": limit if limit_reached else None})

try:
    path = request.get("path")
    if op == "access_read": access_read(path)
    elif op == "access_edit": access_edit(path)
    elif op == "read_file": read_file(path)
    elif op == "read_prefix": read_prefix(path)
    elif op == "mkdir": mkdir(path)
    elif op == "write_file": write_file(path)
    elif op == "stat_is_dir": stat_is_dir(path)
    elif op == "list_dir": list_dir(path)
    elif op == "glob_files": glob_files(path)
    elif op == "grep_files": grep_files(path)
    else: fail("Unknown remote helper operation: " + op)
except Exception as exc:
    fail(str(exc))
`;
