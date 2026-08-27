import { describe, expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent } from "@mariozechner/pi-coding-agent";
import { Box, Container, Text } from "@mariozechner/pi-tui";
import remoteSshExtension from "../src/index.js";
import { installToolOutputVisibility, withCompactHiddenResult } from "../src/tool-output-visibility.js";

initTheme("dark", false);

const ui = { requestRender() {} } as never;

describe("remote tool output visibility", () => {
	test("expanded compact tools restore the wrapped definition's host-owned shell", () => {
		installToolOutputVisibility();
		const definition = withCompactHiddenResult({
			name: "edit",
			label: "edit",
			description: "test tool",
			parameters: {},
			renderShell: "default" as const,
			renderCall: () => new Text("call", 0, 0),
			renderResult: () => new Text("result", 0, 0),
			execute: async () => ({ content: [{ type: "text" as const, text: "result" }] }),
		});
		const component = new ToolExecutionComponent("edit", "id", { session: "box", path: "file.txt" }, {}, definition as never, ui, process.cwd());

		component.setExpanded(true);

		expect(component.children.some((child) => child instanceof Box)).toBe(true);
	});

	test("registered read-like tools use compact self rendering and the host shell when expanded", () => {
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

			expect(component.children.some((child) => child instanceof Box)).toBe(false);
			expect(component.render(120).join("\n")).toContain("session: lab/pi");

			component.setExpanded(true);

			expect(component.children.some((child) => child instanceof Box)).toBe(true);
			expect(component.render(120).join("\n")).toContain("session: lab/pi");
		}
	});

	test("wrapped read results survive expand collapse expand transitions", () => {
		const definitions = new Map<string, any>();
		remoteSshExtension({ registerTool: (definition: any) => definitions.set(definition.name, definition) } as never);
		const component = new ToolExecutionComponent("read", "read-id", { session: "lab/pi", path: "remote.txt" }, {}, definitions.get("read"), ui, process.cwd());
		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "remote result body" }] } as never);

		expect(component.children.some((child) => child instanceof Box)).toBe(false);
		expect(component.render(120).join("\n")).not.toContain("remote result body");

		component.setExpanded(true);
		expect(component.children.some((child) => child instanceof Box)).toBe(true);
		expect(component.render(120).join("\n")).toContain("remote result body");

		component.setExpanded(false);
		expect(component.children.some((child) => child instanceof Box)).toBe(false);
		expect(component.render(120).join("\n")).not.toContain("remote result body");

		component.setExpanded(true);
		expect(component.children.some((child) => child instanceof Box)).toBe(true);
		expect(component.render(120).join("\n")).toContain("remote result body");
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
