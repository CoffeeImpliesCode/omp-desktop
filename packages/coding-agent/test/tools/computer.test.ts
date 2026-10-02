import { afterAll, describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { isReadOnlyComputerCall, renderComputerCall } from "@oh-my-pi/pi-coding-agent/tools/computer/call";
import type {
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import {
	type ComputerController,
	ComputerSupervisor,
	type ComputerWorkerHandle,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import type {
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	DesktopCapabilities,
	DesktopControlAction,
	DesktopControlCapabilities,
	DesktopDisplay,
	DesktopPoint,
	DesktopWindow,
	DesktopWindowState,
	DesktopWorkspace,
	PointerOptions,
} from "@oh-my-pi/pi-natives";

import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

/** Method name of the last step in a facade call chain, or "" when the chain is malformed. */
function terminalMethod(chain: unknown): string {
	if (!Array.isArray(chain) || chain.length === 0) return "";
	const terminal: unknown = chain[chain.length - 1];
	if (terminal === null || typeof terminal !== "object" || !("method" in terminal)) return "";
	return typeof terminal.method === "string" ? terminal.method : "";
}

/** Control operations the fake backend advertises and implements. */
const controlOperations = [
	"focusWindow",
	"closeWindow",
	"moveWindow",
	"moveWindowBy",
	"resizeWindow",
	"maximizeWindow",
	"minimizeWindow",
	"restoreWindow",
	"toggleMaximized",
	"toggleFullscreen",
	"toggleWindowedFullscreen",
	"setFullscreen",
	"setFloating",
	"centerWindow",
	"moveWindowToWorkspace",
	"moveWindowToDisplay",
	"focusWorkspace",
	"focusDisplay",
	"moveWorkspaceToDisplay",
];

const controlCapabilities: DesktopControlCapabilities = {
	backend: "fake",
	operations: controlOperations,
	coordinateSpace: "desktop",
	focusMayWarpPointer: false,
};

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	takeover: true,
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
	windowControl: controlCapabilities,
};

const display: DesktopDisplay = {
	id: "display-1",
	name: "Primary",
	x: 0,
	y: 0,
	width: 64,
	height: 32,
	scale: 1,
	pixelX: 0,
	pixelY: 0,
	pixelWidth: 64,
	pixelHeight: 32,
	isPrimary: true,
};

const secondDisplay: DesktopDisplay = {
	id: "display-2",
	name: "Secondary",
	x: 64,
	y: 0,
	width: 64,
	height: 32,
	scale: 1,
	pixelX: 64,
	pixelY: 0,
	pixelWidth: 64,
	pixelHeight: 32,
	isPrimary: false,
};

const windowFixture: DesktopWindow = {
	id: "42",
	title: "Editor",
	app: "Code",
	pid: 123,
	x: 4,
	y: 5,
	width: 40,
	height: 20,
	focused: true,
};

const secondWindowFixture: DesktopWindow = {
	id: "7",
	title: "99",
	app: "Numbers",
	pid: 124,
	x: 10,
	y: 12,
	width: 30,
	height: 16,
	focused: false,
};

const firstWorkspace: DesktopWorkspace = {
	id: "fake-workspace:1",
	index: 1,
	name: "main",
	displayId: "display-1",
	active: true,
	focused: true,
	urgent: false,
	activeWindowId: "42",
};

const secondWorkspace: DesktopWorkspace = {
	id: "fake-workspace:2",
	index: 2,
	name: "code",
	displayId: "display-1",
	active: false,
	focused: false,
	urgent: false,
};

const axNode: AxNode = {
	ref: "e1",
	role: "button",
	nativeRole: "button",
	title: "Save",
	enabled: true,
	focused: false,
	childCount: 0,
	x: 7,
	y: 8,
	width: 9,
	height: 10,
};

interface FakeSessionOptions {
	/** Operations the fake backend advertises and implements. */
	operations?: string[];
	windows?: DesktopWindow[];
	workspaces?: DesktopWorkspace[];
	displays?: DesktopDisplay[];
}

/** One modeled window: its listed descriptor plus the state a control action changes. */
interface FakeWindow {
	descriptor: DesktopWindow;
	workspaceId: string;
	displayId: string;
	floating: boolean;
	maximized: boolean;
	minimized: boolean;
	fullscreen: boolean;
	/** Geometry handed back when the window leaves its filled state. */
	filledBounds?: { x: number; y: number; width: number; height: number };
}

/**
 * Models a live desktop: control actions change window/workspace state the way
 * reads observe it, an accepted mutation drops cached coordinate frames, and
 * targets that no longer exist fail with the native error codes.
 */
class FakeNativeSession implements NativeDesktopSession {
	readonly capabilities: DesktopCapabilities;
	readonly control: NativeDesktopSession["control"];
	readonly listWorkspaces: NativeDesktopSession["listWorkspaces"];
	readonly windowState: NativeDesktopSession["windowState"];
	clickCount = 0;
	closeCount = 0;
	controlCount = 0;
	/** Actions that reached the native boundary, including ones the backend itself refuses. */
	readonly receivedActions: DesktopControlAction[] = [];
	sourceWidth = 64;
	sourceHeight = 32;
	readonly #operations: string[];
	readonly #displays: DesktopDisplay[];
	readonly #workspaces: DesktopWorkspace[];
	readonly #windows: FakeWindow[];
	/** Targets holding a live coordinate frame; an accepted mutation drops all of them. */
	readonly #frames = new Set<string>();

	constructor(options: FakeSessionOptions = {}) {
		const {
			operations = controlOperations,
			windows = [windowFixture],
			workspaces = [firstWorkspace, secondWorkspace],
			displays = [display],
		} = options;
		this.#operations = [...operations];
		this.#displays = [...displays];
		this.#workspaces = workspaces.map(workspace => ({ ...workspace }));
		this.#windows = windows.map(descriptor => ({
			descriptor: { ...descriptor },
			workspaceId: workspaces[0]?.id ?? "",
			displayId: workspaces[0]?.displayId ?? display.id,
			floating: false,
			maximized: false,
			minimized: false,
			fullscreen: false,
		}));
		this.capabilities = {
			...capabilities,
			windowControl: { ...controlCapabilities, operations: [...operations] },
		};
		this.control = async (action: DesktopControlAction): Promise<void> => {
			this.#apply(action);
		};
		this.listWorkspaces = async (): Promise<DesktopWorkspace[]> =>
			this.#workspaces.map(workspace => ({ ...workspace }));
		this.windowState = async (id: string): Promise<DesktopWindowState> => this.#state(id);
	}

	async listDisplays(): Promise<DesktopDisplay[]> {
		return this.#displays.map(candidate => ({ ...candidate }));
	}
	async listWindows(): Promise<DesktopWindow[]> {
		return this.#windows.map(candidate => ({ ...candidate.descriptor }));
	}
	async capture(target: string): Promise<{
		data: Uint8Array;
		width: number;
		height: number;
		sourceWidth: number;
		sourceHeight: number;
		target: string;
	}> {
		this.#frames.add(target);
		return {
			data: Uint8Array.of(137, 80, 78, 71),
			width: 64,
			height: 32,
			sourceWidth: this.sourceWidth,
			sourceHeight: this.sourceHeight,
			target,
		};
	}
	async click(target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.#requireFrame(target);
		this.clickCount += 1;
	}
	async moveMouse(target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.#requireFrame(target);
	}
	async drag(target: string, _points: DesktopPoint[], _opts?: PointerOptions | null): Promise<void> {
		this.#requireFrame(target);
	}
	async scroll(
		target: string,
		_x: number,
		_y: number,
		_dx: number,
		_dy: number,
		_opts?: PointerOptions | null,
	): Promise<void> {
		this.#requireFrame(target);
	}
	async typeText(_target: string, _text: string, _opts?: PointerOptions | null): Promise<void> {}
	async keyChord(_target: string, _keys: string[], _opts?: PointerOptions | null): Promise<void> {}
	async axSnapshot(_target: string, _opts?: AxSnapshotOptions | null): Promise<{ text: string }> {
		return { text: "- button [ref=e1]" };
	}
	async axQuery(_target: string, _query: AxQuery): Promise<AxNode[]> {
		return [axNode];
	}
	async axElementAt(_target: string, _x: number, _y: number): Promise<AxNode | null> {
		return axNode;
	}
	async axFocused(): Promise<AxNode | null> {
		return axNode;
	}
	async axNode(_ref: string): Promise<AxNode> {
		return axNode;
	}
	async axAttributes(_ref: string): Promise<Array<[string, string]>> {
		return [];
	}
	async axChildren(_ref: string): Promise<AxNode[]> {
		return [];
	}
	async axParent(_ref: string): Promise<AxNode | null> {
		return null;
	}
	async axPerform(_ref: string, _action: string): Promise<void> {}
	async axSetValue(_ref: string, _value: string): Promise<void> {}
	async axFocus(_ref: string): Promise<void> {}
	async axClick(_ref: string, _opts?: PointerOptions | null): Promise<void> {}
	async close(): Promise<void> {
		this.closeCount += 1;
	}

	#requireFrame(target: string): void {
		if (this.#frames.has(target)) return;
		throw new Error(
			`InvalidCoordinateFrame: no capture of '${target}' yet — take a screenshot of this target first; coordinate input is in pixels of that screenshot`,
		);
	}

	#apply(action: DesktopControlAction): void {
		this.receivedActions.push({ ...action });
		if (!this.#operations.includes(action.operation))
			throw new Error(`ControlUnsupported: ${action.operation} is unavailable on the fake desktop backend`);
		// The native core invalidates every cached coordinate frame before an accepted
		// mutation can partly apply, so older captures stop being usable immediately.
		this.#frames.clear();
		switch (action.operation) {
			case "focusWorkspace":
				this.#focusWorkspace(this.#workspace(action.workspaceId));
				break;
			case "moveWorkspaceToDisplay":
				this.#workspace(action.workspaceId).displayId = this.#display(action.displayId).id;
				break;
			case "focusDisplay": {
				const target = this.#display(action.displayId);
				const workspace = this.#workspaces.find(candidate => candidate.displayId === target.id);
				if (!workspace) throw new Error(`InvalidTarget: display ${target.id} has no workspace`);
				this.#focusWorkspace(workspace);
				break;
			}
			default:
				this.#applyWindow(action);
				break;
		}
		this.controlCount += 1;
	}

	#applyWindow(action: DesktopControlAction): void {
		const window = this.#window(action.windowId);
		switch (action.operation) {
			case "focusWindow":
				this.#focus(window);
				break;
			case "closeWindow":
				this.#remove(window);
				break;
			case "moveWindow":
				this.#place(window, action.x ?? window.descriptor.x, action.y ?? window.descriptor.y);
				break;
			case "moveWindowBy":
				this.#place(window, window.descriptor.x + (action.dx ?? 0), window.descriptor.y + (action.dy ?? 0));
				break;
			case "resizeWindow":
				this.#place(
					window,
					window.descriptor.x,
					window.descriptor.y,
					action.width ?? window.descriptor.width,
					action.height ?? window.descriptor.height,
				);
				break;
			case "maximizeWindow":
				window.maximized = true;
				this.#fillArea(window);
				break;
			case "minimizeWindow":
				window.minimized = true;
				break;
			case "restoreWindow":
				this.#restore(window);
				break;
			case "toggleMaximized":
				if (window.maximized) this.#restore(window);
				else {
					window.maximized = true;
					this.#fillArea(window);
				}
				break;
			case "toggleFullscreen":
			// Windowed fullscreen has no record field of its own here; only the native
			// compositor can tell the two apart, so no JS test claims that operation.
			case "toggleWindowedFullscreen":
				this.#setFullscreen(window, !window.fullscreen);
				break;
			case "setFullscreen":
				this.#setFullscreen(window, action.enabled === true);
				break;
			case "setFloating":
				window.floating = action.enabled === true;
				break;
			case "centerWindow": {
				const area = this.#display(window.displayId);
				this.#place(
					window,
					area.x + Math.round((area.width - window.descriptor.width) / 2),
					area.y + Math.round((area.height - window.descriptor.height) / 2),
				);
				break;
			}
			case "moveWindowToWorkspace":
				this.#toWorkspace(window, this.#workspace(action.workspaceId), action.focus === true);
				break;
			case "moveWindowToDisplay": {
				const from = this.#display(window.displayId);
				const to = this.#display(action.displayId);
				const x = to.x + (window.descriptor.x - from.x);
				const y = to.y + (window.descriptor.y - from.y);
				window.displayId = to.id;
				this.#place(window, x, y);
				break;
			}
		}
	}

	#state(id: string): DesktopWindowState {
		const window = this.#window(id);
		return {
			window: { ...window.descriptor },
			workspaceId: window.workspaceId,
			displayId: window.displayId,
			floating: window.floating,
			maximized: window.maximized,
			minimized: window.minimized,
			fullscreen: window.fullscreen,
		};
	}

	#window(id: string | undefined): FakeWindow {
		const found = this.#windows.find(candidate => candidate.descriptor.id === id);
		if (!found) throw new Error(`WindowNotFound: window ${id} is not available`);
		return found;
	}

	#workspace(id: string | undefined): DesktopWorkspace {
		const found = this.#workspaces.find(candidate => candidate.id === id);
		if (!found) throw new Error(`InvalidTarget: workspace ${id} is not available`);
		return found;
	}

	#display(id: string | undefined): DesktopDisplay {
		const found = this.#displays.find(candidate => candidate.id === id);
		if (!found) throw new Error(`InvalidTarget: display ${id} is not available`);
		return found;
	}

	#place(
		window: FakeWindow,
		x: number,
		y: number,
		width = window.descriptor.width,
		height = window.descriptor.height,
	): void {
		window.descriptor = { ...window.descriptor, x, y, width, height };
	}

	#fillArea(window: FakeWindow): void {
		const area = this.#display(window.displayId);
		window.filledBounds ??= {
			x: window.descriptor.x,
			y: window.descriptor.y,
			width: window.descriptor.width,
			height: window.descriptor.height,
		};
		this.#place(window, area.x, area.y, area.width, area.height);
	}

	#unfill(window: FakeWindow): void {
		const previous = window.filledBounds;
		window.filledBounds = undefined;
		if (previous) this.#place(window, previous.x, previous.y, previous.width, previous.height);
	}

	#setFullscreen(window: FakeWindow, enabled: boolean): void {
		window.fullscreen = enabled;
		if (enabled) this.#fillArea(window);
		else this.#unfill(window);
	}

	#restore(window: FakeWindow): void {
		window.maximized = false;
		window.minimized = false;
		window.fullscreen = false;
		this.#unfill(window);
	}

	#focus(window: FakeWindow): void {
		for (const candidate of this.#windows)
			candidate.descriptor = { ...candidate.descriptor, focused: candidate === window };
		for (const workspace of this.#workspaces) {
			workspace.focused = workspace.id === window.workspaceId;
			workspace.active = workspace.focused;
		}
	}

	#focusWorkspace(workspace: DesktopWorkspace): void {
		for (const candidate of this.#workspaces) {
			candidate.focused = candidate === workspace;
			candidate.active = candidate.focused;
		}
		const active = this.#windows.find(candidate => candidate.workspaceId === workspace.id);
		if (active) this.#focus(active);
	}

	#remove(window: FakeWindow): void {
		this.#windows.splice(this.#windows.indexOf(window), 1);
		for (const workspace of this.#workspaces)
			if (workspace.activeWindowId === window.descriptor.id)
				workspace.activeWindowId = this.#windows.find(
					candidate => candidate.workspaceId === workspace.id,
				)?.descriptor.id;
	}

	#toWorkspace(window: FakeWindow, workspace: DesktopWorkspace, focus: boolean): void {
		const previous = window.workspaceId;
		window.workspaceId = workspace.id;
		workspace.activeWindowId = window.descriptor.id;
		const vacated = this.#workspaces.find(candidate => candidate.id === previous);
		if (vacated?.activeWindowId === window.descriptor.id)
			vacated.activeWindowId = this.#windows.find(candidate => candidate.workspaceId === previous)?.descriptor.id;
		if (focus) this.#focus(window);
	}
}

