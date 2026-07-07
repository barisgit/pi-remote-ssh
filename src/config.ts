import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const REMOTE_SSH_STATE_ENV = "PI_REMOTE_SSH_STATE_DIR";
export const REMOTE_SSH_SOCKET_ENV = "PI_REMOTE_SSH_SOCKET_DIR";

export function getPiConfigDir(): string {
	const agentDir = getAgentDir();
	if (agentDir.endsWith("/agent") || agentDir.endsWith("\\agent")) {
		return dirname(agentDir);
	}
	return join(homedir(), ".pi");
}

export function getRemoteSshStateDir(): string {
	return process.env[REMOTE_SSH_STATE_ENV] ?? join(getPiConfigDir(), "remote-ssh");
}

export function getRemoteSshSocketDir(stateDir = getRemoteSshStateDir()): string {
	const configured = process.env[REMOTE_SSH_SOCKET_ENV];
	if (configured !== undefined && configured.length > 0) return configured;
	const stateHash = createHash("sha256").update(stateDir).digest("hex").slice(0, 8);
	return join(tmpdir(), "prs", stateHash);
}
