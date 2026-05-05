export function renderArgsWithRemotePath<T extends { session?: string; path?: string }>(args: T, fallbackPath = "."): T {
	if (args.session === undefined) return args;
	return { ...args, path: `${args.path ?? fallbackPath} [session: ${args.session}]` };
}

export function renderArgsWithRemoteCommand<T extends { session?: string; command?: string }>(args: T): T {
	if (args.session === undefined) return args;
	return { ...args, command: `session=${args.session} ${args.command ?? ""}` };
}
