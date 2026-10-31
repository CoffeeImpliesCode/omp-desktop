import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent, type ToolResultFrame } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";

describe("native streaming edit previews", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function createComponent(onRender: () => void): ToolExecutionComponent {
		const ui = { requestRender: onRender } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		return new ToolExecutionComponent(
			"edit",
			{ path: "/tmp/mod.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
			{},
			tool,
			ui,
			"/tmp",
		);
	}

	test("new batches replace the preview and empty batches retain it", () => {
		let renders = 0;
		const component = createComponent(() => renders++);
		try {
			component.updateStreamPreview({
				generation: 1,
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", firstChangedLine: 1 }],
			});
			const first = Bun.stripANSI(component.render(100).join("\n"));
			expect(first).toContain("const a = 2;");
			expect(renders).toBe(1);
			component.releaseRenderCaches();
			expect(Bun.stripANSI(component.render(100).join("\n"))).toBe(first);

			component.updateStreamPreview({ generation: 2, streaming: true, files: [] });
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("const a = 2;");
			expect(renders).toBe(1);

			component.updateStreamPreview({
				generation: 3,
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 3;", firstChangedLine: 1 }],
			});
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("const a = 3;");
			expect(renders).toBe(2);
		} finally {
			component.stopAnimation();
		}
	});

	test("terminal results reject late preview batches", () => {
		const component = createComponent(() => {});
		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "ok" }],
					details: { diff: "@@ -1 +1 @@\n-old\n+final", firstChangedLine: 1 },
				},
				false,
			);
			component.updateStreamPreview({
				generation: 4,
				streaming: false,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-old\n+late", firstChangedLine: 1 }],
			});
			const rendered = Bun.stripANSI(component.render(100).join("\n"));
			expect(rendered).toContain("final");
			expect(rendered).not.toContain("late");
		} finally {
			component.stopAnimation();
		}
	});

	const nativeContext: DescribeContext = {
		cols: 100,
		dark: true,
		reduceMotion: false,
		supports: () => true,
		feature: () => true,
	};

	const finalResults: {
		name: string;
		result: ToolResultFrame;
		expected?: string;
		nativeExpected?: string;
		absent?: string;
	}[] = [
		{
			name: "authoritative final diff",
			result: { content: [], details: { diff: "-1|old\n+1|FINAL_ONLY", firstChangedLine: 1 } },
			expected: "FINAL_ONLY",
			absent: "PREVIEW_ONLY",
		},
		{
			name: "authoritative no-op details",
			result: { content: [], details: { diff: "" } },
			absent: "PREVIEW_ONLY",
		},
		{
			name: "successful result without details",
			result: { content: [{ type: "text", text: "ok" }] },
			expected: "PREVIEW_ONLY",
		},
		{
			name: "successful result with classification-only details",
			result: { content: [], details: { errorKind: "unseen_lines" } },
			nativeExpected: "PREVIEW_ONLY",
		},
		{
			name: "error without details",
			result: { content: [{ type: "text", text: "REFUSED_ONLY" }], isError: true },
			expected: "REFUSED_ONLY",
			absent: "PREVIEW_ONLY",
		},
		{
			name: "error with classification-only details",
			result: {
				content: [{ type: "text", text: "REFUSED_ONLY" }],
				details: { diff: "", errorKind: "unseen_lines" },
				isError: true,
			},
			expected: "REFUSED_ONLY",
			absent: "PREVIEW_ONLY",
		},
	];
	for (const { name, result, expected, nativeExpected, absent } of finalResults) {
		test(`replays ${name} after releasing the streamed preview caches`, () => {
			const component = createComponent(() => {});
			try {
				component.updateStreamPreview({
					streaming: false,
					files: [{ path: "/tmp/mod.ts", diff: "-42|old\n+42|PREVIEW_ONLY", firstChangedLine: 42 }],
				});
				component.render(100);
				component.describe(nativeContext);
				component.updateResult(result);
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					const rows = component.render(100);
					const native = component.describe(nativeContext);
					const plain = Bun.stripANSI(rows.join("\n"));
					if (expected) expect(plain).toContain(expected);
					const expectedNative = nativeExpected ?? expected;
					if (expectedNative) expect(JSON.stringify(native)).toContain(expectedNative);
					if (absent) {
						expect(plain).not.toContain(absent);
						expect(JSON.stringify(native)).not.toContain(absent);
					}
					if (result.isError) expect(native.p).toMatchObject({ target: "/tmp/mod.ts:42" });
					component.releaseRenderCaches();
					expect(component.render(100)).toEqual(rows);
					expect(component.describe(nativeContext)).toEqual(native);
					const narrow = component.render(48);
					component.releaseRenderCaches();
					expect(component.render(48)).toEqual(narrow);
					if (result.isError) {
						component.updateResult(result);
						expect(component.describe(nativeContext).p).toMatchObject({ target: "/tmp/mod.ts:42" });
					}
				}
			} finally {
				component.stopAnimation();
			}
		});
	}
});
