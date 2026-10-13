import {
	ToolExecutionComponent,
	keyHint,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isAbsolute, relative } from "node:path";

type ThemeLike = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	styledSymbol?: (name: string, color: string) => string;
	spinnerFrames?: string[];
	format?: { bracketLeft?: string; bracketRight?: string };
	sep?: { dot?: string };
};

type Status = "success" | "error" | "warning" | "info" | "pending" | "running" | "aborted";

type StatusLineOptions = {
	icon?: Status;
	spinnerFrame?: number;
	title: string;
	description?: string;
	meta?: string[];
};

type ToolExecutionComponentPatched = Record<PropertyKey, any>;

const COMPACT_HIDDEN_RESULT_KEY = Symbol.for("pi.toolOutputVisibility.compactHiddenResult");
const ORIGINAL_GET_TEXT_OUTPUT_KEY = Symbol.for("pi.toolOutputVisibility.originalGetTextOutput");

// Call and result renderers share one box, but retain their own lastComponent contracts.
type ExpandedFrame = { box: Box; call: Component; result: Component | undefined };

const COLLAPSED_PREVIEW_HEAD_LINES = 12;
const COLLAPSED_PREVIEW_TAIL_LINES = 12;
const COLLAPSED_PREVIEW_PARTIAL_LINES = 25;
const DEFAULT_COMPACT_WIDTH = 80;
const MIN_COMPACT_DESCRIPTION_WIDTH = 16;
const STATUS_PREFIX_WIDTH = 20;
const SESSION_META_MAX_WIDTH = 36;
const HIDDEN_XML_TAGS = ["dcp-id", "dcp-owner"];

/** Apply previews and DCP sanitization to every native text fallback, including renderer failures. */
export function installToolOutputVisibility() {
	patchGenericFallbackPreview();
}

/** Keep collapsed calls compact and draw Pi's native-style box when expanded. */
export function withCompactHiddenResult<TDefinition>(definition: TDefinition): TDefinition {
	const tool = definition as ToolDefinition<any, any, any>;
	const frames = new WeakMap<object, ExpandedFrame>();
	const wrapped: typeof tool = {
		...tool,
		renderShell: "self",
		renderCall(args, theme, context) {
			if (context.expanded) {
				const previous = frames.get(context.state);
				const lastComponent = previous?.call ?? (context.lastComponent instanceof DynamicCompactCallText ? undefined : context.lastComponent);
				const call = tool.renderCall?.(args, theme, { ...context, lastComponent }) ?? lastComponent ?? new Text("", 0, 0);
				if (tool.renderShell === "self") return call;

				const bg = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
				const box = new Box(context.outputPad, 1, (text) => theme.bg(bg, text));
				box.addChild(call);
				frames.set(context.state, { box, call, result: previous?.result });
				return box;
			}

			frames.delete(context.state);
			const compact = context.lastComponent instanceof DynamicCompactCallText ? context.lastComponent : new DynamicCompactCallText();
			compact.setState({
				name: tool.name,
				args: (args ?? {}) as Record<string, unknown>,
				theme: theme as ThemeLike,
				isRunning: context.executionStarted && context.isPartial,
				showExpandHint: context.argsComplete && !context.isPartial && !context.expanded,
			});
			return compact;
		},
		renderResult(result, options, theme, context) {
			const sanitizedResult = sanitizeToolResultPayload(result);
			if (options.expanded) {
				const frame = frames.get(context.state);
				const lastComponent = frame?.result ?? (isHiddenResult(context.lastComponent) ? undefined : context.lastComponent);
				const rendered = tool.renderResult?.(sanitizedResult, options, theme, { ...context, lastComponent }) ?? new Container();
				if (!frame) return rendered;

				// Pi invokes renderCall before renderResult on every update. Returning the
				// box from the call slot gives both slots one background and padding.
				frame.box.addChild(rendered);
				frame.result = rendered;
				return hiddenResult();
			}

			if (options.isPartial) {
				return new Text(theme.fg("dim", "…"), 0, 0);
			}

			if (context.isError) {
				return tool.renderResult?.(sanitizedResult, options, theme, context) ?? new Text(theme.fg("error", "failed"), 0, 0);
			}

			return hiddenResult();
		},
	};
	return wrapped as TDefinition;
}

