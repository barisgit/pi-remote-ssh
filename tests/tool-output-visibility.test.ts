import { describe, expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import remoteSshExtension from "../src/index.ts";
import { installToolOutputVisibility, withCompactHiddenResult } from "../src/tool-output-visibility.ts";

const nativeGetRenderShell = (ToolExecutionComponent.prototype as any).getRenderShell;
const nativeUpdateDisplay = (ToolExecutionComponent.prototype as any).updateDisplay;
const nativeAddChild = Container.prototype.addChild;

initTheme("dark", false);

const ui = { requestRender() {} } as never;

describe("remote tool output visibility", () => {
	test("visibility uses native shell selection, display updates and container composition", () => {
		installToolOutputVisibility();
		expect((ToolExecutionComponent.prototype as any).getRenderShell).toBe(nativeGetRenderShell);
		expect((ToolExecutionComponent.prototype as any).updateDisplay).toBe(nativeUpdateDisplay);
		expect(Container.prototype.addChild).toBe(nativeAddChild);
	});

	test("expanded self framing matches the native box across status, width and padding", () => {
		installToolOutputVisibility();
		const tool = {
			name: "read", label: "read", description: "test tool", parameters: {},
			renderCall: () => new Text("call", 0, 0),
			renderResult: (result: any) => new Text(result.content[0].text, 0, 0),
			execute: async () => ({ content: [{ type: "text" as const, text: "result" }] }),
		};
		for (const outputPad of [0, 1, 3]) {
			const native = new ToolExecutionComponent("read", "native", {}, { outputPad }, tool as never, ui, process.cwd());
			const compact = new ToolExecutionComponent("read", "compact", {}, { outputPad }, withCompactHiddenResult(tool) as never, ui, process.cwd());
			native.setExpanded(true);
			compact.setExpanded(true);
			for (const result of [undefined, { content: [{ type: "text", text: "working" }] }, { content: [{ type: "text", text: "done" }] }, { content: [{ type: "text", text: "failed" }], isError: true }]) {
				if (result) {
					native.updateResult(result as never, result.content[0]!.text === "working");
					compact.updateResult(result as never, result.content[0]!.text === "working");
				}
				for (const width of [40, 120]) expect(compact.render(width)).toEqual(native.render(width));
			}
		}
	});

	test("expanded frames isolate calls and preserve each renderer's last component", () => {
		const tool = withCompactHiddenResult({
			name: "read", label: "read", description: "test tool", parameters: {},
			renderCall: (_args: unknown, _theme: unknown, context: { lastComponent?: Text }) => {
				const component = context.lastComponent ?? new Text("call", 0, 0);
				expect(component).toBeInstanceOf(Text);
				return component;
			},
			renderResult: (result: any, _options: unknown, _theme: unknown, context: { lastComponent?: Text }) => {
				const component = context.lastComponent ?? new Text("", 0, 0);
				expect(component).toBeInstanceOf(Text);
				component.setText(result.content[0].text);
				return component;
			},
		});
		const first = new ToolExecutionComponent("read", "first", {}, {}, tool as never, ui, process.cwd());
		const second = new ToolExecutionComponent("read", "second", {}, {}, tool as never, ui, process.cwd());
		first.setExpanded(true);
		second.setExpanded(true);
		first.updateResult({ content: [{ type: "text", text: "first body" }] } as never);
		second.updateResult({ content: [{ type: "text", text: "second body" }] } as never);
		first.setOutputPad(3);
		expect(first.render(80).join("\n")).toContain("first body");
		expect(first.render(80).join("\n")).not.toContain("second body");
		expect(second.render(80).join("\n")).toContain("second body");
	});

	test("registered read-like tools use compact self rendering and native-looking framing when expanded", () => {
		const definitions = new Map<string, any>();
		remoteSshExtension({ registerTool: (definition: any) => definitions.set(definition.name, definition) } as never);

		for (const name of ["read", "ls", "grep", "find"]) {
			const args = name === "grep"
				? { session: "lab/pi", path: "src", pattern: "needle" }
				: name === "find"
					? { session: "lab/pi", path: "src", pattern: "*.ts" }
					: { session: "lab/pi", path: "src" };
			const component = new ToolExecutionComponent(name, `${name}-id`, args, {}, definitions.get(name), ui, process.cwd());
			component.setArgsComplete();

			expect(component.render(120).join("\n")).toContain("session: lab/pi");
			for (const width of [40, 120]) {
				const lines = component.render(width).map((line) => Bun.stripANSI(line)).filter((line) => line.trim());
				expect(lines).toHaveLength(1);
				expect(lines[0]).toMatch(/^ \S/);
				expect(lines[0]).toEndWith(" ");
				expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
			}

			component.setExpanded(true);

			expect(component.render(120).join("\n")).toContain("session: lab/pi");
		}
	});

	test("wrapped read results survive expand collapse expand transitions", () => {
		const definitions = new Map<string, any>();
		remoteSshExtension({ registerTool: (definition: any) => definitions.set(definition.name, definition) } as never);
		const component = new ToolExecutionComponent("read", "read-id", { session: "lab/pi", path: "remote.txt" }, {}, definitions.get("read"), ui, process.cwd());
		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "remote result body" }] } as never);

		expect(component.render(120).join("\n")).not.toContain("remote result body");

		component.setExpanded(true);
		expect(component.render(120).join("\n")).toContain("remote result body");

		component.setExpanded(false);
		expect(component.render(120).join("\n")).not.toContain("remote result body");

		component.setExpanded(true);
		expect(component.render(120).join("\n")).toContain("remote result body");
	});

	test("generic fallback keeps head/tail previews and hides DCP tags", () => {
		installToolOutputVisibility();
		const component = new ToolExecutionComponent("unregistered", "fallback", {}, {}, undefined, ui, process.cwd());
		const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n<dcp-id>private</dcp-id>\n<dcp-system-reminder>remember</dcp-system-reminder>";
		component.updateResult({ content: [{ type: "text", text }] } as never);
		const output = (component as any).getTextOutput();
		expect(output).toContain("line 1\nline 2");
		expect(output).toContain("more lines");
		expect(output).toContain("line 40");
		expect(output).toContain("> DCP reminder\n> remember");
		expect(output).not.toContain("private");
		component.setExpanded(true);
		expect((component as any).getTextOutput()).toContain("line 20");
		expect((component as any).getTextOutput()).not.toContain("dcp-id");
	});

	test("installing visibility repeatedly preserves the active component patches", () => {
		installToolOutputVisibility();
		const prototype = ToolExecutionComponent.prototype as any;
		const componentMethods = {
			getRenderShell: prototype.getRenderShell,
			updateDisplay: prototype.updateDisplay,
			getTextOutput: prototype.getTextOutput,
		};
		const containerAddChild = Container.prototype.addChild;

		installToolOutputVisibility();

		expect(prototype.getRenderShell).toBe(componentMethods.getRenderShell);
		expect(prototype.updateDisplay).toBe(componentMethods.updateDisplay);
		expect(prototype.getTextOutput).toBe(componentMethods.getTextOutput);
		expect(Container.prototype.addChild).toBe(containerAddChild);
	});
});
