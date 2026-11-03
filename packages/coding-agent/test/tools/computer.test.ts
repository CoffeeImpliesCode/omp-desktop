import { afterAll, afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import { inspect } from "node:util";
import { createContext, runInContext } from "node:vm";
import { scheduler } from "node:timers/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { isReadOnlyComputerCall, renderComputerCall } from "@oh-my-pi/pi-coding-agent/tools/computer/call";
import {
	type ComputerRunOk,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
	type ComputerWorkerTransport,
	ESCAPE_AFTER_CALL_MESSAGE,
	ESCAPE_STOPPED_MESSAGE,
	SCREEN_LOCKED_CAPTURE_NOTE,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import {
	beginComputerTurnForOwner,
	type ComputerController,
	type ComputerSettleReport,
	type ComputerEscapeStops,
	ComputerSupervisor,
	type ComputerWorkerHandle,
	endComputerTurnForOwner,
	registerComputerController,
	resumeComputerUseForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type {
	ApplicationOpenOptions,
	AxNode,
	AxQuery,
	AxSelectTextOptions,
	AxSnapshotOptions,
	AxTextSelection,
	CaptureRegion,
	DesktopCapabilities,
	DesktopControlAction,
	DesktopControlCapabilities,
	DesktopCapture,
	DesktopDisplay,
	DesktopFocusReturn,
	DesktopPoint,
	DesktopScreenState,
	DesktopWindow,
	DesktopWindowState,
	DesktopWorkspace,
	HoldOptions as NativeHoldOptions,
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
	screenLocked: false,
	displayAsleep: false,
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

/** Escape-stop counts for supervisor tests that exercise no Escape stop, so they never read the native addon. */
const NO_ESCAPE_STOPS: ComputerEscapeStops = { read: () => 0, forget: () => {} };

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
	screenLocked?: boolean;
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
	readonly control: NativeDesktopSession["control"];
	readonly listWorkspaces: NativeDesktopSession["listWorkspaces"];
	readonly windowState: NativeDesktopSession["windowState"];
	/** Lock and sleep state reported by captures, capabilities and screenState, as the native session reads it live. */
	screenLocked = false;
	displayAsleep = false;
	get capabilities(): DesktopCapabilities {
		return {
			...capabilities,
			windowControl: { ...controlCapabilities, operations: [...this.#operations] },
			screenLocked: this.screenLocked,
			displayAsleep: this.displayAsleep,
		};
	}
	get screenState(): DesktopScreenState {
		return { screenLocked: this.screenLocked, displayAsleep: this.displayAsleep };
	}
	escapeStops = 0;
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
	readonly takeovers: (boolean | undefined)[] = [];
	sourceWidth = 64;
	sourceHeight = 32;
	coordinateWidth = 64;
	coordinateHeight = 32;
	readonly #operations: string[];
	readonly #displays: DesktopDisplay[];
	readonly #workspaces: DesktopWorkspace[];
	readonly #windows: FakeWindow[];
	/** Targets holding a live coordinate frame; an accepted mutation drops all of them. */
	readonly #frames = new Set<string>(["desktop"]);

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
			displayServer: undefined,
			screenLocked: this.screenLocked,
		};
		return {
			...frame,
			coordinateWidth: frame.coordinateWidth ?? this.sourceWidth,
			coordinateHeight: frame.coordinateHeight ?? this.sourceHeight,
			displays: frame.displays ?? [display],
			backend: frame.backend ?? "fake",
			displayServer: "displayServer" in frame ? frame.displayServer : undefined,
			screenLocked: frame.screenLocked ?? this.screenLocked,
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
	/** Display-hold calls in order: `turn` for holdDisplayUntilReleased, `release` for releaseDisplayAwake. */
	readonly displayHolds: string[] = [];
	holdDisplayUntilReleased(): void {
		this.displayHolds.push("turn");
	}
	releaseDisplayAwake(): void {
		this.displayHolds.push("release");
	}
	setRunDeadline(_remainingMs: number): void {}
	async listApplications() {
		return [{ id: "test.editor", name: "Editor", path: "/Applications/Editor.app", running: true, pid: 123 }];
	}
	async openApplication(id: string) {
		this.operations.push(`open:${id}`);
		return { ...(await this.listApplications())[0]!, window: windowFixture };
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
	async click(
		target: string,
		_x: number,
		_y: number,
		_opts?: PointerOptions | null,
	): Promise<DesktopFocusReturn | null | void> {
		this.#requireFrame(target);
		this.clickCount += 1;
		this.takeovers.push(_opts?.takeover);
	}
	async moveMouse(target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.#requireFrame(target);
		this.takeovers.push(_opts?.takeover);
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
	readonly selections: string[] = [];
	async axSelectText(_ref: string, text: string, _opts?: AxSelectTextOptions | null): Promise<AxTextSelection> {
		this.selections.push(text);
		return { start: 0, length: text.length, text, focused: true };
	}
	async axFocus(_ref: string): Promise<void> {}
	async axClick(_ref: string, _opts?: PointerOptions | null): Promise<void> {}
	async axType(_ref: string, _text: string, _opts?: PointerOptions | null): Promise<void> {}
	async axKeyChord(_ref: string, _keys: string[], _opts?: PointerOptions | null): Promise<void> {}
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

/** The user presses physical Escape during the next click, as the native takeover monitor reports it. */
class EscapeNativeSession extends FakeNativeSession {
	escapeOnClick = false;
	capabilityReads = 0;
	/** What the stopped click rejects with, as native reports a cancelled operation. */
	escapeError = "Cancelled: desktop operation cancelled; input may be partial; inspect before retrying";
	/** Runs as the Escape lands, before the click rejects. */
	onEscape?: () => void;

	override get capabilities(): DesktopCapabilities {
		this.capabilityReads += 1;
		return super.capabilities;
	}
	override async axSetValue(ref: string, value: string): Promise<void> {
		this.operations.push(`setValue:${ref}:${value}`);
	}

	override async click(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void> {
		if (!this.escapeOnClick) {
			await super.click(target, x, y, opts);
			return;
		}
		this.escapeOnClick = false;
		this.escapeStops += 1;
		this.onEscape?.();
		throw new Error(this.escapeError);
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

/** No Escape stop acknowledged, under a key no other test shares. */
const escapeScope = () => ({ key: `computer-test-${crypto.randomUUID()}`, acknowledged: 0 });

const snapshot = (
	readOnly = false,
	displayTurn?: number,
	backgroundFallback: ComputerSessionSnapshot["backgroundFallback"] = "takeover",
): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: crypto.randomUUID(),
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "active",
	readOnly,
	displayTurn,
	backgroundFallback,
});

async function runWorker(
	transport: MemoryTransport,
	id: string,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
	cellId?: string,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	transport.inbound({
		type: "run",
		id,
		code,
		timeoutMs,
		session: { ...snapshot(readOnly), cellId },
		escape: escapeScope(),
	});
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
	transport.inbound({
		type: "settle",
		id,
		timeoutMs: 5_000,
		session: { ...snapshot(true), cellId },
		output,
	});
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
			transport.inbound({ type: "run", id, code, timeoutMs, session: runSnapshot, escape: escapeScope() });
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
			__omp_log__: (_level: string, value: unknown) => displays.push(value),
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

	it("refuses run args it would drop before anything runs, and still runs empty or null args", async () => {
		const prelude = createComputerPrelude(toolSession(), () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const calls: unknown[] = [];
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: unknown, parameters: unknown) => {
				calls.push(parameters);
				return { text: "", details: { value: "ran" } };
			},
		});
		runInContext(prelude.javascript, realm);

		await expect(
			runInContext('computer.run(async (_scope, path) => path, { args: { path: "/tmp" } })', realm),
		).rejects.toThrow("computer.run() args must be an array of the function's arguments after its scope");
		await expect(runInContext('computer.run("return 1;", { args: ["/tmp"] })', realm)).rejects.toThrow(
			"computer.run() passes args only to a function; a code string receives none",
		);
		expect(calls).toEqual([]);

		expect(await runInContext('computer.run("return 1;", { args: [] })', realm)).toBe("ran");
		expect(await runInContext("computer.run(async () => 1, { args: null })", realm)).toBe("ran");
		expect(calls).toEqual([
			{ code: "return 1;", action: "run" },
			{ fn: "async () => 1", args: [], action: "run" },
		]);
	});

	it("serializes simultaneous direct helpers without refusing calls or overlapping native reads", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		class GatedSession extends FakeNativeSession {
			reads = 0;
			activeReads = 0;
			maxActiveReads = 0;
			override async listWindows(): Promise<DesktopWindow[]> {
				this.reads++;
				this.activeReads++;
				this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
				started.resolve();
				try {
					await gate.promise;
					return await super.listWindows();
				} finally {
					this.activeReads--;
				}
			}
		}
		const session = toolSession();
		const native = new GatedSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "parallel-direct-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		const calls = runInContext("[computer.window(42), computer.window(42)]", realm) as Promise<unknown>[];
		const results = Promise.allSettled(calls);
		try {
			await started.promise;
			expect(native.reads).toBe(1);
			gate.resolve();
			expect(await results).toEqual([
				{ status: "fulfilled", value: expect.objectContaining({ id: "42" }) },
				{ status: "fulfilled", value: expect.objectContaining({ id: "42" }) },
			]);
			expect(native.reads).toBe(2);
			expect(native.maxActiveReads).toBe(1);
		} finally {
			gate.resolve();
			await results;
			await prelude.invoke({ action: "close" }, context);
		}
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
			selectText: { start: 7, length: 0, text: "", focused: true },
			raise: undefined,
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
				'print((await el.selectText("cat", prefix="red ", select="end"))["start"])',
				"await win.focus()",
				"await win.moveTo(x=11, y=12)",
				"await win.raise_()",
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
			"7",
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
					{ method: "ref", args: ["e1"] },
					{ method: "selectText", args: ["cat", { prefix: "red ", select: "end" }] },
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
					{ method: "focus", args: [] },
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
			__omp_log__: () => {},
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

	class RefCallSession extends FakeNativeSession {
		readonly axCalls: unknown[] = [];
		override async axNode(ref: string): Promise<AxNode> {
			this.axCalls.push(["axNode", ref]);
			return axNode;
		}
		override async axPerform(ref: string, action: string): Promise<void> {
			this.axCalls.push(["axPerform", ref, action]);
		}
		override async axClick(ref: string, opts?: PointerOptions | null): Promise<void> {
			this.axCalls.push(["axClick", ref, opts]);
		}
		override async axKeyChord(ref: string, keys: string[], opts?: PointerOptions | null): Promise<void> {
			this.axCalls.push(["axKeyChord", ref, keys, opts]);
		}
	}

	it("chains element calls on JavaScript ref() handles, direct and in runs, and double-clicks", async () => {
		const session = toolSession();
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "ref-chain-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const role = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.ref("e1").click({ count: 2 });
					await computer.ref("e1").press();
					const el = await win.ref("e1");
					await el.click({ count: 2, button: "right" });
					await computer.run(async ({ desktop }) => {
						const win = await desktop.window(42);
						await win.ref("e1").click({ count: 2 });
						await desktop.ref("e1").press();
					});
					return el.role;
				})()`,
				realm,
			);
			expect(role).toBe("button");
			expect(native.axCalls).toEqual([
				["axNode", "e1"],
				["axClick", "e1", { count: 2 }],
				["axNode", "e1"],
				["axPerform", "e1", "press"],
				["axNode", "e1"],
				["axNode", "e1"],
				["axClick", "e1", { button: "right", count: 2 }],
				["axNode", "e1"],
				["axClick", "e1", { count: 2 }],
				["axNode", "e1"],
				["axPerform", "e1", "press"],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("presses a chord into a JavaScript element and keeps press() without a chord the native press", async () => {
		const session = toolSession();
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "element-keys-js" };
		const realm = createContext({
			__omp_display__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.ref("e1").press("cmd+a");
					await win.ref("e1").press();
					await computer.run(async ({ desktop }) => {
						const el = await desktop.ref("e1");
						await el.press(["shift", "tab"]);
						await el.press();
					});
				})()`,
				realm,
			);
			expect(native.axCalls.filter(call => (call as unknown[])[0] !== "axNode")).toEqual([
				["axKeyChord", "e1", ["cmd", "a"], {}],
				["axPerform", "e1", "press"],
				["axKeyChord", "e1", ["shift", "tab"], {}],
				["axPerform", "e1", "press"],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("chains element calls on Python ref() handles and still awaits them to elements", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"win = await computer.window(42)",
					'await win.ref("e1").click(count=2)',
					'await computer.ref("e1").press()',
					'el = await win.ref("e1")',
					"print(repr(el))",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-ref-chain-py-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("<computer.Element ref='e1' role='button'>");
			expect(native.axCalls).toEqual([
				["axNode", "e1"],
				["axClick", "e1", { count: 2 }],
				["axNode", "e1"],
				["axPerform", "e1", "press"],
				["axNode", "e1"],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "ref-chain-py-close" });
		}
	});

	it("double-clicks JavaScript elements and names the element call made on find()'s array", async () => {
		const session = toolSession();
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "element-shape-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const shape = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.ref("e1").doubleClick({ button: "right" });
					await (await win.ref("e1")).doubleClick({ count: 3 });
					const found = await win.find({ role: "button" });
					await found[0].doubleClick();
					await computer.run(async ({ desktop }) => {
						await desktop.ref("e1").doubleClick();
						const [el] = await (await desktop.window(42)).find({ role: "button" });
						await el.doubleClick();
					});
					return { json: JSON.stringify(found), keys: Object.keys(found), spread: [...found].length };
				})()`,
				realm,
			);
			expect({ ...shape, json: JSON.parse(shape.json) }).toEqual({
				json: [expect.objectContaining({ ref: "e1", role: "button" })],
				keys: ["0"],
				spread: 1,
			});
			expect(native.axCalls.filter(call => (call as unknown[])[0] === "axClick")).toEqual([
				["axClick", "e1", { button: "right", count: 2 }],
				["axClick", "e1", { count: 2 }],
				["axClick", "e1", { count: 2 }],
				["axClick", "e1", { count: 2 }],
				["axClick", "e1", { count: 2 }],
			]);
			const misuse = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					const found = await win.find({ role: "button", title: "Run" });
					const messages = [];
					for (const misuse of [() => found.press(), () => win.ref(found.ref)]) {
						try {
							await misuse();
						} catch (error) {
							messages.push(error.message);
						}
					}
					return messages;
				})()`,
				realm,
			);
			expect(misuse).toHaveLength(2);
			expect(misuse[0]).toContain("find() returns an array (length 1), not one element, so it has no press()");
			expect(misuse[0]).toContain("const [el] = await win.find(");
			expect(misuse[1]).toContain("find() returns an array (length 1), not one element, so it has no ref;");
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("double-clicks Python elements and names the element attribute read on find()'s list", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"import copy",
					"win = await computer.window(42)",
					'await win.ref("e1").doubleClick(button="right")',
					'found = await win.find({"role": "button"})',
					"await found[0].doubleClick()",
					"try:",
					"    await found.press()",
					"except AttributeError as error:",
					"    print(error)",
					"print(hasattr(found, 'click'), hasattr(found, 'nope'))",
					"print([element.ref for element in found], found)",
					"print(type(copy.copy(found)).__name__, type(copy.deepcopy(found)).__name__)",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-element-shape-py-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			const lines = result.output.trim().split("\n");
			expect(lines[0]).toContain("find() returns a list (length 1), not one element, so it has no press");
			expect(lines[0]).toContain("el = (await win.find(query))[0]");
			expect(lines[1]).toBe("False False");
			expect(lines[2]).toStartWith("['e1'] [<");
			expect(lines[3]).toBe("list list");
			expect(native.axCalls.filter(call => (call as unknown[])[0] === "axClick")).toEqual([
				["axClick", "e1", { button: "right", count: 2 }],
				["axClick", "e1", { count: 2 }],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "element-shape-py-close" });
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
			expect(options).toEqual({ display: "active", escapeStopKey: expect.stringMatching(/^computer-test-/) });
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

	it("marks a screenshot taken behind the lock screen, and only then", async () => {
		for (const locked of [true, false]) {
			const transport = new MemoryTransport();
			const native = new FakeNativeSession();
			native.screenLocked = locked;
			new ComputerWorkerCore(transport, () => native);

			const result = await runWorker(transport, `locked-${locked}`, "return await desktop.screenshot()");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const [caption] = result.payload.displays.filter(block => block.type === "text");
			const lines = caption?.type === "text" ? caption.text.split("\n") : [];
			if (locked) {
				expect(lines).toHaveLength(2);
				expect(lines[1]).toBe(SCREEN_LOCKED_CAPTURE_NOTE);
				expect(result.payload.screenshots[0]?.screenLocked).toBe(true);
				expect(result.payload.returnValue).toMatchObject({ screenLocked: true });
			} else {
				expect(lines).toHaveLength(1);
				expect(result.payload.screenshots[0]).not.toHaveProperty("screenLocked");
				expect(result.payload.returnValue).not.toHaveProperty("screenLocked");
			}
		}
	});

	it("tells the model a run ended on a locked screen without refusing its input", async () => {
		for (const locked of [true, false]) {
			const session = toolSession();
			const native = new FakeNativeSession();
			native.screenLocked = locked;
			const prelude = workerPrelude(session, native);
			const result = await prelude.invoke(
				{ action: "run", code: "await desktop.screenshot({ silent: true }); await desktop.click(1, 2)" },
				{ session, toolCallId: `locked-run-${locked}`, signal: new AbortController().signal },
			);
			expect(native.clickCount).toBe(1);
			const notes = result.content.filter(block => block.type === "text" && block.text.startsWith("Note: "));
			if (locked) {
				expect(result.content[0]).toMatchObject({
					type: "text",
					text: expect.stringMatching(/^Note: when this run ended the screen is locked\. /),
				});
			} else {
				expect(notes).toEqual([]);
			}
		}
	});

	it("keeps a failed run's own error first and adds the lock state after it", async () => {
		for (const locked of [true, false]) {
			const transport = new MemoryTransport();
			const native = new FakeNativeSession();
			native.screenLocked = locked;
			new ComputerWorkerCore(transport, () => native);
			const result = await runWorker(
				transport,
				`failed-${locked}`,
				'await desktop.screenshot({ silent: true }); await desktop.click(1, 2); assert(false, "verification failed")',
			);
			expect(native.clickCount).toBe(1);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			const [first, ...rest] = result.error.message.split("\n");
			expect(first).toBe("verification failed");
			if (locked) expect(rest.join("\n")).toMatch(/^Note: when this run ended the screen is locked\. /);
			else expect(rest).toEqual([]);
		}
	});

	it("scopes a display-sleep notice to the session's display", async () => {
		const session = toolSession();
		const native = new FakeNativeSession();
		native.displayAsleep = true;
		const prelude = workerPrelude(session, native);
		const result = await prelude.invoke(
			{ action: "run", code: "await desktop.click(1, 2)" },
			{ session, toolCallId: "asleep-run", signal: new AbortController().signal },
		);
		const [note] = result.content;
		const text = note?.type === "text" ? note.text : "";
		expect(text).toMatch(/^Note: when this run ended the session's display is asleep\. /);
		expect(text).toContain("Nothing on that display can be captured or clicked until it wakes.");
		expect(text).toContain("`computer.display`");
	});

	it("adds the lock state to a run timed out by a hung native call without reading capabilities", async () => {
		const started = Promise.withResolvers<void>();
		const hung = Promise.withResolvers<DesktopCapture>();
		class HungSession extends FakeNativeSession {
			/** Native capabilities reads queue behind the hung call when no snapshot exists. */
			blockingReads = 0;
			override get capabilities(): DesktopCapabilities {
				this.blockingReads += 1;
				return super.capabilities;
			}
			override async capture(): Promise<DesktopCapture> {
				started.resolve();
				// Stuck in the OS: cancellation does not settle it.
				return hung.promise;
			}
		}
		const native = new HungSession();
		native.screenLocked = true;
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		const pending = runWorker(transport, "hung", "await desktop.screenshot({ silent: true })", false, 50);
		await started.promise;
		const result = await pending;
		// Let the script's runtime finish so later tests can start theirs.
		hung.reject(new Error("released"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const [first, ...rest] = result.error.message.split("\n");
		expect(first).toBe("Computer code execution timed out after 50ms");
		expect(rest.join("\n")).toMatch(/^Note: when this run ended the screen is locked\. /);
		expect(native.blockingReads).toBe(0);
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
		transport.inbound({
			type: "run",
			id: "abort",
			code: "await wait(5_000)",
			timeoutMs: 5_000,
			session: snapshot(),
			escape: escapeScope(),
		});
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

	describe("window selector misses", () => {
		const desktopWindows: DesktopWindow[] = [
			windowFixture,
			{ ...windowFixture, id: "43", title: "", focused: false },
			{ ...windowFixture, id: "7", app: "Finder", title: "Downloads", pid: 9, focused: false },
			{ ...windowFixture, id: "8", app: "TextEdit", title: "notes.txt", pid: 10, focused: false },
			{ ...windowFixture, id: "9", app: "TextEdit", title: "draft.txt", pid: 10, focused: false },
		];

		class MacSession extends FakeNativeSession {
			override get capabilities(): DesktopCapabilities {
				return { ...super.capabilities, backend: "quartz" };
			}
		}

		async function missMessage(
			windows: DesktopWindow[],
			selector: string,
			options: { native?: FakeNativeSession; readOnly?: boolean } = {},
		): Promise<string> {
			const transport = new MemoryTransport();
			const native = options.native ?? new FakeNativeSession();
			native.listWindows = async () => windows;
			new ComputerWorkerCore(transport, () => native);
			const result = await runWorker(
				transport,
				"window-miss",
				`await desktop.window(${selector})`,
				options.readOnly,
			);
			expect(result.ok).toBe(false);
			return result.ok ? "" : result.error.message;
		}

		it("leads with the requested app's windows when its title filter misses", async () => {
			const message = await missMessage(desktopWindows, '{ app: "textedit", title: "report" }');
			expect(message.split("\n").slice(0, 3)).toEqual([
				'no window matches {"app":"textedit","title":"report"}',
				'Open windows by app (id "title"):',
				'- TextEdit: 8 "notes.txt", 9 "draft.txt"',
			]);
		});

		it("says the app has no window and lists every app's windows, untitled ones included", async () => {
			const lines = (await missMessage(desktopWindows, '{ app: "Calendar" }')).split("\n");
			expect(lines).toContain('No open window belongs to an app matching "Calendar".');
			expect(lines).toContain('computer.apps.open("Calendar") launches it by that exact name or ID.');
			expect(lines).toContain('- Code: 42 "Editor", 43 ""');
			expect(lines).toContain('- Finder: 7 "Downloads"');
			expect(lines).toContain('- TextEdit: 8 "notes.txt", 9 "draft.txt"');
		});

		it("on macOS names apps.open as the call that also shows a running app's window and returns it", async () => {
			const lines = (await missMessage(desktopWindows, '{ app: "Calendar" }', { native: new MacSession() })).split(
				"\n",
			);
			const hint = lines.find(line => line.startsWith('computer.apps.open("Calendar")'));
			expect(hint).toContain("shows a window of it if it runs without one");
			expect(hint).toContain("window: null if none appears");
		});

		it("names apps.open when no window is open at all, and in a read-only run such as a direct window call", async () => {
			expect(await missMessage([], '{ app: "Calendar" }')).toContain('computer.apps.open("Calendar")');
			expect(await missMessage(desktopWindows, '{ app: "Calendar" }', { readOnly: true })).toContain(
				'computer.apps.open("Calendar")',
			);
		});

		it("names the missing selector when called with nothing, instead of matching undefined", async () => {
			for (const windows of [desktopWindows, []]) {
				const message = await missMessage(windows, "");
				expect(message.split("\n")[0]).toContain("computer.window() without an id or { app, title } filter");
				expect(message).not.toContain("undefined");
			}
		});

		it("returns the only open window when called with nothing", async () => {
			const transport = new MemoryTransport();
			const native = new FakeNativeSession();
			native.listWindows = async () => [windowFixture];
			new ComputerWorkerCore(transport, () => native);
			const result = await runWorker(transport, "window-only", "(await desktop.window()).id");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.payload.returnValue).toBe(windowFixture.id);
		});

		it("lists untitled windows by id after titled ones, as when macOS hides other apps' titles", async () => {
			const blank = (id: string): DesktopWindow => ({
				...windowFixture,
				id,
				app: "Notes",
				title: "",
				focused: false,
			});
			const message = await missMessage(
				[windowFixture, blank("50"), blank("51"), blank("52"), { ...blank("53"), title: "Inbox" }],
				'"404"',
			);
			expect(message.split("\n")).toContain('- Notes: 53 "Inbox", 50 "", 51 "", 1 more');
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

	it("blocks read-only selectText before invoking the native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const result = await runWorker(
			transport,
			"select-text-read-only",
			'await (await desktop.window("42")).ref("e1").selectText("cat")',
			true,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("read-only run: 'selectText'");
		expect(native.selections).toEqual([]);
	});

	it("names selectText's text argument on a resolved element before the native call", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const result = await runWorker(
			transport,
			"select-text-resolved-argument",
			'const el = await (await desktop.window("42")).ref("e1"); await el.selectText(7)',
		);
		expect(result.ok ? undefined : result.error).toMatchObject({
			isToolError: true,
			message: "selectText(text) requires a string, got number",
		});
		expect(native.selections).toEqual([]);
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

	describe("more windows than the listing cap", () => {
		class CrowdedSession extends FakeNativeSession {
			override async listWindows(): Promise<DesktopWindow[]> {
				const front = Array.from({ length: 59 }, (_, index) => ({
					...windowFixture,
					id: String(index + 100),
					app: "Front",
					focused: false,
				}));
				return [...front, { ...windowFixture, id: "999", app: "Rear", focused: false }];
			}
		}

		it("caps the listing after filtering and finds a window behind the cap by id or app", async () => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => new CrowdedSession());
			const result = await runWorker(
				transport,
				"crowded-desktop",
				'({ listed: (await desktop.windows()).length, filtered: (await desktop.windows({ app: "rear" })).map(w => w.id), byId: (await desktop.window(999)).app, byApp: (await desktop.window({ app: "rear" })).id })',
			);
			expect(result.ok).toBe(true);
			if (result.ok)
				expect(result.payload.returnValue).toEqual({ listed: 48, filtered: ["999"], byId: "Rear", byApp: "999" });
		});

		it("lists at most 48 candidates for an ambiguous filter", async () => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => new CrowdedSession());
			const result = await runWorker(transport, "crowded-ambiguous", 'await desktop.window({ app: "front" })');
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.message).toContain("147 Front");
			expect(result.error.message).not.toContain("148 Front");
			expect(result.error.message).toContain("… 11 more");
		});
	});

	it("returns plain identity snapshots for rendered handle calls and enforces the derived read-only tier", async () => {
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

	it("returns find() results as plain arrays whose element calls name the pick, and gates element doubleClick as exec", async () => {
		const transport = new MemoryTransport();
		const axClicks: unknown[] = [];
		new ComputerWorkerCore(
			transport,
			() =>
				new (class extends FakeNativeSession {
					override async axClick(ref: string, opts?: PointerOptions | null): Promise<void> {
						axClicks.push([ref, opts]);
					}
				})(),
		);

		const found = await runWorker(
			transport,
			"call-find",
			renderComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "find", args: [{ role: "button" }] },
			]),
			true,
		);
		expect(found.ok).toBe(true);
		if (found.ok) expect(found.payload.returnValue).toEqual([expect.objectContaining({ ref: "e1", role: "button" })]);

		const misuse = await runWorker(
			transport,
			"find-misuse",
			'await (await (await desktop.window(42)).find({ role: "button" })).doubleClick()',
		);
		expect(misuse.ok).toBe(false);
		if (!misuse.ok) {
			expect(misuse.error.message).toContain(
				"find() returns an array (length 1), not one element, so it has no doubleClick()",
			);
		}
		const fieldRead = await runWorker(
			transport,
			"find-field-read",
			'(await (await desktop.window(42)).find({ role: "button" })).enabled',
		);
		expect(fieldRead.ok).toBe(false);
		if (!fieldRead.ok) {
			expect(fieldRead.error.message).toContain(
				"find() returns an array (length 1), not one element, so it has no enabled;",
			);
		}

		const doubleClick = [
			{ method: "ref", args: ["e1"] },
			{ method: "doubleClick", args: [] },
		];
		const blocked = await runWorker(transport, "call-double-click-ro", renderComputerCall(doubleClick), true);
		expect(blocked.ok).toBe(false);
		expect(axClicks).toEqual([]);
		const clicked = await runWorker(
			transport,
			"call-double-click",
			renderComputerCall(doubleClick),
			isReadOnlyComputerCall(doubleClick),
		);
		expect(clicked.ok).toBe(true);
		expect(axClicks).toEqual([["e1", { count: 2 }]]);
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

	it("refuses an empty menu path before anything is sent", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"empty-menu-path",
			'const el = await (await desktop.window("42")).ref("e1"); return await el.press({ menu: [] }).then(() => "sent", error => error.message)',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).not.toBe("sent");
		expect(result.payload.returnValue).toContain("menu path");
	});

	it("answers a direct capabilities request without a prior run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({ type: "capabilities", id: "caps", session: snapshot(true), escape: escapeScope() });
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

		transport.inbound({
			type: "run",
			id: "race-run",
			code: "42",
			timeoutMs: 2_000,
			session: snapshot(true),
			escape: escapeScope(),
		});
		transport.inbound({ type: "capabilities", id: "race-caps", session: snapshot(true), escape: escapeScope() });
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

const CLICK = {
	action: "call",
	chain: [
		{ method: "window", args: ["42"] },
		{ method: "click", args: [1, 2] },
	],
};

/** A real supervisor, worker and prelude over a native session whose Escape stops the host reads, as it does natively. */
async function escapeHarness() {
	const native = new EscapeNativeSession();
	const ownerId = `escape-owner-${crypto.randomUUID()}`;
	const session: ToolSession = { ...toolSession(), getEvalKernelOwnerId: () => ownerId };
	const runListeners = new Set<() => void>();
	const sent = {
		types: [] as string[],
		onRun(listener: () => void) {
			runListeners.add(listener);
			return () => runListeners.delete(listener);
		},
	};
	const supervisor = new ComputerSupervisor(
		session,
		() => {
			const worker = liveWorker(native);
			return {
				...worker,
				send: message => {
					sent.types.push(message.type);
					worker.send(message);
					if (message.type === "run") for (const listener of runListeners) listener();
				},
			};
		},
		undefined,
		undefined,
		{ read: () => native.escapeStops, forget: () => {} },
	);
	const unregister = registerComputerController(ownerId, supervisor);
	const prelude = createComputerPrelude(session, () => supervisor);
	const context = { session, toolCallId: "escape-stop" };
	await prelude.invoke(
		{
			action: "call",
			chain: [
				{ method: "window", args: ["42"] },
				{ method: "screenshot", args: [{ silent: true }] },
			],
		},
		context,
	);
	return {
		native,
		prelude,
		sent,
		ownerId,
		context,
		close: async () => {
			unregister();
			await supervisor.close();
		},
	};
}

function confirmationContext(confirm: NonNullable<AgentToolContext["ui"]>["confirm"]): AgentToolContext {
	return { hasUI: true, ui: { confirm } } as AgentToolContext;
}

function policySession(settings: Record<string, unknown>): ToolSession {
	return { ...toolSession(), settings: Settings.isolated({ "computer.enabled": true, ...settings }) };
}

describe("expanded computer APIs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([true, false])(
		"requires an actual live approval answer (%s), retaining only approved mode across helpers",
		async approved => {
			const native = new FakeNativeSession();
			const session = toolSession();
			const supervisor = new ComputerSupervisor(
				session,
				() => liveWorker(native),
				undefined,
				undefined,
				NO_ESCAPE_STOPS,
			);
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
				expect((await acquiring).details).toMatchObject({
					value: approved ? { active: true } : { active: false, reason: "denied" },
				});
				expect(
					(await supervisor.run("return await desktop.control.state()", 2000, snapshot(true))).returnValue,
				).toEqual({ active: approved });
				expect(native.acquireCount).toBe(approved ? 1 : 0);
				await supervisor.run(
					"const win = await desktop.window(42); await win.screenshot({ silent: true }); await win.click(1, 2); await win.click(1, 2, { takeover: false }); await win.click(1, 2, { takeover: true }); await win.move(1, 2); await win.move(1, 2, { takeover: true });",
					2000,
					snapshot(),
				);
				// The grant never fills in an omitted takeover; only the call decides.
				expect(native.takeovers).toEqual([undefined, false, true, undefined, true]);
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
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => liveWorker(native),
			undefined,
			undefined,
			NO_ESCAPE_STOPS,
		);
		try {
			expect(
				(await supervisor.run('return await desktop.control.acquire({ reason: "Headless" })', 2000, snapshot()))
					.returnValue,
			).toEqual({ active: false, reason: "no-ui" });
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

	it.each([
		["allow", "without a UI", { active: true }],
		["allow", "with a UI", { active: true }],
		["deny", "without a UI", { active: false, reason: "denied" }],
		["deny", "with a UI", { active: false, reason: "denied" }],
	] as const)(
		'answers control.acquire from a "computer.control" %s policy %s, without asking',
		async (policy, ui, expected) => {
			const native = new FakeNativeSession();
			const session = policySession({ "tools.approval": { "computer.control": policy } });
			const supervisor = new ComputerSupervisor(
				session,
				() => liveWorker(native),
				undefined,
				undefined,
				NO_ESCAPE_STOPS,
			);
			const confirm = vi.fn(async () => true);
			try {
				const result = await supervisor.run(
					'return await desktop.control.acquire({ reason: "Policy" })',
					2_000,
					snapshot(),
					undefined,
					ui === "with a UI"
						? { ...confirmationContext(confirm), settings: session.settings }
						: ({ hasUI: false, settings: session.settings } as AgentToolContext),
				);
				expect(result.returnValue).toEqual(expected);
				expect(confirm).not.toHaveBeenCalled();
				expect(native.controlActive).toBe(policy === "allow");
			} finally {
				await supervisor.close();
			}
		},
	);

	// Neither the approval mode nor the computer policy grants foreground control.
	it.each([
		["yolo mode", false],
		["--auto-approve", true],
	])("answers headless control.acquire no-ui under %s with a computer allow", async (_label, autoApprove) => {
		const native = new FakeNativeSession();
		const session = policySession({ "tools.approvalMode": "yolo", "tools.approval": { computer: "allow" } });
		const supervisor = new ComputerSupervisor(
			session,
			() => liveWorker(native),
			undefined,
			undefined,
			NO_ESCAPE_STOPS,
		);
		try {
			const result = await supervisor.run(
				'return await desktop.control.acquire({ reason: "Headless" })',
				2_000,
				snapshot(),
				undefined,
				{ hasUI: false, autoApprove, settings: session.settings } as AgentToolContext,
			);
			expect(result.returnValue).toEqual({ active: false, reason: "no-ui" });
			expect(native.acquireCount).toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	it.each([
		["settles when its dialog closes", true],
		["ignores the close", false],
	])("closes an unanswered control prompt before the run times out, when the UI %s", async (_label, settles) => {
		const native = new FakeNativeSession();
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => liveWorker(native),
			undefined,
			undefined,
			NO_ESCAPE_STOPS,
		);
		const lateAnswer = Promise.withResolvers<boolean>();
		let closedAfterMs: number | undefined;
		try {
			const result = await supervisor.run(
				'return await desktop.control.acquire({ reason: "Nobody is here" })',
				2_000,
				snapshot(),
				undefined,
				confirmationContext(async (_title, _reason, options) => {
					const shown = performance.now();
					options?.signal?.addEventListener("abort", () => {
						closedAfterMs = performance.now() - shown;
						if (settles) lateAnswer.resolve(false);
					});
					return await lateAnswer.promise;
				}),
			);
			expect(result.returnValue).toEqual({ active: false, reason: "unanswered" });
			// The prompt closed before the 2 s run timed out, leaving a quarter of it to the script.
			expect(closedAfterMs).toBeGreaterThan(1_000);
			expect(closedAfterMs).toBeLessThan(2_000);
			// A yes after the prompt closed grants nothing.
			lateAnswer.resolve(true);
			expect(
				(await supervisor.run("return await desktop.control.state()", 2_000, snapshot(true))).returnValue,
			).toEqual({ active: false });
			expect(native.acquireCount).toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	it("answers unanswered without a prompt when the run has no time left to wait", async () => {
		const native = new FakeNativeSession();
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => liveWorker(native),
			undefined,
			undefined,
			NO_ESCAPE_STOPS,
		);
		const confirm = vi.fn(async () => true);
		try {
			const result = await supervisor.run(
				// 400 ms remain of the 2 s run, less than the quarter (500 ms) a prompt must leave the script.
				'await wait(1_600); return await desktop.control.acquire({ reason: "Too late" })',
				2_000,
				snapshot(),
				undefined,
				confirmationContext(confirm),
			);
			expect(result.returnValue).toEqual({ active: false, reason: "unanswered" });
			expect(confirm).not.toHaveBeenCalled();
			expect(native.acquireCount).toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	it("revokes an acquired grant on worker error and disposal", async () => {
		const native = new FakeNativeSession();
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => liveWorker(native),
			undefined,
			undefined,
			NO_ESCAPE_STOPS,
		);
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

	it("refuses computer use after the user's Escape until their next message, and not after a host abort", async () => {
		const { native, prelude, sent, ownerId, context, close } = await escapeHarness();
		try {
			await prelude.invoke(CLICK, context);
			const abort = new AbortController();
			const runSent = Promise.withResolvers<void>();
			const unsubscribe = sent.onRun(runSent.resolve);
			const hung = prelude.invoke(
				{ action: "run", code: "await wait(5_000)" },
				{ ...context, signal: abort.signal },
			);
			await runSent.promise;
			unsubscribe();
			const cancels = native.cancelCount;
			abort.abort();
			await expect(hung).rejects.toThrow();
			expect(native.cancelCount).toBeGreaterThan(cancels);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(2);

			native.escapeOnClick = true;
			await expect(prelude.invoke(CLICK, context)).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			const sentAfterStop = sent.types.length;
			for (const parameters of [CLICK, { action: "run", code: "return 1" }, { action: "capabilities" }]) {
				await expect(prelude.invoke(parameters, context)).rejects.toThrow("the user pressed Escape");
			}
			expect(sent.types.length).toBe(sentAfterStop);
			expect(native.clickCount).toBe(2);

			resumeComputerUseForOwner(ownerId);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(3);
		} finally {
			await close();
		}
	});

	it("says a call that finished sent its input when the user's Escape lands as it returns", async () => {
		class EscapeAsClickReturns extends FakeNativeSession {
			override async click(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void> {
				await super.click(target, x, y, opts);
				// Every event went out; the Escape lands in the call's tail, before it returns.
				this.escapeStops = 1;
			}
		}
		const transport = new MemoryTransport();
		const native = new EscapeAsClickReturns();
		new ComputerWorkerCore(transport, () => native);
		await runWorker(transport, "capture-click", "await (await desktop.window(42)).screenshot({ silent: true })");
		const result = await runWorker(transport, "finished-click", "await (await desktop.window(42)).click(1, 2)");
		expect(native.clickCount).toBe(1);
		expect(result.ok ? result.payload.returnValue : result.error).toMatchObject({
			isAbort: false,
			message: ESCAPE_AFTER_CALL_MESSAGE,
		});
	});

	it("reports what the stopped operation said, such as a failed restoration, ahead of the stop", async () => {
		const { native, prelude, context, close } = await escapeHarness();
		try {
			native.escapeOnClick = true;
			native.escapeError =
				"Cancelled: desktop operation cancelled; input may be partial; restoration also failed: key up for shift was not posted; inspect the desktop before retrying";
			const stopped = prelude.invoke(
				{ action: "run", code: "await (await desktop.window(42)).click(1, 2)" },
				context,
			);
			await expect(stopped).rejects.toThrow(`restoration also failed: key up for shift was not posted`);
			await expect(stopped).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
		} finally {
			await close();
		}
	});

	it("still words a run as the user's stop when their next message lifted it while the run ended", async () => {
		const { native, prelude, ownerId, context, close } = await escapeHarness();
		try {
			native.escapeOnClick = true;
			// The user's message lands while the stopped run is still ending, so the host sees no stop pending.
			native.onEscape = () => resumeComputerUseForOwner(ownerId);
			await expect(
				prelude.invoke({ action: "run", code: "await (await desktop.window(42)).click(1, 2)" }, context),
			).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(1);
		} finally {
			await close();
		}
	});

	it("answers a capabilities request while a stopped run is still ending, leaving the refusal to the host", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const run = runWorker(transport, "stopped-run", "await tool.barrier({})");
		const call = await transport.waitFor(message => message.type === "tool-call" && message.runId === "stopped-run");
		// The user's Escape lands while the run waits on its tool; the run is not told until its next check.
		native.escapeStops = 1;
		transport.inbound({ type: "capabilities", id: "during-stop", session: snapshot(true), escape: escapeScope() });
		const reply = await transport.waitFor(message => message.type === "capabilities" && message.id === "during-stop");
		expect(reply).toMatchObject({ type: "capabilities", ok: true });
		if (call.type === "tool-call")
			transport.inbound({ type: "tool-reply", id: call.id, reply: { ok: true, value: null } });
		await run;
	});

	it("sends nothing more from a run whose script catches the cancelled operation", async () => {
		const { native, prelude, context, close } = await escapeHarness();
		try {
			native.escapeOnClick = true;
			const code = `
				const win = await desktop.window(42);
				try { await win.click(1, 2); } catch {}
				for (const next of [() => win.click(1, 2), () => desktop.ref("e1").setValue("x"), () => desktop.capabilities()]) {
					try { await next(); } catch {}
				}
				return 1;`;
			const reads = native.capabilityReads;
			await expect(prelude.invoke({ action: "run", code }, context)).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			expect(native.clickCount).toBe(0);
			expect(native.operations).toEqual([]);
			expect(native.capabilityReads).toBe(reads);
		} finally {
			await close();
		}
	});

	it.each([
		["a clipboard write", 'await desktop.clipboard.write("after");'],
		["a bridged tool call", "await tool.echo({ value: 7 });"],
	])("stops a run before %s after an Escape between native calls", async (_path, effect) => {
		/** The user's Escape lands right after `listWindows` settled and passed its check, while no native call runs. */
		class LateEscapeSession extends FakeNativeSession {
			#readsSinceList: number | undefined;
			constructor() {
				super();
				// The base class declares `escapeStops` as a field, which an accessor override would not shadow.
				Object.defineProperty(this, "escapeStops", {
					get: () => {
						if (this.#readsSinceList === undefined) return 0;
						this.#readsSinceList += 1;
						return this.#readsSinceList > 1 ? 1 : 0;
					},
				});
			}
			override async listWindows(): Promise<DesktopWindow[]> {
				this.#readsSinceList = 0;
				return await super.listWindows();
			}
		}
		const written: string[] = [];
		vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async text => {
			written.push(text);
		});
		const transport = new MemoryTransport();
		// Answer a tool call a regression would send, so the run still ends.
		transport.listeners.add(message => {
			if (message.type === "tool-call")
				transport.inbound({ type: "tool-reply", id: message.id, reply: { ok: true, value: null } });
		});
		new ComputerWorkerCore(transport, () => new LateEscapeSession());
		const result = await runWorker(transport, "effect-after-escape", `await desktop.windows(); ${effect} return 1;`);
		// The worker ends the run with the user's stop, not a bare abort.
		expect(result.ok ? result.payload.returnValue : result.error).toMatchObject({
			isAbort: false,
			message: ESCAPE_STOPPED_MESSAGE,
		});
		expect(written).toEqual([]);
		expect(transport.outbound.filter(message => message.type === "tool-call")).toEqual([]);
	});

	it("starts a clipboard write only once the previous one finished, so its Escape check comes last", async () => {
		// `copyToClipboard` queues a write behind one in flight; an Escape during that wait would follow the check.
		const started: Array<{ text: string; overlapping: boolean }> = [];
		let inFlight = 0;
		vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async text => {
			started.push({ text, overlapping: inFlight > 0 });
			inFlight += 1;
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			inFlight -= 1;
		});
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"queued-clipboard",
			'await Promise.all([desktop.clipboard.write("first"), desktop.clipboard.write("second")]);',
		);
		expect(result.ok).toBe(true);
		expect(started).toEqual([
			{ text: "first", overlapping: false },
			{ text: "second", overlapping: false },
		]);
	});

	it("refuses capabilities and runs after an Escape between calls that no run reported", async () => {
		const { native, prelude, sent, ownerId, context, close } = await escapeHarness();
		try {
			await prelude.invoke(CLICK, context);
			const sentBefore = sent.types.length;
			// Held control stopped between calls: no run observes it before the next call.
			native.escapeStops += 1;
			await expect(prelude.invoke({ action: "capabilities" }, context)).rejects.toThrow("the user pressed Escape");
			await expect(prelude.invoke(CLICK, context)).rejects.toThrow("the user pressed Escape");
			expect(sent.types.length).toBe(sentBefore);

			// The user's message acknowledges that stop even though no run saw it.
			resumeComputerUseForOwner(ownerId);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(2);
			native.escapeStops += 1;
			await expect(prelude.invoke(CLICK, context)).rejects.toThrow("the user pressed Escape");
		} finally {
			await close();
		}
	});

	it("keeps an Escape stop that no result reported across a worker restart", async () => {
		let stops = 0;
		let workers = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				workers += 1;
				const worker = new SupervisorWorker(false);
				return {
					send: message => {
						// The user's Escape lands while the hung run holds the worker.
						if (message.type === "run") stops += 1;
						worker.send(message);
					},
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => worker.terminate(),
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			await expect(supervisor.run("while (true) {}", 5, snapshot())).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow("the user pressed Escape");
			await expect(supervisor.capabilities(snapshot(true))).rejects.toThrow("the user pressed Escape");
			expect(workers).toBe(1);
		} finally {
			await supervisor.close();
		}
	});

	it("keeps a run's result, led by the stop, when the stop lands after the worker answered", async () => {
		let stops = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const worker = new SupervisorWorker(true);
				return {
					send: message => {
						worker.send(message);
						if (message.type === "run") queueMicrotask(() => (stops += 1));
					},
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => worker.terminate(),
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			const result = await supervisor.run("1", 1_000, snapshot());
			expect(result.returnValue).toBe("fresh");
			expect(result.displays[0]).toEqual({ type: "text", text: ESCAPE_AFTER_CALL_MESSAGE });
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow("the user pressed Escape");
		} finally {
			await supervisor.close();
		}
	});

	it("reports a stop that lands while a capabilities request is in flight", async () => {
		let stops = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const worker = new SupervisorWorker(true);
				return {
					send: message => {
						worker.send(message);
						// Held control keeps the monitor armed between runs; the worker's capabilities reply cannot see it.
						if (message.type === "capabilities") stops += 1;
					},
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => worker.terminate(),
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			await expect(supervisor.capabilities(snapshot(true))).rejects.toThrow("the user pressed Escape");
		} finally {
			await supervisor.close();
		}
	});

	it("keeps the worker's own error ahead of the stop it reports", async () => {
		let stops = 0;
		const partial = "type: 3 of 10 characters were sent before the input was cancelled";
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const handlers = new Set<(message: ComputerWorkerOutbound) => void>();
				const emit = (message: ComputerWorkerOutbound) => {
					for (const handler of handlers) handler(message);
				};
				return {
					send: message => {
						if (message.type === "close") queueMicrotask(() => emit({ type: "closed" }));
						if (message.type !== "run") return;
						stops += 1;
						const error = { name: "ToolError", message: partial, isToolError: true, isAbort: false };
						queueMicrotask(() => emit({ type: "result", id: message.id, ok: false, error }));
					},
					onMessage: handler => {
						handlers.add(handler);
						queueMicrotask(() => emit({ type: "ready" }));
						return () => handlers.delete(handler);
					},
					onError: () => () => {},
					terminate: async () => {},
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow(
				`${partial}\n\n${ESCAPE_STOPPED_MESSAGE}`,
			);
		} finally {
			await supervisor.close();
		}
	});

	it("delivers the user's message and keeps the stop when the native count cannot be read", async () => {
		let stops = 0;
		let unreadable = false;
		const ownerId = `escape-owner-${crypto.randomUUID()}`;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new SupervisorWorker(true),
			{ startMs: 200, closeMs: 200 },
			undefined,
			{
				read: () => {
					// The stale-addon stub `desktopEscapeStops` falls back to.
					if (unreadable) throw new Error("@oh-my-pi/pi-natives export `desktopEscapeStops` is missing");
					return stops;
				},
				forget: () => {},
			},
		);
		const unregister = registerComputerController(ownerId, supervisor);
		try {
			await supervisor.run("1", 1_000, snapshot());
			stops = 1;
			unreadable = true;
			// AgentSession calls this while delivering the user's message; a throw would reject its event handling.
			resumeComputerUseForOwner(ownerId);
			unreadable = false;
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow("the user pressed Escape");
		} finally {
			unregister();
			await supervisor.close();
		}
	});

	it("terminates the worker on close when the native count cannot be dropped", async () => {
		let terminated = false;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const worker = new SupervisorWorker(true);
				return {
					send: message => worker.send(message),
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => {
						terminated = true;
						return worker.terminate();
					},
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{
				read: () => 0,
				forget: () => {
					throw new Error("@oh-my-pi/pi-natives export `forgetDesktopEscapeStops` is missing");
				},
			},
		);
		await supervisor.run("1", 1_000, snapshot());
		await supervisor.close();
		expect(terminated).toBe(true);
	});

	it("routes nested menus, displays, observation, applications and bounded holds through the JS facade and worker", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "expanded-js" };
		const images: unknown[] = [];
		const realm = createContext({
			__omp_log__: () => {},
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
				const opened = await computer.apps.open(apps[0].id, { activate: false });
				await opened.window.click(7, 8);
				return { menu, observation, display: { ...display }, apps, opened: { ...opened, window: String(opened.window) } };
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
			expect(value.opened).toEqual({ ...value.apps[0], window: "<window 42 Code>" });
			expect(native.clicks).toEqual([
				{ target: "42", x: 60, y: 30 },
				{ target: "display:display-1", x: 60, y: 30 },
				{ target: "42", x: 7, y: 8 },
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
					"await win.menu.select('File', 'Save')",
					"await win.menu.select(path=['File', 'Save'])",
					"print((await win.menu.items(path='File'))[0]['path'])",
					"try:\n    await win.menu.select('File', None)\nexcept Exception as error:\n    print('select-none:', error)",
					"obs = await win.observe(silent=True)",
					"await win.click(60, 30)",
					"monitor = await computer.display('display-1')",
					"await monitor.screenshot(silent=True)",
					"await monitor.holdKeys(['space'], duration=0)",
					"await win.holdMouse(1, 2, duration=0)",
					"apps = await computer.apps.list(runningOnly=True)",
					"opened = await computer.apps.open(apps[0]['id'], activate=False)",
					"print(obs['nodeCount'], monitor.id, (await computer.control.state())['active'], opened['name'], opened['window'])",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-expanded-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("1 display-1 False Editor <computer.Window id='42' app='Code'>");
			expect(result.output).toContain("['File', 'Save']");
			expect(result.output).toContain("select-none: menu.select requires a menu path");
			expect(result.output).toContain('got ["File",null]');
			expect(native.controlActive).toBe(false);
			expect(native.operations.filter(operation => operation.startsWith("menu:"))).toEqual([
				"menu:42:File/Save",
				"menu:42:File/Save",
				"menu:42:File/Save",
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "expanded-py" });
		}
	});

	it("takes a menu path as one title, an array, or separate titles, and names those forms when it is malformed", async () => {
		const session = toolSession();
		const native = new FakeNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "menu-path-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const items = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.menu.select("File", "Save");
					await win.menu.select(["File", "Save"]);
					return [await win.menu.items("File", "Save"), await win.menu.items(["File"]), await win.menu.items()];
				})()`,
				realm,
			);
			expect(items.map((list: Array<{ path: string[] }>) => list[0]!.path)).toEqual([
				["File", "Save", "Save"],
				["File", "Save"],
				["Save"],
			]);
			expect(native.operations).toEqual(["menu:42:File/Save", "menu:42:File/Save"]);
			const forms =
				'requires a menu path of non-empty titles: one title ("File"), an array (["File", "Export…"]), or separate titles ("File", "Export…")';
			for (const [call, got] of [
				["select()", "no path"],
				['select(["File"], "Save")', '[["File"],"Save"]'],
				['select("File", "")', '["File",""]'],
				['select("File", undefined)', '["File",null]'],
			]) {
				await expect(
					runInContext(`(async () => (await computer.window(42)).menu.${call})()`, realm),
				).rejects.toThrow(`menu.select ${forms}; got ${got}`);
			}
			expect(native.operations).toHaveLength(2);

			// Worker-side code may pass an optional path on as `undefined`, or a value JSON cannot show.
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => native);
			const root = await runWorker(
				transport,
				"menu-undefined",
				"return (await (await desktop.window(42)).menu.items(undefined))[0].path",
			);
			expect(root.ok ? root.payload.returnValue : root.error).toEqual(["Save"]);
			for (const [code, got] of [
				["menu.select(1n)", "bigint"],
				["menu.select((() => { const path = []; path.push(path); return path; })())", "an array"],
			]) {
				const result = await runWorker(transport, `menu-${got}`, `await (await desktop.window(42)).${code}`);
				expect(result.ok ? undefined : result.error).toMatchObject({
					isToolError: true,
					message: `menu.select ${forms}; got ${got}`,
				});
			}
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("names the helper and argument for a missing or non-string text argument before any native call", async () => {
		class ArgumentSession extends FakeNativeSession {
			readonly calls: string[] = [];
			override async axNode(ref: string): Promise<AxNode> {
				this.calls.push(`axNode:${ref}`);
				return axNode;
			}
			override async axSetValue(ref: string, _value: string): Promise<void> {
				this.calls.push(`axSetValue:${ref}`);
			}
			override async axSelectText(
				ref: string,
				text: string,
				opts?: AxSelectTextOptions | null,
			): Promise<AxTextSelection> {
				this.calls.push(`axSelectText:${ref}`);
				return super.axSelectText(ref, text, opts);
			}
			override async axPerform(ref: string, _action: string): Promise<void> {
				this.calls.push(`axPerform:${ref}`);
			}
			override async typeText(target: string, _text: string): Promise<void> {
				this.calls.push(`typeText:${target}`);
			}
			override async keyChord(target: string, _keys: string[]): Promise<void> {
				this.calls.push(`keyChord:${target}`);
			}
			override async axType(ref: string, _text: string): Promise<void> {
				this.calls.push(`axType:${ref}`);
			}
			override async axKeyChord(ref: string, _keys: string[]): Promise<void> {
				this.calls.push(`axKeyChord:${ref}`);
			}
			override async openApplication(id: string) {
				this.calls.push(`open:${id}`);
				return super.openApplication(id);
			}
		}
		const transport = new MemoryTransport();
		const native = new ArgumentSession();
		new ComputerWorkerCore(transport, () => native);
		for (const [code, message] of [
			['await desktop.ref("e1").setValue()', "setValue(value) requires a string, got undefined"],
			['await desktop.ref("e1").setValue(42)', "setValue(value) requires a string, got number"],
			['await desktop.ref("e1").selectText()', "selectText(text) requires a string, got undefined"],
			['await desktop.ref("e1").selectText(["cat"])', "selectText(text) requires a string, got an array"],
			['await desktop.ref("e1").perform("")', 'perform(action) requires a non-empty string, got ""'],
			['await desktop.ref("e1").type()', "type(text) requires a string, got undefined"],
			[
				'await desktop.ref("e1").press([])',
				'press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got an array',
			],
			["desktop.ref()", "ref(ref) requires a non-empty string, got undefined"],
			["(await desktop.window(42)).ref(null)", "ref(ref) requires a non-empty string, got null"],
			["await (await desktop.window(42)).type()", "type(text) requires a string, got undefined"],
			["await desktop.type(['a'])", "type(text) requires a string, got an array"],
			[
				"await desktop.press()",
				'press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got undefined',
			],
			[
				"await desktop.press(['cmd', 1])",
				'press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got an array',
			],
			["await desktop.apps.open()", "apps.open(id) requires a non-empty string, got undefined"],
			// Last: reverting the fix would hand undefined to the real clipboard.
			["await desktop.clipboard.write()", "clipboard.write(text) requires a string, got undefined"],
		]) {
			const result = await runWorker(transport, `argument-${code}`, code);
			expect(result.ok ? undefined : result.error).toMatchObject({ isToolError: true, message });
		}
		// A read-only run still reports the read-only refusal first.
		const readOnly = await runWorker(transport, "argument-read-only", 'await desktop.ref("e1").setValue()', true);
		expect(readOnly.ok ? undefined : readOnly.error.message).toBe(
			"read-only run: 'setValue' requires read_only: false",
		);
		// A menu read makes its macOS window key, so a read-only run refuses it too.
		const menuRead = await runWorker(
			transport,
			"menu-read-only",
			"await (await desktop.window(42)).menu.items()",
			true,
		);
		expect(menuRead.ok ? undefined : menuRead.error.message).toBe(
			"read-only run: 'menu.items' requires read_only: false",
		);
		// The JavaScript facade's direct ref call checks the argument before the ref lookup too.
		const session = toolSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "argument-facade" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			await expect(runInContext('computer.ref("e1").setValue()', realm)).rejects.toThrow(
				"setValue(value) requires a string, got undefined",
			);
			await expect(runInContext('computer.ref("e1").perform()', realm)).rejects.toThrow(
				"perform(action) requires a non-empty string, got undefined",
			);
			await expect(runInContext('computer.ref("e1").selectText()', realm)).rejects.toThrow(
				"selectText(text) requires a string, got undefined",
			);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
		expect(native.calls).toEqual([]);
	});

	it("leaves a printed observe() tree out of the JavaScript value's echo, but keeps ax readable", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "observe-once-js" };
		const printed: string[] = [];
		const realm = createContext({
			__omp_log__: (_level: string, text: string) => printed.push(text),
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
				return { text, details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const [mutated, observation, silent] = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					const options = { silent: true };
					const pending = win.observe(options);
					options.silent = false;
					const mutated = await pending;
					return [mutated, await win.observe(), await win.observe({ silent: true })];
				})()`,
				realm,
			);
			expect(printed.join("\n").split("- button [ref=e1]")).toHaveLength(2);
			expect(observation.ax).toBe("- button [ref=e1]");
			// Eval echoes a trailing value the way console.log prints it.
			expect(inspect(observation)).not.toContain("- button [ref=e1]");
			expect(structuredClone(observation)).toMatchObject({ nodeCount: 1, truncated: false });
			expect({ ...observation }).not.toHaveProperty("ax");
			expect(JSON.parse(JSON.stringify(observation))).not.toHaveProperty("ax");
			expect(structuredClone(silent)).toMatchObject({ ax: "- button [ref=e1]", nodeCount: 1 });
			// The call ran silent, so its value keeps the only copy of the tree.
			expect(structuredClone(mutated)).toMatchObject({ ax: "- button [ref=e1]" });
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("prints a trailing Python observe() tree once and keeps ax readable", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		const run = (code: string) =>
			executePython(code, {
				cwd: process.cwd(),
				sessionId: `computer-observe-once-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			});
		// Everything the model reads from a cell: printed text and non-view outputs (views are user-only).
		const trees = async (call: string) => {
			const result = await run(`win = await computer.window(42)\n${call}`);
			expect(result.exitCode).toBe(0);
			const modelOutputs = result.displayOutputs.filter(output => output.type !== "view");
			return `${result.output}${JSON.stringify(modelOutputs)}`.split("- button [ref=e1]").length - 1;
		};
		try {
			for (const call of [
				"await win.observe()",
				"print(await win.observe())",
				"await win.observe(silent=True)",
				"await win.observe({'silent': True})",
				"await win.observe({'silent': True}, silent=None)",
				"await win.observe({'silent': True}, silent=False)",
				"await win.observe({'silent': False}, silent=True)",
			]) {
				expect([call, await trees(call)]).toEqual([call, 1]);
			}
			const read = await run(
				"obs = await (await computer.window(42)).observe()\nprint(obs['ax'] == '- button [ref=e1]')",
			);
			expect(read.output.trim().split("\n").at(-1)).toBe("True");
			const pickled = await run(
				"import pickle\nobs = await (await computer.window(42)).observe()\ncopy = pickle.loads(pickle.dumps(obs))\nprint(type(copy) is dict and copy == dict(obs) and 'ax' in copy)",
			);
			expect(pickled.output.trim().split("\n").at(-1)).toBe("True");
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "observe-once-py" });
		}
	}, 30_000);

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
		for (const method of ["observe"])
			expect(
				isReadOnlyComputerCall([
					{ method: "window", args: [42] },
					{ method, args: [] },
				]),
			).toBe(true);
		for (const method of ["menu.items", "menu.select", "bringToCurrentSpace", "holdKeys", "holdMouse"])
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
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new SupervisorWorker(++workers > 1),
			{
				startMs: 200,
				closeMs: 200,
			},
			undefined,
			NO_ESCAPE_STOPS,
		);
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
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new SupervisorWorker(true),
			{
				startMs: 200,
				closeMs: 200,
			},
			undefined,
			NO_ESCAPE_STOPS,
		);
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
		});
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
			escape: escapeScope(),
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
			escape: escapeScope(),
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
		transport.inbound({ type: "discard", cellId: "cell-cancelled" });

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

describe("display hold follows the agent turn", () => {
	async function runTurn(transport: MemoryTransport, id: string, code: string, displayTurn?: number, cellId?: string) {
		transport.inbound({
			type: "run",
			id,
			code,
			timeoutMs: 2_000,
			session: { ...snapshot(false, displayTurn), cellId },
			escape: escapeScope(),
		});
		const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
		if (message.type !== "result" || !message.ok) throw new Error(`run ${id} failed`);
		return message.payload.returnValue;
	}

	it("settles cells independently after their display turn ends without holding it again", async () => {
		const native = new EditableWindowSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		await readCell(transport, "read");

		await runTurn(transport, "first", 'await (await desktop.window("42")).type("alpha")', 1, "cell-first");
		await runTurn(transport, "second", 'await (await desktop.window("42")).type("beta")', 1, "cell-second");
		transport.inbound({ type: "release-display", turn: 1 });
		transport.inbound({
			type: "settle",
			id: "settle-first",
			timeoutMs: 5_000,
			session: { ...snapshot(true, 1), cellId: "cell-first" },
			output: "",
		});
		const result = await transport.waitFor(message => message.type === "result" && message.id === "settle-first");
		if (result.type !== "result" || !result.ok) throw new Error("Expected the first cell's settlement");
		expect(result.payload.returnValue).toContain('after type "alpha"');
		expect(result.payload.returnValue).not.toContain('type "beta"');
		expect(await settleWorker(transport, "settle-first-again", "", "cell-first")).toBeUndefined();
		expect(await settleWorker(transport, "settle-second", "", "cell-second")).toContain('after type "beta"');
		expect(native.displayHolds).toEqual(["turn", "turn", "release"]);
	});

	it("holds the display for a run inside a turn, and the turn's end releases only the hold", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);

		expect(
			await runTurn(transport, "turn-1", "globalThis.kept = (await desktop.windows())[0].id; return kept;", 1),
		).toBe("42");
		expect(native.displayHolds).toEqual(["turn"]);
		await native.acquireControl();
		const before = { cancel: native.cancelCount, retire: native.retireCount, close: native.closeCount };

		transport.inbound({ type: "release-display", turn: 1 });
		expect(native.displayHolds).toEqual(["turn", "release"]);
		expect({ cancel: native.cancelCount, retire: native.retireCount, close: native.closeCount }).toEqual(before);
		expect(native.controlState()).toEqual({ active: true });

		// A run of the ended turn that arrives after its end (work outliving the turn) is left to the grace period.
		await runTurn(transport, "turn-1-late", "return kept;", 1);
		expect(native.displayHolds).toEqual(["turn", "release"]);

		// The next turn's first run holds it again, in the same native session and runtime.
		expect(await runTurn(transport, "turn-2", "return kept;", 2)).toBe("42");
		expect(native.displayHolds).toEqual(["turn", "release", "turn"]);
	});

	it("leaves a run outside any turn to the native grace period", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		await runTurn(transport, "no-turn", "return (await desktop.windows()).length;");
		expect(native.displayHolds).toEqual([]);
	});

	it("holds the display again for a run whose turn goes on after a dialog", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		transport.inbound({
			type: "run",
			id: "confirming",
			code: 'await desktop.control.acquire({ reason: "Edit" }); return 1;',
			timeoutMs: 2_000,
			session: snapshot(false, 1),
			escape: escapeScope(),
		});
		const confirm = await transport.waitFor(
			message => message.type === "control-request" && message.runId === "confirming",
		);
		if (confirm.type !== "control-request") throw new Error("Expected the run's control confirmation");
		expect(native.displayHolds).toEqual(["turn"]);
		// The confirmation dialog ends turn 1; the answer resumes it as turn 2.
		transport.inbound({ type: "release-display", turn: 1 });
		transport.inbound({ type: "resume-display", from: 5, turn: 6 });
		expect(native.displayHolds).toEqual(["turn", "release"]);
		transport.inbound({ type: "resume-display", from: 1, turn: 2 });
		expect(native.displayHolds).toEqual(["turn", "release", "turn"]);
		transport.inbound({ type: "tool-reply", id: confirm.id, reply: { ok: true, value: "approved" } });
		await transport.waitFor(message => message.type === "result" && message.id === "confirming");

		// With no run of that turn active, a resume holds nothing.
		transport.inbound({ type: "resume-display", from: 2, turn: 3 });
		expect(native.displayHolds).toEqual(["turn", "release", "turn"]);
	});

	it("treats the old boolean control reply as a refusal, not a grant", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		transport.inbound({
			type: "run",
			id: "unknown-verdict",
			code: 'return await desktop.control.acquire({ reason: "Edit" });',
			timeoutMs: 2_000,
			session: snapshot(),
			escape: escapeScope(),
		});
		const confirm = await transport.waitFor(message => message.type === "control-request");
		if (confirm.type !== "control-request") throw new Error("Expected the run's control confirmation");
		transport.inbound({ type: "tool-reply", id: confirm.id, reply: { ok: true, value: true } });
		const result = await transport.waitFor(message => message.type === "result" && message.id === "unknown-verdict");
		if (result.type !== "result" || !result.ok) throw new Error("control.acquire failed");
		expect(result.payload.returnValue).toEqual({ active: false, reason: "denied" });
		expect(native.acquireCount).toBe(0);
	});

	it("gives a control confirmation the run's time less 5 s, and passes an unanswered verdict on", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		transport.inbound({
			type: "run",
			id: "unanswered-verdict",
			code: 'return await desktop.control.acquire({ reason: "Edit" });',
			timeoutMs: 120_000,
			session: snapshot(),
			escape: escapeScope(),
		});
		const confirm = await transport.waitFor(message => message.type === "control-request");
		if (confirm.type !== "control-request") throw new Error("Expected the run's control confirmation");
		expect(confirm.timeoutMs).toBeGreaterThan(114_000);
		expect(confirm.timeoutMs).toBeLessThanOrEqual(115_000);
		transport.inbound({ type: "tool-reply", id: confirm.id, reply: { ok: true, value: "unanswered" } });
		const result = await transport.waitFor(
			message => message.type === "result" && message.id === "unanswered-verdict",
		);
		if (result.type !== "result" || !result.ok) throw new Error("control.acquire failed");
		expect(result.payload.returnValue).toEqual({ active: false, reason: "unanswered" });
		expect(native.acquireCount).toBe(0);
	});

	it("carries a turn resumed while a cold run starts into that run's hold", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		const created = Promise.withResolvers<void>();
		new ComputerWorkerCore(transport, async () => {
			await created.promise;
			return native;
		});
		transport.inbound({
			type: "run",
			id: "cold",
			code: "return 1;",
			timeoutMs: 2_000,
			session: snapshot(false, 1),
			escape: escapeScope(),
		});
		// A dialog opens and is answered while the native session is still being created.
		transport.inbound({ type: "release-display", turn: 1 });
		transport.inbound({ type: "resume-display", from: 1, turn: 2 });
		created.resolve();
		await transport.waitFor(message => message.type === "result" && message.id === "cold");
		expect(native.displayHolds).toEqual(["turn"]);
	});

	it("numbers runs by the owner's turn and releases the owner's sessions once when it ends", async () => {
		const owner = `computer-turn-${crypto.randomUUID()}`;
		const snapshots: ComputerSessionSnapshot[] = [];
		const settledSnapshots: ComputerSessionSnapshot[] = [];
		const releases: number[] = [];
		const session: ToolSession = { ...toolSession(), getEvalKernelOwnerId: () => owner };
		const prelude = createComputerPrelude(session, () => ({
			async run(_code, _timeoutMs, runSnapshot) {
				snapshots.push(runSnapshot);
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async settle(runSnapshot) {
				settledSnapshots.push(runSnapshot);
				return undefined;
			},
			async capabilities() {
				return capabilities;
			},
			releaseDisplay(turn) {
				releases.push(turn);
			},
			async close() {},
		}));
		const signal = new AbortController().signal;
		const cell: PreludeCell = { signal };
		const context = { session, toolCallId: "computer-turn", signal, cell };
		const run = () => prelude.invoke({ action: "run", code: "await desktop.windows()" }, context);

		// No agent turn (SDK or eval use): the run keeps the grace period.
		await run();
		beginComputerTurnForOwner(owner);
		await run();
		await run();
		expect(releases).toEqual([]);
		endComputerTurnForOwner(owner);
		expect(releases).toEqual([1]);
		endComputerTurnForOwner(owner);
		expect(releases).toEqual([1]);
		await run();
		beginComputerTurnForOwner(owner);
		await run();
		await prelude.settleCell?.(cell, { failed: false, output: "" });
		expect(settledSnapshots).toHaveLength(1);
		expect(settledSnapshots[0]).toMatchObject({ cellId: snapshots[0]?.cellId, displayTurn: 2, readOnly: true });
		expect(snapshots[0]?.cellId).toBeString();
		expect(snapshots.every(entry => entry.cellId === snapshots[0]?.cellId)).toBe(true);
		endComputerTurnForOwner(owner);
		expect(snapshots.map(entry => entry.displayTurn)).toEqual([undefined, 1, 1, undefined, 2]);
		expect(releases).toEqual([1, 2]);
		await prelude.invoke({ action: "close" }, context);
	});

	it("sends the turn's end to a running worker and starts none for it", async () => {
		const sent: ComputerWorkerInbound[] = [];
		let workers = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				workers += 1;
				const worker = new SupervisorWorker(true);
				const send = worker.send.bind(worker);
				worker.send = message => {
					sent.push(message);
					send(message);
				};
				return worker;
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			NO_ESCAPE_STOPS,
		);
		supervisor.releaseDisplay(1);
		expect(workers).toBe(0);
		await supervisor.run("1", 1_000, snapshot(false, 2));
		supervisor.releaseDisplay(2);
		expect(sent.map(message => message.type)).toEqual(["run", "release-display"]);
		expect(sent[1]).toEqual({ type: "release-display", turn: 2 });
		expect(workers).toBe(1);
		await supervisor.close();
	});

	it("holds the display for a run whose turn goes on while its worker is still starting", async () => {
		const native = new FakeNativeSession();
		const ready = Promise.withResolvers<void>();
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const transport = new MemoryTransport();
				new ComputerWorkerCore(transport, () => native);
				return {
					send: message => transport.inbound(message),
					onMessage: handler => {
						transport.listeners.add(handler);
						void ready.promise.then(() => handler({ type: "ready" }));
						return () => {
							transport.listeners.delete(handler);
						};
					},
					onError: () => () => {},
					terminate: async () => {
						transport.inbound({ type: "close" });
					},
				};
			},
			{ startMs: 1_000, closeMs: 200 },
			undefined,
			NO_ESCAPE_STOPS,
		);
		const run = supervisor.run("return 1;", 2_000, snapshot(false, 1));
		// A dialog opens and is answered before the cold worker's handshake, so before the run reaches it.
		supervisor.releaseDisplay(1);
		supervisor.resumeDisplay(1, 2);
		ready.resolve();
		await run;
		expect(native.displayHolds).toEqual(["turn"]);
		await supervisor.close();
	});
});

describe("computer background fallback", () => {
	const reason = "window 42 (Wish) reads the hardware pointer for button presses";
	const ran = `click ran in takeover because ${reason}; the input was delivered, and `;
	const clickTarget = 'await (await desktop.window("42")).click(1, 2)';

	/**
	 * Refuses background clicks the way the native backend does; a takeover
	 * click resolves to `report`, native's focus outcome. The window list's
	 * `focused` flag stays on Notes throughout, as a stale listing would.
	 */
	class RefusingSession extends FakeNativeSession {
		readonly sent: Array<PointerOptions | null | undefined> = [];
		refusal = `BackgroundUnavailable: ${reason}; nothing was sent`;
		report: DesktopFocusReturn | null = { handedBack: true, previousPid: 300, frontPid: 300 };

		override async listWindows(): Promise<DesktopWindow[]> {
			return [
				{ ...windowFixture, id: "42", app: "Wish", pid: 200, focused: false },
				{ ...windowFixture, id: "7", app: "Notes", pid: 300, focused: true },
				{ ...windowFixture, id: "9", app: "Mail", pid: 400, focused: false },
			];
		}

		override async click(
			_target: string,
			_x: number,
			_y: number,
			opts?: PointerOptions | null,
		): Promise<DesktopFocusReturn | null | void> {
			this.sent.push(opts);
			if (opts?.takeover !== true) throw new Error(this.refusal);
			return this.report;
		}
	}

	/** The single fallback notice of a successful run. */
	function notice(result: Extract<ComputerWorkerOutbound, { type: "result" }>): string {
		const [text, ...rest] = texts(result);
		expect(rest).toEqual([]);
		expect(text).toStartWith(ran);
		return text.slice(ran.length);
	}

	async function run(
		native: NativeDesktopSession,
		code: string,
		backgroundFallback: ComputerSessionSnapshot["backgroundFallback"],
	): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		const id = crypto.randomUUID();
		transport.inbound({
			type: "run",
			id,
			code,
			timeoutMs: 2_000,
			session: snapshot(false, undefined, backgroundFallback),
			escape: escapeScope(),
		});
		const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
		if (message.type !== "result") throw new Error(`Expected computer result, received ${message.type}`);
		return message;
	}

	function texts(result: Extract<ComputerWorkerOutbound, { type: "result" }>): string[] {
		if (!result.ok) throw new Error(`run failed: ${result.error.message}`);
		return result.payload.displays.flatMap(block => (block.type === "text" ? [block.text] : []));
	}

	it("reruns a refused background call once in takeover and says so, naming the app focus returned to", async () => {
		const native = new RefusingSession();
		const result = await run(native, clickTarget, "takeover");
		expect(notice(result)).toContain("returned to Notes");
		expect(native.sent).toEqual([{}, { takeover: true, returnFocus: true }]);

		// Negative control: an error other than BackgroundUnavailable is never rerun.
		const failing = new RefusingSession();
		failing.refusal = "InputFailed: window 42 rejected the event";
		const failed = await run(failing, clickTarget, "takeover");
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(failed.error.message).toStartWith("InputFailed: window 42 rejected the event");
		expect(failing.sent).toHaveLength(1);
	});

	it("reports a rerun as delivered, dropping the refused attempt's 'nothing was sent'", async () => {
		for (const unsent of ["; nothing was sent", ", so nothing was sent", "; no input was sent"]) {
			const native = new RefusingSession();
			native.refusal = `BackgroundUnavailable: ${reason}${unsent}`;
			const result = await run(native, clickTarget, "takeover");
			expect(texts(result), unsent).toEqual([`${ran}focus returned to Notes`]);
		}
	});

	it("refuses without a takeover under refuse, and tells the model so without suggesting one", async () => {
		const native = new RefusingSession();
		const result = await run(native, clickTarget, "refuse");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toStartWith(`BackgroundUnavailable: ${reason}`);
		expect(result.error.message).toContain('"refuse"');
		expect(result.error.message).toContain("no takeover happened");
		expect(result.error.message).not.toContain("takeover:");
		expect(native.sent).toEqual([{}]);
	});

	it("passes an explicit takeover through under takeover; false never falls back", async () => {
		const forced = new RefusingSession();
		const result = await run(
			forced,
			'await (await desktop.window("42")).click(1, 2, { takeover: true })',
			"takeover",
		);
		expect(texts(result)).toEqual([]);
		expect(forced.sent).toEqual([{ takeover: true }]);

		const background = new RefusingSession();
		const refused = await run(
			background,
			'await (await desktop.window("42")).click(1, 2, { takeover: false })',
			"takeover",
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.error.message).toStartWith(`BackgroundUnavailable: ${reason}`);
		expect(background.sent).toEqual([{ takeover: false }]);
	});

	it("never reruns a call the user stepped into, and keeps the code of a failed rerun", async () => {
		const stepped = new RefusingSession();
		stepped.refusal =
			"UserIntervened: window 42's application came to the front during background input; no further input was sent; inspect the window";
		const intervened = await run(stepped, clickTarget, "takeover");
		expect(intervened.ok).toBe(false);
		if (intervened.ok) return;
		expect(intervened.error.message).toStartWith("UserIntervened: window 42's application came to the front");
		expect(stepped.sent).toEqual([{}]);

		class FailingRerun extends RefusingSession {
			override async click(
				_target: string,
				_x: number,
				_y: number,
				opts?: PointerOptions | null,
			): Promise<DesktopFocusReturn | null | void> {
				this.sent.push(opts);
				throw new Error(opts?.takeover === true ? "InputFailed: window 42 rejected the event" : this.refusal);
			}
		}
		const failing = new FailingRerun();
		const failed = await run(failing, clickTarget, "takeover");
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(failed.error.message).toBe(
			`InputFailed: click fell back to takeover because ${reason}, and the takeover failed: window 42 rejected the event`,
		);
		expect(failing.sent).toEqual([{}, { takeover: true, returnFocus: true }]);
	});

	describe("refuse beats the model's own foreground requests", () => {
		/** Records every native call that could take the user's foreground. */
		class ForegroundSession extends FakeNativeSession {
			readonly calls: string[] = [];

			override async click(target: string, _x: number, _y: number, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`click:${target}:${opts?.takeover ?? "-"}`);
			}
			override async keyChord(target: string, _keys: string[], opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`press:${target}:${opts?.takeover ?? "-"}`);
			}
			override async typeText(target: string, _text: string, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`type:${target}:${opts?.takeover ?? "-"}`);
			}
			override async raiseWindow(windowId: string): Promise<void> {
				this.calls.push(`raise:${windowId}`);
			}
			override async axPerform(_ref: string, action: string): Promise<void> {
				this.calls.push(`perform:${action}`);
			}
			override async axClick(_ref: string, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`axClick:${opts?.takeover ?? "-"}`);
			}
			override async axType(_ref: string, _text: string, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`axType:${opts?.takeover ?? "-"}`);
			}
			override async axKeyChord(_ref: string, _keys: string[], opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`axKeyChord:${opts?.takeover ?? "-"}`);
			}
			override async axFocus(ref: string): Promise<void> {
				this.calls.push(`focus:${ref}`);
			}
			override async holdKeys(target: string, _keys: string[], options: NativeHoldOptions): Promise<void> {
				this.calls.push(`holdKeys:${target}:${options.takeover ?? "-"}`);
			}
			override async openApplication(id: string, options?: { activate?: boolean }) {
				this.calls.push(`open:${id}:${options?.activate ?? "-"}`);
				return { ...(await this.listApplications())[0]!, window: windowFixture };
			}
		}

		/** Each call that would bring an app forward or drive the user's own input, and the route its refusal names. */
		const foreground: Array<{ code: string; call: string; route: string }> = [
			{
				code: 'await (await desktop.window("42")).press("a", { takeover: true })',
				call: "press:42:true",
				route: "Call it without takeover",
			},
			{
				code: 'await (await desktop.ref("e1")).click({ takeover: true })',
				call: "axClick:true",
				route: "Call it without takeover",
			},
			{
				code: 'await (await desktop.ref("e1")).type("a", { takeover: true })',
				call: "axType:true",
				route: "Call it without takeover",
			},
			{
				code: 'await (await desktop.ref("e1")).press("cmd+a", { takeover: true })',
				call: "axKeyChord:true",
				route: "Call it without takeover",
			},
			{ code: 'await (await desktop.window("42")).raise()', call: "raise:42", route: "no raise is needed" },
			{
				code: 'await (await desktop.ref("e1")).perform("AXRaise")',
				call: "perform:AXRaise",
				route: "no raise is needed",
			},
			{
				code: 'await (await desktop.ref("e1")).perform(" Raise ")',
				call: "perform: Raise ",
				route: "no raise is needed",
			},
			{
				code: 'await desktop.apps.open("test.editor", { activate: true })',
				call: "open:test.editor:true",
				route: "without activate",
			},
			{
				code: 'await desktop.apps.open("/tmp/report.pdf", { reveal: true })',
				call: "open:/tmp/report.pdf:-",
				route: "apps.open(folder)",
			},
			{ code: 'await desktop.type("x")', call: "type:desktop:-", route: "window handle" },
			{
				code: 'await (await desktop.display("active")).click(1, 2)',
				call: "click:display:active:-",
				route: "window handle",
			},
		];

		it("refuses each before anything is sent, saying the user's setting keeps the agent in the background", async () => {
			for (const { code, route } of foreground) {
				const native = new ForegroundSession();
				const result = await run(native, code, "refuse");
				expect(result.ok, code).toBe(false);
				if (result.ok) continue;
				expect(result.error.message, code).toStartWith("BackgroundUnavailable: ");
				expect(result.error.message, code).toContain("keeps the agent in the background; nothing was sent");
				expect(result.error.message, code).toContain(route);
				expect(native.calls, code).toEqual([]);
			}
		});

		it("names the window or element a refusal kept input from", async () => {
			for (const [code, target] of [
				['await (await desktop.window("42")).raise()', "window 42"],
				['await (await desktop.ref("e1")).perform("AXRaise")', "element e1"],
			] as const) {
				const result = await run(new ForegroundSession(), code, "refuse");
				expect(result.ok, code).toBe(false);
				if (result.ok) continue;
				expect(result.error.message, code).toContain(`nothing was sent to ${target}.`);
			}
		});

		it("sends each as before under takeover", async () => {
			for (const { code, call } of foreground) {
				const native = new ForegroundSession();
				const result = await run(native, code, "takeover");
				expect(result.ok, code).toBe(true);
				expect(native.calls, code).toEqual([call]);
			}
		});

		it("still sends background requests under refuse", async () => {
			const native = new ForegroundSession();
			const code = [
				'await (await desktop.window("42")).press("a");',
				'await (await desktop.window("42")).press("a", { takeover: false });',
				'await (await desktop.ref("e1")).perform("press");',
				'await desktop.apps.open("test.editor");',
			].join("\n");
			expect((await run(native, code, "refuse")).ok).toBe(true);
			expect(native.calls).toEqual(["press:42:-", "press:42:false", "perform:press", "open:test.editor:-"]);
		});

		it("checks and sends the same option value when a getter changes between reads", async () => {
			// Each getter answers false on its first read and true afterwards.
			const flip = "(() => { let reads = 0; return () => reads++ > 0; })()";
			const code = [
				`const takeover = ${flip}, activate = ${flip}, held = ${flip}, element = ${flip};`,
				'await (await desktop.window("42")).press("a", { get takeover() { return takeover(); } });',
				'await (await desktop.ref("e1")).click({ get takeover() { return element(); } });',
				'await (await desktop.window("42")).holdKeys(["a"], { duration: 0, get takeover() { return held(); } });',
				'await desktop.apps.open("test.editor", { get activate() { return activate(); } });',
			].join("\n");
			const native = new ForegroundSession();
			expect((await run(native, code, "refuse")).ok).toBe(true);
			expect(native.calls).toEqual([
				"press:42:false",
				"axClick:false",
				"holdKeys:42:false",
				"open:test.editor:false",
			]);
		});

		class FileSession extends ForegroundSession {
			readonly opened: Array<{ id: string; options?: ApplicationOpenOptions }> = [];
			override async openApplication(id: string, options?: ApplicationOpenOptions) {
				this.opened.push({ id, options });
				return super.openApplication(id, options);
			}
		}
		const here = (name: string) => path.join(import.meta.dir, name);

		it("opens a relative path in the session's folder, even a missing one, and passes reveal and app on", async () => {
			const native = new FileSession();
			const code = [
				'await desktop.apps.open("computer.test.ts", { reveal: true });',
				'await desktop.apps.open("computer.test.ts", { app: "Editor" });',
				'await desktop.apps.open("./missing/report.pdf", { app: "./Editor.app" });',
				'await desktop.apps.open("Editor");',
				'await desktop.apps.open("/tmp/report.pdf");',
				'await desktop.apps.open("https://example.com");',
				'await desktop.apps.open("shell:AppsFolder\\\\Calculator!App");',
			].join("\n");
			expect((await run(native, code, "takeover")).ok).toBe(true);
			expect(native.opened).toEqual([
				{ id: here("computer.test.ts"), options: { reveal: true } },
				{ id: here("computer.test.ts"), options: { app: "Editor" } },
				{ id: here("missing/report.pdf"), options: { app: here("Editor.app") } },
				{ id: "Editor", options: {} },
				{ id: "/tmp/report.pdf", options: {} },
				{ id: "https://example.com", options: {} },
				{ id: "shell:AppsFolder\\Calculator!App", options: {} },
			]);
		});

		it("keeps an exact application ID over a same-named file in the session's folder", async () => {
			class ShadowedSession extends FileSession {
				override async listApplications() {
					return [
						{ id: "computer.test.ts", name: "Editor", path: "/Applications/Editor.app", running: true, pid: 123 },
					];
				}
			}
			const native = new ShadowedSession();
			const code = [
				'await desktop.apps.open("computer.test.ts");',
				'await desktop.apps.open("README.md", { app: "computer.test.ts" });',
			].join("\n");
			expect((await run(native, code, "takeover")).ok).toBe(true);
			expect(native.opened).toEqual([
				{ id: "computer.test.ts", options: {} },
				{ id: "README.md", options: { app: "computer.test.ts" } },
			]);
		});

		it("refuses focus() off macOS, where it moves keyboard focus, and keeps macOS's background focus", async () => {
			const elsewhere = new ForegroundSession();
			const refused = await run(elsewhere, 'await (await desktop.ref("e1")).focus()', "refuse");
			expect(refused.ok).toBe(false);
			if (refused.ok) return;
			expect(refused.error.message).toStartWith("BackgroundUnavailable: focus() would");
			expect(refused.error.message).toContain("Use setValue(), press() or another AX action");
			expect(elsewhere.calls).toEqual([]);

			expect((await run(elsewhere, 'await (await desktop.ref("e1")).focus()', "takeover")).ok).toBe(true);
			expect(elsewhere.calls).toEqual(["focus:e1"]);

			class MacSession extends ForegroundSession {
				override get capabilities(): DesktopCapabilities {
					return { ...super.capabilities, backend: "quartz" };
				}
			}
			const mac = new MacSession();
			expect((await run(mac, 'await (await desktop.ref("e1")).focus()', "refuse")).ok).toBe(true);
			expect(mac.calls).toEqual(["focus:e1"]);
		});

		it("refuses AXOpen on macOS, which brings an Open panel's application forward even when it fails", async () => {
			class MacSession extends ForegroundSession {
				override get capabilities(): DesktopCapabilities {
					return { ...super.capabilities, backend: "quartz" };
				}
			}
			// Native `action_name` runs exactly these two as AXOpen.
			for (const action of ["AXOpen", "Open"]) {
				const code = `await (await desktop.ref("e1")).perform(${JSON.stringify(action)})`;
				const mac = new MacSession();
				const refused = await run(mac, code, "refuse");
				expect(refused.ok, action).toBe(false);
				if (refused.ok) continue;
				expect(refused.error.message, action).toStartWith(
					`BackgroundUnavailable: perform(${JSON.stringify(action)}) would bring the window's application to the front`,
				);
				expect(refused.error.message, action).toContain("keeps the agent in the background; nothing was sent");
				expect(refused.error.message, action).toContain("Use press() on a button that does the same");
				expect(mac.calls, action).toEqual([]);

				expect((await run(mac, code, "takeover")).ok, action).toBe(true);
				expect(mac.calls, action).toEqual([`perform:${action}`]);
			}

			// Other spellings reach native as other actions ("AXopen", "AX Open ").
			const other = new MacSession();
			const others = ['perform("open")', 'perform(" Open ")'].map(
				call => `await (await desktop.ref("e1")).${call};`,
			);
			expect((await run(other, others.join("\n"), "refuse")).ok).toBe(true);
			expect(other.calls).toEqual(["perform:open", "perform: Open "]);

			const elsewhere = new ForegroundSession();
			expect((await run(elsewhere, 'await (await desktop.ref("e1")).perform("AXOpen")', "refuse")).ok).toBe(true);
			expect(elsewhere.calls).toEqual(["perform:AXOpen"]);
		});

		describe("macOS calls that open a menu", () => {
			class MacSession extends ForegroundSession {
				override get capabilities(): DesktopCapabilities {
					return { ...super.capabilities, backend: "quartz" };
				}
				override async drag(target: string, _points: DesktopPoint[], opts?: PointerOptions | null): Promise<void> {
					this.calls.push(`drag:${target}:${opts?.takeover ?? "-"}`);
				}
				override async holdMouse(
					target: string,
					_x: number,
					_y: number,
					options: NativeHoldOptions,
				): Promise<void> {
					this.calls.push(`holdMouse:${target}:${options.takeover ?? "-"}`);
				}
			}

			const win = 'await (await desktop.window("42"))';
			const el = 'await (await desktop.ref("e1"))';
			/** Each call kind that opens a context menu or names an item of the menu it opens, and the call its refusal names. */
			const menus: Array<{ code: string; call: string; named: string }> = [
				{
					code: `${el}.perform("AXShowMenu")`,
					call: "perform:AXShowMenu",
					named: 'perform("AXShowMenu") would open a context menu',
				},
				{
					code: `${el}.perform(" showMenu ")`,
					call: "perform: showMenu ",
					named: 'perform(" showMenu ") would open a context menu',
				},
				{
					code: `${el}.perform("show_menu")`,
					call: "perform:show_menu",
					named: 'perform("show_menu") would open a context menu',
				},
				{
					code: `${el}.perform("AXShowMenu", { menu: ["Copy"] })`,
					call: "perform:AXShowMenu",
					named: "would open a context menu",
				},
				{
					code: `${el}.perform("press", { menu: ["New Folder"] })`,
					call: "perform:press",
					named: "perform with menu would open a menu",
				},
				{
					code: `${el}.press({ menu: ["New Folder"] })`,
					call: "perform:press",
					named: "press with menu would open a menu",
				},
				{
					code: 'await desktop.ref("e1").press({ menu: ["New Folder"] })',
					call: "perform:press",
					named: "press with menu would open a menu",
				},
				{
					code: `${win}.click(1, 2, { button: "right" })`,
					call: "click:42:-",
					named: 'click with button: "right" would open a context menu',
				},
				{
					code: `${win}.click(1, 2, { button: " Right " })`,
					call: "click:42:-",
					named: "would open a context menu",
				},
				{
					code: `${win}.click(1, 2, { modifiers: ["ctrl"] })`,
					call: "click:42:-",
					named: "click with Control held would open a context menu",
				},
				{
					code: `${win}.click(1, 2, { modifiers: ["cmd+Control"] })`,
					call: "click:42:-",
					named: "click with Control held",
				},
				{
					code: `${win}.click(1, 2, { menu: ["Fonts"] })`,
					call: "click:42:-",
					named: "click with menu would open a menu",
				},
				{
					code: `${win}.doubleClick(1, 2, { button: "right" })`,
					call: "click:42:-",
					named: 'doubleClick with button: "right"',
				},
				{
					code: `${win}.drag([[1, 2], [3, 4]], { keys: ["control"] })`,
					call: "drag:42:-",
					named: "drag with Control held",
				},
				{
					code: `${win}.holdMouse(1, 2, { duration: 0, button: "right" })`,
					call: "holdMouse:42:-",
					named: 'holdMouse with button: "right"',
				},
				{
					code: `${el}.click({ button: "right" })`,
					call: "axClick:-",
					named: 'click with button: "right" would open a context menu',
				},
				{ code: `${el}.click({ modifiers: ["ctrl"] })`, call: "axClick:-", named: "click with Control held" },
				{
					code: `${el}.doubleClick({ button: "right" })`,
					call: "axClick:-",
					named: 'doubleClick with button: "right"',
				},
				{
					code: 'await desktop.ref("e1").click({ button: "right", menu: ["Copy"] })',
					call: "axClick:-",
					named: "would open a context menu",
				},
			];

			it("refuses each under refuse before anything is sent, naming the keyboard, the menu bar and the setting", async () => {
				for (const { code, named } of menus) {
					const native = new MacSession();
					const result = await run(native, code, "refuse");
					expect(result.ok, code).toBe(false);
					if (result.ok) continue;
					expect(result.error.message, code).toStartWith("BackgroundUnavailable: ");
					expect(result.error.message, code).toContain(named);
					expect(result.error.message, code).toContain("which takes the user's keyboard while it is open");
					expect(result.error.message, code).toContain('computer.backgroundFallback setting is "refuse"');
					expect(result.error.message, code).toContain("win.menu.select(...)");
					expect(result.error.message, code).toContain("an element action such as press()");
					expect(native.calls, code).toEqual([]);
				}
			});

			it("sends each as before under takeover", async () => {
				for (const { code, call } of menus) {
					const native = new MacSession();
					const result = await run(native, code, "takeover");
					expect(result.ok, code).toBe(true);
					expect(native.calls, code).toEqual([call]);
				}
			});

			it("still sends primary clicks, presses and other AX actions under refuse, and menu calls off macOS", async () => {
				const mac = new MacSession();
				const code = [
					`${win}.click(1, 2);`,
					`${win}.click(1, 2, { button: "middle", modifiers: ["ctrl"] });`,
					`${win}.click(1, 2, { modifiers: ["cmd", "shift"] });`,
					`${win}.drag([[1, 2], [3, 4]], { keys: ["space"] });`,
					`${el}.press();`,
					`${el}.perform("AXIncrement");`,
					`${el}.click();`,
				].join("\n");
				expect((await run(mac, code, "refuse")).ok).toBe(true);
				expect(mac.calls).toEqual([
					"click:42:-",
					"click:42:-",
					"click:42:-",
					"drag:42:-",
					"perform:press",
					"perform:AXIncrement",
					"axClick:-",
				]);

				const elsewhere = new ForegroundSession();
				const menu = [
					`${win}.click(1, 2, { button: "right" });`,
					`${el}.perform("AXShowMenu");`,
					`${el}.press({ menu: ["New Folder"] });`,
				].join("\n");
				expect((await run(elsewhere, menu, "refuse")).ok).toBe(true);
				expect(elsewhere.calls).toEqual(["click:42:-", "perform:AXShowMenu", "perform:press"]);
			});

			describe("popup buttons and menu buttons", () => {
				/** A macOS session whose elements are controls of `role`, recording the `refuseMenu` native gets. */
				class ControlSession extends MacSession {
					constructor(readonly role = "AXButton") {
						super();
					}
					override async axNode(ref: string): Promise<AxNode> {
						return { ...axNode, ref, nativeRole: this.role };
					}
					override async axSetValue(_ref: string, value: string): Promise<void> {
						this.calls.push(`setValue:${value}`);
					}
					override async click(
						target: string,
						_x: number,
						_y: number,
						opts?: PointerOptions | null,
					): Promise<void> {
						this.calls.push(`click:${target}:${opts?.refuseMenu ?? "-"}`);
					}
					override async axClick(_ref: string, opts?: PointerOptions | null): Promise<void> {
						this.calls.push(`axClick:${opts?.refuseMenu ?? "-"}`);
					}
					override async drag(
						target: string,
						_points: DesktopPoint[],
						opts?: PointerOptions | null,
					): Promise<void> {
						this.calls.push(`drag:${target}:${opts?.refuseMenu ?? "-"}`);
					}
					override async holdMouse(
						target: string,
						_x: number,
						_y: number,
						options: NativeHoldOptions,
					): Promise<void> {
						this.calls.push(`holdMouse:${target}:${options.refuseMenu ?? "-"}`);
					}
				}

				/** Each element call that opens a popup button's or menu button's menu, as measured on guest B. */
				const controls: Array<{ role: string; code: string; call: string; named: string }> = [
					{
						role: "AXPopUpButton",
						code: `${el}.press()`,
						call: "perform:press",
						named: "press() on an AXPopUpButton",
					},
					{
						role: "AXMenuButton",
						code: `${el}.press()`,
						call: "perform:press",
						named: "press() on an AXMenuButton",
					},
					{
						role: "AXPopUpButton",
						code: 'await desktop.ref("e1").press()',
						call: "perform:press",
						named: "press() on an AXPopUpButton",
					},
					{
						role: "AXPopUpButton",
						code: `${el}.perform("AXPress")`,
						call: "perform:AXPress",
						named: 'perform("AXPress") on an AXPopUpButton',
					},
					{
						role: "AXMenuButton",
						code: `${el}.perform(" Press ")`,
						call: "perform: Press ",
						named: 'perform(" Press ") on an AXMenuButton',
					},
					{
						role: "AXPopUpButton",
						code: `${el}.setValue("Large")`,
						call: "setValue:Large",
						named: "setValue() on an AXPopUpButton",
					},
					{ role: "AXPopUpButton", code: `${el}.click()`, call: "axClick:-", named: "click on an AXPopUpButton" },
					{
						role: "AXMenuButton",
						code: `${el}.doubleClick()`,
						call: "axClick:-",
						named: "doubleClick on an AXMenuButton",
					},
				];

				it("refuses each under refuse before anything is sent, naming the keyboard and the menu bar", async () => {
					for (const { role, code, named } of controls) {
						const native = new ControlSession(role);
						const result = await run(native, code, "refuse");
						expect(result.ok, code).toBe(false);
						if (result.ok) continue;
						expect(result.error.message, code).toStartWith("BackgroundUnavailable: ");
						expect(result.error.message, code).toContain(`${named} would open its menu`);
						expect(result.error.message, code).toContain("which takes the user's keyboard while it is open");
						expect(result.error.message, code).toContain('computer.backgroundFallback setting is "refuse"');
						expect(result.error.message, code).toContain("win.menu.select(...)");
						expect(result.error.message, code).toContain("tell the user the step needs their screen");
						expect(native.calls, code).toEqual([]);
					}
				});

				it("sends each as before under takeover", async () => {
					for (const { role, code, call } of controls) {
						const native = new ControlSession(role);
						expect((await run(native, code, "takeover")).ok, code).toBe(true);
						expect(native.calls, code).toEqual([call]);
					}
				});

				it("still presses, sets and clicks other controls under refuse, and menu buttons off macOS", async () => {
					const button = new ControlSession();
					const code = [
						`${el}.press();`,
						`${el}.perform("AXPress");`,
						`${el}.setValue("x");`,
						`${el}.click();`,
					].join("\n");
					expect((await run(button, code, "refuse")).ok).toBe(true);
					expect(button.calls).toEqual(["perform:press", "perform:AXPress", "setValue:x", "axClick:true"]);

					// A menu button's menu is a pull-down, so setValue and other actions do not open it.
					const menuButton = new ControlSession("AXMenuButton");
					const other = [`${el}.setValue("x");`, `${el}.perform("AXShowDefaultUI");`].join("\n");
					expect((await run(menuButton, other, "refuse")).ok).toBe(true);
					expect(menuButton.calls).toEqual(["setValue:x", "perform:AXShowDefaultUI"]);

					class ElsewhereSession extends ForegroundSession {
						override async axNode(ref: string): Promise<AxNode> {
							return { ...axNode, ref, nativeRole: "AXPopUpButton" };
						}
					}
					const elsewhere = new ElsewhereSession();
					expect((await run(elsewhere, `${el}.press();\n${el}.click();`, "refuse")).ok).toBe(true);
					expect(elsewhere.calls).toEqual(["perform:press", "axClick:-"]);
				});

				it("asks native to refuse a click landing on one, or a hold or drag starting on one, only under refuse on macOS", async () => {
					const code = [
						`${win}.click(1, 2);`,
						`${win}.doubleClick(1, 2);`,
						`${el}.click();`,
						`${win}.holdMouse(1, 2, { duration: 0 });`,
						`${win}.drag([[1, 2], [3, 4]]);`,
					].join("\n");
					const refusing = new ControlSession();
					expect((await run(refusing, code, "refuse")).ok).toBe(true);
					expect(refusing.calls).toEqual([
						"click:42:true",
						"click:42:true",
						"axClick:true",
						"holdMouse:42:true",
						"drag:42:true",
					]);

					const taking = new ControlSession();
					expect((await run(taking, code, "takeover")).ok).toBe(true);
					expect(taking.calls).toEqual(["click:42:-", "click:42:-", "axClick:-", "holdMouse:42:-", "drag:42:-"]);
				});

				it("reports native's refusal of such a press with the reason, the setting and the alternatives", async () => {
					const refusals = {
						click: "the click on window 42 (Code), which lands on a menu button or popup button,",
						drag: "the drag on window 42 (Code), which starts on a menu button or popup button,",
					};
					class LandingSession extends ControlSession {
						override async click(
							target: string,
							x: number,
							y: number,
							opts?: PointerOptions | null,
						): Promise<void> {
							await super.click(target, x, y, opts);
							if (opts?.refuseMenu)
								throw new Error(
									`BackgroundUnavailable: ${refusals.click} would open its menu; nothing was sent`,
								);
						}
						override async drag(
							target: string,
							points: DesktopPoint[],
							opts?: PointerOptions | null,
						): Promise<void> {
							await super.drag(target, points, opts);
							if (opts?.refuseMenu)
								throw new Error(
									`BackgroundUnavailable: ${refusals.drag} would open its menu; nothing was sent`,
								);
						}
					}
					for (const [method, code] of [
						["click", `${win}.click(1, 2)`],
						["drag", `${win}.drag([[1, 2], [3, 4]])`],
						// The setting refused the press, not the model's `takeover: false`.
						["click", `${win}.click(1, 2, { takeover: false })`],
					] as const) {
						const native = new LandingSession();
						const result = await run(native, code, "refuse");
						expect(result.ok, code).toBe(false);
						if (result.ok) continue;
						const message = result.error.message;
						// The same shape as the worker's own menu refusals: the press and its effect, the setting, the way around.
						expect(message, code).toStartWith(
							`BackgroundUnavailable: ${refusals[method]} would open its menu, which takes the user's keyboard while it is open`,
						);
						expect(message, code).toContain('computer.backgroundFallback setting is "refuse"');
						expect(message, code).toContain("win.menu.select(...)");
						expect(message, code).toContain("tell the user the step needs their screen");
						expect(message, code).not.toContain("no takeover happened");
						expect(native.calls, code).toEqual([`${method}:42:true`]);
					}
				});
			});
		});

		it("refuses control.acquire without asking the user", async () => {
			const transport = new MemoryTransport();
			const native = new ForegroundSession();
			new ComputerWorkerCore(transport, () => native);
			const id = crypto.randomUUID();
			transport.inbound({
				type: "run",
				id,
				code: 'await desktop.control.acquire({ reason: "Test task" })',
				timeoutMs: 2_000,
				session: snapshot(false, undefined, "refuse"),
				escape: escapeScope(),
			});
			const result = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
			if (result.type !== "result" || result.ok) throw new Error("control.acquire was not refused");
			expect(result.error.message).toStartWith("BackgroundUnavailable: control.acquire would");
			expect(result.error.message).toContain("Window input needs no control");
			expect(transport.outbound.some(message => message.type === "control-request")).toBe(false);
			expect(native.acquireCount).toBe(0);
		});

		it("releases a grant acquired before the user chose refuse, at the next run", async () => {
			const held = new ForegroundSession();
			held.controlActive = true;
			expect((await run(held, "return 1", "takeover")).ok).toBe(true);
			expect(held.controlActive).toBe(true);
			expect((await run(held, "return 1", "refuse")).ok).toBe(true);
			expect(held.controlActive).toBe(false);
		});
	});

	it("never forwards a model-supplied returnFocus on holds; only the host's rerun sets it", async () => {
		const native = new RefusingSession();
		const holds: NativeHoldOptions[] = [];
		native.holdKeys = async (_target: string, _keys: string[], options: NativeHoldOptions) => {
			holds.push(options);
			if (options.takeover !== true) throw new Error(native.refusal);
		};
		native.holdMouse = async (_target: string, _x: number, _y: number, options: NativeHoldOptions) => {
			holds.push(options);
		};
		const code = [
			'const win = await desktop.window("42");',
			"await win.holdMouse(1, 2, { duration: 0, takeover: true, returnFocus: true });",
			"await win.holdKeys(['a'], { duration: 0, returnFocus: true });",
		].join("\n");
		await run(native, code, "takeover");
		expect(holds.map(options => options.returnFocus)).toEqual([undefined, undefined, true]);
	});

	it("reports where native saw focus end, not the window list's focused flag", async () => {
		const elsewhere = new RefusingSession();
		elsewhere.report = { handedBack: false, previousPid: 300, frontPid: 400 };
		const third = notice(await run(elsewhere, clickTarget, "takeover"));
		expect(third).toContain("on Mail");
		expect(third).toContain("did not return to Notes");
		expect(third).not.toContain("returned to");

		const stuck = new RefusingSession();
		stuck.report = { handedBack: false, previousPid: 300, frontPid: 200 };
		const stayed = notice(await run(stuck, clickTarget, "takeover"));
		expect(stayed).toContain("stayed on Wish");
		expect(stayed).toContain("did not return to Notes");

		const unknown = new RefusingSession();
		unknown.report = null;
		const unread = notice(await run(unknown, clickTarget, "takeover"));
		expect(unread).toContain("not confirmed");
		expect(unread).not.toContain("Notes");

		const front = new RefusingSession();
		front.report = { handedBack: true, previousPid: 300 };
		expect(notice(await run(front, clickTarget, "takeover"))).toContain("not confirmed");
	});
});

describe("window() waiting for a window to appear", () => {
	class OpeningSession extends FakeNativeSession {
		listings = 0;
		constructor(readonly appearsAt: number) {
			super();
		}
		override async listWindows(): Promise<DesktopWindow[]> {
			this.listings += 1;
			return this.listings >= this.appearsAt
				? [windowFixture, { ...windowFixture, id: "151", app: "Preview", title: "report.pdf" }]
				: [windowFixture];
		}
	}

	async function run(native: NativeDesktopSession, code: string, readOnly = false, timeoutMs = 5_000) {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		const id = crypto.randomUUID();
		transport.inbound({
			type: "run",
			id,
			code,
			timeoutMs,
			session: snapshot(readOnly),
			escape: escapeScope(),
		});
		const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
		if (message.type !== "result") throw new Error(`Expected computer result, received ${message.type}`);
		return message;
	}

	/** One event-loop turn, which fake timers leave alone: every pending promise of the worker runs first. */
	function turn(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		return promise;
	}

	/**
	 * Under fake timers, let `native` list `count` times, moving the clock one 100 ms poll interval after each
	 * listing but the last, once the worker is asleep in that interval.
	 */
	async function pollListings(native: OpeningSession, count: number): Promise<void> {
		for (let listed = 1; ; listed++) {
			while (native.listings < listed) await turn();
			if (listed === count) return;
			await turn();
			vi.advanceTimersByTime(100);
		}
	}

	it("polls a filter with wait until the window appears in a read-only run", async () => {
		vi.useFakeTimers();
		try {
			const native = new OpeningSession(4);
			const pending = run(
				native,
				'return (await desktop.window({ app: "Preview", title: "report.pdf", wait: 2000 })).id',
				true,
			);
			await pollListings(native, 4);
			const result = await pending;
			if (!result.ok) throw new Error(result.error.message);
			expect(result.payload.returnValue).toBe("151");
			expect(native.listings).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops polling when the run is cancelled by its deadline", async () => {
		vi.useFakeTimers();
		try {
			const native = new OpeningSession(Number.POSITIVE_INFINITY);
			const pending = run(native, 'return await desktop.window({ app: "Preview", wait: 10000 })', false, 300);
			// Listings at 0, 100 and 200 ms; the 300 ms deadline cancels the run during the next interval.
			await pollListings(native, 3);
			await turn();
			vi.advanceTimersByTime(100);
			const result = await pending;
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.message).toContain("timed out");
			// A loop that outlived its run would list again in each later interval.
			for (let interval = 0; interval < 5; interval++) {
				await turn();
				vi.advanceTimersByTime(100);
			}
			await turn();
			expect(native.listings).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still fails at once without wait", async () => {
		const native = new OpeningSession(4);
		const result = await run(native, 'return await desktop.window({ app: "Preview" })');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toStartWith('no window matches {"app":"Preview"}');
		expect(native.listings).toBe(1);
	});

	it("reports the window miss after waiting when nothing appears", async () => {
		vi.useFakeTimers();
		try {
			const native = new OpeningSession(Number.POSITIVE_INFINITY);
			const pending = run(native, 'return await desktop.window({ app: "Preview", wait: 300 })');
			// Listings at 0, 100 and 200 ms and the last at the 300 ms deadline.
			await pollListings(native, 4);
			const result = await pending;
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.message).toStartWith('no window matches {"app":"Preview","wait":300}');
			expect(result.error.message).toContain("Open windows by app");
			expect(native.listings).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["60000", "NaN", '"soon"'])("refuses an invalid wait of %s", async wait => {
		const native = new OpeningSession(1);
		const result = await run(native, `return await desktop.window({ app: "Preview", wait: ${wait} })`);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("window({ wait }) takes milliseconds from 0 to 10000");
		expect(native.listings).toBe(0);
	});

	it("resolves a delayed window through Python keyword filters", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new OpeningSession(3);
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		const result = await executePython(
			'win = await computer.window(app="Preview", title="report.pdf", wait=2000)\nprint(win.id)',
			{
				cwd: process.cwd(),
				sessionId: `computer-window-wait-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n").at(-1)).toBe("151");
		expect(native.listings).toBe(3);
	});
});
