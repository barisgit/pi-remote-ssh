const SESSION_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SHELL_SYNTAX_PATTERN = /[\s;&|<>`$(){}[\]\\'\"\n\r\t]/;
const TARGET_LIKE_PATTERN = /^(?:[^@\s]+@)?[^@\s:]+:[^\s]+$|^[^@\s]+@[^@\s]+$/;
const BLOCKED_SHORT_OPTIONS = new Set(["-S", "-M", "-O", "-N", "-f"]);
const OPTIONS_WITH_VALUE = new Set([
	"-B",
	"-b",
	"-c",
	"-D",
	"-E",
	"-e",
	"-F",
	"-I",
	"-i",
	"-J",
	"-L",
	"-l",
	"-m",
	"-o",
	"-p",
	"-Q",
	"-R",
	"-W",
	"-w",
]);
const CONTROL_OPTION_KEYS = new Set(["controlmaster", "controlpath", "controlpersist", "remotecommand"]);

export function assertValidSessionPath(path: string): void {
	if (typeof path !== "string" || path.length === 0) {
		throw new Error("Session path is required.");
	}
	if (path.startsWith("/") || path.includes("\\") || path.includes("~")) {
		throw new Error(`Invalid session path "${path}": use slash-separated [a-zA-Z0-9._-] segments, not absolute paths, '~', or backslashes.`);
	}
	if (/\p{C}/u.test(path)) {
		throw new Error(`Invalid session path "${path}": control characters are not allowed.`);
	}
	const segments = path.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === ".." || segment === ".")) {
		throw new Error(`Invalid session path "${path}": empty, '.', and '..' segments are not allowed.`);
	}
	for (const segment of segments) {
		if (!SESSION_SEGMENT_PATTERN.test(segment)) {
			throw new Error(`Invalid session path "${path}": segment "${segment}" must match [a-zA-Z0-9._-]+.`);
		}
	}
}

export function assertValidRemoteCwd(remoteCwd: string | undefined): void {
	if (remoteCwd === undefined) return;
	if (typeof remoteCwd !== "string" || remoteCwd.length === 0 || !remoteCwd.startsWith("/")) {
		throw new Error("remote_cwd must be an absolute path on the remote host.");
	}
	if (/\p{C}/u.test(remoteCwd)) {
		throw new Error("remote_cwd must not contain control characters.");
	}
}

export function assertValidTarget(target: string): void {
	if (typeof target !== "string" || target.length === 0) {
		throw new Error("target is required.");
	}
	if (SHELL_SYNTAX_PATTERN.test(target)) {
		throw new Error("target must be a single SSH target token, not shell syntax.");
	}
}

export function assertValidPort(port: number | undefined): void {
	if (port === undefined) return;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error("port must be an integer from 1 to 65535.");
	}
}

export function assertValidSshArgs(sshArgs: string[] | undefined, port: number | undefined): void {
	if (sshArgs === undefined) return;
	if (!Array.isArray(sshArgs)) throw new Error("ssh_args must be an array of argument tokens.");

	let sawPortInArgs: string | undefined;
	for (let i = 0; i < sshArgs.length; i++) {
		const token = sshArgs[i];
		if (typeof token !== "string" || token.length === 0) {
			throw new Error("ssh_args must contain non-empty string tokens.");
		}
		if (/\p{C}/u.test(token) || SHELL_SYNTAX_PATTERN.test(token)) {
			throw new Error(`Invalid ssh_args token "${token}": shell syntax and whitespace are not allowed inside tokens.`);
		}
		if (token === "--") {
			throw new Error("ssh_args must not contain '--' or remote command separators.");
		}
		if (!token.startsWith("-")) {
			throw new Error(`Invalid ssh_args token "${token}": positional targets and remote commands are not allowed.`);
		}
		if (TARGET_LIKE_PATTERN.test(token)) {
			throw new Error(`Invalid ssh_args token "${token}": target-like positional arguments are not allowed.`);
		}

		const [optionName, inlineValue] = splitOptionAssignment(token);
		if (BLOCKED_SHORT_OPTIONS.has(optionName)) {
			throw new Error(`ssh_args option ${optionName} conflicts with extension-managed SSH control lifecycle.`);
		}
		if (optionName === "-p") {
			sawPortInArgs = inlineValue ?? sshArgs[i + 1];
		}
		if (optionName === "-o") {
			const value = inlineValue ?? sshArgs[i + 1];
			if (value === undefined) throw new Error("ssh_args option -o requires a value.");
			assertAllowedSshOption(value);
		}
		if (token.startsWith("-o") && token !== "-o") {
			assertAllowedSshOption(token.slice(2));
		}

		if (OPTIONS_WITH_VALUE.has(optionName) && inlineValue === undefined) {
			i += 1;
			if (i >= sshArgs.length) throw new Error(`ssh_args option ${optionName} requires a value.`);
			const value = sshArgs[i];
			if (typeof value !== "string" || value.length === 0) {
				throw new Error(`Invalid value for ssh_args option ${optionName}.`);
			}
			if (/\p{C}/u.test(value) || SHELL_SYNTAX_PATTERN.test(value)) {
				throw new Error(`Invalid value for ssh_args option ${optionName}: shell syntax and whitespace are not allowed inside tokens.`);
			}
		}
	}

	if (port !== undefined && sawPortInArgs !== undefined && String(port) !== sawPortInArgs) {
		throw new Error("Conflicting port values: use either port or matching ssh_args -p, not both.");
	}
}

function splitOptionAssignment(token: string): [string, string | undefined] {
	const equals = token.indexOf("=");
	if (equals === -1) return [token, undefined];
	return [token.slice(0, equals), token.slice(equals + 1)];
}

function assertAllowedSshOption(value: string): void {
	const key = value.split("=", 1)[0]?.toLowerCase();
	if (key && CONTROL_OPTION_KEYS.has(key)) {
		throw new Error(`ssh_args option -o ${key} conflicts with extension-managed SSH control lifecycle.`);
	}
}