/**
 * An addon build from before window control: the capability block and the native
 * control members are both absent, so a caller that skipped the capability check
 * would hit an undefined-method crash instead of a capability failure.
 */
function legacySession(): NativeDesktopSession {
	return new Proxy(new FakeNativeSession(), {
		get(target, prop) {
			if (prop === "capabilities") return { ...capabilities, windowControl: undefined };
			if (prop === "control" || prop === "windowState" || prop === "listWorkspaces") return undefined;
			const value = Reflect.get(target, prop, target);
			// Members must run against the real session: a private field read through
			// the proxy would fail on an unrelated lookup the legacy test still needs.
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

class MemoryTransport implements ComputerWorkerTransport {
	readonly outbound: ComputerWorkerOutbound[] = [];
	#handler?: (message: ComputerWorkerInbound) => void;
	#waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve: (message: ComputerWorkerOutbound) => void;
	}>();

	send(message: ComputerWorkerOutbound): void {
		this.outbound.push(message);
		for (const waiter of this.#waiters) {
			if (!waiter.predicate(message)) continue;
			this.#waiters.delete(waiter);
			waiter.resolve(message);
		}
	}
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}
	close(): void {}
	inbound(message: ComputerWorkerInbound): void {
		this.#handler?.(message);
	}
	waitFor(predicate: (message: ComputerWorkerOutbound) => boolean): Promise<ComputerWorkerOutbound> {
		const existing = this.outbound.find(predicate);
		if (existing) return Promise.resolve(existing);
		const pending = Promise.withResolvers<ComputerWorkerOutbound>();
		this.#waiters.add({ predicate, resolve: pending.resolve });
		return pending.promise;
	}
}

const snapshot = (readOnly = false): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: crypto.randomUUID(),
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "all",
	readOnly,
});

