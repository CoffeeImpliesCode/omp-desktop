import { describe, expect, it } from "bun:test";
import {
	type ComputerCallStep,
	DESKTOP_METHODS,
	ELEMENT_METHODS,
	isReadOnlyComputerCall,
	renderComputerCall,
	WINDOW_METHODS,
} from "@oh-my-pi/pi-coding-agent/tools/computer/call";

function errorMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("Expected callback to throw");
}

/** A rejection must name the refused helper and the allowlist that replaces it. */
function expectRejection(run: () => unknown, rejected: string, supported: readonly string[]): void {
	const message = errorMessage(run);
	expect(message).toContain(rejected);
	expect(message).toContain(supported.join(", "));
}

/** One `desktop.window("42").method(...)` chain, the only shape that reaches a window helper. */
function windowCall(method: string, args: unknown[] = []): ComputerCallStep[] {
	return [
		{ method: "window", args: ["42"] },
		{ method, args },
	];
}

describe("renderComputerCall", () => {
	it("renders root, window-hop, and element-hop calls byte-for-byte", () => {
		expect(renderComputerCall([{ method: "windows", args: [{ app: "Code" }] }])).toBe(
			'return await desktop.windows({"app":"Code"});',
		);
		expect(renderComputerCall([{ method: "clipboard.write", args: ["hi"] }])).toBe(
			'return await desktop.clipboard.write("hi");',
		);
		expect(
			renderComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "click", args: [10, 20, { button: "right" }] },
			]),
		).toBe('return await (await desktop.window("42")).click(10, 20, {"button":"right"});');
		expect(
			renderComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "setValue", args: ["todo"] },
			]),
		).toBe('return await (await desktop.ref("e5")).setValue("todo");');
	});

	it("renders control reads and options objects as the bytes the call parser reads back", () => {
		expect(renderComputerCall([{ method: "workspaces", args: [] }])).toBe("return await desktop.workspaces();");
		expect(renderComputerCall(windowCall("state"))).toBe('return await (await desktop.window("42")).state();');
		expect(renderComputerCall(windowCall("moveTo", [{ x: 120, y: 64 }]))).toBe(
			'return await (await desktop.window("42")).moveTo({"x":120,"y":64});',
		);
		expect(renderComputerCall(windowCall("resize", [{ width: 1280, height: undefined }]))).toBe(
			'return await (await desktop.window("42")).resize({"width":1280});',
		);
		expect(
			renderComputerCall(windowCall("moveToWorkspace", [{ workspaceId: "niri-workspace:3", focus: true }])),
		).toBe(
			'return await (await desktop.window("42")).moveToWorkspace({"workspaceId":"niri-workspace:3","focus":true});',
		);
		expect(renderComputerCall([{ method: "focusDisplay", args: [{ displayId: "DP-2" }] }])).toBe(
			'return await desktop.focusDisplay({"displayId":"DP-2"});',
		);
		expect(
			renderComputerCall([
				{ method: "moveWorkspaceToDisplay", args: [{ workspaceId: "niri-workspace:3", displayId: "DP-2" }] },
			]),
		).toBe('return await desktop.moveWorkspaceToDisplay({"workspaceId":"niri-workspace:3","displayId":"DP-2"});');
	});

	it("closes one window handle and never the session-ending root helper", () => {
		expect(renderComputerCall(windowCall("close"))).toBe('return await (await desktop.window("42")).close();');
		expect(isReadOnlyComputerCall(windowCall("close"))).toBe(false);
		expect(() => renderComputerCall([{ method: "close", args: [] }])).toThrow();
	});
});