function hiddenResult() {
	const hidden = new Container() as Container & { [COMPACT_HIDDEN_RESULT_KEY]: true };
	hidden[COMPACT_HIDDEN_RESULT_KEY] = true;
	return hidden;
}

function isHiddenResult(component: Component | undefined) {
	return Boolean((component as (Component & { [COMPACT_HIDDEN_RESULT_KEY]?: true }) | undefined)?.[COMPACT_HIDDEN_RESULT_KEY]);
}

function truncate(value: string, max = 48) {
	const width = Math.max(1, max);
	return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

type DynamicCompactCallState = {
	name: string;
	args: Record<string, unknown>;
	theme: ThemeLike;
	isRunning: boolean;
	showExpandHint: boolean;
};

class DynamicCompactCallText implements Component {
	private state: DynamicCompactCallState | undefined;

	setState(state: DynamicCompactCallState) {
		this.state = state;
	}

	render(width: number): string[] {
		if (!this.state) return [];

		const { name, args, theme, isRunning, showExpandHint } = this.state;
		const expandHint = showExpandHint ? ` ${expandHintText(theme)}` : "";
		const contentWidth = Math.max(0, width - 2);
		const callWidth = Math.max(1, contentWidth - visibleWidth(expandHint));
		const line = truncateToWidth(compactCallText(name, args, theme, isRunning, callWidth), callWidth, "");
		return [truncateToWidth(` ${truncateToWidth(`${line}${expandHint}`, contentWidth, "")} `, width, "")];
	}

	invalidate() {}
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
	return count === 1 ? singular : plural;
}

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatReminderBlock(body: string) {
	const lines = body
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));

	if (lines.length === 0) return "";
	return ["> DCP reminder", ...lines.map((line) => (line.length > 0 ? `> ${line}` : ">"))].join("\n");
}