async function runWorker(
	transport: MemoryTransport,
	id: string,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	transport.inbound({ type: "run", id, code, timeoutMs, session: snapshot(readOnly) });
	const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
	if (message.type !== "result") throw new Error(`Expected computer result, received ${message.type}`);
	return message;
}

function toolSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

afterAll(async () => {
	await disposeAllKernelSessions();
});

describe("computer prelude", () => {
	it("validates action shapes and maps explicitly read-only runs to read approval", async () => {
		const prelude = createComputerPrelude(toolSession(), () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const context = { session: toolSession(), toolCallId: "computer-validation" };

		await expect(prelude.invoke({}, context)).rejects.toThrow("computer received invalid arguments");
		await expect(prelude.invoke({ action: "run", code: "1", unexpected: true }, context)).rejects.toThrow(
			"computer received invalid arguments",
		);
		await expect(prelude.invoke({ action: "capabilities", code: "1" }, context)).rejects.toThrow(
			"computer received invalid arguments",
		);
		await expect(prelude.invoke({ action: "run" }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(prelude.invoke({ action: "run", code: "1", fn: "() => 1" }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(prelude.invoke({ action: "call" }, context)).rejects.toThrow("computer received invalid arguments");
		await expect(prelude.invoke({ action: "call", chain: [], read_only: true }, context)).rejects.toThrow(
			"computer received invalid arguments",
		);
		await expect(
			prelude.invoke({ action: "call", chain: [{ method: "launch", args: [] }] }, context),
		).rejects.toThrow('Unknown desktop method "launch"');

		expect(computerApproval({ action: "run", code: "1", read_only: true })).toBe("read");
		expect(computerApproval({ action: "run", code: "1", read_only: false })).toBe("exec");
		expect(computerApproval({ action: "call", chain: [{ method: "windows", args: [] }] })).toBe("read");
		expect(
			computerApproval({
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [] },
				],
			}),
		).toBe("read");
		expect(
			computerApproval({
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "press", args: [] },
				],
			}),
		).toBe("exec");
		expect(computerApproval({ action: "call", chain: [{ method: "launch", args: [] }] })).toBe("exec");
		expect(computerApproval({ action: "call", chain: [null] })).toBe("exec");
		expect(computerApproval({ action: "call" })).toBe("exec");
		expect(computerApproval({ action: "capabilities" })).toBe("read");
		expect(computerApproval({ action: "close" })).toBe("exec");
		expect(computerApproval("garbage")).toBe("exec");
		await prelude.invoke({ action: "close" }, context);
	});

	it("routes run, capabilities, images, cancellation inputs, and close through one host controller", async () => {
		const calls: Array<{
			code: string;
			timeoutMs: number;
			snapshot: ComputerSessionSnapshot;
			signal?: AbortSignal;
		}> = [];
		let closeCount = 0;
		const controller: ComputerController = {
			async run(code: string, timeoutMs: number, runSnapshot: ComputerSessionSnapshot, signal?: AbortSignal) {
				calls.push({ code, timeoutMs, snapshot: runSnapshot, signal });
				return {
					displays: [
						{ type: "text", text: "captured" },
						{ type: "image", data: "iVBORw==", mimeType: "image/png" },
					],
					returnValue: { windows: 1 },
					screenshots: [],
					capabilities,
				};
			},
			async capabilities() {
				return capabilities;
			},
			async close() {
				closeCount += 1;
			},
		};
		const session = toolSession();
		const prelude = createComputerPrelude(session, () => controller);
		const abort = new AbortController();
		const context = { session, toolCallId: "computer-run", signal: abort.signal };

		const result = await prelude.invoke(
			{ action: "run", code: "await desktop.windows()", read_only: true, timeout: 7 },
			context,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			code: "await desktop.windows()",
			timeoutMs: 7_000,
			snapshot: { readOnly: true, display: "all" },
			signal: abort.signal,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "captured" },
			{ type: "image", data: "iVBORw==", mimeType: "image/png", detail: "original" },
		]);
		expect(result.details).toMatchObject({
			code: "await desktop.windows()",
			readOnly: true,
			backend: "fake",
			value: { windows: 1 },
		});

		const functionResult = await prelude.invoke(
			{ action: "run", fn: "(_scope, count) => count", args: [7] },
			context,
		);
		expect(calls[1]?.code).toBe("return await ((_scope, count) => count)({ desktop, wait, assert }, 7);");
		expect(functionResult.details).toMatchObject({ value: { windows: 1 } });

		await prelude.invoke(
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [{ maxDepth: 3 }] },
				],
			},
			context,
		);
		await prelude.invoke({ action: "call", chain: [{ method: "press", args: ["cmd+s"] }], timeout: 9 }, context);
		expect(calls[2]).toMatchObject({
			code: 'return await (await desktop.window("42")).ax({"maxDepth":3});',
			snapshot: { readOnly: true },
		});
		expect(calls[3]).toMatchObject({
			code: 'return await desktop.press("cmd+s");',
			timeoutMs: 9_000,
			snapshot: { readOnly: false },
		});

		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			prelude.invoke(
				{ action: "run", code: "await desktop.windows()" },
				{ session, toolCallId: "computer-cancelled", signal: cancelled.signal },
			),
		).rejects.toMatchObject({ name: "ToolAbortError" });
		expect(calls).toHaveLength(4);

		const capabilityResult = await prelude.invoke({ action: "capabilities" }, context);
		expect(capabilityResult.details).toEqual(capabilities);
		await prelude.invoke({ action: "close" }, context);
		await prelude.invoke({ action: "close" }, context);
		expect(closeCount).toBe(1);
		await expect(prelude.invoke({ action: "run", code: "await desktop.windows()" }, context)).rejects.toThrow(
			"Computer session is closed",
		);
	});

	it("installs a frozen JavaScript facade with handle proxies, runs, direct values, and display text", async () => {
		const session = toolSession();
		const prelude = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const calls: unknown[] = [];
		const displays: unknown[] = [];
		const windowSnapshot = {
			id: "42",
			app: "Code",
			title: "main.ts",
			pid: 7,
			bounds: { x: 1, y: 2, width: 3, height: 4 },
			focused: true,
		};
		const elementSnapshot = {
			ref: "e1",
			role: "button",
			nativeRole: "AXButton",
			title: "Save",
			enabled: true,
			focused: false,
			childCount: 0,
		};
		const callValues: Record<string, unknown> = {
			window: windowSnapshot,
			focusedWindow: null,
			windows: [windowSnapshot],
			ax: "- button [ref=e1]",
			find: [elementSnapshot],
			ref: elementSnapshot,
			elementAt: elementSnapshot,
			press: undefined,
			parent: null,
			children: [elementSnapshot, elementSnapshot],
			bounds: { x: 7, y: 8, width: 9, height: 10 },
			"clipboard.read": "copied",
		};
		const realm = createContext({
			__omp_display__: (value: unknown) => displays.push(value),
			__omp_prelude__: async (name: unknown, parameters: unknown) => {
				expect(name).toBe("computer");
				calls.push(parameters);
				if (parameters === null || typeof parameters !== "object" || !("action" in parameters)) return undefined;
				if (parameters.action === "run") return { text: "inner display", details: { value: 42 } };
				if (parameters.action === "capabilities") return { text: "", details: capabilities };
				if (parameters.action === "call" && "chain" in parameters) {
					return { text: "", details: { value: callValues[terminalMethod(parameters.chain)] } };
				}
				return undefined;
			},
		});
		runInContext(prelude.javascript, realm);

		const fn = (_scope: unknown, count: number): number => count;
		const argFn = (value: number): number => value;
		Reflect.set(realm, "fn", fn);
		Reflect.set(realm, "argFn", argFn);
		expect(
			await runInContext("computer.run(fn, { args: [7, /save/gi, argFn], read_only: true, timeout: 5 })", realm),
		).toBe(42);
		expect(
			await runInContext(
				'computer.run("41 + 1", { timeout: 2, action: "close", code: "old", fn: "old", unexpected: true })',
				realm,
			),
		).toBe(42);
		expect(await runInContext("computer.capabilities()", realm)).toEqual(capabilities);

		expect(
			await runInContext(
				'(async () => { globalThis.win = await computer.window({ app: "Code" }); return { ...win }; })()',
				realm,
			),
		).toEqual(windowSnapshot);
		expect(await runInContext("computer.focusedWindow()", realm)).toBeNull();
		expect(await runInContext("win.ax({ maxDepth: 3 })", realm)).toBe("- button [ref=e1]");
		expect(await runInContext("win.press('cmd+s', undefined)", realm)).toBeUndefined();
		expect(await runInContext("win.moveTo({ x: 11, y: 12 })", realm)).toBeUndefined();
		expect(
			await runInContext(
				'(async () => { globalThis.el = await win.ref("e1"); return [el.ref, el.role, el.title]; })()',
				realm,
			),
		).toEqual(["e1", "button", "Save"]);
		expect(await runInContext("el.bounds()", realm)).toEqual({ x: 7, y: 8, width: 9, height: 10 });
		expect(await runInContext("el.parent()", realm)).toBeNull();
		expect(await runInContext("el.children().then(kids => kids.map(kid => kid.ref))", realm)).toEqual(["e1", "e1"]);
		expect(await runInContext('win.find({ role: "button" }).then(found => found[0].role)', realm)).toBe("button");
		expect(await runInContext("computer.elementAt(3, 4).then(found => found.ref)", realm)).toBe("e1");
		expect(await runInContext("computer.clipboard.read()", realm)).toBe("copied");
		await runInContext("computer.close()", realm);

		expect(calls).toEqual([
			{
				action: "run",
				fn: String(fn),
				args: [7, { __omp_re: { source: "save", flags: "gi" } }, { __omp_fn: String(argFn) }],
				read_only: true,
				timeout: 5,
			},
			{ action: "run", code: "41 + 1", timeout: 2 },
			{ action: "capabilities" },
			{ action: "call", chain: [{ method: "window", args: [{ app: "Code" }] }] },
			{ action: "call", chain: [{ method: "focusedWindow", args: [] }] },
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [{ maxDepth: 3 }] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "press", args: ["cmd+s"] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "moveTo", args: [{ x: 11, y: 12 }] },
				],
			},
			{ action: "call", chain: [{ method: "ref", args: ["e1"] }] },
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "bounds", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "parent", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "children", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "find", args: [{ role: "button" }] },
				],
			},
			{ action: "call", chain: [{ method: "elementAt", args: [3, 4] }] },
			{ action: "call", chain: [{ method: "clipboard.read", args: [] }] },
			{ action: "close" },
		]);
		expect(displays).toEqual(["inner display", "inner display"]);
		expect(
			runInContext(
				"Object.isFrozen(computer) && Object.isFrozen(computer.clipboard) && Object.isFrozen(win) && Object.isFrozen(el)",
				realm,
			),
		).toBe(true);
		await expect(runInContext("computer.run({ code: '1 + 1' })", realm)).rejects.toThrow(
			"computer.run() expects a function or code string",
		);
		await expect(runInContext('computer.run("1", null)', realm)).rejects.toThrow(
			"computer.run() expects an options object",
		);
		await expect(runInContext("computer.run(Math.max)", realm)).rejects.toThrow(
			"computer.run() cannot serialize a native or bound function",
		);
	});

	it("returns direct values and prints inner display text from the Python facade in a real kernel", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = {
			...toolSession(),
			getEvalPreludes: () => definitions,
		};
		const shipped = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const callValues: Record<string, unknown> = {
			window: {
				id: "42",
				app: "Code",
				title: "main.ts",
				bounds: { x: 1, y: 2, width: 3, height: 4 },
				focused: true,
			},
			ax: "- button [ref=e1]",
			ref: { ref: "e1", role: "button", nativeRole: "AXButton", enabled: true, focused: false, childCount: 0 },
			press: undefined,
			focus: undefined,
			click: undefined,
		};
		const definition: EvalPreludeDefinition = {
			...shipped,
			async invoke(parameters) {
				calls.push(parameters);
				if (parameters !== null && typeof parameters === "object" && "chain" in parameters) {
					return { content: [], details: { value: callValues[terminalMethod(parameters.chain)] } };
				}
				return {
					content: [{ type: "text", text: "computer inner display" }],
					details: { value: { answer: 42 } },
				};
			},
		};
		definitions = [definition];

		const result = await executePython(
			[
				'value = await computer.run("return 6 * 7;", read_only=True, timeout=3)',
				'print(value["answer"])',
				"try:",
				"    await computer.run(lambda: 42)",
				"except TypeError as error:",
				"    print(str(error))",
				'win = await computer.window(app="Code")',
				"print(repr(win), win.bounds)",
				"print(await win.ax(maxDepth=3))",
				'el = await win.ref("e1")',
				"print(repr(el))",
				"await el.press()",
				"await win.focus()",
				"await win.moveTo(x=11, y=12)",
				"await win.click(10, 20, button='right', takeover=None)",
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-facade-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
			"computer inner display",
			"42",
			"computer.run() expects a JavaScript code string",
			"<computer.Window id='42' app='Code'> {'x': 1, 'y': 2, 'width': 3, 'height': 4}",
			"- button [ref=e1]",
			"<computer.Element ref='e1' role='button'>",
		]);
		expect(calls).toEqual([
			{ action: "run", code: "return 6 * 7;", read_only: true, timeout: 3 },
			{ action: "call", chain: [{ method: "window", args: [{ app: "Code" }] }] },
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [{ maxDepth: 3 }] },
				],
			},
			{ action: "call", chain: [{ method: "ref", args: ["e1"] }] },
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "press", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "focus", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "moveTo", args: [{ x: 11, y: 12 }] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "click", args: [10, 20, { button: "right" }] },
				],
			},
		]);
	});

	it("treats text-only Python host responses as unavailable capabilities", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = {
			...toolSession(),
			getEvalPreludes: () => definitions,
		};
		const shipped = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		definitions = [
			{
				...shipped,
				async invoke(parameters) {
					calls.push(parameters);
					return { content: [{ type: "text", text: "Computer capabilities unavailable" }] };
				},
			},
		];

		const result = await executePython("print(await computer.capabilities())", {
			cwd: process.cwd(),
			sessionId: `computer-unavailable-py-${crypto.randomUUID()}`,
			toolSession: session,
			kernelMode: "per-call",
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("None");
		expect(calls).toEqual([{ action: "capabilities" }]);
	});

	it("reflects the live enabled setting", () => {
		const session = toolSession();
		const prelude = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));

		expect(prelude.enabled?.()).toBe(true);
		cfgComputerEnabled.override(session.settings, false);
		expect(prelude.enabled?.()).toBe(false);
	});
});

