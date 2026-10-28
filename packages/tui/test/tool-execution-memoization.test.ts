import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme, setTheme } from "@oh-my-pi/pi-tui/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { convertImageToPngShared } from "@oh-my-pi/pi-tui/chat/image-loading";
import { getNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";

/**
 * Contract under test (tool-result render memoization):
 *
 * `ToolExecutionComponent` shapes a tool result into UI components by calling
 * the tool's `renderResult` — an O(result-size) pass. A dirty-key guard at the
 * top of `#updateDisplay()` must collapse the result version, expand state,
 * partial flag, spinner frame, show-images flag, and theme epoch into one key
 * and skip `#rebuildDisplay()` when nothing meaningful changed. So:
 *
 *   - A flood of `invalidate()` calls (one per render frame) after a final
 *     result must re-shape EXACTLY ONCE, not once per frame — this is the
 *     regression guard against the per-frame re-shape stall.
 *   - A state change that actually alters output (`setExpanded(true)`) must
 *     force exactly one additional shaping pass, and the new output must be
 *     observable; a redundant no-op set of the same state must not re-shape.
 *   - Bumping the result version (a NEW result) must force exactly one more
 *     shaping pass, and the rendered output must reflect the new result.
 */
describe("ToolExecutionComponent tool-result render memoization", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A custom tool whose `renderResult` is the single O(result-size) shaping
	// function. It echoes the result text so the rendered frame reflects which
	// result was last shaped — letting us assert the memo never suppresses a
	// real change, only redundant repaints.
	function makeShapingTool() {
		return {
			name: "custom_render",
			label: "Custom",
			renderResult(result: { content: Array<{ type: string; text?: string }> }): Text {
				const joined = result.content.map(c => c.text ?? "").join("");
				return new Text(`shaped:${joined}`, 0, 0);
			},
		};
	}

	function finalResult(text: string) {
		return { content: [{ type: "text", text }] };
	}

	it("re-shapes once per meaningful change, never per invalidate() frame", () => {
		const tool = makeShapingTool();
		const shapeSpy = vi.spyOn(tool, "renderResult");
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"custom_render",
			{},
			{},
			tool as unknown as AgentTool,
			ui,
			process.cwd(),
		);

		// No result yet: the shaping pass has not run.
		expect(shapeSpy).toHaveBeenCalledTimes(0);

		// Phase 1 — a final (non-partial) result shapes exactly once, and a
		// flood of per-frame invalidate()s must NOT re-shape (the regression).
		component.updateResult(finalResult("ALPHA"), false);
		expect(shapeSpy).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 12; i++) component.invalidate();
		expect(shapeSpy).toHaveBeenCalledTimes(1);
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("shaped:ALPHA");

		// Phase 2 — a state change that alters output forces exactly one more
		// shaping pass; further invalidate()s and a redundant same-value set do
		// not, and the expanded frame is observable.
		component.setExpanded(true);
		expect(shapeSpy).toHaveBeenCalledTimes(2);
		for (let i = 0; i < 12; i++) component.invalidate();
		component.setExpanded(true);
		expect(shapeSpy).toHaveBeenCalledTimes(2);

		// Phase 3 — a NEW result (bumped version) forces exactly one more pass,
		// and the rendered output reflects the new result, not the stale one.
		component.updateResult(finalResult("BRAVO"), false);
		expect(shapeSpy).toHaveBeenCalledTimes(3);
		const frame = stripVTControlCharacters(component.render(80).join("\n"));
		expect(frame).toContain("shaped:BRAVO");
		expect(frame).not.toContain("shaped:ALPHA");
	});

	// Regression: the memo key must also cover streamed call-arg changes. The
	// dirty key folds in a display-input version bumped by updateArgs(), so a
	// new args object re-shapes the call preview instead of freezing it at the
	// first render (the bug: key omitted #args, so once the display was built
	// every streamed delta was swallowed by the guard).
	it("re-shapes the call preview when streamed args change, not only on key fields", () => {
		const tool = {
			name: "custom_render",
			label: "Custom",
			renderCall(args: { cmd?: string }): Text {
				return new Text(`call:${args?.cmd ?? ""}`, 0, 0);
			},
		};
		const callSpy = vi.spyOn(tool, "renderCall");
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"custom_render",
			{ cmd: "A" },
			{},
			tool as unknown as AgentTool,
			ui,
			process.cwd(),
		);

		// Constructor shaped the call preview once with the initial args.
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("call:A");
		const afterCtor = callSpy.mock.calls.length;

		// A flood of per-frame invalidate()s must NOT re-shape (memo still holds).
		for (let i = 0; i < 12; i++) component.invalidate();
		expect(callSpy.mock.calls.length).toBe(afterCtor);

		// A NEW args object (streamed delta) MUST re-shape and reflect the change,
		// even though no key field (result version, expanded, …) moved.
		component.updateArgs({ cmd: "B" });
		expect(callSpy.mock.calls.length).toBe(afterCtor + 1);
		const frame = stripVTControlCharacters(component.render(80).join("\n"));
		expect(frame).toContain("call:B");
		expect(frame).not.toContain("call:A");

		// A same-reference updateArgs is the documented no-op and must not re-shape.
		const sameArgs = { cmd: "C" };
		component.updateArgs(sameArgs);
		const afterReal = callSpy.mock.calls.length;
		component.updateArgs(sameArgs);
		expect(callSpy.mock.calls.length).toBe(afterReal);
	});
	// Regression: freezing a backgrounded task (seal()) flips #backgroundTaskFrozen,
	// which the render context consumes (context.frozen) — so it must be in the memo
	// key. The bug: the key omitted it, so once the display was built seal()'s
	// #updateDisplay() early-returned and the row stayed styled as live progress.
});