function sanitizeToolOutput(text: string) {
	let clean = text.replace(/\n?[ \t]*<dcp-system-reminder(?:\s+[^>]*?)?>([\s\S]*?)<\/dcp-system-reminder>[ \t]*\n?/gi, (_match, body: string) => {
		const reminder = formatReminderBlock(body);
		return reminder ? `\n${reminder}\n` : "\n";
	});

	for (const tag of HIDDEN_XML_TAGS) {
		const name = escapeRegex(tag);
		const blockRe = new RegExp(`\\n?[ \\t]*<${name}(?:\\s+[^>]*?)?>[\\s\\S]*?<\\/${name}>[ \\t]*\\n?`, "gi");
		const selfClosingRe = new RegExp(`\\n?[ \\t]*<${name}(?:\\s+[^>]*?)?\/>[ \\t]*\\n?`, "gi");
		const tagLineRe = new RegExp(`\\n?[ \\t]*<\/?${name}(?:\\s+[^>]*?)?>[ \\t]*\\n?`, "gi");
		clean = clean.replace(blockRe, "\n").replace(selfClosingRe, "\n").replace(tagLineRe, "\n");
	}

	return clean.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function sanitizeToolResultPayload<T>(result: T): T {
	if (!result || typeof result !== "object") return result;
	const record = result as { content?: Array<{ type?: string; text?: string; thinking?: string }> };
	if (!Array.isArray(record.content)) return result;

	let changed = false;
	const content = record.content.map((part) => {
		if (part?.type === "text" && typeof part.text === "string") {
			const clean = sanitizeToolOutput(part.text);
			if (clean !== part.text) {
				changed = true;
				return { ...part, text: clean };
			}
		}
		if (part?.type === "thinking" && typeof part.thinking === "string") {
			const clean = sanitizeToolOutput(part.thinking);
			if (clean !== part.thinking) {
				changed = true;
				return { ...part, thinking: clean };
			}
		}
		return part;
	});

	return changed ? ({ ...(result as object), content } as T) : result;
}

function collapseFallbackOutput(text: string, isExpanded: boolean, isPartial: boolean) {
	const sanitized = sanitizeToolOutput(text);
	if (!sanitized || isExpanded) return sanitized;

	const lines = sanitized.split("\n");
	if (isPartial) {
		if (lines.length <= COLLAPSED_PREVIEW_PARTIAL_LINES) return sanitized;
		const omitted = lines.length - COLLAPSED_PREVIEW_PARTIAL_LINES;
		return [`… ${omitted} earlier ${pluralize(omitted, "line")}`, ...lines.slice(-COLLAPSED_PREVIEW_PARTIAL_LINES)].join("\n");
	}

	const visible = COLLAPSED_PREVIEW_HEAD_LINES + COLLAPSED_PREVIEW_TAIL_LINES;
	if (lines.length <= visible) return sanitized;

	const omitted = lines.length - visible;
	return [...lines.slice(0, COLLAPSED_PREVIEW_HEAD_LINES), `… ${omitted} more ${pluralize(omitted, "line")} …`, ...lines.slice(-COLLAPSED_PREVIEW_TAIL_LINES)].join("\n");
}

function patchGenericFallbackPreview() {
	const prototype = ToolExecutionComponent.prototype as ToolExecutionComponentPatched;
	if (prototype[ORIGINAL_GET_TEXT_OUTPUT_KEY]) return;

	prototype[ORIGINAL_GET_TEXT_OUTPUT_KEY] = prototype.getTextOutput;
	prototype.getTextOutput = function patchedGetTextOutput(this: ToolExecutionComponentPatched) {
		const output = prototype[ORIGINAL_GET_TEXT_OUTPUT_KEY]?.call(this) ?? "";
		return collapseFallbackOutput(output, Boolean(this.expanded), Boolean(this.isPartial));
	};
}

function formatPath(value: unknown, max = 48) {
	if (typeof value !== "string" || value.length === 0) return ".";
	if (!isAbsolute(value)) return truncate(value, max);

	const rel = relative(process.cwd(), value);
	return truncate(rel && !rel.startsWith("..") ? rel || "." : value, max);
}

function formatStatusIcon(status: Status, theme: ThemeLike, spinnerFrame?: number) {
	switch (status) {
		case "success":
			return theme.styledSymbol?.("status.success", "success") ?? theme.fg("success", "✓");
		case "error":
			return theme.styledSymbol?.("status.error", "error") ?? theme.fg("error", "✗");
		case "warning":
			return theme.styledSymbol?.("status.warning", "warning") ?? theme.fg("warning", "!");
		case "info":
			return theme.styledSymbol?.("status.info", "accent") ?? theme.fg("accent", "i");
		case "pending":
			return theme.styledSymbol?.("status.pending", "muted") ?? theme.fg("muted", "○");
		case "running": {
			if (spinnerFrame !== undefined && theme.spinnerFrames && theme.spinnerFrames.length > 0) {
				return theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length];
			}
			return theme.styledSymbol?.("status.running", "accent") ?? theme.fg("accent", "●");
		}
		case "aborted":
			return theme.styledSymbol?.("status.aborted", "error") ?? theme.fg("error", "×");
	}
}

function renderStatusLine(options: StatusLineOptions, theme: ThemeLike) {
	const icon = options.icon ? formatStatusIcon(options.icon, theme, options.spinnerFrame) : "";
	const title = theme.fg("accent", options.title);
	let line = icon ? `${icon} ${title}` : title;

	if (options.description) {
		line += `: ${theme.fg("muted", options.description)}`;
	}

	const meta = options.meta?.filter((value) => value.trim().length > 0) ?? [];
	if (meta.length > 0) {
		line += ` ${theme.fg("dim", meta.join(theme.sep?.dot ?? " · "))}`;
	}

	return line;
}

