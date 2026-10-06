import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";

import type {
	Application,
	ApplicationQuery,
	ApplicationOpenOptions,
	DesktopMenuItem as MenuItem,
	DesktopObservation as NativeObservation,
	DesktopControlState,
	HoldOptions as NativeHoldOptions,
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	CaptureRegion,
	DesktopCapabilities,
	DesktopControlAction,
	DesktopCapture,
	DesktopDisplay,
	DesktopPoint,
	DesktopSessionOptions,
	DesktopWindow,
	DesktopWindowState,
	DesktopWorkspace,
	PointerOptions,
} from "@oh-my-pi/pi-natives";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { cloneSafe, RunOutput } from "../browser/run-output";
import {
	bindRunFacade,
	markHandled,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
} from "../run-scope";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import {
	type AxReadOptions,
	DESKTOP_WINDOW_ID,
	desktopPoint,
	describeRosterChanges,
	diffTree,
	type InputKind,
	type InputWindow,
	ObservationLedger,
	renderGone,
	renderReadBack,
	renderUnattributed,
	renderUnreadable,
	windowAt,
} from "./observation";
import { describeWindowMiss } from "./window-miss";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerTransport,
	RunErrorPayload,
	ToolReply,
} from "./protocol";

/** Native desktop operations consumed by the script runtime. */
export interface NativeDesktopSession {
	readonly capabilities: DesktopCapabilities;
	listDisplays(): Promise<DesktopDisplay[]>;
	listWindows(): Promise<DesktopWindow[]>;
	capture(target: string, caps?: { maxWidth?: number; maxHeight?: number } | null): Promise<DesktopCapture>;
	captureRegion(
		target: string,
		region: CaptureRegion,
		caps?: { maxWidth?: number; maxHeight?: number } | null,
	): Promise<DesktopCapture>;
	cancel(): void;
	retire(): void;
	listApplications(options?: ApplicationQuery): Promise<Application[]>;
	openApplication(id: string, options?: ApplicationOpenOptions): Promise<Application>;
	menuItems(target: string, path?: string[]): Promise<MenuItem[]>;
	menuSelect(target: string, path: string[]): Promise<void>;
	observe(
		target: string,
		caps?: { maxWidth?: number; maxHeight?: number },
		options?: AxOptions,
	): Promise<NativeObservation>;
	holdKeys(target: string, keys: string[], options: NativeHoldOptions): Promise<void>;
	holdMouse(target: string, x: number, y: number, options: NativeHoldOptions): Promise<void>;
	acquireControl(): Promise<DesktopControlState>;
	releaseControl(): void;
	controlState(): DesktopControlState;
	bringToCurrentSpace(windowId: string): Promise<void>;
	click(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void>;
	moveMouse(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void>;
	drag(target: string, points: DesktopPoint[], opts?: PointerOptions | null): Promise<void>;
	scroll(target: string, x: number, y: number, dx: number, dy: number, opts?: PointerOptions | null): Promise<void>;
	typeText(target: string, text: string, opts?: PointerOptions | null): Promise<void>;
	keyChord(target: string, keys: string[], opts?: PointerOptions | null): Promise<void>;
	raiseWindow(windowId: string): Promise<void>;
	control(action: DesktopControlAction): Promise<void>;
	listWorkspaces(): Promise<DesktopWorkspace[]>;
	windowState(windowId: string): Promise<DesktopWindowState>;
	axSnapshot(target: string, opts?: AxSnapshotOptions | null): Promise<{ text: string }>;
	axQuery(target: string, query: AxQuery): Promise<AxNode[]>;
	axElementAt(target: string, x: number, y: number): Promise<AxNode | null | undefined>;
	axFocused(): Promise<AxNode | null | undefined>;
	axNode(ref: string): Promise<AxNode>;
	axAttributes(ref: string): Promise<Array<[string, string]>>;
	axChildren(ref: string): Promise<AxNode[]>;
	axParent(ref: string): Promise<AxNode | null | undefined>;
	axPerform(ref: string, action: string): Promise<void>;
	axSetValue(ref: string, value: string): Promise<void>;
	axFocus(ref: string): Promise<void>;
	axClick(ref: string, opts?: PointerOptions | null): Promise<void>;
	close(): Promise<void>;
}

/** Creates the native session co-located with the computer worker runtime. */
export type NativeDesktopSessionFactory = (
	options: DesktopSessionOptions,
) => NativeDesktopSession | Promise<NativeDesktopSession>;

type WindowFilter = { id?: string | number; app?: string; title?: string };
type InputOptions = { takeover?: boolean };
type ScreenshotOptions = { silent?: boolean };
type ScreenshotResult = Pick<
	ComputerScreenshot,
	"path" | "width" | "height" | "coordinateWidth" | "coordinateHeight" | "region"
>;
type ClickOptions = InputOptions & { button?: string; count?: number; modifiers?: string[] };
type DragOptions = InputOptions & { modifiers?: string[]; keys?: string[] };
type ScrollOptions = InputOptions & { dx?: number; dy?: number };
type AxOptions = Pick<AxSnapshotOptions, "all" | "maxDepth">;
type HoldOptions = Pick<NativeHoldOptions, "duration" | "takeover">;
type HoldMouseOptions = NativeHoldOptions;
type ObservationResult = ScreenshotResult & { ax: string; nodeCount: number; truncated: boolean };

/** Target id of desktop-root input: keys reach the focused window, pointer input the window under it. */
const DESKTOP_TARGET = DESKTOP_WINDOW_ID;
/** Window input aimed at screenshot pixels; the rest of a window's input is keys. */
const POINTER_METHODS: Record<string, true> = { click: true, doubleClick: true, move: true, drag: true, scroll: true };
/**
 * A settling cell reads windows back no sooner than this after its last
 * input, so the app can react. One read per window: a second would retire the
 * refs the model held before the cell.
 */
const SETTLE_DELAY_MS = 500;
/** Past this much of the settle's own budget, remaining windows are named instead of read. */
const SETTLE_READ_BUDGET_MS = 10_000;

/**
 * The lane for callers that are not eval cells (a host batching calls, the SDK):
 * one logical batch, so a run and its settle agree without a per-request id.
 */
const UNTAGGED_CELL_ID = "unbatched";

type MoveOptions = { x: number; y: number };
type MoveByOptions = { dx: number; dy: number };
type ResizeOptions = { width?: number; height?: number };
type EnabledOptions = { enabled: boolean };
type WorkspaceOptions = { workspaceId: string; focus?: boolean };
type DisplayOptions = { displayId: string };
type WorkspaceDisplayOptions = { workspaceId: string; displayId: string };

type PendingTool = { resolve(value: unknown): void; reject(reason?: unknown): void };
interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	pendingTools: Map<string, PendingTool>;
}

interface ComputerRunContext {
	signal: AbortSignal;
	readOnly: boolean;
	snapshot: ComputerSessionSnapshot;
	output: RunOutput;
	confirmControl(reason: string): Promise<boolean>;
	screenshots: ComputerScreenshot[];
}

type RunContextAccessor = () => ComputerRunContext;

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: true, isAbort: false };
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const error = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) error.stack = payload.stack;
		return error;
	}
	const ErrorType = payload.isToolError ? ToolError : Error;
	const error = new ErrorType(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function nativeError(error: unknown): ToolError {
	return new ToolError(error instanceof Error ? error.message : String(error));
}

async function nativeCall<T>(signal: AbortSignal, call: () => T | Promise<T>): Promise<T> {
	throwIfAborted(signal);
	try {
		const value = await call();
		throwIfAborted(signal);
		return value;
	} catch (error) {
		throwIfAborted(signal);
		if (error instanceof ToolAbortError) throw error;
		throw nativeError(error);
	}
}

function pointerOptions(options?: ClickOptions | DragOptions | InputOptions): PointerOptions {
	const mapped: PointerOptions = {};
	if (!options) return mapped;
	if ("button" in options && options.button !== undefined) mapped.button = options.button;
	if ("count" in options && options.count !== undefined) mapped.count = options.count;
	if ("modifiers" in options && options.modifiers !== undefined) mapped.modifiers = options.modifiers;
	if ("keys" in options && options.keys !== undefined) mapped.keys = options.keys;
	if (options.takeover !== undefined) mapped.takeover = options.takeover;
	return mapped;
}

function chordKeys(chord: string | string[]): string[] {
	return typeof chord === "string"
		? chord
				.split("+")
				.map(key => key.trim())
				.filter(Boolean)
		: chord;
}

function validateKeys(value: unknown, label: string, options?: { allowEmpty?: boolean }): asserts value is string[] {
	if (
		!Array.isArray(value) ||
		(!options?.allowEmpty && value.length === 0) ||
		value.some(key => typeof key !== "string" || !key.trim())
	) {
		throw new ToolError(`${label} requires a non-empty array of non-empty strings`);
	}
}

function validateHold(options: HoldOptions): void {
	if (
		!options ||
		typeof options.duration !== "number" ||
		!Number.isFinite(options.duration) ||
		options.duration < 0 ||
		options.duration > 100
	) {
		throw new ToolError("duration must be seconds in the range 0..100");
	}
}

function strictObject(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !allowed.includes(key))
	) {
		throw new ToolError(`${label} must be an object with only: ${allowed.join(", ")}`);
	}
}