describe("isReadOnlyComputerCall", () => {
	it("classifies read-only chains by the terminal helper", () => {
		expect(isReadOnlyComputerCall([{ method: "screenshot", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall([{ method: "type", args: ["x"] }])).toBe(false);
		expect(isReadOnlyComputerCall([{ method: "clipboard.read", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall(windowCall("ax"))).toBe(true);
		expect(isReadOnlyComputerCall(windowCall("focus"))).toBe(false);
		expect(
			isReadOnlyComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "bounds", args: [] },
			]),
		).toBe(true);
		expect(
			isReadOnlyComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "press", args: [] },
			]),
		).toBe(false);
	});

	it("keeps window, workspace, and display discovery read-only", () => {
		expect(isReadOnlyComputerCall([{ method: "windows", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall([{ method: "focusedWindow", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall([{ method: "workspaces", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall(windowCall("state"))).toBe(true);
	});

	it("limits read approval to inspection helpers across the complete allowlists", () => {
		const windowReads = Object.keys(WINDOW_METHODS)
			.filter(method => isReadOnlyComputerCall(windowCall(method)))
			.sort();
		expect(windowReads).toEqual(["ax", "find", "ref", "screenshot", "state"]);

		const desktopReads = Object.keys(DESKTOP_METHODS)
			.filter(method => isReadOnlyComputerCall([{ method, args: [] }]))
			.sort();
		expect(desktopReads).toEqual([
			"capabilities",
			"clipboard.read",
			"displays",
			"elementAt",
			"focusedElement",
			"focusedWindow",
			"ref",
			"screenshot",
			"window",
			"windows",
			"workspaces",
		]);
	});
});

describe("allowlist rejection", () => {
	it("refuses the removed raise helper on every handle kind", () => {
		expectRejection(() => renderComputerCall(windowCall("raise")), "raise", Object.keys(WINDOW_METHODS));
		expectRejection(
			() =>
				renderComputerCall([
					{ method: "ref", args: ["e5"] },
					{ method: "raise", args: [] },
				]),
			"raise",
			Object.keys(ELEMENT_METHODS),
		);
		expect(errorMessage(() => renderComputerCall([{ method: "raise", args: [] }]))).toContain("raise");
	});

	it("refuses unknown helpers and inherited object keys in each chain position", () => {
		expectRejection(
			() => renderComputerCall([{ method: "launch", args: [] }]),
			"launch",
			Object.keys(DESKTOP_METHODS),
		);
		expectRejection(
			() => renderComputerCall([{ method: "toString", args: [] }]),
			"toString",
			Object.keys(DESKTOP_METHODS),
		);
		expectRejection(() => renderComputerCall(windowCall("setValue", ["x"])), "setValue", Object.keys(WINDOW_METHODS));
		expectRejection(() => renderComputerCall(windowCall("toString")), "toString", Object.keys(WINDOW_METHODS));
		expectRejection(
			() =>
				renderComputerCall([
					{ method: "ref", args: ["e5"] },
					{ method: "resize", args: [{}] },
				]),
			"resize",
			Object.keys(ELEMENT_METHODS),
		);
		expect(() => isReadOnlyComputerCall([{ method: "launch", args: [] }])).toThrow();
		expect(() => isReadOnlyComputerCall(windowCall("raise"))).toThrow();
	});

	it("refuses empty, over-long, and non-handle-rooted chains", () => {
		expect(errorMessage(() => renderComputerCall([]))).toContain("chain");
		expect(() =>
			renderComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "find", args: [{}] },
				{ method: "press", args: [] },
			]),
		).toThrow();
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "workspaces", args: [] },
					{ method: "focusWorkspace", args: [{ workspaceId: "niri-workspace:3" }] },
				]),
			),
		).toContain("workspaces");
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "windows", args: [] },
					{ method: "click", args: [1, 2] },
				]),
			),
		).toBe(
			"Only desktop.window(id)/desktop.display(id)/desktop.ref(ref) results accept a chained call; got desktop.windows().",
		);
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "window", args: ["42"] },
					{ method: "setValue", args: ["x"] },
				]),
			),
		).toBe(`Unknown window method "setValue". Window handles support: ${Object.keys(WINDOW_METHODS).join(", ")}.`);
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "window", args: ["42"] },
					{ method: "toString", args: [] },
				]),
			),
		).toContain('Unknown window method "toString"');
		expect(
			errorMessage(() =>
				renderComputerCall([
					{ method: "ref", args: ["e5"] },
					{ method: "raise", args: [] },
				]),
			),
		).toBe(`Unknown element method "raise". Element handles support: ${Object.keys(ELEMENT_METHODS).join(", ")}.`);
		expect(errorMessage(() => isReadOnlyComputerCall([{ method: "launch", args: [] }]))).toContain(
			'Unknown desktop method "launch"',
		);
	});
});
