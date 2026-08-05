import { describe, expect, test } from "bun:test";
import { formatSessionTree, renderRemoteSshResult } from "../src/tool-render.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const render = (component: { render(width: number): string[] }) => component.render(120).map((line) => line.trimEnd()).join("\n");

describe("remote SSH tool rendering", () => {
	test("collapsed trees reveal small groups but summarize large groups", () => {
		const paths = [
			...Array.from({ length: 12 }, (_, index) => `paxia/algenbox/algenbox${index + 1}`),
			...Array.from({ length: 4 }, (_, index) => `paxia/paxense/paxense${index + 1}`),
			...Array.from({ length: 3 }, (_, index) => `personal-servers/server-${index + 1}`),
			...Array.from({ length: 4 }, (_, index) => `tm42/26-${String(index + 1).padStart(4, "0")}`),
		];

		expect(formatSessionTree(paths)).toBe([
			"23 SSH sessions",
			"├─ paxia/",
			"│  ├─ algenbox/ (12)",
			"│  └─ paxense/ (4)",
			"├─ personal-servers/",
			"│  ├─ server-1",
			"│  ├─ server-2",
			"│  └─ server-3",
			"└─ tm42/ (4)",
		].join("\n"));
	});

	test("expanded list results stay hierarchical and show every leaf with connection metadata", () => {
		const result = {
			content: [{ type: "text" as const, text: "flat raw output" }],
			details: {
				entries: [
					{ path: "lab/pi-1", targets: ["pi@one", "pi@one.local"], socket_status: "present" },
					{ path: "lab/pi-2", target: "pi@two", socket_status: "absent" },
				],
				view: "full",
			},
		};
		const component = renderRemoteSshResult("list", result, { expanded: true, isPartial: false }, theme, { args: {}, isError: false });
		expect(render(component)).toBe([
			"2 SSH sessions",
			"└─ lab/",
			"   ├─ pi-1 → pi@one → pi@one.local (present)",
			"   └─ pi-2 → pi@two (absent)",
		].join("\n"));
	});

	test("create and delete results have compact summaries and expanded details", () => {
		const created = { content: [{ type: "text" as const, text: "Created SSH session lab/pi (pi@host)." }], details: { sessions: [{ path: "lab/pi", targets: ["pi@host"] }] } };
		const deleted = { content: [{ type: "text" as const, text: "Deleted SSH session lab/pi." }], details: { sessions: [{ path: "lab/pi" }] } };
		expect(render(renderRemoteSshResult("create", created, { expanded: false, isPartial: false }, theme, { args: {}, isError: false }))).toBe("created lab/pi → pi@host");
		expect(render(renderRemoteSshResult("delete", deleted, { expanded: false, isPartial: false }, theme, { args: {}, isError: false }))).toBe("deleted lab/pi");
		expect(render(renderRemoteSshResult("create", created, { expanded: true, isPartial: false }, theme, { args: {}, isError: false }))).toContain("Created SSH session lab/pi");
	});
});
