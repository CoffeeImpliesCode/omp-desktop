import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createContext, runInContext } from "node:vm";
import { scheduler } from "node:timers/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { isReadOnlyComputerCall, renderComputerCall } from "@oh-my-pi/pi-coding-agent/tools/computer/call";
import type {
	ComputerRunOk,
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import {
	type ComputerController,
	type ComputerSettleReport,
	ComputerSupervisor,
	type ComputerWorkerHandle,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type {
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	CaptureRegion,
	DesktopCapabilities,
	DesktopControlAction,
	DesktopControlCapabilities,
	DesktopCapture,
	DesktopDisplay,
	DesktopPoint,
	DesktopWindow,
	DesktopWindowState,
	DesktopWorkspace,
	PointerOptions,
} from "@oh-my-pi/pi-natives";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

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
	globalEscape: true,
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
	windowControl: controlCapabilities,
	applications: true,
	menus: true,
	heldInput: true,
	spaces: true,
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

/** One captured frame; `displays` rides desktop captures, in the capture's own pixels. */
interface FakeFrame {
	data: Uint8Array;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	coordinateWidth: number;
	coordinateHeight: number;
	region?: CaptureRegion;
	target: string;
	displays: DesktopDisplay[];
	backend: string;
	displayServer?: string;
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
	/** Capture caps each `capture()` call was given, in order. */
	captureCaps: Array<{ maxWidth?: number; maxHeight?: number }> = [];
	/** Frame the captures answer with; the fixed 64×32 frame when unset. */
	captureFrame?: (target: string) => FakeFrame;
	/** Actions that reached the native boundary, including ones the backend itself refuses. */
	readonly receivedActions: DesktopControlAction[] = [];
	cancelCount = 0;
	retireCount = 0;
	controlActive = false;
	acquireCount = 0;
	readonly operations: string[] = [];
	readonly inputModes: boolean[] = [];
	sourceWidth = 64;
	sourceHeight = 32;
	coordinateWidth = 64;
	coordinateHeight = 32;
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
	async capture(target: string, caps?: { maxWidth?: number; maxHeight?: number } | null): Promise<DesktopCapture> {
		this.captureCaps.push({ ...caps });
		this.#frames.add(target);
		const frame = this.captureFrame?.(target) ?? {
			data: Uint8Array.of(137, 80, 78, 71),
			width: 64,
			height: 32,
			sourceWidth: this.sourceWidth,
			sourceHeight: this.sourceHeight,
			coordinateWidth: this.coordinateWidth,
			coordinateHeight: this.coordinateHeight,
			target,
			displays: [display],
			backend: "fake",
		};
		return {
			...frame,
			coordinateWidth: frame.coordinateWidth ?? this.sourceWidth,
			coordinateHeight: frame.coordinateHeight ?? this.sourceHeight,
			displays: frame.displays ?? [display],
			backend: frame.backend ?? "fake",
			displayServer: frame.displayServer,
		};
	}
	async captureRegion(_target: string, _region: CaptureRegion): Promise<DesktopCapture> {
		throw new Error("Unexpected region capture");
	}
	cancel(): void {
		this.cancelCount += 1;
		this.controlActive = false;
	}
	retire(): void {
		this.retireCount += 1;
	}
	async listApplications() {
		return [{ id: "test.editor", name: "Editor", path: "/Applications/Editor.app", running: true, pid: 123 }];
	}
	async openApplication(id: string) {
		this.operations.push(`open:${id}`);
		return (await this.listApplications())[0]!;
	}
	async menuItems(_target: string, path: string[] = []) {
		return [{ title: "Save", path: [...path, "Save"], enabled: true, checked: false, hasSubmenu: false }];
	}
	async menuSelect(target: string, path: string[]) {
		this.operations.push(`menu:${target}:${path.join("/")}`);
	}
	async observe(target: string) {
		return {
			capture: await this.capture(target),
			accessibility: { text: "- button [ref=e1]", nodeCount: 1, truncated: false },
		};
	}
	async holdKeys(target: string, keys: string[], options: { duration: number }) {
		this.operations.push(`holdKeys:${target}:${keys.join("+")}:${options.duration}`);
	}
	async holdMouse(target: string, x: number, y: number, options: { duration: number }) {
		this.operations.push(`holdMouse:${target}:${x},${y}:${options.duration}`);
	}
	async acquireControl() {
		this.acquireCount += 1;
		this.controlActive = true;
		return { active: true };
	}
	releaseControl(): void {
		this.controlActive = false;
	}
	controlState() {
		return { active: this.controlActive };
	}
	async bringToCurrentSpace(target: string) {
		this.operations.push(`space:${target}`);
	}
	async click(target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.#requireFrame(target);
		this.clickCount += 1;
		this.inputModes.push(_opts?.takeover ?? this.controlActive);
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
	async raiseWindow(_windowId: string): Promise<void> {}
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
		this.controlActive = false;
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

/** A backend with independent full frames and native-detail crops, not a facade response stub. */
class ZoomNativeSession extends FakeNativeSession {
	readonly fullFrames = new Map<string, DesktopCapture>();
	readonly fullCaptureCounts = new Map<string, number>();
	readonly clicks: Array<{ target: string; x: number; y: number }> = [];

	override async capture(target: string): Promise<DesktopCapture> {
		const frame = await super.capture(target);
		this.fullFrames.set(target, frame);
		this.fullCaptureCounts.set(target, (this.fullCaptureCounts.get(target) ?? 0) + 1);
		return frame;
	}

	override async captureRegion(target: string, region: CaptureRegion): Promise<DesktopCapture> {
		const frame = this.fullFrames.get(target);
		if (!frame) throw new Error(`InvalidCoordinateFrame: screenshot ${target} first`);
		return {
			...frame,
			width: 128,
			height: 64,
			sourceWidth: 128,
			sourceHeight: 64,
			region,
		};
	}

	override async click(target: string, x: number, y: number): Promise<void> {
		const frame = this.fullFrames.get(target);
		if (!frame || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
			throw new Error("InvalidCoordinateFrame: click outside the full screenshot");
		}
		this.clicks.push({ target, x, y });
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
	readonly listeners = new Set<(message: ComputerWorkerOutbound) => void>();
	#waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve: (message: ComputerWorkerOutbound) => void;
	}>();

	send(message: ComputerWorkerOutbound): void {
		this.outbound.push(message);
		for (const listener of this.listeners) listener(message);
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
	display: "active",
	readOnly,
});

async function runWorker(
	transport: MemoryTransport,
	id: string,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
	cellId?: string,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	transport.inbound({ type: "run", id, code, timeoutMs, session: { ...snapshot(readOnly), cellId } });
	const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
	if (message.type !== "result") throw new Error(`Expected computer result, received ${message.type}`);
	return message;
}

/** Settles the cell that just ended; `output` is what that cell printed. */
async function settleRun(
	transport: MemoryTransport,
	id: string,
	output = "",
	cellId?: string,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	// The `settle` verb arrives with the post-input report; the cast keeps this
	// request typed by its own shape rather than the protocol's earlier union.
	transport.inbound({
		type: "settle",
		id,
		timeoutMs: 5_000,
		session: { ...snapshot(true), cellId },
		output,
	} as unknown as ComputerWorkerInbound);
	const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
	if (message.type !== "result") throw new Error(`Expected computer result, received ${message.type}`);
	return message;
}

/** What a settle answered with; a failed settle is a bug in the test, not a report. */
async function settledPayload(
	transport: MemoryTransport,
	id: string,
	output = "",
	cellId?: string,
): Promise<ComputerRunOk> {
	const result = await settleRun(transport, id, output, cellId);
	if (!result.ok) throw new Error(`settle ${id} failed: ${result.error.message}`);
	return result.payload;
}

/** What a settle reported, or undefined when it had nothing to say. */
async function settleWorker(transport: MemoryTransport, id: string, output = "", cellId?: string): Promise<unknown> {
	const result = await settleRun(transport, id, output, cellId);
	if (!result.ok) throw new Error(`settle ${id} failed: ${result.error.message}`);
	return result.payload.returnValue;
}

/** A cell that prints the window's tree, settled: the model has now seen that tree. */
async function readCell(transport: MemoryTransport, id: string): Promise<string> {
	const read = await runWorker(transport, id, 'return await (await desktop.window("42")).ax()');
	if (!read.ok) throw new Error(`read ${id} failed: ${read.error.message}`);
	const tree = String(read.payload.returnValue);
	expect(await settleWorker(transport, `${id}-settle`, tree)).toBeUndefined();
	return tree;
}

/**
 * A window whose tree answers inputs the way an app does: pressing "Edit"
 * turns it into "Done" and reveals a field. Every snapshot mints fresh refs;
 * like the native registry, the current and the previous snapshot's refs
 * resolve and older ones throw `StaleRef`.
 */
class EditableWindowSession extends FakeNativeSession {
	editing = false;
	snapshots = 0;
	/** Read-only rows added to the tree, to push a report past its byte budget. */
	filler = 0;
	/** A prose line after the rows, like the walk's truncation trailers. */
	trailer = "";
	/** Value of the window's text row, to vary it between reads. */
	status = "Ready";
	/** Whether the window refuses accessibility reads. */
	axFails = false;
	windows: DesktopWindow[] = [windowFixture];
	#nextRef = 1;
	#live = new Set<string>();
	#previous = new Set<string>();

	#resolves(ref: string): boolean {
		return this.#live.has(ref) || this.#previous.has(ref);
	}

	override async listWindows(): Promise<DesktopWindow[]> {
		return this.windows;
	}

	override async axSnapshot(): Promise<{ text: string }> {
		if (this.axFails) throw new Error("AxFailed: window has no accessibility root");
		this.snapshots += 1;
		this.#previous = this.#live;
		this.#live = new Set();
		const ref = (): string => {
			const minted = `e${this.#nextRef++}`;
			this.#live.add(minted);
			return minted;
		};
		const rows = [
			`- window "Editor" [ref=${ref()}] app=Code (focused)`,
			`  - toolbar [ref=${ref()}]`,
			`    - button "${this.editing ? "Done" : "Edit"}" [ref=${ref()}]`,
			...(this.editing ? [`    - textfield "Phone" [ref=${ref()}]: "555"`] : []),
			`    - button "Share" [ref=${ref()}]`,
			`  - statictext [ref=${ref()}]: "${this.status}"`,
			...(this.filler > 0 ? [`  - list [ref=${ref()}]`] : []),
			...Array.from(
				{ length: this.filler },
				(_, index) => `    - statictext "Row ${index} of the ${this.status} transcript" [ref=${ref()}]`,
			),
		];
		return { text: [...rows, ...(this.trailer === "" ? [] : [this.trailer])].join("\n") };
	}

	override async axNode(ref: string): Promise<AxNode> {
		if (!this.#resolves(ref)) throw new Error(`StaleRef: ${ref} expired; re-run ax()/find()`);
		return { ...axNode, ref };
	}

	override async axPerform(ref: string, _action: string): Promise<void> {
		if (!this.#resolves(ref)) throw new Error(`StaleRef: ${ref} expired; re-run ax()/find()`);
		this.editing = !this.editing;
	}

	override async raiseWindow(_windowId: string): Promise<void> {
		// No-op for test
	}

	override async keyChord(_target: string, _keys: string[], _opts?: PointerOptions | null): Promise<void> {
		// No-op for test
	}
}
/** A controller carrying the settle verb a post-input report arrives through. */
type SettlingController = ComputerController & {
	settle(
		runSnapshot: ComputerSessionSnapshot,
		output: string,
		signal?: AbortSignal,
	): Promise<ComputerSettleReport | undefined>;
};

/** A controller that runs every call through a real worker core over `native`. */
function workerController(native: NativeDesktopSession): SettlingController {
	const transport = new MemoryTransport();
	new ComputerWorkerCore(transport, () => native);
	let runs = 0;
	let settles = 0;
	const controller: SettlingController = {
		async run(code) {
			const result = await runWorker(transport, `kernel-${++runs}`, code);
			if (!result.ok) {
				const error = result.error.isToolError
					? new ToolError(result.error.message)
					: new Error(result.error.message);
				error.name = result.error.name;
				throw error;
			}
			return result.payload;
		},
		async settle(_runSnapshot, output) {
			const id = `settle-${++settles}`;
			const result = await settleRun(transport, id, output);
			if (!result.ok) throw new Error(`${id} failed: ${result.error.message}`);
			const { returnValue, displays } = result.payload;
			const text = typeof returnValue === "string" ? returnValue : undefined;
			const images = displays.filter(block => block.type === "image");
			return text === undefined && images.length === 0 ? undefined : { text, images };
		},
		async capabilities() {
			return undefined;
		},
		async close() {},
	};
	return controller;
}

/** What a stubbed host controller answers with; every field is read per call. */
interface StubController {
	/** What a call resolves to, unless `failure` is set. */
	value?: unknown;
	/** Thrown by a call instead of answering. */
	failure?: Error;
	/** The post-input report a settle appends; undefined settles silently. */
	report?: string;
	/** Thrown by the settle instead of answering. */
	settleFailure?: Error;
	/** Runs inside the settle, before it answers. */
	onSettle?: () => void;
}

/** A host controller that answers from the stub the test mutates between calls. */
function stubController(stub: StubController): SettlingController {
	const controller: SettlingController = {
		async run() {
			if (stub.failure) throw stub.failure;
			return { displays: [], returnValue: stub.value, screenshots: [] };
		},
		async settle() {
			stub.onSettle?.();
			if (stub.settleFailure) throw stub.settleFailure;
			return stub.report === undefined ? undefined : { text: stub.report };
		},
		async capabilities() {
			return undefined;
		},
		async close() {},
	};
	return controller;
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

/** The identity a prelude sees for the eval cell its calls belong to. */
type PreludeCell = { readonly signal: AbortSignal };

/** What a prelude adds to a cell once that cell has ended. */
interface SettleReply {
	text?: string;
	images?: Array<{ data: string; mimeType: string }>;
}

/** A prelude definition carrying the settle hook the host invokes after a cell. */
type SettlingPrelude = EvalPreludeDefinition & {
	settleCell?(cell: PreludeCell, outcome: { failed: boolean; output: string }): Promise<SettleReply | undefined>;
};

/** Host context carrying the cell a prelude call belongs to. */
type CellAwareContext = Parameters<EvalPreludeDefinition["invoke"]>[1] & { cell?: PreludeCell };

/** Exercise the shipped host approval/call rendering and worker, with only native OS work substituted. */
function workerPrelude(session: ToolSession, native: NativeDesktopSession): EvalPreludeDefinition {
	const transport = new MemoryTransport();
	new ComputerWorkerCore(transport, () => native);
	return createComputerPrelude(session, () => ({
		async run(code, timeoutMs, runSnapshot) {
			const id = crypto.randomUUID();
			transport.inbound({ type: "run", id, code, timeoutMs, session: runSnapshot });
			const result = await transport.waitFor(message => message.type === "result" && message.id === id);
			if (result.type !== "result") throw new Error("Expected a computer result");
			if (!result.ok) throw new Error(result.error.message);
			return result.payload;
		},
		async capabilities() {
			return native.capabilities;
		},
		async close() {
			transport.inbound({ type: "close" });
			await transport.waitFor(message => message.type === "closed");
		},
	}));
}
afterAll(async () => {
	await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
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
			snapshot: { readOnly: true, display: "active" },
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

	it("keeps full target click frames across direct JavaScript and run zooms", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const emitted: unknown[] = [];
		const context = { session, toolCallId: "zoom-js" };
		const realm = createContext({
			__omp_display__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				emitted.push(...result.content);
				return {
					text: result.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n"),
					details: result.details,
				};
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const zooms = await runInContext(
				`(async () => {
					await computer.screenshot({ silent: true });
					const win = await computer.window(42);
					await win.screenshot({ silent: true });
					const region = { x: 8, y: 4, width: 16, height: 8 };
					const desktopZoom = await computer.zoom(region);
					const windowZoom = await win.zoom(region, { silent: true });
					await computer.click(60, 30);
					await win.click(60, 30);
					const runZoom = await computer.run(async ({ desktop }) => {
						const win = await desktop.window(42);
						const zoom = await win.zoom({ x: 8, y: 4, width: 16, height: 8 }, { silent: true });
						await win.click(60, 30);
						return zoom;
					});
					return [desktopZoom, windowZoom, runZoom];
				})()`,
				realm,
			);
			for (const zoom of zooms) {
				expect(zoom.path).toMatch(/omp-computer-.*\.png$/);
				expect(zoom).toMatchObject({
					width: 128,
					height: 64,
					coordinateWidth: 64,
					coordinateHeight: 32,
					region: { x: 8, y: 4, width: 16, height: 8 },
				});
			}
			expect(native.fullCaptureCounts).toEqual(
				new Map([
					["desktop", 1],
					["42", 1],
				]),
			);
			expect(native.clicks).toEqual([
				{ target: "desktop", x: 60, y: 30 },
				{ target: "42", x: 60, y: 30 },
				{ target: "42", x: 60, y: 30 },
			]);
			expect(emitted).toContainEqual({
				type: "image",
				data: "iVBORw==",
				mimeType: "image/png",
				detail: "original",
			});
			expect(emitted).toContainEqual({
				type: "text",
				text: expect.stringContaining(
					'region={"x":8,"y":4,"width":16,"height":8}; coordinateWidth=64 coordinateHeight=32; use the base full screenshot coordinates for input, not zoom pixels',
				),
			});
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("keeps full target click frames across direct Python and run zooms", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"import json",
					"await computer.screenshot(silent=True)",
					"win = await computer.window(42)",
					"await win.screenshot(silent=True)",
					'region = {"x": 8, "y": 4, "width": 16, "height": 8}',
					"desktop_zoom = await computer.zoom(region, silent=True)",
					"window_zoom = await win.zoom(region, silent=True)",
					"await computer.click(60, 30)",
					"await win.click(60, 30)",
					`run_zoom = await computer.run('const zoom = await desktop.zoom({ x: 8, y: 4, width: 16, height: 8 }, { silent: true }); await desktop.click(60, 30); return zoom;')`,
					"print(json.dumps([desktop_zoom, window_zoom, run_zoom]))",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-zoom-py-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			const zooms = JSON.parse(result.output.trim());
			expect(zooms).toHaveLength(3);
			for (const zoom of zooms) {
				expect(zoom).toMatchObject({
					width: 128,
					height: 64,
					coordinateWidth: 64,
					coordinateHeight: 32,
					region: { x: 8, y: 4, width: 16, height: 8 },
				});
			}
			expect(native.fullCaptureCounts).toEqual(
				new Map([
					["desktop", 1],
					["42", 1],
				]),
			);
			expect(native.clicks).toEqual([
				{ target: "desktop", x: 60, y: 30 },
				{ target: "42", x: 60, y: 30 },
				{ target: "desktop", x: 60, y: 30 },
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "zoom-py-close" });
		}
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

	it("settles only cells whose code reached the desktop, and says when a settle fails", async () => {
		const stub: StubController = { report: 'window "42" after press e3 — current tree:' };
		const prelude = createComputerPrelude(toolSession(), () => stubController(stub)) as SettlingPrelude;
		const press = {
			action: "call",
			chain: [
				{ method: "ref", args: ["e3"] },
				{ method: "press", args: [] },
			],
		};
		const acting: PreludeCell = { signal: new AbortController().signal };
		const idle: PreludeCell = { signal: new AbortController().signal };
		const actingContext: CellAwareContext = { session: toolSession(), toolCallId: "press", cell: acting };
		await prelude.invoke(press, actingContext);
		expect(await prelude.settleCell?.(idle, { failed: false, output: "" })).toBeUndefined();
		expect(await prelude.settleCell?.(acting, { failed: false, output: "" })).toEqual({
			text: 'window "42" after press e3 — current tree:',
		});
		// Settled once: the cell is reported, not re-reported on every later turn.
		expect(await prelude.settleCell?.(acting, { failed: false, output: "" })).toBeUndefined();

		stub.settleFailure = new Error("computer worker restarted; captures and ax refs were reset");
		const broken: PreludeCell = { signal: new AbortController().signal };
		const brokenContext: CellAwareContext = { session: toolSession(), toolCallId: "press-2", cell: broken };
		await prelude.invoke(press, brokenContext);
		expect((await prelude.settleCell?.(broken, { failed: false, output: "" }))?.text).toContain(
			"No post-input report for this cell (computer worker restarted",
		);
	});

	it("appends the guide once per conversation to the cell of its first window lookup, hit or miss", async () => {
		let conversation = "session-a";
		let readActive = true;
		const session: ToolSession = {
			...toolSession(),
			getSessionId: () => conversation,
			isToolActive: (name: string) => name !== "read" || readActive,
		};
		const stub: StubController = { value: { id: "42", app: "Code", title: "main.ts", focused: true } };
		// The turn a cell belongs to, aborted while that cell's report settles.
		let abortedWhileSettling: AbortController | undefined;
		stub.onSettle = () => abortedWhileSettling?.abort();
		const prelude = createComputerPrelude(session, () => stubController(stub)) as SettlingPrelude;
		/** Run one cell of direct calls (each `[method, …]` a chain), then settle it unless cancelled. */
		const cell = async (chains: string[][], end: "settle" | "cancel" | "abort" = "settle") => {
			const turn = new AbortController();
			const current: PreludeCell = { signal: turn.signal };
			for (const methods of chains) {
				const chain = methods.map(method => ({
					method,
					args: method === "window" ? [{ app: "Reminders" }] : [],
				}));
				const context: CellAwareContext = { session, toolCallId: methods[0]!, cell: current };
				await prelude.invoke({ action: "call", chain }, context).catch(() => undefined);
			}
			if (end === "cancel") {
				turn.abort();
				return undefined;
			}
			abortedWhileSettling = end === "abort" ? turn : undefined;
			return (await prelude.settleCell?.(current, { failed: stub.failure !== undefined, output: "" }))?.text;
		};

		// Other calls, and window methods on a handle, never bring it.
		expect(await cell([["windows"], ["window", "ax"]])).toBeUndefined();
		// A miss brings it, caught or not; later lookups do not.
		stub.failure = new ToolError('no window matches {"app":"Reminders"}');
		expect(await cell([["window"]])).toContain(prelude.documentation!);
		expect(await cell([["window"]])).toBeUndefined();
		stub.failure = undefined;
		expect(await cell([["focusedWindow"]])).toBeUndefined();
		// A cancelled cell is never settled, and a turn aborted while settling is not answered, so the next
		// lookup still brings it; so does a null focusedWindow().
		conversation = "session-b";
		stub.value = null;
		expect(await cell([["focusedWindow"]], "cancel")).toBeUndefined();
		expect(await cell([["focusedWindow"]], "abort")).toBeUndefined();
		expect(await cell([["focusedWindow"]])).toContain(prelude.documentation!);
		conversation = "session-a";
		expect(await cell([["window"]])).toBeUndefined();
		// A session without `read` has the guide inline in the eval description instead.
		conversation = "session-c";
		readActive = false;
		expect(await cell([["window"]])).toBeUndefined();
	});

	it("puts the guide ahead of the post-input report of the first lookup's cell", async () => {
		const session: ToolSession = { ...toolSession(), getSessionId: () => "session" };
		const report = 'window "42" after press e3 — current tree:';
		const prelude = createComputerPrelude(session, () =>
			stubController({
				value: { id: "42", app: "Code", title: "main.ts" },
				report,
			}),
		) as SettlingPrelude;
		const current: PreludeCell = { signal: new AbortController().signal };
		const lookup: CellAwareContext = { session, toolCallId: "window", cell: current };
		await prelude.invoke({ action: "call", chain: [{ method: "window", args: [{ app: "Code" }] }] }, lookup);

		const text = (await prelude.settleCell?.(current, { failed: false, output: "" }))?.text ?? "";
		expect(text).toContain(prelude.documentation!);
		expect(text).toContain(report);
		expect(text.indexOf(prelude.documentation!)).toBeLessThan(text.indexOf(report));
	});

	it("appends the guide after the first lookup's cell through the eval tool in JavaScript and Python", async () => {
		const native = new FakeNativeSession();
		native.listWindows = async () => [
			windowFixture,
			{ ...windowFixture, id: "67", app: "Reminders", title: "Reminders", pid: 11, focused: false },
		];
		let conversation = "js";
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = {
			...toolSession(),
			settings: Settings.isolated({ "computer.enabled": true, "async.enabled": false }),
			getSessionId: () => conversation,
			getEvalSessionId: () => `computer-guide-${conversation}`,
			getEvalPreludes: () => definitions,
		};
		const prelude = createComputerPrelude(session, () => workerController(native));
		definitions = [prelude];
		const tool = new EvalTool(session);
		const output = async (language: "js" | "py", code: string): Promise<string> =>
			(await tool.execute(`guide-${language}-${crypto.randomUUID()}`, { language, code })).content
				.map(block => (block.type === "text" ? block.text : ""))
				.join("");
		const guide = prelude.documentation!;

		// A miss the cell swallows still brings it, after the cell's own output.
		const swallowed = await output(
			"js",
			'try { await computer.window({ app: "Contacts" }); } catch {} print("after");',
		);
		expect(swallowed).toContain(guide);
		expect(swallowed.indexOf("after")).toBeLessThan(swallowed.indexOf(guide));
		expect(await output("js", 'print((await computer.window({ app: "Reminders" })).title);')).toBe("Reminders");

		conversation = "py";
		const failed = await output("py", 'await computer.window({"app": "Contacts"})');
		expect(failed).toContain("Contacts");
		expect(failed).toContain(guide);
		expect(await output("py", 'print((await computer.window({"app": "Reminders"})).title)')).toBe("Reminders");
	});
});

describe("computer worker round trips", () => {
	it("lists windows and returns screenshot caption, image, and detail through a fake native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, options => {
			expect(options).toEqual({ display: "active" });
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
		expect(texts[0]?.text).toMatch(
			/^screenshot desktop 64×32; coordinateWidth=64 coordinateHeight=32 → .*omp-computer-.*\.png$/,
		);
		expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png", detail: "original" }]);
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
				text: expect.stringMatching(
					/^screenshot desktop 64×32 \(scaled from 128×64\); coordinateWidth=64 coordinateHeight=32 → .*omp-computer-.*\.png$/,
				),
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

	it.each(["abort", "timeout"] as const)("cancels native work on %s and reuses the same session", async reason => {
		const started = Promise.withResolvers<void>();
		const pendingCapture = Promise.withResolvers<DesktopCapture>();
		class CancellableSession extends FakeNativeSession {
			#block = true;

			override async capture(
				target: string,
				caps?: { maxWidth?: number; maxHeight?: number } | null,
			): Promise<DesktopCapture> {
				if (!this.#block) return super.capture(target, caps);
				this.#block = false;
				started.resolve();
				return pendingCapture.promise;
			}

			override cancel(): void {
				super.cancel();
				pendingCapture.reject(new Error("Cancelled: native capture stopped"));
			}
		}
		const native = new CancellableSession();
		const transport = new MemoryTransport();
		let creations = 0;
		new ComputerWorkerCore(transport, () => {
			creations += 1;
			return native;
		});
		const pending = runWorker(
			transport,
			"cancel-native",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
			false,
			reason === "timeout" ? 100 : 2_000,
		);
		await started.promise;
		if (reason === "abort") {
			transport.inbound({ type: "abort", id: "cancel-native" });
			// The native signal is synchronous, not deferred until Promise.race settles.
			expect(native.cancelCount).toBe(1);
		}
		const cancelled = await pending;
		expect(cancelled.ok).toBe(false);
		if (!cancelled.ok) {
			expect(cancelled.error.message).toContain(reason === "timeout" ? "timed out after 100ms" : "aborted");
		}
		expect(native.cancelCount).toBe(1);
		expect(native.clickCount).toBe(0);
		const recovered = await runWorker(
			transport,
			"after-native-cancel",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
		);
		expect(recovered.ok).toBe(true);
		expect(native.clickCount).toBe(1);
		expect(native.cancelCount).toBe(1);
		expect(native.retireCount).toBe(1);
		expect(native.closeCount).toBe(0);
		expect(creations).toBe(1);
	});

	it("does not let a finished run's watchdog or stale abort cancel the next native operation", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const first = await runWorker(transport, "finished", "42", false, 100);
		expect(first.ok).toBe(true);
		expect(native.retireCount).toBe(1);
		expect(native.cancelCount).toBe(0);
		const second = runWorker(
			transport,
			"next",
			"await wait(150); await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
		);
		transport.inbound({ type: "abort", id: "finished" });
		expect((await second).ok).toBe(true);
		expect(native.retireCount).toBe(2);
		expect(native.cancelCount).toBe(0);
		expect(native.clickCount).toBe(1);
	});

	it("cancels unawaited native mutations before the next run without cancelling that run", async () => {
		const releaseOld = Promise.withResolvers<void>();
		const oldSettled = Promise.withResolvers<void>();
		class QueuedInputSession extends FakeNativeSession {
			#generation = 0;
			readonly delivered: number[] = [];

			override async click(_target: string, x: number): Promise<void> {
				const generation = this.#generation;
				if (x === 1) {
					try {
						await releaseOld.promise;
						if (generation !== this.#generation) throw new Error("Cancelled: old input generation");
						this.delivered.push(x);
					} finally {
						oldSettled.resolve();
					}
				} else {
					this.delivered.push(x);
				}
			}

			override cancel(): void {
				super.cancel();
				this.#generation += 1;
			}
			override retire(): void {
				super.retire();
				this.#generation += 1;
			}
		}
		const native = new QueuedInputSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		const first = await runWorker(transport, "floating-input", 'void desktop.click(1, 1); "returned"');
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.payload.returnValue).toBe("returned");

		const second = runWorker(
			transport,
			"next-input",
			'await tool.inputBarrier(); await desktop.click(2, 2); "fresh"',
		);
		const barrier = await transport.waitFor(
			message => message.type === "tool-call" && message.runId === "next-input",
		);
		if (barrier.type !== "tool-call") throw new Error("Expected next run's input barrier");
		// Let the old queued input reach its event-delivery check while the next
		// run is active. It must observe the retired generation and deliver nothing.
		releaseOld.resolve();
		await oldSettled.promise;
		expect(native.delivered).toEqual([]);
		expect(native.retireCount).toBe(1);
		transport.inbound({ type: "tool-reply", id: barrier.id, reply: { ok: true, value: null } });
		const recovered = await second;
		expect(recovered.ok).toBe(true);
		if (recovered.ok) expect(recovered.payload.returnValue).toBe("fresh");
		expect(native.delivered).toEqual([2]);
		expect(native.retireCount).toBe(2);
	});

	it("requires a full screenshot of the same target before zoom and never replaces it for invalid input", async () => {
		const transport = new MemoryTransport();
		const native = new ZoomNativeSession();
		new ComputerWorkerCore(transport, () => native);
		expect((await runWorker(transport, "desktop-only", "await desktop.screenshot({ silent: true })")).ok).toBe(true);
		const missing = await runWorker(
			transport,
			"missing-window-frame",
			"await (await desktop.window(42)).zoom({ x: 8, y: 4, width: 16, height: 8 })",
			true,
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.message).toContain("screenshot 42 first");
		const invalid = await runWorker(transport, "missing-region", "await desktop.zoom(undefined)", true);
		expect(invalid.ok).toBe(false);
		expect(native.fullCaptureCounts).toEqual(new Map([["desktop", 1]]));
		expect((await runWorker(transport, "original-frame", "await desktop.click(60, 30)")).ok).toBe(true);
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
			if (!result.ok) expect(result.error.message.split("\n")[0]).toBe(`no window matches ${id}`);
		});
	});

	describe("window selector misses", () => {
		const desktopWindows: DesktopWindow[] = [
			windowFixture,
			{ ...windowFixture, id: "43", title: "", focused: false },
			{ ...windowFixture, id: "7", app: "Finder", title: "Downloads", pid: 9, focused: false },
			{ ...windowFixture, id: "8", app: "TextEdit", title: "notes.txt", pid: 10, focused: false },
			{ ...windowFixture, id: "9", app: "TextEdit", title: "draft.txt", pid: 10, focused: false },
		];

		async function missMessage(windows: DesktopWindow[], selector: string): Promise<string> {
			const transport = new MemoryTransport();
			const native = new FakeNativeSession({ windows });
			native.listWindows = async () => windows;
			new ComputerWorkerCore(transport, () => native);
			const result = await runWorker(transport, "window-miss", `await desktop.window(${selector})`);
			expect(result.ok).toBe(false);
			return result.ok ? "" : result.error.message;
		}

		it("leads with the requested app's windows when its title filter misses", async () => {
			const message = await missMessage(desktopWindows, '{ app: "textedit", title: "report" }');
			const requestedApp = message.indexOf("notes.txt");
			expect(requestedApp).toBeGreaterThanOrEqual(0);
			expect(requestedApp).toBeLessThan(message.indexOf("Editor"));
			expect(requestedApp).toBeLessThan(message.indexOf("Downloads"));
		});

		it("counts an app's untitled windows instead of leaving them out", async () => {
			const lines = (await missMessage(desktopWindows, '{ app: "Calendar" }')).split("\n");
			expect(lines).toContain('- Code: 42 "Editor", 1 untitled');
			expect(lines).toContain('- Finder: 7 "Downloads"');
			expect(lines).toContain('- TextEdit: 8 "notes.txt", 9 "draft.txt"');
		});

		it("keeps a newline in an app name from forging a row", async () => {
			const forged = { ...windowFixture, id: "11", app: "Notes\n- Calendar: 404", title: "x", focused: false };
			const message = await missMessage([...desktopWindows, forged], '{ app: "Calendar", title: "agenda" }');
			expect(message.split("\n").filter(line => line.startsWith("- Calendar"))).toEqual([]);
		});

		it("bounds the listing on a desktop with many apps and long titles", async () => {
			const crowded = Array.from({ length: 40 }, (_, app) =>
				Array.from({ length: 4 }, (_, index) => ({
					...windowFixture,
					id: `${app}-${index}`,
					app: `App ${String(app).padStart(2, "0")}`,
					title: "t".repeat(300),
					focused: false,
				})),
			).flat();
			const message = await missMessage(crowded, '{ app: "Calendar" }');
			expect(message.length).toBeLessThan(5_000);
			expect(message.split("\n").at(-1)).toBe("- 28 more apps with 112 windows");
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

function liveWorker(native: NativeDesktopSession): ComputerWorkerHandle {
	const transport = new MemoryTransport();
	new ComputerWorkerCore(transport, () => native);
	return {
		send: message => transport.inbound(message),
		onMessage: handler => {
			transport.listeners.add(handler);
			queueMicrotask(() => handler({ type: "ready" }));
			return () => {
				transport.listeners.delete(handler);
			};
		},
		onError: () => () => {},
		terminate: async () => {
			transport.inbound({ type: "close" });
		},
	};
}

function confirmationContext(confirm: NonNullable<AgentToolContext["ui"]>["confirm"]): AgentToolContext {
	return { hasUI: true, ui: { confirm } } as AgentToolContext;
}

describe("expanded computer APIs", () => {
	it.each([true, false])(
		"requires an actual live approval answer (%s), retaining only approved mode across helpers",
		async approved => {
			const native = new FakeNativeSession();
			const session = toolSession();
			const supervisor = new ComputerSupervisor(session, () => liveWorker(native));
			const prelude = createComputerPrelude(session, () => supervisor);
			const answer = Promise.withResolvers<boolean>();
			const shown = Promise.withResolvers<void>();
			const context = confirmationContext(async (_title, reason, options) => {
				expect(reason).toContain("Edit the target");
				expect(reason).toContain("Use the host interrupt");
				expect(options?.signal).toBeInstanceOf(AbortSignal);
				shown.resolve();
				return await answer.promise;
			});
			try {
				const acquiring = prelude.invoke(
					{ action: "call", chain: [{ method: "control.acquire", args: [{ reason: "Edit the target" }] }] },
					{ session, toolCallId: "live-human-approval", context },
				);
				await shown.promise;
				expect(native.acquireCount).toBe(0);
				answer.resolve(approved);
				expect((await acquiring).details).toMatchObject({ value: { active: approved } });
				expect(
					(await supervisor.run("return await desktop.control.state()", 2000, snapshot(true))).returnValue,
				).toEqual({ active: approved });
				expect(native.acquireCount).toBe(approved ? 1 : 0);
				await supervisor.run(
					"const win = await desktop.window(42); await win.screenshot({ silent: true }); await win.click(1, 2); await win.click(1, 2, { takeover: false });",
					2000,
					snapshot(),
				);
				expect(native.inputModes).toEqual([approved, false]);
				await supervisor.revokeControl();
				expect(native.controlActive).toBe(false);
				expect(
					(await supervisor.run("return await desktop.control.state()", 2000, snapshot(true))).returnValue,
				).toEqual({ active: false });
			} finally {
				await supervisor.close();
			}
		},
	);

	it("denies headless control and ignores a late yes after cancellation", async () => {
		const native = new FakeNativeSession();
		const supervisor = new ComputerSupervisor(toolSession(), () => liveWorker(native));
		try {
			expect(
				(await supervisor.run('return await desktop.control.acquire({ reason: "Headless" })', 2000, snapshot()))
					.returnValue,
			).toEqual({ active: false });
			expect(native.acquireCount).toBe(0);
			const answer = Promise.withResolvers<boolean>();
			const shown = Promise.withResolvers<void>();
			const abort = new AbortController();
			const pending = supervisor.run(
				'return await desktop.control.acquire({ reason: "Cancelled" })',
				2000,
				snapshot(),
				abort.signal,
				confirmationContext(async () => {
					shown.resolve();
					return await answer.promise;
				}),
			);
			await shown.promise;
			abort.abort();
			answer.resolve(true);
			await expect(pending).rejects.toThrow();
			expect(native.acquireCount).toBe(0);
			expect(native.controlActive).toBe(false);
		} finally {
			await supervisor.close();
		}
	});

	it("revokes an acquired grant on worker error and disposal", async () => {
		const native = new FakeNativeSession();
		const supervisor = new ComputerSupervisor(toolSession(), () => liveWorker(native));
		const context = confirmationContext(async () => true);
		await supervisor.run(
			'await desktop.control.acquire({ reason: "Test task" })',
			2000,
			snapshot(),
			undefined,
			context,
		);
		await expect(supervisor.run('throw new Error("stop")', 2000, snapshot())).rejects.toThrow("stop");
		expect(native.controlActive).toBe(false);
		await supervisor.run(
			'await desktop.control.acquire({ reason: "New task" })',
			2000,
			snapshot(),
			undefined,
			context,
		);
		await supervisor.close();
		expect(native.controlActive).toBe(false);
		expect(native.closeCount).toBe(1);
	});

	it("routes nested menus, displays, observation, applications and bounded holds through the JS facade and worker", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "expanded-js" };
		const images: unknown[] = [];
		const realm = createContext({
			__omp_display__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				images.push(...result.content.filter(block => block.type === "image"));
				return { details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const value = await runInContext(
				`(async () => {
				const win = await computer.window(42);
				const menu = await win.menu.items("File");
				await win.menu.select(menu[0].path);
				const observation = await win.observe();
				await win.click(60, 30);
				const display = await computer.display("display-1");
				await display.screenshot({ silent: true });
				await display.zoom({ x: 2, y: 2, width: 4, height: 4 }, { silent: true });
				await display.click(60, 30);
				await display.holdKeys(["space"], { duration: 0 });
				await win.holdMouse(1, 2, { duration: 0, keys: ["space"] });
				const apps = await computer.apps.list({ runningOnly: true });
				await computer.apps.open(apps[0].id, { activate: false });
				return { menu, observation, display: { ...display }, apps };
			})()`,
				realm,
			);
			expect(value.menu[0].path).toEqual(["File", "Save"]);
			expect(value.observation).toMatchObject({
				coordinateWidth: 64,
				coordinateHeight: 32,
				nodeCount: 1,
				truncated: false,
				ax: "- button [ref=e1]",
			});
			expect(value.display).toEqual({ id: "display-1" });
			expect(native.clicks).toEqual([
				{ target: "42", x: 60, y: 30 },
				{ target: "display:display-1", x: 60, y: 30 },
			]);
			expect(native.operations).toEqual([
				"menu:42:File/Save",
				"holdKeys:display:display-1:space:0",
				"holdMouse:42:1,2:0",
				"open:test.editor",
			]);
			expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png", detail: "original" }]);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("routes Python nested handles and new methods through the actual kernel and worker", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"win = await computer.window(42)",
					"items = await win.menu.items('File')",
					"await win.menu.select(items[0]['path'])",
					"obs = await win.observe(silent=True)",
					"await win.click(60, 30)",
					"monitor = await computer.display('display-1')",
					"await monitor.screenshot(silent=True)",
					"await monitor.holdKeys(['space'], duration=0)",
					"await win.holdMouse(1, 2, duration=0)",
					"apps = await computer.apps.list(runningOnly=True)",
					"await computer.apps.open(apps[0]['id'], activate=False)",
					"print(obs['nodeCount'], monitor.id, (await computer.control.state())['active'])",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-expanded-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("1 display-1 False");
			expect(native.controlActive).toBe(false);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "expanded-py" });
		}
	});

	it("does not emit a failed observation or replace the prior frame before the next click", async () => {
		class FailingObservation extends ZoomNativeSession {
			override async observe(_target: string): Promise<{
				capture: DesktopCapture;
				accessibility: { text: string; nodeCount: number; truncated: boolean };
			}> {
				throw new Error("AccessibilityUnavailable");
			}
		}
		const native = new FailingObservation();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		await runWorker(transport, "observe-base", "await (await desktop.window(42)).screenshot({ silent: true })");
		const failed = await runWorker(transport, "observe-error", "await (await desktop.window(42)).observe()");
		expect(failed.ok).toBe(false);
		expect(native.fullCaptureCounts.get("42")).toBe(1);
		expect(
			(await runWorker(transport, "observe-prior-click", "await (await desktop.window(42)).click(60, 30)")).ok,
		).toBe(true);
		expect(native.clicks).toEqual([{ target: "42", x: 60, y: 30 }]);
	});

	it("classifies all new nested read and exec calls without permitting window methods on display handles", () => {
		for (const method of ["apps.list", "control.state", "display"])
			expect(isReadOnlyComputerCall([{ method, args: [] }])).toBe(true);
		for (const method of ["apps.open", "control.acquire", "control.release", "holdKeys", "holdMouse"])
			expect(isReadOnlyComputerCall([{ method, args: [] }])).toBe(false);
		for (const method of ["observe", "menu.items"])
			expect(
				isReadOnlyComputerCall([
					{ method: "window", args: [42] },
					{ method, args: [] },
				]),
			).toBe(true);
		for (const method of ["menu.select", "bringToCurrentSpace", "holdKeys", "holdMouse"])
			expect(
				isReadOnlyComputerCall([
					{ method: "window", args: [42] },
					{ method, args: [] },
				]),
			).toBe(false);
		expect(() =>
			renderComputerCall([
				{ method: "display", args: ["all"] },
				{ method: "menu.select", args: [["File"]] },
			]),
		).toThrow("Unknown display method");
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

describe("computer cell settlement", () => {
	/** A desktop capture twice the display's pixels, so pointer pixels are halved on the way in. */
	const doubledFrame = (target: string): FakeFrame => ({
		data: Uint8Array.of(137, 80, 78, 71),
		width: 128,
		height: 64,
		sourceWidth: 128,
		sourceHeight: 64,
		coordinateWidth: 128,
		coordinateHeight: 64,
		target,
		displays: [{ ...display, pixelWidth: 128, pixelHeight: 64 }],
		backend: "fake",
	});

	/** The frames a settle showed the model alongside its report. */
	const imageBlocks = (payload: ComputerRunOk) => payload.displays.filter(block => block.type === "image");

	it("reports a touched window's tree marked against the model's last read, with live refs", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		expect(await readCell(transport, "read")).toContain('- button "Edit" [ref=e3]');
		const press = await runWorker(transport, "press", 'await (await desktop.ref("e3")).press()');
		expect(press.ok).toBe(true);

		const report = await settleWorker(transport, "settle-press");
		expect(report).toBe(
			[
				'window "42" Code "Editor" after press e3 — 1 changed, 1 added, 0 removed (rows marked ~ changed, + added):',
				'- window "Editor" [ref=e6] app=Code (focused)',
				"  - toolbar [ref=e7]",
				'    ~ button "Done" [ref=e8] (was: button "Edit")',
				'    + textfield "Phone" [ref=e9]: "555"',
				'    - button "Share" [ref=e10]',
				'  - statictext [ref=e11]: "Ready"',
			].join("\n"),
		);
		// The printed refs are live: the next cell acts on them directly.
		const next = await runWorker(transport, "press-done", 'await (await desktop.ref("e8")).press()');
		expect(next.ok).toBe(true);
		expect(native.editing).toBe(false);
		expect(await settleWorker(transport, "settle-done")).toContain("after press e8 — 1 changed, 0 added, 1 removed");
		// Nothing new since that read: a further settle has nothing to say.
		expect(await settleWorker(transport, "settle-idle")).toBeUndefined();
	});

	it("reads an unchanged window once, so refs held before the cell still resolve", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		// A silent screenshot is not shown to the model: it does not put the window in pixel mode.
		await runWorker(transport, "silent-shot", 'await (await desktop.window("42")).screenshot({ silent: true })');
		await runWorker(transport, "key", 'await (await desktop.window("42")).press("shift")');
		const before = native.snapshots;
		const report = String(await settleWorker(transport, "settle-key"));
		expect(native.snapshots).toBe(before + 1);
		expect(report.split("\n")[0]).toMatch(
			/after press shift — no accessibility change visible \d\.\d s after the input/,
		);
		expect(report).not.toContain("screenshot below");
		const held = await runWorker(transport, "held", 'return (await desktop.ref("e3")).ref');
		expect(held.ok && held.payload.returnValue).toBe("e3");
	});

	it("does not count a changed native object address as a change", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		native.status = "<AXUIElement 0x600003b2c0f0> {pid=123}";
		await readCell(transport, "read");
		native.status = "<AXUIElement 0x600003b2d9a0> {pid=123}";
		await runWorker(transport, "key", 'await (await desktop.window("42")).press("shift")');
		expect(String(await settleWorker(transport, "settle-key")).split("\n")[0]).toContain("no accessibility change");
	});

	it("skips the read-back when the cell printed the window's tree after its last input", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		const printed = await runWorker(
			transport,
			"press-then-read",
			'const win = await desktop.window("42"); await (await desktop.ref("e3")).press(); return await win.ax()',
		);
		const before = native.snapshots;
		expect(
			await settleWorker(transport, "settle", String(printed.ok && printed.payload.returnValue)),
		).toBeUndefined();
		expect(native.snapshots).toBe(before);
	});

	it("reports a window whose tree the cell read after its input but did not print", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		await runWorker(
			transport,
			"press-then-discard",
			'const win = await desktop.window("42"); await (await desktop.ref("e3")).press(); await win.ax(); return "done"',
		);
		// Marked against the tree the model saw, not the one the cell's code discarded.
		expect(String(await settleWorker(transport, "settle", "done")).split("\n")[0]).toBe(
			'window "42" Code "Editor" after press e3 — 1 changed, 1 added, 0 removed (rows marked ~ changed, + added):',
		);
	});

	it("carries the current tree after a call fails on an expired ref, without a separate read", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		for (const id of ["read-1", "read-2", "read-3"])
			await runWorker(transport, id, 'return await (await desktop.window("42")).ax()');
		const stale = await runWorker(transport, "stale", 'await (await desktop.ref("e3")).press()');
		expect(stale.ok).toBe(false);
		expect(native.editing).toBe(false);

		const report = await settleWorker(transport, "settle-stale");
		expect(report).toBe(
			[
				'window "42" Code "Editor" after ref e3 failed: StaleRef: e3 expired; re-run ax()/find() — current tree:',
				'- window "Editor" [ref=e16] app=Code (focused)',
				"  - toolbar [ref=e17]",
				'    - button "Edit" [ref=e18]',
				'    - button "Share" [ref=e19]',
				'  - statictext [ref=e20]: "Ready"',
			].join("\n"),
		);
	});

	it("reports desktop key input on the window focused when it was sent", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		const other: DesktopWindow = { ...windowFixture, id: "43", title: "Other", focused: false };
		native.windows = [windowFixture, other];
		// The key reaches the focused window and then moves focus away from it.
		native.keyChord = async () => {
			native.editing = true;
			native.windows = [
				{ ...windowFixture, focused: false },
				{ ...other, focused: true },
			];
		};
		await runWorker(transport, "root", 'await desktop.press("cmd+e")');
		const report = String(await settleWorker(transport, "settle-root"));
		expect(report.split("\n")[0]).toBe(
			'window "42" Code "Editor" after desktop press cmd+e — 1 changed, 1 added, 0 removed (rows marked ~ changed, + added):',
		);
		expect(report).not.toContain('window "43" Code "Other" after');
	});

	it("attributes desktop pointer input to the one window under the pointer, even one filling the display", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		native.captureFrame = doubledFrame;
		new ComputerWorkerCore(transport, () => native);
		// The window fills the display: still the target, never passed over as an overlay.
		native.windows = [{ ...windowFixture, x: 0, y: 0, width: 64, height: 32 }];

		await readCell(transport, "read");
		await runWorker(transport, "look", "await desktop.screenshot({ silent: true })");
		await runWorker(transport, "click", "await desktop.click(24, 20)");
		const header = String(await settleWorker(transport, "settle-click")).split("\n")[0];
		expect(header).toMatch(/^window "42" Code "Editor" after desktop click 24,20 — /);
		expect(header).not.toContain("unknown");
	});

	it("leaves desktop pointer input unattributed when listed windows overlap under the pointer", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		native.captureFrame = doubledFrame;
		new ComputerWorkerCore(transport, () => native);
		// Two windows contain the point; no compositor ordering is promised, so neither is chosen.
		native.windows = [windowFixture, { ...windowFixture, id: "43", title: "Behind", x: 8, y: 8, focused: false }];

		await readCell(transport, "read");
		await runWorker(transport, "look", "await desktop.screenshot({ silent: true })");
		await runWorker(transport, "click", "await desktop.click(24, 24)");
		const report = String(await settleWorker(transport, "settle-click"));
		expect(report.split("\n")[0]).toMatch(
			/^window "42" Code "Editor" after desktop click 24,24 \(its window is unknown; shown on the focused window\) — /,
		);
		expect(report).not.toContain('window "43"');
	});

	it("ignores a window the platform cannot place in global coordinates", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		native.captureFrame = doubledFrame;
		new ComputerWorkerCore(transport, () => native);
		native.windows = [
			{
				...windowFixture,
				id: "6",
				title: "Panel",
				x: 0,
				y: 0,
				width: 64,
				height: 32,
				focused: false,
				positionKnown: false,
			},
			windowFixture,
		];

		await readCell(transport, "read");
		await runWorker(transport, "look", "await desktop.screenshot({ silent: true })");
		await runWorker(transport, "click", "await desktop.click(24, 24)");
		const header = String(await settleWorker(transport, "settle-click")).split("\n")[0];
		expect(header).toMatch(/^window "42" Code "Editor" after desktop click 24,24 — /);
		expect(header).not.toContain("unknown");
	});

	it("names an input it cannot attribute when no window holds focus", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);
		native.windows = [{ ...windowFixture, focused: false }];

		await runWorker(transport, "root", 'await desktop.press("cmd+e")');
		const report = String(await settleWorker(transport, "settle-root"));
		expect(report).toContain("could not attribute desktop press cmd+e to a window");
		expect(report).not.toContain('window "42"');
	});

	it("reports a window a control mutation changed", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		await runWorker(transport, "maximize", 'await (await desktop.window("42")).maximize()');
		const header = String(await settleWorker(transport, "settle-maximize")).split("\n")[0];
		expect(header).toMatch(/^window "42" Code "Editor" after maximize — /);
	});

	it("records a desktop workspace switch on the window focused when it was sent", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		await runWorker(transport, "workspace", 'await desktop.focusWorkspace({ workspaceId: "fake-workspace:2" })');
		const header = String(await settleWorker(transport, "settle-workspace")).split("\n")[0];
		expect(header).toMatch(
			/^window "42" Code "Editor" after desktop focusWorkspace fake-workspace:2 \(its window is unknown; shown on the focused window\) — /,
		);
	});

	it("names windows the cell's input opened and focused", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await runWorker(transport, "read", 'return await (await desktop.window("42")).ax()');
		const dialog: DesktopWindow = { ...windowFixture, id: "43", title: "Save", width: 30, height: 12, focused: true };
		native.axPerform = async () => {
			native.windows = [{ ...windowFixture, focused: false }, dialog];
		};
		await runWorker(transport, "open", 'await (await desktop.ref("e2")).press()');
		const report = await settleWorker(transport, "settle-open");
		expect(report).toMatch(/\n\nnew window "43" Code "Save" 30×12 \(focused\)$/);
	});

	it("repeats a screenshot for a window worked by pixels, even without AX", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		// Screenshot, then a tree read, then pixel input: the window is worked by pixels.
		await runWorker(
			transport,
			"look",
			'const win = await desktop.window("42"); await win.screenshot(); await win.ax()',
		);
		await runWorker(transport, "click", 'await (await desktop.window("42")).click(3, 4)');
		const pixels = await settledPayload(transport, "settle-pixels");
		expect(String(pixels.returnValue).split("\n")[0]).toEndWith("; screenshot below:");
		expect(imageBlocks(pixels)).toHaveLength(1);
		expect(pixels.screenshots).toEqual([expect.objectContaining({ target: "42" })]);
		// The automatic frame is the capped one, saved and shown as the very same pixels.
		expect(native.captureCaps.at(-1)).toEqual({ maxWidth: 1280, maxHeight: 896 });
		expect(imageBlocks(pixels)[0]?.data).toBe(
			Buffer.from(await Bun.file(pixels.screenshots[0]!.path).arrayBuffer()).toString("base64"),
		);

		// Keys leave the mode as it is.
		await runWorker(transport, "key", 'await (await desktop.window("42")).press("shift")');
		expect(imageBlocks(await settledPayload(transport, "settle-key"))).toHaveLength(1);

		// An AX failure still leaves the frame.
		native.axFails = true;
		await runWorker(transport, "click-2", 'await (await desktop.window("42")).click(5, 6)');
		const blind = await settledPayload(transport, "settle-blind");
		expect(String(blind.returnValue)).toContain("could not be read back through AX: AxFailed");
		expect(imageBlocks(blind)).toHaveLength(1);
		native.axFails = false;

		// A silent capture is no frame the model saw, but the pointer input that follows is evidence.
		await runWorker(transport, "silent", 'await (await desktop.window("42")).screenshot({ silent: true })');
		await runWorker(transport, "click-3", 'await (await desktop.window("42")).click(7, 8)');
		expect(imageBlocks(await settledPayload(transport, "settle-silent-click"))).toHaveLength(1);

		// A screenshot shown in an earlier cell does not keep the mode through this cell's element action.
		await runWorker(transport, "look-only", 'await (await desktop.window("42")).screenshot()');
		expect(await settleWorker(transport, "settle-look-only")).toBeUndefined();
		await runWorker(transport, "read", 'return await (await desktop.window("42")).ax()');
		const button = native.editing ? "Done" : "Edit";
		await runWorker(
			transport,
			"press",
			`const [el] = (await (await desktop.window("42")).ax()).match(/button "${button}" \\[ref=(e\\d+)\\]/).slice(1); await (await desktop.ref(el)).press()`,
		);
		const ax = await settledPayload(transport, "settle-ax");
		expect(String(ax.returnValue)).not.toContain("screenshot below");
		expect(imageBlocks(ax)).toHaveLength(0);

		// A displayed screenshot taken after the input already answers it: no read-back at all.
		await runWorker(
			transport,
			"click-look",
			'const win = await desktop.window("42"); await win.click(1, 1); await win.screenshot()',
		);
		const looked = await settleRun(transport, "settle-looked");
		if (!looked.ok) throw new Error(`settle-looked failed: ${looked.error.message}`);
		expect(looked.payload.returnValue).toBeUndefined();
		expect(looked.payload.displays).toEqual([]);
	});

	it("adds a desktop screenshot while the desktop root is worked by pixels", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		// A displayed desktop screenshot, then a click at its pixels: the root is worked by pixels.
		await readCell(transport, "read");
		await runWorker(transport, "look", "await desktop.screenshot()");
		await runWorker(transport, "root-click", "await desktop.click(7, 8)");
		const click = await settledPayload(transport, "settle-root-click");
		// The frame the model clicks in is the desktop's, not the window's.
		expect(click.screenshots).toEqual([expect.objectContaining({ target: "desktop" })]);
		expect(imageBlocks(click)).toHaveLength(1);

		// Keys at the root keep the mode.
		await runWorker(transport, "root-key", 'await desktop.press("shift")');
		const key = await settledPayload(transport, "settle-root-key");
		expect(key.screenshots).toEqual([expect.objectContaining({ target: "desktop" })]);
		expect(imageBlocks(key)).toHaveLength(1);

		// An element action in a cell without root pixel input ends it.
		const ref = String(key.returnValue).match(/button "(?:Edit|Done)" \[ref=(e\d+)\]/)![1];
		await runWorker(transport, "press", `await (await desktop.ref("${ref}")).press()`);
		await settleRun(transport, "settle-press");
		await runWorker(transport, "root-key-2", 'await desktop.press("shift")');
		const after = await settledPayload(transport, "settle-root-key-2");
		expect(String(after.returnValue)).not.toContain("screenshot below");
		expect(after.screenshots).toEqual([]);
		expect(imageBlocks(after)).toHaveLength(0);
	});

	it("elides a large report tree to its budget and keeps the rows the input changed", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		native.filler = 2_000;
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		await runWorker(transport, "press", 'await (await desktop.ref("e3")).press()');
		const [header, ...tree] = String(await settleWorker(transport, "settle-large")).split("\n");
		expect(header).toMatch(/ \d+ rows elided to fit \(every changed row kept\)/);
		expect(Buffer.byteLength(tree.join("\n"), "utf-8")).toBeLessThanOrEqual(16 * 1024);
		expect(tree).toContainEqual(expect.stringMatching(/^ {4}~ button "Done" \[ref=e\d+\] \(was: button "Edit"\)$/));
		expect(tree).toContainEqual(expect.stringMatching(/^ {4}\+ textfield "Phone" \[ref=e\d+\]: "555"$/));
		expect(tree).toContainEqual(expect.stringMatching(/^ {4}… \d+ rows elided$/));

		// An explicit read is the model's own choice of size: it is never elided.
		const whole = await runWorker(transport, "read-whole", 'return await (await desktop.window("42")).ax()');
		if (!whole.ok) throw new Error(`read-whole failed: ${whole.error.message}`);
		expect(String(whole.payload.returnValue).length).toBeGreaterThan(16 * 1024);
	});

	it("counts the changed rows elision had to drop when the changes alone exceed the budget", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		native.filler = 2_000;
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		native.status = "Busy";
		await runWorker(transport, "press", 'await (await desktop.ref("e3")).press()');
		const [header, ...tree] = String(await settleWorker(transport, "settle-flood")).split("\n");
		const counts = header.match(
			/ — (\d+) changed, (\d+) added, .* (\d+) rows elided to fit \((\d+) changed rows among them\)/,
		);
		expect(counts).not.toBeNull();
		const [changed, added, , lost] = counts!.slice(1).map(Number);
		const kept = tree.filter(line => /^(?: {2})*[+~] /.test(line)).length;
		expect(changed + added).toBe(2_003);
		expect(lost).toBe(changed + added - kept);
		expect(kept).toBeGreaterThan(0);
		expect(Buffer.byteLength(tree.join("\n"), "utf-8")).toBeLessThanOrEqual(16 * 1024);
	});

	it("fails closed when a settle is cancelled mid-read", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		// A read that never answers: only cancellation can end the settle.
		const { promise } = Promise.withResolvers<{ text: string }>();
		native.axSnapshot = () => promise;
		new ComputerWorkerCore(transport, () => native);

		await runWorker(transport, "press", 'await (await desktop.window("42")).press("shift")');
		transport.inbound({
			type: "settle",
			id: "settle-cancel",
			timeoutMs: 5_000,
			session: snapshot(true),
			output: "",
		} as unknown as ComputerWorkerInbound);
		transport.inbound({ type: "abort", id: "settle-cancel" });
		const result = await transport.waitFor(message => message.type === "result" && message.id === "settle-cancel");
		if (result.type !== "result" || result.ok) throw new Error("cancelled settle must fail");
		expect(result.error.isAbort).toBe(true);
		expect(result.error.name).toBe("ToolAbortError");
	});

	it("waits out the settle delay after a slow gesture ends, not from where it started", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		// A paced gesture: the native call only returns once the harness releases it.
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		native.drag = async () => {
			started.resolve();
			await release.promise;
		};
		new ComputerWorkerCore(transport, () => native);

		await runWorker(transport, "look", 'await (await desktop.window("42")).screenshot({ silent: true })');
		const dragging = runWorker(
			transport,
			"slow-drag",
			'await (await desktop.window("42")).drag([[3, 4], [8, 9]])',
			false,
			10_000,
		);
		await started.promise;
		release.resolve();
		await dragging;
		const endedAt = Date.now();
		await settledPayload(transport, "settle-slow");

		// Real elapsed time, because the settle's delay is a wait on the platform clock
		// inside the worker; no fake timer can cover it.
		expect(Date.now() - endedAt).toBeGreaterThanOrEqual(400);
	});

	it("drops an oversized row or trailer whole instead of printing half of it", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		// One row and one prose line, each larger than the whole report budget.
		native.status = "x".repeat(20_000);
		native.trailer = "… ".repeat(10_000);
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		await runWorker(transport, "press", 'await (await desktop.ref("e3")).press()');
		const [header, ...tree] = String(await settleWorker(transport, "settle-oversized")).split("\n");
		expect(Buffer.byteLength(tree.join("\n"), "utf-8")).toBeLessThanOrEqual(16 * 1024);
		// Neither oversized line survives in part: no fragment of their text, and no
		// row left without the ref that makes it addressable.
		expect(tree.join("\n")).not.toContain("xxxx");
		for (const line of tree.filter(candidate => /^\s*[-+~] /.test(candidate))) {
			expect(line).toMatch(/ \[ref=e\d+\]/);
		}
		expect(header).toMatch(/rows elided to fit/);
	});

	it("drops the pending input of a cancelled cell instead of reporting it in the next one", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		// The cancelled cell's input is still in flight when the turn aborts.
		const started = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		native.keyChord = async () => {
			started.resolve();
			await held.promise;
		};
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		transport.inbound({
			type: "run",
			id: "cancelled",
			code: 'await (await desktop.window("42")).press("shift")',
			timeoutMs: 5_000,
			session: { ...snapshot(false), cellId: "cell-cancelled" },
		});
		await started.promise;
		transport.inbound({ type: "abort", id: "cancelled" });
		held.resolve();
		const cancelled = await transport.waitFor(message => message.type === "result" && message.id === "cancelled");
		if (cancelled.type !== "result" || cancelled.ok) throw new Error("cancelled run must fail");
		expect(cancelled.error.isAbort).toBe(true);

		// No settle ever runs for that cell; the next cell answers for its own input alone.
		await runWorker(transport, "next", 'await (await desktop.window("42")).type("hi")', false, 10_000, "cell-next");
		const report = String(await settleWorker(transport, "settle-next", "", "cell-next"));
		expect(report).toContain('after type "hi"');
		expect(report).not.toContain("press shift");
	});

	it("gives overlapping cells only their own input feedback", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		// Two cells interleave on one worker: A's keystroke is still pending when B types.
		const a = await runWorker(
			transport,
			"a-run",
			'await (await desktop.window("42")).press("shift")',
			false,
			10_000,
			"cell-a",
		);
		expect(a.ok).toBe(true);
		const b = await runWorker(
			transport,
			"b-run",
			'await (await desktop.window("42")).type("hi")',
			false,
			10_000,
			"cell-b",
		);
		expect(b.ok).toBe(true);

		const bReport = String(await settleWorker(transport, "b-settle", "", "cell-b"));
		expect(bReport).toContain('after type "hi"');
		expect(bReport).not.toContain("press shift");
		const aReport = String(await settleWorker(transport, "a-settle", "", "cell-a"));
		expect(aReport).toContain("after press shift");
		expect(aReport).not.toContain('type "hi"');
	});

	it("answers every settle waiting behind an active cell instead of refusing the later ones", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		native.keyChord = async () => {
			started.resolve();
			await release.promise;
		};
		new ComputerWorkerCore(transport, () => native);

		for (let index = 0; index < 4; index++) {
			const typed = await runWorker(
				transport,
				`type-${index}`,
				'await (await desktop.window("42")).type("x")',
				false,
				10_000,
				`cell-${index}`,
			);
			expect(typed.ok).toBe(true);
		}
		// The fifth cell's key input still holds the worker when they all settle.
		transport.inbound({
			type: "run",
			id: "hold",
			code: 'await (await desktop.window("42")).press("shift")',
			timeoutMs: 10_000,
			session: { ...snapshot(false), cellId: "cell-4" },
		});
		await started.promise;

		const waiting = Array.from({ length: 5 }, (_, index) =>
			settleRun(transport, `settle-${index}`, "", `cell-${index}`),
		);
		release.resolve();
		const settled = await Promise.all(waiting);
		for (const [index, result] of settled.entries()) {
			if (!result.ok) throw new Error(`settle ${index} was refused: ${result.error.message}`);
			const report = String(result.payload.returnValue);
			expect(report).toContain(index === 4 ? "after press shift" : 'after type "x"');
			expect(report).not.toContain(index === 4 ? 'type "x"' : "press shift");
		}
	});

	it("forgets a cell cancelled after its input finished, with no capture and no report", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		// The cell's input is done; the cell is cancelled while it runs the rest of its
		// own code, so no native request is active to abort.
		await runWorker(
			transport,
			"done",
			'await (await desktop.window("42")).press("shift")',
			false,
			10_000,
			"cell-cancelled",
		);
		const before = transport.outbound.length;
		transport.inbound({ type: "discard", cellId: "cell-cancelled" } as unknown as ComputerWorkerInbound);

		// Nothing of that cell is left: no report, no captured frame.
		expect(await settleWorker(transport, "settle-cancelled", "", "cell-cancelled")).toBeUndefined();
		const shown = transport.outbound
			.slice(before)
			.filter(message => message.type === "result" && message.ok)
			.flatMap(message => message.payload.displays);
		expect(shown).toEqual([]);

		await runWorker(transport, "next", 'await (await desktop.window("42")).type("hi")', false, 10_000, "cell-next");
		const report = String(await settleWorker(transport, "settle-next", "", "cell-next"));
		expect(report).toContain('after type "hi"');
		expect(report).not.toContain("press shift");
	});

	it("settles an untagged call's own input whatever request ids it used", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);

		await readCell(transport, "read");
		// No `cellId`: a host that batches calls is one logical cell, so its settle
		// still finds its input whatever the request id says.
		await runWorker(transport, "batch", 'await (await desktop.window("42")).type("hi")');
		expect(String(await settleWorker(transport, "batch-settle"))).toContain('after type "hi"');
	});

	it("does not enable later automatic frames from a cancelled screenshot that finishes late", async () => {
		const transport = new MemoryTransport();
		const native = new EditableWindowSession();
		new ComputerWorkerCore(transport, () => native);
		await readCell(transport, "read");

		const started = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const written = Promise.withResolvers<void>();
		const originalWrite = Bun.write;
		let first = true;
		const write = spyOn(Bun, "write").mockImplementation(async (file, data, options) => {
			if (typeof file !== "string" || !(data instanceof Uint8Array)) {
				throw new Error("Screenshot fixture expected a PNG byte write to a path");
			}
			if (!first) return originalWrite(file, data, options);
			first = false;
			started.resolve();
			await held.promise;
			try {
				return await originalWrite(file, data, options);
			} finally {
				written.resolve();
			}
		});
		try {
			const cancelled = runWorker(
				transport,
				"frame",
				'await (await desktop.window("42")).screenshot()',
				false,
				10_000,
				"cell-frame",
			);
			await started.promise;
			transport.inbound({ type: "discard", cellId: "cell-frame" });
			expect((await cancelled).ok).toBe(false);
			await runWorker(
				transport,
				"next",
				'await (await desktop.window("42")).type("hi")',
				false,
				10_000,
				"cell-next",
			);
			held.resolve();
			await written.promise;
			// The completed write's promise callbacks drain before the next event-loop turn.
			await scheduler.yield();
			const before = transport.outbound.length;
			const report = String(await settleWorker(transport, "settle-next", "", "cell-next"));
			expect(report).toContain('after type "hi"');
			const images = transport.outbound
				.slice(before)
				.filter(message => message.type === "result" && message.ok)
				.flatMap(message => message.payload.displays)
				.filter(display => display.type === "image");
			expect(images).toEqual([]);
		} finally {
			held.resolve();
			write.mockRestore();
		}
	});
});