function compactDescriptionBudget(width: number, meta: string[] = []) {
	const metaWidth = meta.filter(Boolean).reduce((sum, value) => sum + visibleWidth(value) + 3, 0);
	return Math.max(MIN_COMPACT_DESCRIPTION_WIDTH, width - metaWidth - STATUS_PREFIX_WIDTH);
}

function formatLineRange(args: Record<string, unknown>) {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return undefined;

	const start = offset ?? 1;
	const end = limit !== undefined ? start + limit - 1 : undefined;
	return end !== undefined ? `${start}-${end}` : `${start}`;
}

function sessionMeta(args: Record<string, unknown>) {
	return typeof args.session === "string" && args.session.length > 0 ? `session: ${truncate(args.session, SESSION_META_MAX_WIDTH)}` : "";
}

function compactCallText(name: string, args: Record<string, unknown>, theme: ThemeLike, isRunning = false, width = DEFAULT_COMPACT_WIDTH) {
	const icon = isRunning ? "running" : "pending";
	const session = sessionMeta(args);

	switch (name) {
		case "read":
			return renderReadCall(args, theme, icon, session, width);
		case "grep":
			return renderGrepCall(args, theme, icon, session, width);
		case "find":
			return renderFindCall(args, theme, icon, session, width);
		case "ls":
			return renderLsCall(args, theme, icon, session, width);
		default:
			return renderStatusLine({ icon, title: theme.bold(name) }, theme);
	}
}

function renderReadCall(args: Record<string, unknown>, theme: ThemeLike, icon: Status, session: string, width: number) {
	const range = formatLineRange(args);
	const meta = [range ?? "", session];
	const path = formatPath(args.file_path ?? args.path, compactDescriptionBudget(width, meta));
	return renderStatusLine({ icon, title: "Read", description: path, meta }, theme);
}

function renderGrepCall(args: Record<string, unknown>, theme: ThemeLike, icon: Status, session: string, width: number) {
	const pathBudget = Math.floor(compactDescriptionBudget(width) / 2);
	const path = typeof args.path === "string" && args.path ? formatPath(args.path, pathBudget) : "";
	const glob = typeof args.glob === "string" && args.glob ? truncate(args.glob, 20) : "";
	const limit = typeof args.limit === "number" ? String(args.limit) : "";
	const meta = [path, glob, limit, session].filter(Boolean);
	const pattern = typeof args.pattern === "string" && args.pattern ? truncate(args.pattern, compactDescriptionBudget(width, meta)) : "…";
	return renderStatusLine({ icon, title: "Grep", description: JSON.stringify(pattern), meta }, theme);
}

function renderFindCall(args: Record<string, unknown>, theme: ThemeLike, icon: Status, session: string, width: number) {
	const limit = typeof args.limit === "number" ? String(args.limit) : "";
	const meta = [limit, session].filter(Boolean);
	const pattern = typeof args.pattern === "string" && args.pattern ? truncate(args.pattern, compactDescriptionBudget(width, meta)) : "…";
	return renderStatusLine({ icon, title: "Find", description: pattern, meta }, theme);
}

function renderLsCall(args: Record<string, unknown>, theme: ThemeLike, icon: Status, session: string, width: number) {
	const limit = typeof args.limit === "number" ? String(args.limit) : undefined;
	const meta = [limit ?? "", session];
	const path = formatPath(args.path, compactDescriptionBudget(width, meta));
	return renderStatusLine({ icon, title: "Ls", description: path, meta }, theme);
}

function expandHintText(theme: ThemeLike) {
	const expandHint = keyHint("app.tools.expand", "expand");
	const left = theme.format?.bracketLeft ?? "[";
	const right = theme.format?.bracketRight ?? "]";
	return theme.fg("dim", `${left}${expandHint}${right}`);
}