describe("computer worker round trips", () => {
	it("lists windows and returns screenshot caption, image, and detail through a fake native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, options => {
			expect(options).toEqual({ display: "all" });
			return native;
		});

		const result = await runWorker(
			transport,
			"capture",
			"const windows = await desktop.windows(); await desktop.screenshot(); ({ count: windows.length })",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).toEqual({ count: 1 });
		const texts = result.payload.displays.filter(block => block.type === "text");
		const images = result.payload.displays.filter(block => block.type === "image");
		expect(texts).toHaveLength(1);
		expect(texts[0]?.text).toMatch(/^screenshot desktop 64×32 → .*omp-computer-.*\.png$/);
		expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
		expect(result.payload.screenshots).toHaveLength(1);
		expect(result.payload.screenshots[0]).toMatchObject({ width: 64, height: 32, target: "desktop" });
		expect(result.payload.screenshots[0]?.path).toMatch(/omp-computer-.*\.png$/);
	});

	it("reports source dimensions when a screenshot is scaled", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		native.sourceWidth = 128;
		native.sourceHeight = 64;
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(transport, "scaled-capture", "await desktop.screenshot()");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.displays[0]).toEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringMatching(/^screenshot desktop 64×32 \(scaled from 128×64\) → .*omp-computer-.*\.png$/),
			}),
		);
		expect(result.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 128,
			sourceHeight: 64,
		});
	});

	it("blocks read-only click after capture before invoking native input", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(
			transport,
			"read-only",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
			true,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.isToolError).toBe(true);
		expect(result.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("rejects an aborted run with an abort error", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({ type: "run", id: "abort", code: "await wait(5_000)", timeoutMs: 5_000, session: snapshot() });
		await Promise.resolve();
		transport.inbound({ type: "abort", id: "abort" });
		const result = await transport.waitFor(message => message.type === "result" && message.id === "abort");
		expect(result.type).toBe("result");
		if (result.type !== "result" || result.ok) return;
		expect(result.error.isAbort).toBe(true);
		expect(result.error.name).toBe("ToolAbortError");
	});

	it("reports the worker watchdog timeout budget explicitly", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const result = await runWorker(transport, "timeout", "await wait(5_000)", false, 10);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({
			isToolError: true,
			message: "Computer code execution timed out after 10ms",
		});
	});

	it("round-trips tool calls and resolves the in-script promise", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const resultPromise = runWorker(transport, "bridge", "await tool.echo({ value: 7 })");
		const call = await transport.waitFor(message => message.type === "tool-call" && message.runId === "bridge");
		expect(call).toMatchObject({ type: "tool-call", runId: "bridge", name: "echo", args: { value: 7 } });
		if (call.type !== "tool-call") return;
		transport.inbound({ type: "tool-reply", id: call.id, reply: { ok: true, value: { echoed: 7 } } });
		const result = await resultPromise;
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ echoed: 7 });
	});

	it("uses a retained window screenshot in the current run payload", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-window-screenshot",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-screenshot",
			"await globalThis.retainedWin.screenshot({ silent: true })",
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.payload.screenshots).toHaveLength(1);
		expect(second.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 64,
			sourceHeight: 32,
			target: "42",
		});
	});

	it("resolves ref() to a populated live element and find() to every match", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"ref-resolve",
			'const win = await desktop.window("42"); const el = await win.ref("e1"); const all = await win.find({ role: "button" }); ({ role: el.role, count: all.length })',
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ role: "button", count: 1 });
	});

	describe("numeric window ids", () => {
		it.each([
			["a number", "desktop.window(42)"],
			["an { id } number", "desktop.window({ id: 42 })"],
		])("resolves %s as that window id", async (_label, selector) => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(
				transport,
				() => new FakeNativeSession({ windows: [windowFixture, secondWindowFixture] }),
			);
			const result = await runWorker(transport, "numeric-id", `(await ${selector}).id`);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.payload.returnValue).toBe("42");
		});

		it.each([
			["a missing id", 404],
			["a number that is another window's title", 99],
		])("throws a miss for %s", async (_label, id) => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(
				transport,
				() => new FakeNativeSession({ windows: [windowFixture, secondWindowFixture] }),
			);
			const result = await runWorker(transport, "numeric-miss", `await desktop.window(${id})`);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toBe(`no window matches ${id}`);
		});
	});

	it("enforces the derived read-only tier for rendered handle calls", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		// Coordinate input needs a capture of its own target, exactly like the real core.
		const primed = await runWorker(
			transport,
			"prime-click-frame",
			'await (await desktop.window("42")).screenshot({ silent: true })',
		);
		expect(primed.ok).toBe(true);

		const clickChain = [
			{ method: "window", args: ["42"] },
			{ method: "click", args: [1, 2] },
		];
		const blocked = await runWorker(transport, "call-click-ro", renderComputerCall(clickChain), true);
		expect(blocked.ok).toBe(false);
		expect(native.clickCount).toBe(0);
		const clicked = await runWorker(
			transport,
			"call-click",
			renderComputerCall(clickChain),
			isReadOnlyComputerCall(clickChain),
		);
		expect(clicked.ok).toBe(true);
		expect(native.clickCount).toBe(1);
	});

	it("applies the current read-only policy to a retained writable window", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-writable-window",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-read-only",
			"await globalThis.retainedWin.click(1, 1)",
			true,
		);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("allows a retained read-only window to mutate in a later exec run", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-read-only-window",
			'globalThis.retainedWin = await desktop.window("42")',
			true,
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-exec",
			"await globalThis.retainedWin.screenshot({ silent: true }); await globalThis.retainedWin.click(1, 1)",
		);
		expect(second.ok).toBe(true);
		expect(native.clickCount).toBe(1);
	});

	it("denies async continuations leaked from an ended run the next run's authority", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		// Run 1 (exec) leaks a promise continuation that clicks once triggered.
		// The continuation is registered inside run 1's async context, so it must
		// retain run 1's (aborted) context even when it executes during run 2.
		const first = await runWorker(
			transport,
			"leak-continuation",
			[
				'globalThis.leakWin = await desktop.window("42");',
				"globalThis.leakErr = null;",
				"const { promise: trigger, resolve: fireLeak } = Promise.withResolvers(); globalThis.fireLeak = fireLeak;",
				"globalThis.leakDone = trigger.then(() => globalThis.leakWin.click(1, 1)).catch(err => { globalThis.leakErr = String(err); });",
				'"armed"',
			].join("\n"),
		);
		expect(first.ok).toBe(true);
		// Run 2 (exec) fires the leaked continuation and awaits its settlement; the
		// click must fail with run 1's abort instead of borrowing run 2's policy.
		const second = await runWorker(
			transport,
			"leak-victim",
			"globalThis.fireLeak(); await globalThis.leakDone; globalThis.leakErr",
		);
		expect(second.ok).toBe(true);
		if (second.ok) expect(String(second.payload.returnValue)).toContain("Computer run ended");
		expect(native.clickCount).toBe(0);
	});

	it("uses a retained AX element in the current run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-element",
			'globalThis.retainedEl = (await (await desktop.window("42")).find({ role: "button" }))[0]',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(transport, "reuse-element", "await globalThis.retainedEl.bounds()");
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.payload.returnValue).toEqual({ x: 7, y: 8, width: 9, height: 10 });
	});

	it("answers a direct capabilities request without a prior run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({ type: "capabilities", id: "caps", session: snapshot(true) });
		const reply = await transport.waitFor(message => message.type === "capabilities" && message.id === "caps");
		expect(reply.type).toBe("capabilities");
		if (reply.type !== "capabilities" || !reply.ok) throw new Error("expected a successful capabilities reply");
		expect(reply.capabilities).toEqual(capabilities);
	});

	it("creates the native session once when a run and capabilities race a cold worker", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		let creations = 0;
		const release = Promise.withResolvers<void>();
		// Async factory reproduces the real `import(...)` suspension so both
		// handlers reach session creation before it resolves.
		new ComputerWorkerCore(transport, async () => {
			creations += 1;
			await release.promise;
			return native;
		});

		transport.inbound({ type: "run", id: "race-run", code: "42", timeoutMs: 2_000, session: snapshot(true) });
		transport.inbound({ type: "capabilities", id: "race-caps", session: snapshot(true) });
		release.resolve();

		const runReply = await transport.waitFor(message => message.type === "result" && message.id === "race-run");
		const capsReply = await transport.waitFor(
			message => message.type === "capabilities" && message.id === "race-caps",
		);
		expect(runReply.type === "result" && runReply.ok).toBe(true);
		expect(capsReply.type === "capabilities" && capsReply.ok).toBe(true);
		expect(creations).toBe(1);
	});

	it("keeps retained window fields as snapshots while state() reads the moved window", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const result = await runWorker(
			transport,
			"window-geometry",
			[
				'const win = await desktop.window("42");',
				"const before = { ...win.bounds };",
				"await win.moveTo({ x: 12, y: 14 });",
				"const moved = await win.state();",
				"await win.moveBy({ dx: -2, dy: 3 });",
				"const shifted = await win.state();",
				"await win.resize({ width: 50 });",
				"const resized = await win.state();",
				"await win.center();",
				"({",
				"  before,",
				"  snapshotBounds: { ...win.bounds },",
				"  moved: moved.window,",
				"  shifted: [shifted.window.x, shifted.window.y],",
				"  resized: [resized.window.width, resized.window.height],",
				"  centered: (await win.state()).window,",
				"})",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).toEqual({
			before: { x: 4, y: 5, width: 40, height: 20 },
			// The handle keeps the descriptor it resolved with; only state() is a fresh read.
			snapshotBounds: { x: 4, y: 5, width: 40, height: 20 },
			moved: { ...windowFixture, x: 12, y: 14 },
			shifted: [10, 17],
			resized: [50, 20],
			centered: { ...windowFixture, x: 7, y: 6, width: 50, height: 20 },
		});
	});

	it("distinguishes the idempotent setters from the toggles by repeating them and reading state back", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const result = await runWorker(
			transport,
			"window-state-toggles",
			[
				'const win = await desktop.window("42");',
				"const read = async () => await win.state();",
				"await win.maximize();",
				"await win.maximize();",
				"const maximized = await read();",
				"await win.restore();",
				"const restored = await read();",
				"await win.minimize();",
				"const minimized = await read();",
				"await win.setFloating({ enabled: true });",
				"const floating = await read();",
				"await win.setFullscreen({ enabled: true });",
				"await win.setFullscreen({ enabled: true });",
				"const full = await read();",
				"await win.setFullscreen({ enabled: false });",
				"await win.setFullscreen({ enabled: false });",
				"const unfilled = await read();",
				"await win.toggleMaximized();",
				"const toggled = await read();",
				"await win.toggleMaximized();",
				"const untiled = await read();",
				"await win.toggleFullscreen();",
				"const toggledFull = await read();",
				"await win.toggleFullscreen();",
				"const untiledFull = await read();",
				"({",
				"  maximize: [maximized.maximized, maximized.window],",
				"  restore: [restored.maximized, restored.minimized, restored.window],",
				"  minimize: minimized.minimized,",
				"  floating: floating.floating,",
				"  fullscreen: [full.fullscreen, full.window],",
				"  unfilled: [unfilled.fullscreen, unfilled.window],",
				"  toggleMaximized: [toggled.maximized, untiled.maximized],",
				"  toggleFullscreen: [toggledFull.fullscreen, untiledFull.fullscreen],",
				"})",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const filled = { ...windowFixture, x: 0, y: 0, width: 64, height: 32 };
		expect(result.payload.returnValue).toEqual({
			// Maximize and setFullscreen ran twice each and kept their state; sending a
			// toggle for either would have flipped it back on the second call.
			maximize: [true, filled],
			restore: [false, false, { ...windowFixture }],
			minimize: true,
			floating: true,
			fullscreen: [true, filled],
			unfilled: [false, { ...windowFixture }],
			toggleMaximized: [true, false],
			toggleFullscreen: [true, false],
		});
	});

	it("moves a window between workspaces and displays, and refocuses either", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(
			transport,
			() =>
				new FakeNativeSession({
					windows: [windowFixture, secondWindowFixture],
					displays: [display, secondDisplay],
				}),
		);

		const result = await runWorker(
			transport,
			"window-spaces",
			[
				'const win = await desktop.window("42");',
				'await win.moveToWorkspace({ workspaceId: "fake-workspace:2", focus: true });',
				"const moved = await win.state();",
				'await win.moveToDisplay({ displayId: "display-2" });',
				"const relocated = await win.state();",
				'await desktop.moveWorkspaceToDisplay({ workspaceId: "fake-workspace:2", displayId: "display-2" });',
				'await desktop.focusDisplay({ displayId: "display-2" });',
				"const afterDisplay = (await desktop.focusedWindow()).id;",
				'await desktop.focusWorkspace({ workspaceId: "fake-workspace:1" });',
				"({",
				"  moved: [moved.workspaceId, moved.window.focused],",
				"  relocated: [relocated.displayId, relocated.window.x],",
				"  afterDisplay,",
				"  afterWorkspace: (await desktop.focusedWindow()).id,",
				"  workspaces: (await desktop.workspaces()).map(w => [w.id, w.displayId, w.focused, w.activeWindowId]),",
				"})",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).toEqual({
			moved: ["fake-workspace:2", true],
			relocated: ["display-2", 68],
			afterDisplay: "42",
			afterWorkspace: "7",
			workspaces: [
				["fake-workspace:1", "display-1", true, "7"],
				["fake-workspace:2", "display-2", false, "42"],
			],
		});

		// Discovery never needs exec authority.
		const discovery = await runWorker(transport, "read-only-workspaces", "(await desktop.workspaces()).length", true);
		expect(discovery.ok).toBe(true);
		if (discovery.ok) expect(discovery.payload.returnValue).toBe(2);
	});

	it("moves a window to another workspace without stealing focus when focus is omitted", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession({ windows: [windowFixture, secondWindowFixture] }));

		const result = await runWorker(
			transport,
			"workspace-move-default-focus",
			[
				'const win = await desktop.window("7");',
				'await win.moveToWorkspace({ workspaceId: "fake-workspace:2" });',
				"({",
				"  workspaceId: (await win.state()).workspaceId,",
				"  focused: (await desktop.focusedWindow()).id,",
				"  workspaces: (await desktop.workspaces()).map(w => [w.id, w.focused, w.activeWindowId]),",
				"})",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// An omitted focus is the documented false default, not a hidden true: window 7
		// lands on workspace 2 while window 42 keeps focus and workspace 1 stays focused.
		expect(result.payload.returnValue).toEqual({
			workspaceId: "fake-workspace:2",
			focused: "42",
			workspaces: [
				["fake-workspace:1", true, "42"],
				["fake-workspace:2", false, "7"],
			],
		});
	});

	it("closes one window and leaves the desktop session running", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession({ windows: [windowFixture, secondWindowFixture] });
		new ComputerWorkerCore(transport, () => native);

		const closed = await runWorker(
			transport,
			"close-window",
			[
				"globalThis.closedWin = await desktop.window('42');",
				"await closedWin.close();",
				"(await desktop.windows()).map(w => w.id)",
			].join("\n"),
		);
		expect(closed.ok).toBe(true);
		if (closed.ok) expect(closed.payload.returnValue).toEqual(["7"]);
		expect(native.closeCount).toBe(0);

		const afterwards = await runWorker(
			transport,
			"after-window-close",
			[
				"let stateError = null;",
				"try {",
				"  await closedWin.state();",
				"} catch (error) {",
				"  stateError = error.message;",
				"}",
				"({ ids: (await desktop.windows()).map(w => w.id), stateError })",
			].join("\n"),
		);
		expect(afterwards.ok).toBe(true);
		if (afterwards.ok) {
			const payload = afterwards.payload.returnValue as { ids: string[]; stateError: string | null };
			expect(payload.ids).toEqual(["7"]);
			// The native code survives the round trip; the sentence behind it is the backend's.
			expect(payload.stateError).toMatch(/^WindowNotFound:/);
		}

		transport.inbound({ type: "close" });
		await transport.waitFor(message => message.type === "closed");
		expect(native.closeCount).toBe(1);
	});

	it("refuses a window control mutation in a read-only run without touching the window", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession({ windows: [windowFixture, secondWindowFixture] });
		new ComputerWorkerCore(transport, () => native);

		const blocked = await runWorker(
			transport,
			"read-only-focus",
			[
				'const readOnly = await (await desktop.window("7")).state();',
				'if (readOnly.window.id !== "7") throw new Error("state read failed");',
				"await (await desktop.window('7')).focus();",
				'"unreachable"',
			].join("\n"),
			true,
		);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.message).toBe("read-only run: 'focus' requires read_only: false");
		expect(native.controlCount).toBe(0);

		const focused = await runWorker(
			transport,
			"exec-focus",
			["await (await desktop.window('7')).focus();", "(await desktop.focusedWindow()).id"].join("\n"),
		);
		expect(focused.ok).toBe(true);
		if (focused.ok) expect(focused.payload.returnValue).toBe("7");
	});

	it("refuses control mutations from a retained handle under a read-only or ended run", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const armed = await runWorker(
			transport,
			"retain-window",
			'globalThis.retainedWin = await desktop.window("42"); "armed"',
		);
		expect(armed.ok).toBe(true);

		const readOnly = await runWorker(
			transport,
			"retained-read-only",
			"await globalThis.retainedWin.moveTo({ x: 1, y: 2 })",
			true,
		);
		expect(readOnly.ok).toBe(false);
		if (!readOnly.ok) expect(readOnly.error.message).toBe("read-only run: 'moveTo' requires read_only: false");

		const leaking = await runWorker(
			transport,
			"arm-control-leak",
			[
				"const { promise: trigger, resolve: fire } = Promise.withResolvers();",
				"globalThis.fireLeak = fire;",
				"globalThis.leakDone = trigger",
				"  .then(() => globalThis.retainedWin.close())",
				"  .catch(error => { globalThis.leakErr = error.message; });",
				// Ending on the pending chain would make this run's completion value a
				// promise the worker waits on, so the arming run must return a literal.
				'"armed"',
			].join("\n"),
		);
		expect(leaking.ok).toBe(true);
		if (leaking.ok) expect(leaking.payload.returnValue).toBe("armed");
		const victim = await runWorker(
			transport,
			"fire-control-leak",
			"globalThis.fireLeak(); await globalThis.leakDone; globalThis.leakErr",
		);
		expect(victim.ok).toBe(true);
		if (victim.ok) expect(String(victim.payload.returnValue)).toContain("Computer run ended");
		expect(native.controlCount).toBe(0);

		const preserved = await runWorker(
			transport,
			"preserved-window",
			"(await (await desktop.window('42')).state()).window",
		);
		expect(preserved.ok).toBe(true);
		if (preserved.ok) expect(preserved.payload.returnValue).toEqual(windowFixture);
	});

	it("fails with ControlUnsupported when the addon predates window control", async () => {
		const transport = new MemoryTransport();
		const native = legacySession();
		new ComputerWorkerCore(transport, () => native);

		const state = await runWorker(transport, "legacy-state", 'await (await desktop.window("42")).state()');
		expect(state.ok).toBe(false);
		if (!state.ok)
			expect(state.error.message).toBe(
				"ControlUnsupported: window state is unavailable on the fake desktop backend",
			);

		const workspaces = await runWorker(transport, "legacy-workspaces", "await desktop.workspaces()");
		expect(workspaces.ok).toBe(false);
		if (!workspaces.ok)
			expect(workspaces.error.message).toBe(
				"ControlUnsupported: workspace listing is unavailable on the fake desktop backend",
			);

		const focus = await runWorker(transport, "legacy-focus", 'await (await desktop.window("42")).focus()');
		expect(focus.ok).toBe(false);
		if (!focus.ok)
			expect(focus.error.message).toBe("ControlUnsupported: focusWindow is unavailable on the fake desktop backend");

		// Discovery that never needed the control surface still reads the live window.
		const windows = await runWorker(
			transport,
			"legacy-windows",
			"(await desktop.windows()).map(w => [w.id, w.focused])",
		);
		expect(windows.ok).toBe(true);
		if (windows.ok) expect(windows.payload.returnValue).toEqual([["42", true]]);
	});

	it("refuses an operation the backend never advertised and leaves the window alone", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession({ operations: ["focusWindow", "closeWindow"] });
		new ComputerWorkerCore(transport, () => native);

		const minimized = await runWorker(
			transport,
			"unadvertised-minimize",
			'await (await desktop.window("42")).minimize()',
		);
		expect(minimized.ok).toBe(false);
		if (!minimized.ok) {
			expect(minimized.error.message).toContain("ControlUnsupported");
			expect(minimized.error.message).toContain("minimizeWindow");
		}
		// The refusal is the worker's own: the backend never received the action.
		expect(native.receivedActions).toEqual([]);

		const preserved = await runWorker(
			transport,
			"unadvertised-state",
			"(await (await desktop.window('42')).state()).minimized",
		);
		expect(preserved.ok).toBe(true);
		if (preserved.ok) expect(preserved.payload.returnValue).toBe(false);

		const focus = await runWorker(
			transport,
			"unadvertised-focus",
			['await (await desktop.window("42")).focus();', '"focused"'].join("\n"),
		);
		expect(focus.ok).toBe(true);
		if (focus.ok) expect(focus.payload.returnValue).toBe("focused");
	});

	it("refuses every mutation when the addon advertises a control backend with no operations", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession({ operations: [], windows: [windowFixture, secondWindowFixture] });
		new ComputerWorkerCore(transport, () => native);

		const focus = await runWorker(transport, "empty-operations-focus", 'await (await desktop.window("7")).focus()');
		expect(focus.ok).toBe(false);
		if (!focus.ok) expect(focus.error.message).toContain("ControlUnsupported");
		// The block is present but advertises nothing, so the worker must refuse the
		// action itself instead of handing it to a backend that cannot run it.
		expect(native.receivedActions).toEqual([]);

		const focused = await runWorker(transport, "empty-operations-focused", "(await desktop.focusedWindow()).id");
		expect(focused.ok).toBe(true);
		if (focused.ok) expect(focused.payload.returnValue).toBe("42");
	});

	it("refuses malformed control options before any native action reaches the backend", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession({ windows: [windowFixture, secondWindowFixture] });
		new ComputerWorkerCore(transport, () => native);

		const refused = await runWorker(
			transport,
			"malformed-control-options",
			[
				'globalThis.win = await desktop.window("42");',
				"globalThis.refusals = {};",
				"const refuse = async (name, call) => {",
				"  try {",
				"    await call();",
				"  } catch (error) {",
				"    globalThis.refusals[name] = String(error?.message ?? error);",
				"  }",
				"};",
				'await refuse("resize-no-axis", () => globalThis.win.resize({}));',
				'await refuse("resize-zero", () => globalThis.win.resize({ width: 0 }));',
				'await refuse("resize-fraction", () => globalThis.win.resize({ height: 12.5 }));',
				'await refuse("move-to-missing-x", () => globalThis.win.moveTo({ y: 5 }));',
				'await refuse("move-to-infinite", () => globalThis.win.moveTo({ x: Infinity, y: 5 }));',
				'await refuse("set-fullscreen-missing", () => globalThis.win.setFullscreen({}));',
				'await refuse("set-floating-string", () => globalThis.win.setFloating({ enabled: "yes" }));',
				'await refuse("workspace-missing-id", () => globalThis.win.moveToWorkspace({}));',
				'await refuse("workspace-focus-string", () => globalThis.win.moveToWorkspace({ workspaceId: "fake-workspace:2", focus: "yes" }));',
				'await refuse("workspace-focus-number", () => globalThis.win.moveToWorkspace({ workspaceId: "fake-workspace:2", focus: 1 }));',
				'await refuse("display-missing-id", () => desktop.focusDisplay({}));',
				'await refuse("workspace-root-missing-id", () => desktop.focusWorkspace({}));',
				"({ refusals: globalThis.refusals, state: await globalThis.win.state() })",
			].join("\n"),
		);
		expect(refused.ok).toBe(true);
		if (!refused.ok) return;
		const payload = refused.payload.returnValue as {
			refusals: Record<string, string>;
			state: DesktopWindowState;
		};
		// Only a rejected call records a key, so every malformed call refused.
		expect(Object.keys(payload.refusals).sort()).toEqual([
			"display-missing-id",
			"move-to-infinite",
			"move-to-missing-x",
			"resize-fraction",
			"resize-no-axis",
			"resize-zero",
			"set-floating-string",
			"set-fullscreen-missing",
			"workspace-focus-number",
			"workspace-focus-string",
			"workspace-missing-id",
			"workspace-root-missing-id",
		]);
		// None of them failed inside the backend, which is where a coerced or missing
		// option would otherwise surface as a half-applied mutation.
		for (const [name, message] of Object.entries(payload.refusals))
			expect(`${name}: ${message}`).not.toMatch(
				/^(ControlUnsupported|ControlFailed|InvalidTarget|WindowNotFound|StaleRef|InvalidCoordinateFrame)/,
			);
		expect(native.receivedActions).toEqual([]);
		expect(payload.state).toEqual({
			window: { ...windowFixture },
			workspaceId: "fake-workspace:1",
			displayId: "display-1",
			floating: false,
			maximized: false,
			minimized: false,
			fullscreen: false,
		});
	});

	it("denies coordinate input anchored to a frame an accepted mutation invalidated", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const stale = await runWorker(
			transport,
			"frame-stale-click",
			[
				'const win = await desktop.window("42");',
				"await win.screenshot({ silent: true });",
				"await win.moveTo({ x: 20, y: 24 });",
				"await win.click(1, 1);",
			].join("\n"),
		);
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.error.message).toContain("InvalidCoordinateFrame");
		expect(native.clickCount).toBe(0);

		// The move itself applied: the frame was dropped, not the mutation.
		const moved = await runWorker(
			transport,
			"frame-move-applied",
			"(await (await desktop.window('42')).state()).window.x",
		);
		expect(moved.ok).toBe(true);
		if (moved.ok) expect(moved.payload.returnValue).toBe(20);

		const recaptured = await runWorker(
			transport,
			"frame-recaptured",
			[
				'const win = await desktop.window("42");',
				"await win.screenshot({ silent: true });",
				"await win.click(1, 1);",
				'"clicked"',
			].join("\n"),
		);
		expect(recaptured.ok).toBe(true);
		if (recaptured.ok) expect(recaptured.payload.returnValue).toBe("clicked");
		expect(native.clickCount).toBe(1);
	});

	it("refuses an ambiguous window selector instead of guessing one window", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(
			transport,
			() =>
				new FakeNativeSession({
					windows: [windowFixture, { ...secondWindowFixture, app: "Code", title: "Notes" }],
				}),
		);

		const result = await runWorker(transport, "ambiguous-window", 'await desktop.window({ app: "Code" })');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain('multiple windows match {"app":"Code"}');
		expect(result.error.message).toContain('42 Code "Editor"');
		expect(result.error.message).toContain('7 Code "Notes"');
	});
});