function matchesFilter(window: DesktopWindow, filter?: WindowFilter): boolean {
	if (!filter) return true;
	const app = filter.app?.toLocaleLowerCase();
	const title = filter.title?.toLocaleLowerCase();
	return (
		(filter.id === undefined || window.id === String(filter.id)) &&
		(!app || window.app.toLocaleLowerCase().includes(app)) &&
		(!title || window.title.toLocaleLowerCase().includes(title))
	);
}

function guardRun(context: ComputerRunContext, method: string): void {
	if (context.readOnly) throw new ToolError(`read-only run: '${method}' requires read_only: false`);
	throwIfAborted(context.signal);
}

function readCapabilities(session: NativeDesktopSession): DesktopCapabilities {
	try {
		return session.capabilities;
	} catch (error) {
		throw nativeError(error);
	}
}

function controlNumber(method: string, label: string, value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`${method} requires ${label}`);
	return value;
}

function controlSize(method: string, label: string, value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value <= 0)
		throw new ToolError(`${method} requires ${label} to be a positive whole number`);
	return value;
}

function controlId(method: string, label: string, value: string | undefined): string {
	if (typeof value !== "string" || value === "") throw new ToolError(`${method} requires ${label}`);
	return value;
}

function controlEnabled(method: string, value: boolean | undefined): boolean {
	if (typeof value !== "boolean") throw new ToolError(`${method} requires enabled: true or enabled: false`);
	return value;
}

/**
 * Optional focus flag for `moveToWorkspace`. An absent key is the documented
 * false default; a present non-boolean is a caller typo, not a request to skip
 * focusing, so it fails instead of silently moving the window unfocused.
 */
function controlFocus(method: string, value: boolean | undefined): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw new ToolError(`${method} requires focus: true or focus: false`);
	return value;
}

/**
 * Refuses a read that needs the native control surface before touching it, so
 * an addon without window control fails with its capability code instead of
 * an undefined-method crash.
 */
function requireWindowControl(session: NativeDesktopSession, subject: string): void {
	const { backend, windowControl } = readCapabilities(session);
	if (!windowControl)
		throw new ToolError(`ControlUnsupported: ${subject} is unavailable on the ${backend} desktop backend`);
}

/**
 * Sends one window/workspace mutation. Capabilities are validated before the
 * call, so an operation the backend never advertised never reaches native code.
 */
async function sendControl(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	action: DesktopControlAction,
): Promise<void> {
	const { backend, windowControl } = readCapabilities(session);
	if (!windowControl || !windowControl.operations.includes(action.operation)) {
		const supported = windowControl?.operations ?? [];
		throw new ToolError(
			`ControlUnsupported: ${action.operation} is unavailable on the ${backend} desktop backend` +
				(supported.length > 0 ? ` (supported: ${supported.join(", ")})` : ""),
		);
	}
	await nativeCall(context.signal, () => session.control(action));
}

async function captureScreenshot(
	session: NativeDesktopSession,
	getContext: RunContextAccessor,
	observer: InputObserver,
	target: string,
	options?: ScreenshotOptions,
	region?: CaptureRegion,
): Promise<ScreenshotResult> {
	const context = getContext();
	const caps = {
		maxWidth: context.snapshot.captureMaxWidth,
		maxHeight: context.snapshot.captureMaxHeight,
	};
	const frame = await nativeCall(context.signal, () =>
		region === undefined ? session.capture(target, caps) : session.captureRegion(target, region, caps),
	);
	throwIfAborted(context.signal);
	if (target === DESKTOP_TARGET) observer.noteDesktopCapture(frame.displays ?? []);
	return await emitScreenshot(context, frame, options);
}

async function emitScreenshot(
	context: ComputerRunContext,
	frame: DesktopCapture,
	options?: ScreenshotOptions,
): Promise<ScreenshotResult> {
	const destination = path.join(os.tmpdir(), `omp-computer-${Snowflake.next()}.png`);
	await Bun.write(destination, frame.data);
	throwIfAborted(context.signal);
	const result: ScreenshotResult = {
		path: destination,
		width: frame.width,
		height: frame.height,
		coordinateWidth: frame.coordinateWidth,
		coordinateHeight: frame.coordinateHeight,
		...(frame.region ? { region: frame.region } : {}),
	};
	const scaled = frame.width !== frame.sourceWidth || frame.height !== frame.sourceHeight;
	context.screenshots.push({
		...result,
		sourceWidth: frame.sourceWidth,
		sourceHeight: frame.sourceHeight,
		target: frame.target,
	});
	if (!options?.silent) {
		const dimensions = `${frame.width}×${frame.height}${scaled ? ` (scaled from ${frame.sourceWidth}×${frame.sourceHeight})` : ""}`;
		const coordinates = `coordinateWidth=${frame.coordinateWidth} coordinateHeight=${frame.coordinateHeight}`;
		context.output.push({
			type: "text",
			text: frame.region
				? `zoom ${frame.target} ${dimensions}; region=${JSON.stringify(frame.region)}; ${coordinates}; use the base full screenshot coordinates for input, not zoom pixels → ${destination}`
				: `screenshot ${frame.target} ${dimensions}; ${coordinates} → ${destination}`,
		});
		context.output.push({
			type: "image",
			data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString("base64"),
			mimeType: "image/png",
			detail: "original",
		});
	}
	return result;
}

class El {
	readonly ref: string;
	readonly role: string;
	readonly nativeRole: string;
	readonly title?: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly focused: boolean;
	readonly childCount: number;
	readonly #session: NativeDesktopSession;
	readonly #getContext: RunContextAccessor;
	readonly #observer: InputObserver;

	constructor(session: NativeDesktopSession, getContext: RunContextAccessor, observer: InputObserver, node: AxNode) {
		this.#session = session;
		this.#getContext = getContext;
		this.#observer = observer;
		this.ref = node.ref;
		this.role = node.role;
		this.nativeRole = node.nativeRole;
		this.title = node.title;
		this.description = node.description;
		this.enabled = node.enabled;
		this.focused = node.focused;
		this.childCount = node.childCount;
	}