describe("ToolExecutionComponent released cache replay", () => {
	const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
	const nativeContext: DescribeContext = {
		cols: 80,
		dark: true,
		reduceMotion: false,
		supports: () => true,
		feature: () => true,
	};
	const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
	const originalProtocol = TERMINAL.imageProtocol;
	const components: ToolExecutionComponent[] = [];
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(async () => {
		for (const component of components) component.dispose();
		components.length = 0;
		terminal.imageProtocol = originalProtocol;
		vi.restoreAllMocks();
		await setTheme("dark");
	});

	function settled(name: string, custom = false): ToolExecutionComponent {
		const tool = custom
			? ({
					name,
					label: "Custom",
					renderCall: (args: { command: string }) => new Text(args.command, 0, 0),
					renderResult: (result: { content: { text?: string }[] }) =>
						new Text(result.content.map(block => block.text ?? "").join("\n"), 0, 0),
				} as unknown as AgentTool)
			: undefined;
		const component = new ToolExecutionComponent(name, { command: "printf REPLAY_COMMAND" }, {}, tool, ui);
		components.push(component);
		component.updateResult({
			content: Array.from({ length: 24 }, (_, index) => ({
				type: "text",
				text: `REPLAY_ROW_${index} with enough synthetic text to wrap in a narrow terminal.`,
			})),
		});
		return component;
	}

	for (const name of ["unknown_replay_tool", "bash", "eval", "custom_replay_tool"]) {
		it(`replays ${name} output at new widths, expansion states, and themes`, async () => {
			const component = settled(name, name === "custom_replay_tool");
			const twin = settled(name, name === "custom_replay_tool");
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				twin.setExpanded(expanded);
				const rows = component.render(80);
				const native = component.describe(nativeContext);
				component.releaseRenderCaches();
				expect(component.render(80)).toEqual(rows);
				expect(component.describe(nativeContext)).toEqual(native);
				expect(component.render(43)).toEqual(twin.render(43));
				expect(Bun.stripANSI(component.render(43).join("\n"))).toContain("REPLAY_ROW_");
			}
			component.releaseRenderCaches();
			expect((await setTheme("light")).success).toBe(true);
			component.invalidate();
			twin.invalidate();
			expect(component.render(43)).toEqual(twin.render(43));
			expect(component.describe({ ...nativeContext, dark: false })).toEqual(
				twin.describe({ ...nativeContext, dark: false }),
			);
		});
	}

	it("keeps a task snapshot's retry countdown and native ages stable during replay", () => {
		let now = 100_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const component = new ToolExecutionComponent("task", { task: "Synthetic retry assignment" }, {}, undefined, ui);
		components.push(component);
		component.updateResult({
			content: [],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [
					{
						index: 0,
						id: "ReplayAgent",
						agent: "task",
						agentSource: "bundled",
						status: "running",
						task: "Synthetic retry assignment",
						assignment: "Synthetic retry assignment",
						description: "Retry snapshot",
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						requests: 0,
						tokens: 0,
						cost: 0,
						durationMs: 0,
						retryState: {
							attempt: 1,
							maxAttempts: 3,
							startedAtMs: 90_000,
							delayMs: 60_000,
							errorMessage: "Synthetic provider retry",
						},
					},
				],
			},
		});
		const rows = component.render(100);
		const native = component.describe(nativeContext);
		expect(Bun.stripANSI(rows.join("\n"))).toContain("retrying 1/3");
		expect(JSON.stringify(native)).toContain("Synthetic provider retry");
		component.releaseRenderCaches();
		now += 30_000;
		expect(component.render(100)).toEqual(rows);
		expect(component.describe(nativeContext)).toEqual(native);
	});

	it("replays native image blobs and Kitty conversions without losing graphics placements", async () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const jpeg = await new Bun.Image(Buffer.from(png, "base64")).jpeg().toBase64();
		const image = { type: "image" as const, data: jpeg, mimeType: "image/jpeg" };
		await convertImageToPngShared(image);
		const budget = new ImageBudget(2);
		const component = new ToolExecutionComponent("unknown_image_tool", {}, {}, undefined, {
			...ui,
			imageBudget: budget,
		});
		components.push(component);
		component.updateResult({ content: [image] });

		function imageNode(node: NativeNode): NativeNode | undefined {
			if (node.k === "image") return node;
			for (const child of node.c ?? []) {
				if (!("k" in child)) continue;
				const found = imageNode(child);
				if (found) return found;
			}
			return undefined;
		}

		const rows = component.render(80);
		expect(rows.join("")).toContain("\x1b_Ga=p");
		expect(budget.takeTransmits()).toHaveLength(1);
		const native = component.describe(nativeContext);
		component.releaseRenderCaches();
		expect(component.render(80)).toEqual(rows);
		expect(budget.takeTransmits()).toEqual([]);
		const replayed = component.describe(nativeContext);
		expect(replayed).toEqual(native);
		const blob = (imageNode(replayed)?.p as { blob: string } | undefined)?.blob;
		expect(blob).toBeDefined();
		expect(Buffer.from(getNativeBlob(blob!)!.bytes).toString("base64")).toBe(jpeg);
		expect(getNativeBlob(blob!)?.mime).toBe("image/jpeg");
		component.setShowImages(false);
		expect(Bun.stripANSI(component.render(43).join("\n"))).toContain("[Image:");
		component.releaseRenderCaches();
		component.setShowImages(true);
		expect(component.render(43).join("")).toContain("\x1b_Ga=p");
	});
});