class SupervisorWorker implements ComputerWorkerHandle {
	readonly #respond: boolean;
	#messageHandlers = new Set<(message: ComputerWorkerOutbound) => void>();
	#terminated = false;

	constructor(respond: boolean) {
		this.#respond = respond;
	}
	send(message: ComputerWorkerInbound): void {
		if (message.type === "run" && this.#respond) {
			queueMicrotask(() =>
				this.#emit({
					type: "result",
					id: message.id,
					ok: true,
					payload: { displays: [], returnValue: "fresh", screenshots: [], capabilities },
				}),
			);
		} else if (message.type === "capabilities" && this.#respond) {
			queueMicrotask(() => this.#emit({ type: "capabilities", id: message.id, ok: true, capabilities }));
		} else if (message.type === "close") {
			queueMicrotask(() => this.#emit({ type: "closed" }));
		}
	}
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		queueMicrotask(() => this.#emit({ type: "ready" }));
		return () => this.#messageHandlers.delete(handler);
	}
	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {
		this.#terminated = true;
	}
	#emit(message: ComputerWorkerOutbound): void {
		if (this.#terminated) return;
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("computer supervisor recovery", () => {
	it("surfaces a timeout ToolError and creates a fresh worker for the next run", async () => {
		let workers = 0;
		const supervisor = new ComputerSupervisor(toolSession(), () => new SupervisorWorker(++workers > 1), {
			startMs: 200,
			closeMs: 200,
		});
		await expect(supervisor.run("await new Promise(() => {})", 5, snapshot())).rejects.toEqual(
			expect.objectContaining({
				name: "ToolError",
				message: "computer worker restarted; captures and ax refs were reset",
			}),
		);
		const result = await supervisor.run("41 + 1", 1_000, snapshot());
		expect(result.returnValue).toBe("fresh");
		expect(workers).toBe(2);
		await supervisor.close();
	});

	it("resolves direct capabilities before any run instead of a stale cache", async () => {
		const supervisor = new ComputerSupervisor(toolSession(), () => new SupervisorWorker(true), {
			startMs: 200,
			closeMs: 200,
		});
		// Regression (#11169): capabilities() used to return the run-populated
		// cache, so a fresh session yielded undefined until a run happened.
		const direct = await supervisor.capabilities(snapshot(true));
		expect(direct).toEqual(capabilities);
		await supervisor.close();
	});
});
