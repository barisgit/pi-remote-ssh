import {
	ToolExecutionComponent,
	keyHint,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@mariozechner/pi-tui";
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

type ContainerPatched = Container & Record<PropertyKey, any>;
type ToolExecutionComponentPatched = Record<PropertyKey, any>;

const FALLBACK_PREVIEW_PATCH_KEY = Symbol.for("pi.toolOutputVisibility.fallbackPreviewPatched");
const DYNAMIC_EXPANDED_SHELL_PATCH_KEY = Symbol.for("pi.toolOutputVisibility.dynamicExpandedShellPatched");
const DYNAMIC_EXPANDED_SHELL_PATCH_VERSION = 4;
const DYNAMIC_EXPANDED_SHELL_KEY = Symbol.for("pi.toolOutputVisibility.dynamicExpandedShell");
const COMPACT_PARENT_KEY = Symbol.for("pi.toolOutputVisibility.compactParent");
const COMPACT_BLOCK_SPACER_KEY = Symbol.for("pi.toolOutputVisibility.compactBlockSpacer");
const ORIGINAL_ADD_CHILD_KEY = Symbol.for("pi.toolOutputVisibility.originalAddChild");
const ORIGINAL_GET_TEXT_OUTPUT_KEY = Symbol.for("pi.toolOutputVisibility.originalGetTextOutput");
const ORIGINAL_GET_RENDER_SHELL_KEY = Symbol.for("pi.toolOutputVisibility.originalGetRenderShell");
const ORIGINAL_UPDATE_DISPLAY_KEY = Symbol.for("pi.toolOutputVisibility.originalUpdateDisplay");

const COLLAPSED_PREVIEW_HEAD_LINES = 12;
const COLLAPSED_PREVIEW_TAIL_LINES = 12;
const COLLAPSED_PREVIEW_PARTIAL_LINES = 25;
const HIDDEN_XML_TAGS = ["dcp-id", "dcp-owner"];

export function installToolOutputVisibility() {
	patchContainerParents();
	patchGenericFallbackPreview();
	patchDynamicExpandedShell();
}

export function withCompactHiddenResult<TDefinition>(definition: TDefinition): TDefinition {
	const tool = definition as ToolDefinition<any, any, any>;
	return {
		...tool,
		[DYNAMIC_EXPANDED_SHELL_KEY]: true,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (context.expanded) {
				return tool.renderCall?.(args, theme, context) ?? ((context.lastComponent as Text | undefined) ?? new Text("", 0, 0));
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const isRunning = context.executionStarted && context.isPartial;
			const showExpandHint = context.argsComplete && !context.isPartial && !context.expanded;
			let line = compactCallText(tool.name, (args ?? {}) as Record<string, unknown>, theme as ThemeLike, isRunning);

			if (showExpandHint) line += ` ${expandHintText(theme as ThemeLike)}`;
			text.setText(line);
			return text;
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			const sanitizedResult = sanitizeToolResultPayload(result);
			if (options.expanded) {
				return tool.renderResult?.(sanitizedResult, options, theme, context) ?? new Container();
			}

			if (options.isPartial) {
				return new Text(theme.fg("dim", "…"), 0, 0);
			}

			if (context.isError) {
				return tool.renderResult?.(sanitizedResult, options, theme, context) ?? new Text(theme.fg("error", "failed"), 0, 0);
			}

			return new Container();
		},
	} as TDefinition;
}

function createCompactBlockSpacer() {
	const spacer = new Spacer(1) as Spacer & { [COMPACT_BLOCK_SPACER_KEY]?: true };
	spacer[COMPACT_BLOCK_SPACER_KEY] = true;
	return spacer;
}

function truncate(value: string, max = 48) {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
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
	const state = globalThis as typeof globalThis & { [FALLBACK_PREVIEW_PATCH_KEY]?: boolean };
	if (state[FALLBACK_PREVIEW_PATCH_KEY]) return;

	const prototype = ToolExecutionComponent.prototype as ToolExecutionComponentPatched;
	if (prototype[ORIGINAL_GET_TEXT_OUTPUT_KEY]) {
		state[FALLBACK_PREVIEW_PATCH_KEY] = true;
		return;
	}

	prototype[ORIGINAL_GET_TEXT_OUTPUT_KEY] = prototype.getTextOutput;
	prototype.getTextOutput = function patchedGetTextOutput(this: ToolExecutionComponentPatched) {
		const output = prototype[ORIGINAL_GET_TEXT_OUTPUT_KEY]?.call(this) ?? "";
		return collapseFallbackOutput(output, Boolean(this.expanded), Boolean(this.isPartial));
	};

	state[FALLBACK_PREVIEW_PATCH_KEY] = true;
}

function hasDynamicExpandedShell(component: ToolExecutionComponentPatched) {
	return Boolean(component.toolDefinition?.[DYNAMIC_EXPANDED_SHELL_KEY]);
}

function patchContainerParents() {
	const prototype = Container.prototype as ContainerPatched;
	if (!prototype[ORIGINAL_ADD_CHILD_KEY]) {
		prototype[ORIGINAL_ADD_CHILD_KEY] = prototype.addChild;
	}

	prototype.addChild = function patchedAddChild(this: ContainerPatched, child: Component) {
		(child as Component & { [COMPACT_PARENT_KEY]?: ContainerPatched })[COMPACT_PARENT_KEY] = this;
		return prototype[ORIGINAL_ADD_CHILD_KEY]?.call(this, child);
	};
}

function isCompactToolComponent(child: unknown): child is ToolExecutionComponentPatched {
	return child instanceof ToolExecutionComponent && hasDynamicExpandedShell(child as ToolExecutionComponentPatched);
}

function startsCompactToolBlock(component: ToolExecutionComponentPatched) {
	const siblings = component[COMPACT_PARENT_KEY]?.children ?? [];
	const index = siblings.indexOf(component);
	if (index <= 0) return true;
	return !isCompactToolComponent(siblings[index - 1]);
}

function syncDynamicShellContainer(component: ToolExecutionComponentPatched) {
	const renderShell = component.getRenderShell();
	const desired = renderShell === "self" ? component.selfRenderContainer : component.contentBox;
	if (!desired) return;

	const imageComponents = component.imageComponents ?? [];
	if (renderShell === "self") {
		component.children = startsCompactToolBlock(component) ? [createCompactBlockSpacer(), desired, ...imageComponents] : [desired, ...imageComponents];
		return;
	}

	const withoutShells = component.children.filter((child: unknown) => child !== component.selfRenderContainer && child !== component.contentBox);
	if (withoutShells.length === 0) {
		component.children = [desired];
		return;
	}

	component.children = [withoutShells[0], desired, ...withoutShells.slice(1)];
}

function patchDynamicExpandedShell() {
	const state = globalThis as typeof globalThis & { [DYNAMIC_EXPANDED_SHELL_PATCH_KEY]?: boolean | number };
	if (state[DYNAMIC_EXPANDED_SHELL_PATCH_KEY] === DYNAMIC_EXPANDED_SHELL_PATCH_VERSION) return;

	const prototype = ToolExecutionComponent.prototype as ToolExecutionComponentPatched;
	if (!prototype[ORIGINAL_GET_RENDER_SHELL_KEY]) {
		prototype[ORIGINAL_GET_RENDER_SHELL_KEY] = prototype.getRenderShell;
	}
	prototype.getRenderShell = function patchedGetRenderShell(this: ToolExecutionComponentPatched) {
		if (!hasDynamicExpandedShell(this)) {
			return prototype[ORIGINAL_GET_RENDER_SHELL_KEY]?.call(this) ?? "default";
		}

		if (this.expanded) {
			return this.builtInToolDefinition?.renderShell ?? "default";
		}

		return "self";
	};

	if (!prototype[ORIGINAL_UPDATE_DISPLAY_KEY]) {
		prototype[ORIGINAL_UPDATE_DISPLAY_KEY] = prototype.updateDisplay;
	}
	prototype.updateDisplay = function patchedUpdateDisplay(this: ToolExecutionComponentPatched) {
		if (hasDynamicExpandedShell(this)) syncDynamicShellContainer(this);
		const result = prototype[ORIGINAL_UPDATE_DISPLAY_KEY]?.call(this);
		if (hasDynamicExpandedShell(this)) syncDynamicShellContainer(this);
		return result;
	};

	state[DYNAMIC_EXPANDED_SHELL_PATCH_KEY] = DYNAMIC_EXPANDED_SHELL_PATCH_VERSION;
}

function formatPath(value: unknown) {
	if (typeof value !== "string" || value.length === 0) return ".";
	if (!isAbsolute(value)) return truncate(value);

	const rel = relative(process.cwd(), value);
	return truncate(rel && !rel.startsWith("..") ? rel || "." : value);
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

function formatLineRange(args: Record<string, unknown>) {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return undefined;

	const start = offset ?? 1;
	const end = limit !== undefined ? start + limit - 1 : undefined;
	return end !== undefined ? `${start}-${end}` : `${start}`;
}

function sessionMeta(args: Record<string, unknown>) {
	return typeof args.session === "string" && args.session.length > 0 ? `session: ${truncate(args.session, 36)}` : "";
}

function compactCallText(name: string, args: Record<string, unknown>, theme: ThemeLike, isRunning = false) {
	const icon = isRunning ? "running" : "pending";
	const session = sessionMeta(args);

	switch (name) {
		case "read": {
			const path = formatPath(args.file_path ?? args.path);
			const range = formatLineRange(args);
			return renderStatusLine({ icon, title: "Read", description: path, meta: [range ?? "", session] }, theme);
		}
		case "grep": {
			const pattern = typeof args.pattern === "string" && args.pattern ? truncate(args.pattern, 36) : "…";
			const meta = [typeof args.path === "string" && args.path ? formatPath(args.path) : "", typeof args.glob === "string" && args.glob ? truncate(args.glob, 20) : "", typeof args.limit === "number" ? String(args.limit) : "", session].filter(Boolean);
			return renderStatusLine({ icon, title: "Grep", description: JSON.stringify(pattern), meta }, theme);
		}
		case "find": {
			const pattern = typeof args.pattern === "string" && args.pattern ? truncate(args.pattern, 40) : "…";
			const meta = [typeof args.limit === "number" ? String(args.limit) : "", session].filter(Boolean);
			return renderStatusLine({ icon, title: "Find", description: pattern, meta }, theme);
		}
		case "ls": {
			const path = formatPath(args.path);
			const limit = typeof args.limit === "number" ? String(args.limit) : undefined;
			return renderStatusLine({ icon, title: "Ls", description: path, meta: [limit ?? "", session] }, theme);
		}
		default:
			return renderStatusLine({ icon, title: theme.bold(name) }, theme);
	}
}

function expandHintText(theme: ThemeLike) {
	const expandHint = keyHint("app.tools.expand", "expand");
	const left = theme.format?.bracketLeft ?? "[";
	const right = theme.format?.bracketRight ?? "]";
	return theme.fg("dim", `${left}${expandHint}${right}`);
}
