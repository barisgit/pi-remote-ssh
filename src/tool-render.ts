import { Text } from "@mariozechner/pi-tui";

type ToolKind = "create" | "list" | "delete";
type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type RenderOptions = { expanded: boolean; isPartial: boolean };
type RenderContext = { args?: Record<string, unknown>; isError?: boolean };
type TextPart = { type: "text"; text: string };
type ContentPart = { type: string; text?: string };
type ToolResult = { content: ContentPart[]; details?: unknown; isError?: boolean };
type Session = { path: string; target?: string; targets?: string[]; socket_status?: string; type?: "namespace" };

type TreeNode = { session?: Session; children: Map<string, TreeNode> };

const COLLAPSED_LEAF_GROUP_LIMIT = 3;
const COLLAPSED_TREE_LINE_LIMIT = 12;

export function renderRemoteSshCall(kind: ToolKind, args: Record<string, unknown>, theme: Theme) {
	let text = theme.fg("toolTitle", theme.bold("remote ssh"));
	text += ` ${theme.fg("accent", kind)}`;
	const subject = callSubject(kind, args);
	if (subject) text += ` ${theme.fg("muted", subject)}`;
	return new Text(text, 0, 0);
}

function renderSessionMeta(session: Session): string {
	const targets = session.targets?.join(" → ") ?? session.target;
	const status = session.socket_status ? ` (${session.socket_status})` : "";
	return `${targets ? ` → ${targets}` : ""}${status}`;
}

export function renderRemoteSshResult(kind: ToolKind, result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext) {
	if (options.isPartial) return new Text(theme.fg("dim", "working"), 0, 0);
	const raw = result.content.filter((part): part is TextPart => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
	const isError = context.isError || result.isError === true;
	if (isError) return new Text(theme.fg("error", compactLine(raw || "failed", 160)), 0, 0);
	const details = (result.details ?? {}) as { entries?: Session[]; sessions?: Session[]; session?: Session };
	if (kind === "list" && details.entries) {
		const entries = details.entries.filter((entry) => entry.type !== "namespace");
		return new Text(theme.fg("muted", formatSessionEntries(entries, options.expanded)), 0, 0);
	}
	if (options.expanded) return new Text(theme.fg("dim", raw), 0, 0);

	let summary: string;
	if (kind === "create") {
		summary = mutationSummary("created", details.sessions ?? (details.session ? [details.session] : []), raw, true);
	} else {
		summary = mutationSummary("deleted", details.sessions ?? (details.session ? [details.session] : []), raw, false);
	}
	return new Text(theme.fg("muted", summary), 0, 0);
}

export function formatSessionTree(paths: string[]): string {
	return formatSessionEntries(paths.map((path) => ({ path })), false);
}

function formatSessionEntries(entries: Session[], expanded: boolean): string {
	if (entries.length === 0) return "No SSH sessions found.";
	const root: TreeNode = { children: new Map() };
	for (const session of entries) {
		let node = root;
		for (const segment of session.path.split("/").filter(Boolean)) {
			let child = node.children.get(segment);
			if (!child) {
				child = { children: new Map() };
				node.children.set(segment, child);
			}
			node = child;
		}
		node.session = session;
	}
	const lines = [`${entries.length} SSH ${entries.length === 1 ? "session" : "sessions"}`];
	renderChildren(root, "", lines, expanded);
	if (!expanded && lines.length > COLLAPSED_TREE_LINE_LIMIT) {
		return [...lines.slice(0, COLLAPSED_TREE_LINE_LIMIT - 1), "… expand to view more"].join("\n");
	}
	return lines.join("\n");
}

function renderChildren(node: TreeNode, prefix: string, lines: string[], expanded: boolean) {
	const children = [...node.children.entries()];
	children.forEach(([name, child], index) => {
		const last = index === children.length - 1;
		const connector = last ? "└─ " : "├─ ";
		const descendants = countTerminals(child);
		const onlyLeafChildren = child.children.size > 0 && [...child.children.values()].every((entry) => entry.session && entry.children.size === 0);
		const isLeaf = child.session !== undefined && child.children.size === 0;
		if (isLeaf) {
			lines.push(`${prefix}${connector}${name}${expanded ? renderSessionMeta(child.session!) : ""}`);
			return;
		}
		if (onlyLeafChildren && !expanded && descendants > COLLAPSED_LEAF_GROUP_LIMIT) {
			lines.push(`${prefix}${connector}${name}/ (${descendants})`);
			return;
		}
		lines.push(`${prefix}${connector}${name}/`);
		renderChildren(child, `${prefix}${last ? "   " : "│  "}`, lines, expanded);
	});
}

function countTerminals(node: TreeNode): number {
	let count = node.session ? 1 : 0;
	for (const child of node.children.values()) count += countTerminals(child);
	return count;
}

function callSubject(kind: ToolKind, args: Record<string, unknown>): string {
	if (kind === "list") {
		const parts = [typeof args.prefix === "string" ? args.prefix : "all"];
		if (typeof args.depth === "number") parts.push(`depth ${args.depth}`);
		return parts.join(" · ");
	}
	const paths = Array.isArray(args.sessions)
		? args.sessions.map((session) => typeof session === "object" && session ? String((session as { path?: unknown }).path ?? "") : "").filter(Boolean)
		: Array.isArray(args.paths) ? args.paths.map(String) : typeof args.path === "string" ? [args.path] : [];
	return paths.length > 2 ? `${paths.length} sessions` : paths.join(", ");
}

function mutationSummary(verb: string, sessions: Session[], fallback: string, includeTarget: boolean): string {
	if (sessions.length === 0) return compactLine(fallback, 160);
	if (sessions.length > 1) return `${verb} ${sessions.length} sessions`;
	const session = sessions[0]!;
	if (!includeTarget) return `${verb} ${session.path}`;
	const targets = session.targets?.join(" → ") ?? session.target;
	return `${verb} ${session.path}${targets ? ` → ${targets}` : ""}`;
}

function compactLine(value: string, max: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1))}…`;
}
