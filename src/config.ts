import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const REMOTE_SSH_STATE_ENV = "PI_REMOTE_SSH_STATE_DIR";

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