	/** A read of this element; a failure (an expired ref) has the settle renew the window's tree. */
	#read<T>(method: string, call: () => Promise<T>): Promise<T> {
		return this.#observer.read(this.#getContext().signal, this.ref, `${method} ${this.ref}`, call);
	}

	/** An input on this element, recorded for the cell's post-input read-back. */
	#input(method: string, label: string, dispatch: () => Promise<void>): Promise<void> {
		const context = this.#getContext();
		guardRun(context, method);
		return this.#observer.input(context.signal, this.#observer.windowOf(this.ref), label, "element", dispatch);
	}

	async value(): Promise<string | undefined> {
		return (await this.#read("value", () => this.#session.axNode(this.ref))).value;
	}

	setValue(value: string): Promise<void> {
		return this.#input("setValue", `setValue ${this.ref}`, () => this.#session.axSetValue(this.ref, value));
	}

	async bounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
		const node = await this.#read("bounds", () => this.#session.axNode(this.ref));
		if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined)
			return null;
		return { x: node.x, y: node.y, width: node.width, height: node.height };
	}

	async attributes(): Promise<Record<string, string>> {
		return Object.fromEntries(await this.#read("attributes", () => this.#session.axAttributes(this.ref)));
	}

	async actions(): Promise<string[]> {
		return (await this.#read("actions", () => this.#session.axNode(this.ref))).actions ?? [];
	}

	perform(action: string): Promise<void> {
		return this.#input("perform", `perform ${this.ref} ${action}`, () => this.#session.axPerform(this.ref, action));
	}

	press(): Promise<void> {
		return this.#input("press", `press ${this.ref}`, () => this.#session.axPerform(this.ref, "press"));
	}

	click(options?: InputOptions): Promise<void> {
		return this.#input("click", `click ${this.ref}`, () => this.#session.axClick(this.ref, pointerOptions(options)));
	}

	focus(): Promise<void> {
		return this.#input("focus", `focus ${this.ref}`, () => this.#session.axFocus(this.ref));
	}

	async parent(): Promise<El | null> {
		const node = await this.#read("parent", () => this.#session.axParent(this.ref));
		return node ? this.#observer.element(this.#getContext, node, this.#observer.windowOf(this.ref)) : null;
	}

	async children(): Promise<El[]> {
		return (await this.#read("children", () => this.#session.axChildren(this.ref))).map(node =>
			this.#observer.element(this.#getContext, node, this.#observer.windowOf(this.ref)),
		);
	}
}

class Win {
	readonly id: string;
	readonly app: string;
	readonly title: string;
	readonly pid?: number;
	readonly positionKnown: boolean;
	readonly bounds: { x: number; y: number; width: number; height: number };
	readonly focused: boolean;
	readonly #session: NativeDesktopSession;
	readonly #getContext: RunContextAccessor;
	readonly #observer: InputObserver;

	constructor(
		session: NativeDesktopSession,
		getContext: RunContextAccessor,
		observer: InputObserver,
		window: DesktopWindow,
	) {
		this.#session = session;
		this.#getContext = getContext;
		this.#observer = observer;
		this.id = window.id;
		this.app = window.app;
		this.title = window.title;
		this.pid = window.pid;
		this.positionKnown = window.positionKnown !== false;
		this.bounds = { x: window.x, y: window.y, width: window.width, height: window.height };
		this.focused = window.focused;
	}

	async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
		const frame = await captureScreenshot(this.#session, this.#getContext, this.#observer, this.id, options);
		// A silent capture is no frame the model saw: it does not put the window in pixel mode.
		if (!options?.silent) this.#observer.recordCapture({ id: this.id, pid: this.pid });
		return frame;
	}

	async state(): Promise<DesktopWindowState> {
		const { signal } = this.#getContext();
		throwIfAborted(signal);
		requireWindowControl(this.#session, "window state");
		return await nativeCall(signal, () => this.#session.windowState(this.id));
	}

	/**
	 * An input on this window, recorded for the cell's read-back. Desktop-root
	 * input is recorded on the window it reaches when sent: the one under
	 * `point` for pointer input, the focused one for keys; it stays
	 * unattributed when neither is a single, certain answer.
	 */
	#input(
		method: string,
		label: string,
		dispatch: () => Promise<void>,
		point?: { x: number; y: number },
	): Promise<void> {
		const context = this.#getContext();
		guardRun(context, method);
		const kind: InputKind = POINTER_METHODS[method] === true ? "pixel" : "key";
		if (this.id === DESKTOP_TARGET)
			return this.#observer.input(context.signal, undefined, `desktop ${label}`, kind, dispatch, { point });
		return this.#observer.input(context.signal, { id: this.id, pid: this.pid }, label, kind, dispatch);
	}

	/** A window/workspace/display mutation, recorded like any other input. */
	#control(method: string, dispatch: () => Promise<void>): Promise<void> {
		const context = this.#getContext();
		guardRun(context, method);
		return this.#observer.control(context.signal, { id: this.id, pid: this.pid }, method, dispatch);
	}

	click(x: number, y: number, options?: ClickOptions): Promise<void> {
		return this.#input(
			"click",
			`click ${x},${y}`,
			() => this.#session.click(this.id, x, y, pointerOptions(options)),
			{ x, y },
		);
	}

	doubleClick(x: number, y: number, options?: Omit<ClickOptions, "count">): Promise<void> {
		return this.#input(
			"doubleClick",
			`doubleClick ${x},${y}`,
			() => this.#session.click(this.id, x, y, pointerOptions({ ...options, count: 2 })),
			{ x, y },
		);
	}

	move(x: number, y: number): Promise<void> {
		return this.#input("move", `move ${x},${y}`, () => this.#session.moveMouse(this.id, x, y), { x, y });
	}

	drag(points: Array<[number, number]>, options?: DragOptions): Promise<void> {
		const [start] = points;
		return this.#input(
			"drag",
			"drag",
			() =>
				this.#session.drag(
					this.id,
					points.map(([x, y]) => ({ x, y })),
					pointerOptions(options),
				),
			start && { x: start[0], y: start[1] },
		);
	}

	scroll(x: number, y: number, options: ScrollOptions = {}): Promise<void> {
		return this.#input(
			"scroll",
			`scroll ${x},${y}`,
			() => this.#session.scroll(this.id, x, y, options.dx ?? 0, options.dy ?? 0, pointerOptions(options)),
			{ x, y },
		);
	}

	type(text: string, options?: InputOptions): Promise<void> {
		const shown = text.length > 24 ? `${text.slice(0, 23)}…` : text;
		return this.#input("type", `type ${JSON.stringify(shown)}`, () =>
			this.#session.typeText(this.id, text, pointerOptions(options)),
		);
	}

	press(chord: string | string[], options?: InputOptions): Promise<void> {
		const keys = chordKeys(chord);
		return this.#input("press", `press ${keys.join("+")}`, () =>
			this.#session.keyChord(this.id, keys, pointerOptions(options)),
		);
	}

	focus(): Promise<void> {
		const context = this.#getContext();
		return this.#control("focus", () =>
			sendControl(this.#session, context, { operation: "focusWindow", windowId: this.id }),
		);
	}

	close(): Promise<void> {
		const context = this.#getContext();
		return this.#control("close", () =>
			sendControl(this.#session, context, { operation: "closeWindow", windowId: this.id }),
		);
	}

	moveTo(options: MoveOptions): Promise<void> {
		const context = this.#getContext();
		return this.#control("moveTo", () =>
			sendControl(this.#session, context, {
				operation: "moveWindow",
				windowId: this.id,
				x: controlNumber("moveTo", "x", options?.x),
				y: controlNumber("moveTo", "y", options?.y),
			}),
		);
	}

	moveBy(options: MoveByOptions): Promise<void> {
		const context = this.#getContext();
		return this.#control("moveBy", () =>
			sendControl(this.#session, context, {
				operation: "moveWindowBy",
				windowId: this.id,
				dx: controlNumber("moveBy", "dx", options?.dx),
				dy: controlNumber("moveBy", "dy", options?.dy),
			}),
		);
	}

	resize(options: ResizeOptions): Promise<void> {
		const context = this.#getContext();
		return this.#control("resize", () => {
			const width = controlSize("resize", "width", options?.width);
			const height = controlSize("resize", "height", options?.height);
			if (width === undefined && height === undefined) throw new ToolError("resize requires width, height, or both");
			const action: DesktopControlAction = { operation: "resizeWindow", windowId: this.id };
			if (width !== undefined) action.width = width;
			if (height !== undefined) action.height = height;
			return sendControl(this.#session, context, action);
		});
	}

	maximize(): Promise<void> {
		const context = this.#getContext();
		return this.#control("maximize", () =>
			sendControl(this.#session, context, { operation: "maximizeWindow", windowId: this.id }),
		);
	}

	minimize(): Promise<void> {
		const context = this.#getContext();
		return this.#control("minimize", () =>
			sendControl(this.#session, context, { operation: "minimizeWindow", windowId: this.id }),
		);
	}

	restore(): Promise<void> {
		const context = this.#getContext();
		return this.#control("restore", () =>
			sendControl(this.#session, context, { operation: "restoreWindow", windowId: this.id }),
		);
	}

	toggleMaximized(): Promise<void> {
		const context = this.#getContext();
		return this.#control("toggleMaximized", () =>
			sendControl(this.#session, context, { operation: "toggleMaximized", windowId: this.id }),
		);
	}

	toggleFullscreen(): Promise<void> {
		const context = this.#getContext();
		return this.#control("toggleFullscreen", () =>
			sendControl(this.#session, context, { operation: "toggleFullscreen", windowId: this.id }),
		);
	}

	toggleWindowedFullscreen(): Promise<void> {
		const context = this.#getContext();
		return this.#control("toggleWindowedFullscreen", () =>
			sendControl(this.#session, context, { operation: "toggleWindowedFullscreen", windowId: this.id }),
		);
	}

	setFullscreen(options: EnabledOptions): Promise<void> {
		const context = this.#getContext();
		return this.#control("setFullscreen", () =>
			sendControl(this.#session, context, {
				operation: "setFullscreen",
				windowId: this.id,
				enabled: controlEnabled("setFullscreen", options?.enabled),
			}),
		);
	}

	setFloating(options: EnabledOptions): Promise<void> {
		const context = this.#getContext();
		return this.#control("setFloating", () =>
			sendControl(this.#session, context, {
				operation: "setFloating",
				windowId: this.id,
				enabled: controlEnabled("setFloating", options?.enabled),
			}),
		);
	}

	center(): Promise<void> {
		const context = this.#getContext();
		return this.#control("center", () =>
			sendControl(this.#session, context, { operation: "centerWindow", windowId: this.id }),
		);
	}

	moveToWorkspace(options: WorkspaceOptions): Promise<void> {
		const context = this.#getContext();
		return this.#control("moveToWorkspace", () =>
			sendControl(this.#session, context, {
				operation: "moveWindowToWorkspace",
				windowId: this.id,
				workspaceId: controlId("moveToWorkspace", "workspaceId", options?.workspaceId),
				focus: controlFocus("moveToWorkspace", options?.focus),
			}),
		);
	}

	moveToDisplay(options: DisplayOptions): Promise<void> {
		const context = this.#getContext();
		return this.#control("moveToDisplay", () =>
			sendControl(this.#session, context, {
				operation: "moveWindowToDisplay",
				windowId: this.id,
				displayId: controlId("moveToDisplay", "displayId", options?.displayId),
			}),
		);
	}

	zoom(region: CaptureRegion, options?: ScreenshotOptions): Promise<ScreenshotResult> {
		if (!region || typeof region !== "object" || Array.isArray(region)) {
			throw new ToolError("zoom requires a region { x, y, width, height } in the last full screenshot's pixels");
		}
		return captureScreenshot(this.#session, this.#getContext, this.#observer, this.id, options, region);
	}

	async holdKeys(keys: string[], options: HoldOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "holdKeys");
		validateHold(options);
		validateKeys(keys, "keys");
		await nativeCall(context.signal, () => this.#session.holdKeys(this.id, keys, options));
	}

	async holdMouse(x: number, y: number, options: HoldMouseOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "holdMouse");
		validateHold(options);
		if (options.keys !== undefined) validateKeys(options.keys, "keys");
		await nativeCall(context.signal, () => this.#session.holdMouse(this.id, x, y, options));
	}

	async observe(options?: ScreenshotOptions & AxOptions): Promise<ObservationResult> {
		const context = this.#getContext();
		const result = await nativeCall(context.signal, () =>
			this.#session.observe(
				this.id,
				{
					maxWidth: context.snapshot.captureMaxWidth,
					maxHeight: context.snapshot.captureMaxHeight,
				},
				options && { all: options.all, maxDepth: options.maxDepth },
			),
		);
		const screenshot = await emitScreenshot(context, result.capture, options);
		if (!options?.silent) context.output.push({ type: "text", text: result.accessibility.text });
		return {
			...screenshot,
			ax: result.accessibility.text,
			nodeCount: result.accessibility.nodeCount,
			truncated: result.accessibility.truncated,
		};
	}

	get menu() {
		return {
			items: async (path?: string | string[]): Promise<MenuItem[]> => {
				const context = this.#getContext();
				const segments = path === undefined ? undefined : typeof path === "string" ? [path] : path;
				if (segments !== undefined) validateKeys(segments, "menu path", { allowEmpty: true });
				return await nativeCall(context.signal, () => this.#session.menuItems(this.id, segments));
			},
			select: async (path: string[]): Promise<void> => {
				const context = this.#getContext();
				guardRun(context, "menu.select");
				validateKeys(path, "menu path");
				await nativeCall(context.signal, () => this.#session.menuSelect(this.id, path));
			},
		};
	}

	async bringToCurrentSpace(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "bringToCurrentSpace");
		await nativeCall(context.signal, () => this.#session.bringToCurrentSpace(this.id));
	}

	async raise(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "raise");
		await nativeCall(context.signal, () => this.#session.raiseWindow(this.id));
	}

	async ax(options?: AxOptions): Promise<string> {
		const { signal } = this.#getContext();
		const text = (await nativeCall(signal, () => this.#session.axSnapshot(this.id, options))).text;
		this.#observer.recordRead({ id: this.id, pid: this.pid }, text, axReadOptions(options));
		return text;
	}

	async find(query: AxQuery): Promise<El[]> {
		const { signal } = this.#getContext();
		const window = { id: this.id, pid: this.pid };
		return (await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map(node =>
			this.#observer.element(this.#getContext, node, window),
		);
	}

	async ref(ref: string): Promise<El> {
		const node = await this.#observer.read(this.#getContext().signal, ref, `ref ${ref}`, () =>
			this.#session.axNode(ref),
		);
		return this.#observer.element(this.#getContext, node, this.#observer.windowOf(ref));
	}
}

/** The comparable part of `ax()` options: what a read-back must repeat to match the model's tree. */
function axReadOptions(options: AxOptions | undefined): AxReadOptions {
	return { all: options?.all, maxDepth: options?.maxDepth };
}

/** Routes one native session's inputs and element reads through its observation ledger. */
class InputObserver {
	readonly ledger = new ObservationLedger();
	readonly #session: NativeDesktopSession;
	/** Display regions of the latest desktop screenshot, whose pixels desktop pointer input is given in. */
	#desktopDisplays: DesktopDisplay[] = [];
	readonly #getContext: RunContextAccessor;

	/** A tree the cell's own code read. */
	recordRead(window: InputWindow, text: string, options: AxReadOptions): void {
		this.ledger.recordRead(this.cellId, window, text, options);
	}

	/** A frame the model was shown of a target. */
	recordCapture(window: InputWindow): void {
		this.ledger.recordCapture(this.cellId, window);
	}

	/** Async callbacks keep their own run's identity, and an ended run cannot record. */
	get cellId(): string {
		const context = this.#getContext();
		throwIfAborted(context.signal);
		return context.snapshot.cellId ?? UNTAGGED_CELL_ID;
	}

	constructor(session: NativeDesktopSession, getContext: RunContextAccessor) {
		this.#session = session;
		this.#getContext = getContext;
	}

	windowOf(ref: string): InputWindow | undefined {
		return this.ledger.windowOf(ref);
	}

	/** A desktop screenshot was taken: desktop pointer input is given in its pixels. */
	noteDesktopCapture(displays: DesktopDisplay[]): void {
		this.#desktopDisplays = displays;
	}

	/** Wrap a resolved node, remembering the window it was read from. */
	element(getContext: RunContextAccessor, node: AxNode, window: InputWindow | undefined): El {
		if (window) this.ledger.recordRefs(window.id, [node.ref]);
		return new El(this.#session, getContext, this, node);
	}

	/** A read addressed by ref. When it fails, the settle prints the ref's window afresh. */
	async read<T>(signal: AbortSignal, ref: string, label: string, call: () => Promise<T>): Promise<T> {
		const cellId = this.cellId;
		try {
			return await nativeCall(signal, call);
		} catch (error) {
			const window = this.ledger.windowOf(ref);
			if (!signal.aborted && window && !(error instanceof ToolAbortError))
				this.ledger.noteFailure(cellId, window, label, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	/**
	 * Dispatch one input, capturing the roster first when it opens the cell's
	 * input. Desktop-root input (`root`) is recorded on the window it reaches:
	 * the single window under `root.point` (desktop-screenshot pixels), or the
	 * focused window for keys; it stays unattributed when no listing makes that
	 * answer certain.
	 */
	async input(
		signal: AbortSignal,
		window: InputWindow | undefined,
		label: string,
		kind: InputKind,
		dispatch: () => Promise<void>,
		root?: { point?: { x: number; y: number } },
	): Promise<void> {
		let roster: DesktopWindow[] | undefined;
		if (this.ledger.wantsRoster(this.cellId)) {
			// Claimed before the await, so concurrent inputs take one roster, the earliest.
			const claim = this.ledger.claimRoster(this.cellId);
			roster = await this.#optional(signal, () => this.#session.listWindows());
			claim.resolve(roster);
		}
		if (root) {
			const at = root.point && desktopPoint(this.#desktopDisplays, root.point);
			if (!root.point || at) window = await this.windowReached(signal, at, roster);
		}
		return await this.#dispatch(signal, window, label, kind, dispatch, root !== undefined);
	}

	/** A window/workspace/display mutation, recorded for the cell's read-back. */
	async control(
		signal: AbortSignal,
		window: InputWindow | undefined,
		label: string,
		dispatch: () => Promise<void>,
	): Promise<void> {
		if (this.ledger.wantsRoster(this.cellId)) {
			const claim = this.ledger.claimRoster(this.cellId);
			claim.resolve(await this.#optional(signal, () => this.#session.listWindows()));
		}
		await this.#dispatch(signal, window, label, "control", dispatch, false);
	}

	async #dispatch(
		signal: AbortSignal,
		window: InputWindow | undefined,
		label: string,
		kind: InputKind,
		dispatch: () => Promise<void>,
		root: boolean,
	): Promise<void> {
		throwIfAborted(signal);
		const cellId = this.cellId;
		this.ledger.noteInput(cellId, window, label, kind, root);
		try {
			await nativeCall(signal, dispatch);
		} catch (error) {
			if (!signal.aborted && window && !(error instanceof ToolAbortError))
				this.ledger.noteFailure(cellId, window, label, error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			if (!signal.aborted) this.ledger.noteInputEnded(cellId);
		}
	}

	/**
	 * The window a desktop point lies in, or without a point the focused one;
	 * undefined when the listing does not answer with exactly one window.
	 * `roster` is a window list read just before, if any.
	 */
	async windowReached(
		signal: AbortSignal,
		point?: { x: number; y: number },
		roster?: DesktopWindow[],
	): Promise<InputWindow | undefined> {
		roster ??= await this.#optional(signal, () => this.#session.listWindows());
		if (!roster) return undefined;
		const window = point ? windowAt(roster, point) : roster.find(candidate => candidate.focused);
		return window && { id: window.id, pid: window.pid };
	}

	/** A native read, or undefined when it fails; a cancellation still throws. */
	async #optional<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T | undefined> {
		try {
			return await nativeCall(signal, call);
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			return undefined;
		}
	}
}

/** Hosts the persistent JavaScript runtime and native desktop session. */
export class ComputerWorkerCore {
	readonly #transport: ComputerWorkerTransport;
	readonly #createSession?: NativeDesktopSessionFactory;
	readonly #unsubscribe: () => void;
	#session?: NativeDesktopSession;
	/** What the model saw of each window and what input touched since; lives and dies with `#session`. */
	#observer?: InputObserver;
	/** In-flight lazy session creation, shared so concurrent run/capabilities requests never double-create. */
	#sessionInit?: Promise<NativeDesktopSession>;
	#runtime?: JsRuntime;
	#active: ActiveRun | null = null;
	/**
	 * Per-run context, carried through AsyncLocalStorage so async work leaked
	 * from an ended run (timers, dangling promises) keeps that run's aborted
	 * context instead of borrowing the next run's signal and read-only policy.
	 */
	readonly #runContexts = new AsyncLocalStorage<ComputerRunContext>();
	/**
	 * Requests waiting for `#active`: one cell's settle can queue behind another
	 * cell's run, so overlapping cells keep their own state instead of losing it
	 * to a busy answer. Each entry's own host deadline bounds how long it waits.
	 */
	#queue: Array<{ message: Extract<ComputerWorkerInbound, { type: "run" | "settle" }>; ac: AbortController }> = [];
	/** The cell the active request belongs to; `discard` matches against it. */
	#activeCellId: string | undefined;
	#closed = false;

	constructor(transport: ComputerWorkerTransport, createSession?: NativeDesktopSessionFactory) {
		this.#transport = transport;
		this.#createSession = createSession;
		this.#unsubscribe = transport.onMessage(message => this.handle(message));
		this.#transport.send({ type: "ready" });
	}

	/** Routes one supervisor command into the persistent worker state. */
	handle(message: ComputerWorkerInbound): void {
		switch (message.type) {
			case "ping":
				this.#transport.send({ type: "pong", id: message.id });
				return;
			case "run":
			case "settle":
				if (!this.#active) {
					void this.#run(message);
					return;
				}
				// Queued, never refused: the host's own deadline for this request is
				// the bound, and an abort drains its slot at once.
				this.#queue.push({ message, ac: new AbortController() });
				return;
			case "capabilities":
				void this.#capabilities(message);
				return;
			case "abort": {
				if (this.#active?.id === message.id) {
					this.#active.ac.abort(new ToolAbortError());
					return;
				}
				// A queued request that never started: answer it now, do not run it.
				const index = this.#queue.findIndex(queued => queued.message.id === message.id);
				if (index < 0) return;
				const [queued] = this.#queue.splice(index, 1);
				queued!.ac.abort(new ToolAbortError());
				this.#transport.send({
					type: "result",
					id: message.id,
					ok: false,
					error: errorPayload(new ToolAbortError()),
				});
				return;
			}
			case "discard":
				this.#discardCell(message.cellId);
				return;
			case "revoke-control":
				this.#active?.ac.abort(new ToolAbortError("Computer control revoked"));
				this.#session?.cancel();
				this.#transport.send({ type: "control-revoked", id: message.id });
				return;
			case "tool-reply":
				this.#deliverToolReply(message.id, message.reply);
				return;
			case "close":
				void this.#close();
		}
	}

	async #ensureSession(snapshot: ComputerSessionSnapshot): Promise<NativeDesktopSession> {
		if (this.#session) return this.#session;
		// Single-flight: share one creation promise so a run and a capabilities
		// request racing on a cold worker cannot each build (and leak) a session.
		this.#sessionInit ??= (async () => {
			try {
				// The worker must answer its readiness handshake without loading the native
				// addon; normal CLI startup and selector pings never execute desktop code.
				const createSession =
					this.#createSession ?? (await import("@oh-my-pi/pi-natives/desktop")).createDesktopSession;
				const session = await createSession({ display: snapshot.display });
				this.#session = session;
				return session;
			} catch (error) {
				throw nativeError(error);
			}
		})();
		try {
			return await this.#sessionInit;
		} catch (error) {
			// A failed attempt must not pin the rejection; let the next request retry.
			this.#sessionInit = undefined;
			throw error;
		}
	}

	#ensureRuntime(snapshot: ComputerSessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({ initialCwd: snapshot.cwd, sessionId: snapshot.sessionId });
		return this.#runtime;
	}

	/** Runs desktop code, or settles the cell that just ended (`settle`), as one abortable run. */
	async #run(
		message: Extract<ComputerWorkerInbound, { type: "run" | "settle" }>,
		queued?: AbortController,
	): Promise<void> {
		if (this.#closed) {
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: false,
				error: errorPayload(new ToolError("Computer worker is closed")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(message.timeoutMs);
		// A queued request starts its own clock here, not while it waited.
		const ac = queued ?? new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const cellId = this.#cellIdOf(message);
		const active: ActiveRun = { id: message.id, ac, signal, pendingTools: new Map() };
		this.#active = active;
		this.#activeCellId = cellId;
		// Cancel synchronously while this run owns the native session, including
		// fire-and-forget operations still pending when the script returns.
		let nativeCancelled = false;
		const onNativeCancel = (): void => {
			if (this.#active === active && this.#session) {
				this.#session.cancel();
				nativeCancelled = true;
			}
		};
		signal.addEventListener("abort", onNativeCancel, { once: true });
		const output = new RunOutput();
		const screenshots: ComputerScreenshot[] = [];
		const runContext: ComputerRunContext = {
			signal,
			readOnly: message.session.readOnly,
			snapshot: message.session,
			output,
			screenshots,
			confirmControl: reason => this.#confirmControl(active, reason),
		};
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let completed = false;
		try {
			throwIfAborted(signal);
			const session = await this.#ensureSession(message.session);
			const observer = (this.#observer ??= new InputObserver(session, this.#currentRunContext));
			let body: () => Promise<unknown>;
			if (message.type === "settle") {
				body = () => this.#settle(session, observer, cellId, signal, message.output);
			} else {
				throwIfAborted(signal);
				const code = message.code;
				const runtime = this.#ensureRuntime(message.session);
				runtime.setCwd(message.session.cwd);
				const desktop = this.#createDesktopScope(session, observer);
				runtime.setRunScope({
					desktop: bindRunFacade(desktop, signal),
					assert: (condition: unknown, text?: string): void => {
						if (!condition) throw new ToolError(text ?? "Assertion failed");
					},
					wait: (msOrPredicate: number | (() => unknown), options?: WaitPredicateOptions): Promise<unknown> => {
						const resolved =
							typeof msOrPredicate === "number"
								? undefined
								: {
										timeout: resolvePredicateTimeout(message.timeoutMs, options?.timeout),
										interval: options?.interval,
									};
						return markHandled(waitForRun(msOrPredicate, signal, resolved));
					},
				});
				body = () =>
					runtime.run(code, `computer-run-${message.id}.js`, this.#runtimeHooks(active, output), {
						runId: message.id,
						cwd: message.session.cwd,
					});
			}
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				rejectCancel(
					timeoutSignal.aborted
						? new ToolError(`Computer code execution timed out after ${message.timeoutMs}ms`)
						: abortError,
				);
				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) pending.reject(toolAbort);
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				returnValue = await Promise.race([this.#runContexts.run(runContext, body), cancelRejection]);
				completed = true;
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			const cancelled = timeoutSignal.aborted || ac.signal.aborted;
			// Successful helper completion invalidates outstanding native work but
			// preserves an explicitly acquired task grant. Errors revoke it.
			signal.removeEventListener("abort", onNativeCancel);
			if (failure === undefined && !signal.aborted) this.#session?.retire();
			else if (!nativeCancelled) this.#session?.cancel();
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Computer run ended")));
			if (this.#active?.id === message.id) {
				this.#active = null;
				this.#activeCellId = undefined;
			}
			// A cancelled run never settles, so its input belongs to no report; a run
			// that merely failed still settles, with `failed` set.
			if (message.type === "run" && cancelled) this.#observer?.ledger.discard(cellId);
			this.#drain();
		}
		if (failure !== undefined) {
			this.#transport.send({ type: "result", id: message.id, ok: false, error: errorPayload(failure.error) });
			return;
		}
		if (completed) {
			let capabilities: DesktopCapabilities;
			try {
				capabilities = (await this.#ensureSession(message.session)).capabilities;
			} catch (error) {
				this.#transport.send({
					type: "result",
					id: message.id,
					ok: false,
					error: errorPayload(nativeError(error)),
				});
				return;
			}
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: true,
				payload: { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots, capabilities },
			});
		}
	}

	/** The cell a request belongs to: its eval cell, or the shared untagged lane. */
	#cellIdOf(message: Extract<ComputerWorkerInbound, { type: "run" | "settle" }>): string {
		return message.session.cellId ?? UNTAGGED_CELL_ID;
	}

	/**
	 * A cancelled eval cell will never settle: forget what it left, stop the work it
	 * still has in flight, and answer its queued requests with the abort. Another
	 * cell's pending state and queued work are untouched.
	 */
	#discardCell(cellId: string): void {
		this.#observer?.ledger.discard(cellId);
		if (this.#activeCellId === cellId) this.#active?.ac.abort(new ToolAbortError());
		for (let index = this.#queue.length - 1; index >= 0; index--) {
			const queued = this.#queue[index]!;
			if (this.#cellIdOf(queued.message) !== cellId) continue;
			this.#queue.splice(index, 1);
			queued.ac.abort(new ToolAbortError());
			this.#transport.send({
				type: "result",
				id: queued.message.id,
				ok: false,
				error: errorPayload(new ToolAbortError()),
			});
		}
	}

	/** Start the next queued request, answering any cancelled while it waited. */
	#drain(): void {
		while (this.#queue.length > 0) {
			const next = this.#queue[0]!;
			if (!next.ac.signal.aborted) {
				this.#queue.shift();
				void this.#run(next.message, next.ac);
				return;
			}
			this.#queue.shift();
			this.#transport.send({
				type: "result",
				id: next.message.id,
				ok: false,
				error: errorPayload(new ToolAbortError()),
			});
		}
	}

	/**
	 * Re-reads every window the cell's input touched and says, once, what it
	 * left behind: each window's current tree marked against the last tree the
	 * model received, a fresh screenshot of windows it works from pixels, then
	 * windows the input opened, closed or focused. Each window is read once, so
	 * refs from the tree the model held before the cell stay valid (the native
	 * registry keeps one previous generation) and the printed refs are live. A
	 * window the cell read with `ax()` after its input is skipped only when
	 * `output`, what the cell printed, carries that tree. Input whose window is
	 * unknown is reported on the focused window, or named on its own when none
	 * has focus. Nothing when the cell sent no input and no ref failed.
	 */
	async #settle(
		session: NativeDesktopSession,
		observer: InputObserver,
		cellId: string,
		signal: AbortSignal,
		output: string,
	): Promise<string | undefined> {
		const pending = observer.ledger.take(cellId, output);
		if (!pending) return undefined;
		const deadline = Date.now() + SETTLE_READ_BUDGET_MS;
		const settleIn = pending.lastInputAt + SETTLE_DELAY_MS - Date.now();
		if (settleIn > 0) await scheduler.wait(settleIn, { signal });
		// Loaded here, like the desktop session above: the readiness handshake must not load the addon.
		const { diffLineRuns } = await import("@oh-my-pi/pi-natives");
		const failure = (error: unknown): string => {
			if (signal.aborted) throw error;
			return error instanceof Error ? error.message : String(error);
		};
		let roster: DesktopWindow[] | undefined;
		try {
			roster = await nativeCall(signal, () => session.listWindows());
		} catch (error) {
			failure(error);
		}
		const focused = roster?.find(window => window.focused);
		if (focused) observer.ledger.attributeToFocused(pending, focused);
		const sections: string[] = [];
		if (pending.unattributed.length > 0) sections.push(renderUnattributed(pending.unattributed));
		for (const touched of pending.touched) {
			const window = roster?.find(candidate => candidate.id === touched.id);
			if (roster && !window) {
				sections.push(renderGone(touched));
				continue;
			}
			if (Date.now() > deadline) {
				sections.push(
					`window ${JSON.stringify(touched.id)} was not read back: the report's time budget is spent; read it yourself`,
				);
				continue;
			}
			try {
				const text = (await nativeCall(signal, () => session.axSnapshot(touched.id, touched.options))).text;
				const change = touched.baseline === undefined ? undefined : diffTree(touched.baseline, text, diffLineRuns);
				observer.ledger.recordShown(cellId, { id: touched.id, pid: window?.pid }, text, touched.options);
				sections.push(
					renderReadBack({ touched, window, text, change, sinceInputMs: Date.now() - pending.lastInputAt }),
				);
			} catch (error) {
				sections.push(renderUnreadable(touched, window, failure(error)));
			}
			// Pixels do not depend on AX: an unreadable surface still gets its frame.
			// The capture also becomes the window's coordinate frame, so the next
			// pixel input maps against the image the model now sees.
			if (touched.screenshot) {
				try {
					await captureScreenshot(session, this.#currentRunContext, observer, touched.id);
				} catch (error) {
					sections.push(`window ${JSON.stringify(touched.id)}: screenshot failed: ${failure(error)}`);
				}
			}
		}
		if (pending.desktopScreenshot) {
			try {
				await captureScreenshot(session, this.#currentRunContext, observer, DESKTOP_TARGET);
				sections.push("desktop screenshot below (you last worked the desktop root from pixels)");
			} catch (error) {
				sections.push(`desktop screenshot failed: ${failure(error)}`);
			}
		}
		if (roster && pending.rosterBefore) {
			const reported = new Set(pending.touched.map(touched => touched.id));
			const changes = describeRosterChanges(pending.rosterBefore, roster, pending.pids, reported);
			if (changes.length > 0) sections.push(changes.join("\n"));
		}
		return sections.length > 0 ? sections.join("\n\n") : undefined;
	}

	/**
	 * Answers a direct capabilities request without executing a script. Unlike a
	 * run, this never touches `#active`, so it resolves even while a run is in
	 * flight and always reports the session's current permission/backend state.
	 */
	async #capabilities(message: Extract<ComputerWorkerInbound, { type: "capabilities" }>): Promise<void> {
		if (this.#closed) {
			this.#transport.send({
				type: "capabilities",
				id: message.id,
				ok: false,
				error: errorPayload(new ToolError("Computer worker is closed")),
			});
			return;
		}
		try {
			const session = await this.#ensureSession(message.session);
			this.#transport.send({ type: "capabilities", id: message.id, ok: true, capabilities: session.capabilities });
		} catch (error) {
			this.#transport.send({
				type: "capabilities",
				id: message.id,
				ok: false,
				error: errorPayload(error instanceof ToolAbortError ? error : nativeError(error)),
			});
		}
	}

	#runtimeHooks(active: ActiveRun, output: RunOutput): RuntimeHooks {
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				output.pushText(chunk);
			},
			onDisplay: display => {
				throwIfAborted(active.signal);
				output.pushDisplay(display);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `computer-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	async #confirmControl(active: ActiveRun, reason: string): Promise<boolean> {
		throwIfAborted(active.signal);
		const id = `computer-control-${active.id}-${crypto.randomUUID()}`;
		const pending = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, pending);
		this.#transport.send({ type: "control-request", id, runId: active.id, reason });
		return (await pending.promise) === true;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const pending = this.#active?.pendingTools.get(id);
		if (!pending) return;
		this.#active?.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	#currentRunContext = (): ComputerRunContext => {
		const context = this.#runContexts.getStore();
		if (!context) throw new ToolError("no active computer run");
		return context;
	};

	#createDesktopScope(session: NativeDesktopSession, observer: InputObserver): object {
		const getContext = this.#currentRunContext;
		const makeWin = (window: DesktopWindow): Win => new Win(session, getContext, observer, window);
		const desktopTarget = new Win(session, getContext, observer, {
			id: DESKTOP_TARGET,
			app: "desktop",
			title: "desktop",
			x: 0,
			y: 0,
			width: 0,
			height: 0,
			focused: false,
		});
		return {
			capabilities: (): DesktopCapabilities => {
				const { signal } = getContext();
				throwIfAborted(signal);
				return readCapabilities(session);
			},
			displays: async (): Promise<DesktopDisplay[]> => {
				const { signal } = getContext();
				return await nativeCall(signal, () => session.listDisplays());
			},
			display: async (selector: string): Promise<object> => {
				const { signal } = getContext();
				if (typeof selector !== "string" || !selector)
					throw new ToolError("display requires an id, 'active', or 'all'");
				if (selector !== "active" && selector !== "all") {
					const displays = await nativeCall(signal, () => session.listDisplays());
					if (!displays.some(display => display.id === selector))
						throw new ToolError(`Unknown display: ${selector}`);
				}
				const target = new Win(session, getContext, observer, {
					id: `display:${selector}`,
					app: "",
					title: "",
					x: 0,
					y: 0,
					width: 0,
					height: 0,
					focused: false,
				});
				return {
					id: selector,
					screenshot: target.screenshot.bind(target),
					zoom: target.zoom.bind(target),
					click: target.click.bind(target),
					doubleClick: target.doubleClick.bind(target),
					move: target.move.bind(target),
					drag: target.drag.bind(target),
					scroll: target.scroll.bind(target),
					type: target.type.bind(target),
					press: target.press.bind(target),
					holdKeys: target.holdKeys.bind(target),
					holdMouse: target.holdMouse.bind(target),
				};
			},
			apps: {
				list: async (options?: ApplicationQuery): Promise<Application[]> => {
					const { signal } = getContext();
					return await nativeCall(signal, () => session.listApplications(options));
				},
				open: async (id: string, options?: ApplicationOpenOptions): Promise<Application> => {
					const context = getContext();
					guardRun(context, "apps.open");
					return await nativeCall(context.signal, () => session.openApplication(id, options));
				},
			},
			control: {
				acquire: async (options: { reason: string }): Promise<{ active: boolean }> => {
					const context = getContext();
					guardRun(context, "control.acquire");
					strictObject(options, ["reason"], "control.acquire");
					if (typeof options.reason !== "string" || !options.reason.trim())
						throw new ToolError("control.acquire requires a non-empty reason");
					if (session.controlState().active) return { active: true };
					const approved = await context.confirmControl(options.reason);
					throwIfAborted(context.signal);
					if (!approved) return { active: false };
					return await nativeCall(context.signal, () => session.acquireControl());
				},
				release: async (): Promise<void> => {
					const context = getContext();
					guardRun(context, "control.release");
					await nativeCall(context.signal, () => session.releaseControl());
				},
				state: async (): Promise<{ active: boolean }> => {
					throwIfAborted(getContext().signal);
					return session.controlState();
				},
			},
			windows: async (filter?: WindowFilter): Promise<DesktopWindow[]> => {
				const { signal } = getContext();
				return (await nativeCall(signal, () => session.listWindows())).filter(window =>
					matchesFilter(window, filter),
				);
			},
			window: async (selector: string | number | WindowFilter): Promise<Win> => {
				const { signal } = getContext();
				const windows = await nativeCall(signal, () => session.listWindows());
				const matches =
					typeof selector === "string" || typeof selector === "number"
						? windows.filter(window => window.id === String(selector))
						: windows.filter(window => matchesFilter(window, selector));
				if (matches.length === 0) {
					// Scripts are untyped: `window(null)` reaches here when no window is open.
					const app = typeof selector === "object" ? selector?.app : undefined;
					throw new ToolError(
						`no window matches ${JSON.stringify(selector)}\n${describeWindowMiss(windows, app)}`,
					);
				}
				if (matches.length > 1) {
					const candidates = matches
						.map(window => `${window.id} ${window.app} ${JSON.stringify(window.title)}`)
						.join("\n");
					throw new ToolError(`multiple windows match ${JSON.stringify(selector)}:\n${candidates}`);
				}
				return makeWin(matches[0]!);
			},
			focusedWindow: async (): Promise<Win | null> => {
				const { signal } = getContext();
				const window = (await nativeCall(signal, () => session.listWindows())).find(candidate => candidate.focused);
				return window ? makeWin(window) : null;
			},
			workspaces: async (): Promise<DesktopWorkspace[]> => {
				const { signal } = getContext();
				throwIfAborted(signal);
				requireWindowControl(session, "workspace listing");
				return await nativeCall(signal, () => session.listWorkspaces());
			},
			focusWorkspace: async (options: WorkspaceOptions): Promise<void> => {
				const context = getContext();
				guardRun(context, "focusWorkspace");
				const workspaceId = controlId("focusWorkspace", "workspaceId", options?.workspaceId);
				await observer.control(context.signal, undefined, `desktop focusWorkspace ${workspaceId}`, () =>
					sendControl(session, context, { operation: "focusWorkspace", workspaceId }),
				);
			},
			focusDisplay: async (options: DisplayOptions): Promise<void> => {
				const context = getContext();
				guardRun(context, "focusDisplay");
				const displayId = controlId("focusDisplay", "displayId", options?.displayId);
				await observer.control(context.signal, undefined, `desktop focusDisplay ${displayId}`, () =>
					sendControl(session, context, { operation: "focusDisplay", displayId }),
				);
			},
			moveWorkspaceToDisplay: async (options: WorkspaceDisplayOptions): Promise<void> => {
				const context = getContext();
				guardRun(context, "moveWorkspaceToDisplay");
				const workspaceId = controlId("moveWorkspaceToDisplay", "workspaceId", options?.workspaceId);
				const displayId = controlId("moveWorkspaceToDisplay", "displayId", options?.displayId);
				await observer.control(
					context.signal,
					undefined,
					`desktop moveWorkspaceToDisplay ${workspaceId} to ${displayId}`,
					() => sendControl(session, context, { operation: "moveWorkspaceToDisplay", workspaceId, displayId }),
				);
			},
			screenshot: (options?: ScreenshotOptions) => desktopTarget.screenshot(options),
			zoom: desktopTarget.zoom.bind(desktopTarget),
			click: desktopTarget.click.bind(desktopTarget),
			doubleClick: desktopTarget.doubleClick.bind(desktopTarget),
			move: desktopTarget.move.bind(desktopTarget),
			drag: desktopTarget.drag.bind(desktopTarget),
			scroll: desktopTarget.scroll.bind(desktopTarget),
			type: desktopTarget.type.bind(desktopTarget),
			press: desktopTarget.press.bind(desktopTarget),
			holdKeys: desktopTarget.holdKeys.bind(desktopTarget),
			holdMouse: desktopTarget.holdMouse.bind(desktopTarget),
			elementAt: async (x: number, y: number): Promise<El | null> => {
				const { signal } = getContext();
				const node = await nativeCall(signal, () => session.axElementAt(DESKTOP_TARGET, x, y));
				return node ? observer.element(getContext, node, await observer.windowReached(signal, { x, y })) : null;
			},
			focusedElement: async (): Promise<El | null> => {
				const { signal } = getContext();
				const node = await nativeCall(signal, () => session.axFocused());
				return node ? observer.element(getContext, node, await observer.windowReached(signal)) : null;
			},
			ref: async (ref: string): Promise<El> => {
				const node = await observer.read(getContext().signal, ref, `ref ${ref}`, () => session.axNode(ref));
				return observer.element(getContext, node, observer.windowOf(ref));
			},
			clipboard: {
				read: async (): Promise<string> => {
					const { signal } = getContext();
					throwIfAborted(signal);
					// Clipboard access is part of the native desktop surface and remains
					// outside the worker's readiness-only import graph.
					const { readTextFromClipboard } = await import("../../utils/clipboard");
					const text = await readTextFromClipboard();
					throwIfAborted(signal);
					return text;
				},
				write: async (text: string): Promise<void> => {
					const context = getContext();
					guardRun(context, "clipboard.write");
					// Clipboard access is part of the native desktop surface and remains
					// outside the worker's readiness-only import graph.
					const { copyToClipboard } = await import("../../utils/clipboard");
					await copyToClipboard(text);
					throwIfAborted(context.signal);
				},
			},
		};
	}

	async #close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#active?.ac.abort(new ToolAbortError());
		try {
			await this.#session?.close();
		} catch {
			// Closing is best-effort; the worker is exiting and has no request to report this against.
		} finally {
			this.#session = undefined;
			this.#observer = undefined;
			this.#sessionInit = undefined;
			this.#unsubscribe();
			this.#transport.send({ type: "closed" });
			this.#transport.close();
		}
	}
}
