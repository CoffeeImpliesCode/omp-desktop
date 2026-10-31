import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
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
	AxSelectTextOptions,
	AxSnapshotOptions,
	AxTextSelection,
	CaptureRegion,
	DesktopCapabilities,
	DesktopControlAction,
	DesktopCapture,
	DesktopDisplay,
	DesktopFocusReturn,
	DesktopPoint,
	DesktopScreenState,
	DesktopSessionOptions,
	DesktopWindow,
	DesktopWindowState,
	DesktopWorkspace,
	OpenedApplication,
	PointerOptions,
} from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
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
import {
	type ComputerEscapeScope,
	type ComputerScreenshot,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerTransport,
	type ControlVerdict,
	ESCAPE_AFTER_CALL_MESSAGE,
	ESCAPE_STOPPED_MESSAGE,
	type RunErrorPayload,
	SCREEN_LOCKED_CAPTURE_NOTE,
	screenStateNotice,
	type ToolReply,
} from "./protocol";

/** A native input call; resolves to its takeover focus report when it took over. */
type InputCall = Promise<DesktopFocusReturn | null | void>;

/** Native desktop operations consumed by the script runtime. */
export interface NativeDesktopSession {
	readonly capabilities: DesktopCapabilities;
	/** Lock and display-sleep state, read without waiting behind queued native work. */
	readonly screenState: DesktopScreenState;
	/** Physical-Escape stops of takeover input under the session's key; host cancels never count. */
	readonly escapeStops: number;
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
	/** Keep the display awake from the next activity until `releaseDisplayAwake()`, not just for the grace period. */
	holdDisplayUntilReleased(): void;
	/** Let a turn's hold go now (activity outside a turn keeps its grace); later activity gets the grace again. */
	releaseDisplayAwake(): void;
	/** Sets when the current run ends, `remainingMs` from now; bounds how long input waits for the user to pause. */
	setRunDeadline(remainingMs: number): void;
	listApplications(options?: ApplicationQuery): Promise<Application[]>;
	openApplication(id: string, options?: ApplicationOpenOptions): Promise<OpenedApplication>;
	menuItems(target: string, path?: string[]): Promise<MenuItem[]>;
	menuSelect(target: string, path: string[]): Promise<void>;
	observe(
		target: string,
		caps?: { maxWidth?: number; maxHeight?: number },
		options?: AxOptions,
	): Promise<NativeObservation>;
	holdKeys(target: string, keys: string[], options: NativeHoldOptions): InputCall;
	holdMouse(target: string, x: number, y: number, options: NativeHoldOptions): InputCall;
	acquireControl(): Promise<DesktopControlState>;
	releaseControl(): void;
	controlState(): DesktopControlState;
	bringToCurrentSpace(windowId: string): Promise<void>;
	click(target: string, x: number, y: number, opts?: PointerOptions | null): InputCall;
	moveMouse(target: string, x: number, y: number, opts?: PointerOptions | null): InputCall;
	drag(target: string, points: DesktopPoint[], opts?: PointerOptions | null): InputCall;
	scroll(target: string, x: number, y: number, dx: number, dy: number, opts?: PointerOptions | null): InputCall;
	typeText(target: string, text: string, opts?: PointerOptions | null): InputCall;
	keyChord(target: string, keys: string[], opts?: PointerOptions | null): InputCall;
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
	axPerform(ref: string, action: string, menu?: string[] | null): Promise<void>;
	axSetValue(ref: string, value: string): Promise<void>;
	axSelectText(ref: string, text: string, opts?: AxSelectTextOptions | null): Promise<AxTextSelection>;
	axFocus(ref: string): Promise<void>;
	axClick(ref: string, opts?: PointerOptions | null): InputCall;
	axType(ref: string, text: string, opts?: PointerOptions | null): InputCall;
	axKeyChord(ref: string, keys: string[], opts?: PointerOptions | null): InputCall;
	close(): Promise<void>;
}

/** Creates the native session co-located with the computer worker runtime. */
export type NativeDesktopSessionFactory = (
	options: DesktopSessionOptions,
) => NativeDesktopSession | Promise<NativeDesktopSession>;

type WindowFilter = { id?: string | number; app?: string; title?: string; wait?: number };
const MAX_WINDOW_WAIT_MS = 10_000;
const WINDOW_WAIT_INTERVAL_MS = 100;
/** Window listings are session-transcript payload; `window()` lookups search the whole native list. */
const MAX_LISTED_WINDOWS = 48;
/**
 * Run time a `control.acquire` confirmation leaves unspent, so an unanswered prompt closes while the script can
 * still act on `{ active: false, reason: "unanswered" }` instead of the run timing out around it. A run shorter
 * than four times this keeps a quarter of its timeout instead.
 */
const CONTROL_ANSWER_RESERVE_MS = 5_000;
type InputOptions = { takeover?: boolean };
type ScreenshotOptions = { silent?: boolean };
type ScreenshotResult = Pick<
	ComputerScreenshot,
	"path" | "width" | "height" | "coordinateWidth" | "coordinateHeight" | "region" | "screenLocked"
>;
type MenuOptions = { menu?: string[] };
type ClickOptions = InputOptions & MenuOptions & { button?: string; count?: number; modifiers?: string[] };
type DragOptions = InputOptions & { modifiers?: string[]; keys?: string[] };
type ScrollOptions = InputOptions & { dx?: number; dy?: number };
type AxOptions = Pick<AxSnapshotOptions, "all" | "maxDepth">;
type HoldOptions = Pick<NativeHoldOptions, "duration" | "takeover">;
type HoldMouseOptions = Pick<NativeHoldOptions, "duration" | "button" | "keys" | "takeover">;
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
	/** Escape stops the user acknowledged; any more stop the run. */
	acknowledgedEscapeStops: number;
	ac: AbortController;
	signal: AbortSignal;
	pendingTools: Map<string, PendingTool>;
	/** The agent turn the run belongs to, if any; a resume while it starts carries it into the turn that went on. */
	displayTurn?: number;
	/** The stop the user's Escape set on this run, reported as its result. */
	escapeStop?: ToolError;
}

interface ComputerRunContext {
	signal: AbortSignal;
	readOnly: boolean;
	snapshot: ComputerSessionSnapshot;
	output: RunOutput;
	confirmControl(reason: string): Promise<ControlVerdict>;
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

/**
 * Native pointer options, each read once from the model's object, so the
 * `refuse` check and the native call see the same `takeover`.
 */
function pointerOptions(options?: ClickOptions | DragOptions | InputOptions): PointerOptions {
	const { button, count, modifiers, keys, menu, takeover }: Partial<ClickOptions & DragOptions> = options ?? {};
	const mapped: PointerOptions = {};
	if (button !== undefined) mapped.button = button;
	if (count !== undefined) mapped.count = count;
	if (modifiers !== undefined) mapped.modifiers = modifiers;
	if (keys !== undefined) mapped.keys = keys;
	if (menu !== undefined) mapped.menu = menuOption({ menu });
	if (takeover !== undefined) mapped.takeover = takeover;
	return mapped;
}

/** The item path of a `menu` option, checked before anything is sent. */
function menuOption(options?: MenuOptions): string[] | undefined {
	if (options?.menu === undefined) return undefined;
	validateKeys(options.menu, "menu path");
	return options.menu;
}

/** Whether `press`'s first argument is its options rather than a chord. */
function isMenuOptions(value: unknown): value is MenuOptions {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chordKeys(chord: unknown): string[] {
	const keys =
		typeof chord === "string"
			? chord
					.split("+")
					.map(key => key.trim())
					.filter(Boolean)
			: chord;
	if (!isStringList(keys) || keys.length === 0) {
		throw new ToolError(
			`press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got ${describeArgument(chord)}`,
		);
	}
	return keys;
}

/** Keys and menu titles share one rule: an array of strings, none blank. */
function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim() !== "");
}

function validateKeys(value: unknown, label: string): asserts value is string[] {
	if (!isStringList(value) || value.length === 0) {
		throw new ToolError(`${label} requires a non-empty array of non-empty strings`);
	}
}

function describeArgument(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

/** Names the helper and parameter in place of the native addon's conversion error, which names neither. */
function validateString(value: unknown, call: string, options?: { nonEmpty?: boolean }): asserts value is string {
	if (typeof value === "string" && (!options?.nonEmpty || value.trim())) return;
	throw new ToolError(
		`${call} requires ${options?.nonEmpty ? "a non-empty string" : "a string"}, got ${describeArgument(value)}`,
	);
}

/** A menu path is one title, an array of titles, or the titles as separate arguments. */
function menuPath(method: string, args: unknown[], options?: { allowEmpty?: boolean }): string[] {
	const path: unknown[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
	if (isStringList(path) && (options?.allowEmpty || path.length > 0)) return path;
	let got = "no path";
	if (args.length > 0) {
		const shown = args.length === 1 ? args[0] : args;
		try {
			got = JSON.stringify(shown) ?? describeArgument(shown);
		} catch {
			// BigInt and cyclic values do not serialize; the type still tells the caller what it passed.
			got = describeArgument(shown);
		}
	}
	throw new ToolError(
		`${method} requires a menu path of non-empty titles: one title ("File"), an array (["File", "Export…"]), or separate titles ("File", "Export…"); got ${got}`,
	);
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

function windowWait(wait: unknown): number {
	if (wait === undefined) return 0;
	if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0 || wait > MAX_WINDOW_WAIT_MS) {
		const got = typeof wait === "number" ? String(wait) : describeArgument(wait);
		throw new ToolError(`window({ wait }) takes milliseconds from 0 to ${MAX_WINDOW_WAIT_MS}; got ${got}`);
	}
	return wait;
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

/** Native options for the tool's own takeover rerun of a refused background call. */
type Fallback = { takeover: true; returnFocus: true };
const FALLBACK: Fallback = { takeover: true, returnFocus: true };
const BACKGROUND_UNAVAILABLE = "BackgroundUnavailable: ";
/** A refusal's closing "nothing was sent", true of the refused background attempt only. */
const UNSENT_CLAUSE = /(?:;|,? so) (?:nothing|no input) was sent$/;
const RAISE_ROUTE = "Background input and screenshots reach a covered window, so no raise is needed.";
const OPEN_ROUTE = "Use press() on a button that does the same, or tell the user the step needs their screen.";

/**
 * Under `computer.backgroundFallback: "refuse"` the user's setting beats the
 * model: a call that would bring an application forward or drive the user's
 * own pointer or keyboard is refused before anything is sent. `effect` says
 * what the call would do; `route` names the background way to the same end.
 */
function refuseForeground(
	context: ComputerRunContext,
	call: string,
	effect: string,
	route: string,
	target?: string,
): void {
	if (context.snapshot.backgroundFallback !== "refuse") return;
	const to = target === undefined ? "" : ` to ${target}`;
	throw new ToolError(
		`${BACKGROUND_UNAVAILABLE}${call} would ${effect}, and the user's computer.backgroundFallback setting is "refuse", which keeps the agent in the background; nothing was sent${to}. ${route}`,
	);
}

/** A URL (`https:`, `x-apple.systempreferences:`, Windows `shell:`); never a drive letter. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/**
 * `apps.open`'s target or `app` selector, against the session's folder
 * `cwd` when it names a path there: one written as a relative path (`./a`,
 * `a/b`), even if missing, or a bare name of an existing entry. An exact
 * application ID or native path (`listed`) keeps precedence over a same-named
 * entry; absolute paths, URLs and other names pass through to native
 * resolution.
 */
async function sessionPath(value: string, cwd: string, listed: (value: string) => Promise<boolean>): Promise<string> {
	if (path.isAbsolute(value) || URL_SCHEME.test(value)) return value;
	const local = path.resolve(cwd, value);
	const written = value.startsWith(".") || value.includes("/") || value.includes(path.sep);
	if (!written && !(await entryExists(local))) return value;
	return (await listed(value)) ? value : local;
}

/** Whether `local` names an entry (a link counts as itself), without blocking the worker. */
async function entryExists(local: string): Promise<boolean> {
	try {
		await fs.lstat(local);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

const MENU_ROUTE =
	"Use the window's menu bar with win.menu.select(...), or an element action such as press(), instead.";
/** AX roles of the controls that open a menu when pressed, as native's `open_menu` reads them. */
const MENU_CONTROL_ROLES = ["AXPopUpButton", "AXMenuButton"];
const MENU_CONTROL_ROUTE =
	"Its options are chosen only through that menu: use the window's menu bar with win.menu.select(...) if it has the same command, or tell the user the step needs their screen.";

/**
 * Under `refuse`, a macOS call that opens a menu is refused before anything is
 * sent: `WindowServer` sends the user's keys to an open menu, so even one
 * closed at once costs the user about a keystroke.
 */
function refuseMenu(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	call: string,
	menu: string,
	route: string,
	target: string,
): void {
	if (context.snapshot.backgroundFallback !== "refuse" || session.capabilities.backend !== "quartz") return;
	refuseForeground(context, call, `open ${menu}, which takes the user's keyboard while it is open`, route, target);
}

/** `refuseMenu` for an element call that opens the menu of a popup button or menu button. */
function refuseControlMenu(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	call: string,
	role: string,
	target: string,
): void {
	if (!MENU_CONTROL_ROLES.includes(role)) return;
	refuseMenu(session, context, `${call} on an ${role}`, "its menu", MENU_CONTROL_ROUTE, target);
}

/**
 * `refuseMenu` for pointer input: a secondary press (the right button, or the
 * left with Control held, as native's `may_open_context_menu` reads it) opens
 * a context menu in most views, a primary click on a popup button or menu
 * button (`role`, for an element click) opens its menu, and a `menu` option
 * names an item of the menu the press opens.
 */
function refusePointerMenu(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	method: string,
	{ button, modifiers, keys, menu }: PointerOptions,
	target: string,
	role?: string,
): void {
	const pressed = typeof button === "string" ? button.trim().toLowerCase() : "left";
	const control = [modifiers, keys].some(
		list =>
			Array.isArray(list) &&
			list.some(
				entry =>
					typeof entry === "string" &&
					entry.split("+").some(key => ["ctrl", "control"].includes(key.trim().toLowerCase())),
			),
	);
	if (pressed === "right") {
		refuseMenu(session, context, `${method} with button: "right"`, "a context menu", MENU_ROUTE, target);
	} else if (pressed === "left" && control) {
		refuseMenu(session, context, `${method} with Control held`, "a context menu", MENU_ROUTE, target);
	} else if (pressed === "left" && role !== undefined) {
		refuseControlMenu(session, context, method, role, target);
	}
	if (menu !== undefined) refuseMenu(session, context, `${method} with menu`, "a menu", MENU_ROUTE, target);
}

/**
 * Under `refuse` on macOS, asks native to refuse a background click that lands
 * on a popup button or menu button, or a hold or drag that starts on one, whose
 * menu would take the user's keyboard; only native can tell what a pixel lands
 * on.
 */
function refuseMenuPress(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	native: { refuseMenu?: boolean },
): void {
	if (context.snapshot.backgroundFallback === "refuse" && session.capabilities.backend === "quartz") {
		native.refuseMenu = true;
	}
}

/** Native's `refuseMenu` refusal; its first group is the press, as `refuseMenu`'s `call`. */
const MENU_CONTROL_REFUSAL =
	/^BackgroundUnavailable: (the .+, which (?:lands|starts) on a menu button or popup button,) would open its menu; nothing was sent$/;

/** App names by pid from the window list, empty when the listing fails. */
async function appNames(session: NativeDesktopSession, signal: AbortSignal): Promise<Map<number, string>> {
	try {
		const windows = await nativeCall(signal, () => session.listWindows());
		return new Map(windows.flatMap(window => (window.pid === undefined ? [] : [[window.pid, window.app]])));
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		return new Map();
	}
}

/**
 * Says where focus ended after a fallback takeover, from native's
 * WindowServer reading taken when the takeover finished.
 */
async function focusReport(
	session: NativeDesktopSession,
	signal: AbortSignal,
	report: DesktopFocusReturn | null | void,
	target?: number,
): Promise<string> {
	if (!report || report.frontPid == null) return "focus was not confirmed afterwards";
	const { frontPid, previousPid, handedBack } = report;
	const names = await appNames(session, signal);
	const name = (pid: number) => names.get(pid) ?? `pid ${pid}`;
	const front = name(frontPid);
	if (previousPid == null) return `focus is on ${front}`;
	if (frontPid === previousPid) return handedBack ? `focus returned to ${front}` : `focus is on ${front}`;
	const user = name(previousPid);
	if (handedBack) return `focus was handed back to ${user}, but ${front} is now front`;
	if (frontPid === target) return `focus stayed on ${front}; it did not return to ${user}`;
	return `focus is on ${front}; it did not return to ${user}`;
}

/**
 * Sends one window input call. A model-supplied `takeover: true` is refused
 * under `computer.backgroundFallback: "refuse"`. When the background route
 * throws `BackgroundUnavailable`, which native raises only before any of the
 * call's input was sent (a user who came to the target gets `UserIntervened`,
 * which is never rerun), and the call did not set `takeover`, the setting
 * decides: `takeover` reruns that call in takeover, handing focus back
 * to the user's app, and reports it in the run output; `refuse` fails without
 * taking over.
 */
async function sendInput(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	method: string,
	takeover: boolean | undefined,
	send: (fallback?: Fallback) => InputCall,
	target?: number,
): Promise<void> {
	if (takeover === true) {
		refuseForeground(
			context,
			`${method} with takeover: true`,
			"bring its application to the front and take the user's keyboard and pointer",
			"Call it without takeover: window input runs in the background.",
		);
	}
	try {
		await nativeCall(context.signal, () => send());
		return;
	} catch (error) {
		if (!(error instanceof ToolError) || !error.message.startsWith(BACKGROUND_UNAVAILABLE)) throw error;
		const refuse = context.snapshot.backgroundFallback === "refuse";
		// Native refuses a menu control's press only for the setting, so it says so
		// even when the call set `takeover: false`.
		const control = refuse ? MENU_CONTROL_REFUSAL.exec(error.message) : null;
		if (control)
			refuseForeground(
				context,
				control[1],
				"open its menu, which takes the user's keyboard while it is open",
				MENU_CONTROL_ROUTE,
			);
		if (takeover !== undefined) throw error;
		const reason = error.message.slice(BACKGROUND_UNAVAILABLE.length);
		const why = reason.replace(UNSENT_CLAUSE, "");
		if (refuse) {
			throw new ToolError(
				`${error.message}; the user's computer.backgroundFallback setting is "refuse", which keeps the agent in the background, so no takeover happened`,
			);
		}
		if (!session.capabilities.takeover) {
			throw new ToolError(`${error.message}; this desktop backend has no takeover, so no takeover happened`);
		}
		let report: DesktopFocusReturn | null | void;
		try {
			report = await nativeCall(context.signal, () => send(FALLBACK));
		} catch (rerun) {
			if (rerun instanceof ToolAbortError) throw rerun;
			const message = rerun instanceof Error ? rerun.message : String(rerun);
			// Keep the rerun's error code in front, as every computer error has it.
			const [, code, detail] = /^(\w+): ([\s\S]*)$/.exec(message) ?? [];
			const failed = code === undefined ? message : detail;
			throw new ToolError(
				`${code === undefined ? "" : `${code}: `}${method} fell back to takeover because ${why}, and the takeover failed: ${failed}`,
			);
		}
		const focus = await focusReport(session, context.signal, report, target);
		context.output.push({
			type: "text",
			text: `${method} ran in takeover because ${why}; the input was delivered, and ${focus}`,
		});
	}
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
	if (frame.screenLocked) result.screenLocked = true;
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
		const captured = frame.region
			? `zoom ${frame.target} ${dimensions}; region=${JSON.stringify(frame.region)}; ${coordinates}; use the base full screenshot coordinates for input, not zoom pixels → ${destination}`
			: `screenshot ${frame.target} ${dimensions}; ${coordinates} → ${destination}`;
		context.output.push({
			type: "text",
			text: frame.screenLocked ? `${captured}\n${SCREEN_LOCKED_CAPTURE_NOTE}` : captured,
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
		validateString(value, "setValue(value)");
		const context = this.#getContext();
		guardRun(context, "setValue");
		// Native chooses a popup's option by opening its menu and pressing the item.
		if (this.nativeRole === "AXPopUpButton")
			refuseControlMenu(this.#session, context, "setValue()", this.nativeRole, `element ${this.ref}`);
		return this.#input("setValue", `setValue ${this.ref}`, () => this.#session.axSetValue(this.ref, value));
	}

	async selectText(text: string, options?: AxSelectTextOptions): Promise<AxTextSelection> {
		const context = this.#getContext();
		guardRun(context, "selectText");
		validateString(text, "selectText(text)");
		return await nativeCall(context.signal, () => this.#session.axSelectText(this.ref, text, options));
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

	perform(action: string, options?: MenuOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "perform");
		validateString(action, "perform(action)", { nonEmpty: true });
		// The names native `axPerform` runs as `AXRaise` (its `action_name` mapping).
		if (action.trim().toLowerCase() === "raise" || action === "AXRaise") {
			refuseForeground(
				context,
				`perform(${JSON.stringify(action)})`,
				"bring the window's application to the front",
				RAISE_ROUTE,
				`element ${this.ref}`,
			);
		}
		// The names native `axPerform` runs as `AXOpen` (`action_name` prefixes "AX"
		// to any other name). On an item in Chrome's Open panel it brings the
		// panel's application to the front, even when the action fails, and it
		// stays there.
		if (this.#session.capabilities.backend === "quartz" && (action === "AXOpen" || action === "Open")) {
			refuseForeground(
				context,
				`perform(${JSON.stringify(action)})`,
				"bring the window's application to the front, as it can on an item in an Open panel even when the action fails",
				OPEN_ROUTE,
				`element ${this.ref}`,
			);
		}
		const menu = menuOption(options);
		// The names native `axPerform` runs as `AXShowMenu`, which opens the element's context menu.
		if (["showmenu", "show_menu"].includes(action.trim().toLowerCase()) || action === "AXShowMenu") {
			refuseMenu(
				this.#session,
				context,
				`perform(${JSON.stringify(action)})`,
				"a context menu",
				MENU_ROUTE,
				`element ${this.ref}`,
			);
		}
		if (menu !== undefined)
			refuseMenu(this.#session, context, "perform with menu", "a menu", MENU_ROUTE, `element ${this.ref}`);
		// The names native `axPerform` runs as `AXPress`.
		if (action.trim().toLowerCase() === "press" || action === "AXPress") {
			refuseControlMenu(
				this.#session,
				context,
				`perform(${JSON.stringify(action)})`,
				this.nativeRole,
				`element ${this.ref}`,
			);
		}
		return this.#input("perform", `perform ${this.ref} ${action}`, () =>
			this.#session.axPerform(this.ref, action, menu),
		);
	}

	/**
	 * Without a chord, the element's native press action, choosing `menu`'s item in the menu it opens;
	 * with one, that chord typed into the element.
	 */
	async press(chord?: string | string[] | MenuOptions, options?: InputOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "press");
		if (chord === undefined || isMenuOptions(chord)) {
			const menu = menuOption(chord);
			if (menu !== undefined)
				refuseMenu(this.#session, context, "press with menu", "a menu", MENU_ROUTE, `element ${this.ref}`);
			refuseControlMenu(this.#session, context, "press()", this.nativeRole, `element ${this.ref}`);
			await this.#input("press", `press ${this.ref}`, () => this.#session.axPerform(this.ref, "press", menu));
			return;
		}
		const keys = chordKeys(chord);
		const native = pointerOptions(options);
		await this.#input("press", `press ${this.ref} ${keys.join("+")}`, () =>
			sendInput(this.#session, context, "press", native.takeover, fallback =>
				this.#session.axKeyChord(this.ref, keys, { ...native, ...fallback }),
			),
		);
	}

	async type(text: string, options?: InputOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "type");
		validateString(text, "type(text)");
		const native = pointerOptions(options);
		await this.#input("type", `type ${this.ref}`, () =>
			sendInput(this.#session, context, "type", native.takeover, fallback =>
				this.#session.axType(this.ref, text, { ...native, ...fallback }),
			),
		);
	}

	async click(options?: ClickOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "click");
		const native = pointerOptions(options);
		refusePointerMenu(this.#session, context, "click", native, `element ${this.ref}`, this.nativeRole);
		refuseMenuPress(this.#session, context, native);
		await this.#input("click", `click ${this.ref}`, () =>
			sendInput(this.#session, context, "click", native.takeover, fallback =>
				this.#session.axClick(this.ref, { ...native, ...fallback }),
			),
		);
	}

	async doubleClick(options?: Omit<ClickOptions, "count">): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "doubleClick");
		const native = { ...pointerOptions(options), count: 2 };
		refusePointerMenu(this.#session, context, "doubleClick", native, `element ${this.ref}`, this.nativeRole);
		refuseMenuPress(this.#session, context, native);
		await this.#input("doubleClick", `doubleClick ${this.ref}`, () =>
			sendInput(this.#session, context, "doubleClick", native.takeover, fallback =>
				this.#session.axClick(this.ref, { ...native, ...fallback }),
			),
		);
	}

	async focus(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "focus");
		// macOS sets AXFocused inside the app without activating it; Windows
		// (UIA SetFocus) and Linux (AT-SPI grab_focus) move keyboard focus.
		if (this.#session.capabilities.backend !== "quartz") {
			refuseForeground(
				context,
				"focus()",
				"move the user's keyboard focus to this element",
				"Use setValue(), press() or another AX action, which need no focus.",
				`element ${this.ref}`,
			);
		}
		await this.#input("focus", `focus ${this.ref}`, () => this.#session.axFocus(this.ref));
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

const ELEMENT_FIELDS = ["ref", "role", "nativeRole", "title", "description", "enabled", "focused", "childCount"];

/** `find()`'s array answers element field reads and calls with how to pick one, instead of `undefined` or "is not a function". */
function foundElements(elements: El[]): El[] {
	const pickOne = (member: string): TypeError =>
		new TypeError(
			`find() returns an array (length ${elements.length}), not one element, so it has no ${member}; pick one first: const [el] = await win.find(query)`,
		);
	for (const method of Object.getOwnPropertyNames(El.prototype)) {
		if (method === "constructor") continue;
		Object.defineProperty(elements, method, {
			value: () => {
				throw pickOne(`${method}()`);
			},
		});
	}
	for (const field of ELEMENT_FIELDS) {
		Object.defineProperty(elements, field, {
			get: () => {
				throw pickOne(field);
			},
		});
	}
	return elements;
}

/** `await ref("e5")` resolves the element; its methods chain on the handle and await the lookup first. */
class ElRef implements PromiseLike<El> {
	readonly ref: string;
	readonly #getContext: RunContextAccessor;
	readonly #lookup: () => Promise<El>;
	#element?: Promise<El>;

	constructor(ref: string, getContext: RunContextAccessor, lookup: () => Promise<El>) {
		this.ref = ref;
		this.#getContext = getContext;
		this.#lookup = lookup;
	}

	#resolve(): Promise<El> {
		this.#element ??= this.#lookup();
		return this.#element;
	}

	// oxlint-disable-next-line unicorn/no-thenable -- the handle is awaitable by design: `await ref("e5")` resolves the element.
	then<A = El, B = never>(
		onFulfilled?: ((element: El) => A | PromiseLike<A>) | null,
		onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
	): Promise<A | B> {
		return this.#resolve().then(onFulfilled, onRejected);
	}

	catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<El | B> {
		return this.#resolve().catch(onRejected);
	}

	finally(onFinally?: (() => void) | null): Promise<El> {
		return this.#resolve().finally(onFinally);
	}

	async value(): Promise<string | undefined> {
		return (await this.#resolve()).value();
	}

	async setValue(value: string): Promise<void> {
		// Reject a read-only run or a bad argument before the ref lookup reaches the native addon.
		guardRun(this.#getContext(), "setValue");
		validateString(value, "setValue(value)");
		await (await this.#resolve()).setValue(value);
	}

	async selectText(text: string, options?: AxSelectTextOptions): Promise<AxTextSelection> {
		guardRun(this.#getContext(), "selectText");
		validateString(text, "selectText(text)");
		return (await this.#resolve()).selectText(text, options);
	}

	async bounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
		return (await this.#resolve()).bounds();
	}

	async attributes(): Promise<Record<string, string>> {
		return (await this.#resolve()).attributes();
	}

	async actions(): Promise<string[]> {
		return (await this.#resolve()).actions();
	}

	async perform(action: string, options?: MenuOptions): Promise<void> {
		guardRun(this.#getContext(), "perform");
		validateString(action, "perform(action)", { nonEmpty: true });
		await (await this.#resolve()).perform(action, options);
	}

	async press(chord?: string | string[] | MenuOptions, options?: InputOptions): Promise<void> {
		guardRun(this.#getContext(), "press");
		if (chord !== undefined && !isMenuOptions(chord)) chordKeys(chord);
		await (await this.#resolve()).press(chord, options);
	}

	async type(text: string, options?: InputOptions): Promise<void> {
		guardRun(this.#getContext(), "type");
		validateString(text, "type(text)");
		await (await this.#resolve()).type(text, options);
	}

	async click(options?: ClickOptions): Promise<void> {
		await (await this.#resolve()).click(options);
	}

	async doubleClick(options?: Omit<ClickOptions, "count">): Promise<void> {
		await (await this.#resolve()).doubleClick(options);
	}

	async focus(): Promise<void> {
		await (await this.#resolve()).focus();
	}

	async parent(): Promise<El | null> {
		return (await this.#resolve()).parent();
	}

	async children(): Promise<El[]> {
		return (await this.#resolve()).children();
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

	/** Refuses root input under the user's background-only policy before dispatch. */
	#guardInput(method: string): ComputerRunContext {
		const context = this.#getContext();
		guardRun(context, method);
		if (this.id === DESKTOP_TARGET || this.id.startsWith("display:")) {
			refuseForeground(
				context,
				`${method} on the ${this.id} target`,
				"drive the user's own pointer and keyboard",
				"Send it to a window handle from computer.window(...), which takes input in the background.",
			);
		}
		return context;
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
		const context = this.#guardInput(method);
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
		const context = this.#guardInput("click");
		const native = pointerOptions(options);
		refusePointerMenu(this.#session, context, "click", native, `window ${this.id}`);
		refuseMenuPress(this.#session, context, native);
		return this.#input(
			"click",
			`click ${x},${y}`,
			() =>
				sendInput(
					this.#session,
					context,
					"click",
					native.takeover,
					fallback => this.#session.click(this.id, x, y, { ...native, ...fallback }),
					this.pid,
				),
			{ x, y },
		);
	}

	doubleClick(x: number, y: number, options?: Omit<ClickOptions, "count">): Promise<void> {
		const context = this.#guardInput("doubleClick");
		const native = { ...pointerOptions(options), count: 2 };
		refusePointerMenu(this.#session, context, "doubleClick", native, `window ${this.id}`);
		refuseMenuPress(this.#session, context, native);
		return this.#input(
			"doubleClick",
			`doubleClick ${x},${y}`,
			() =>
				sendInput(
					this.#session,
					context,
					"doubleClick",
					native.takeover,
					fallback => this.#session.click(this.id, x, y, { ...native, ...fallback }),
					this.pid,
				),
			{ x, y },
		);
	}

	move(x: number, y: number, options?: InputOptions): Promise<void> {
		const context = this.#guardInput("move");
		const native = pointerOptions(options);
		return this.#input(
			"move",
			`move ${x},${y}`,
			() =>
				sendInput(
					this.#session,
					context,
					"move",
					native.takeover,
					fallback => this.#session.moveMouse(this.id, x, y, { ...native, ...fallback }),
					this.pid,
				),
			{ x, y },
		);
	}

	drag(points: Array<[number, number]>, options?: DragOptions): Promise<void> {
		const context = this.#guardInput("drag");
		const native = pointerOptions(options);
		refusePointerMenu(this.#session, context, "drag", native, `window ${this.id}`);
		refuseMenuPress(this.#session, context, native);
		const [start] = points;
		return this.#input(
			"drag",
			"drag",
			() =>
				sendInput(
					this.#session,
					context,
					"drag",
					native.takeover,
					fallback =>
						this.#session.drag(
							this.id,
							points.map(([x, y]) => ({ x, y })),
							{ ...native, ...fallback },
						),
					this.pid,
				),
			start && { x: start[0], y: start[1] },
		);
	}

	scroll(x: number, y: number, options: ScrollOptions = {}): Promise<void> {
		const context = this.#guardInput("scroll");
		const native = pointerOptions(options);
		const dx = options.dx ?? 0;
		const dy = options.dy ?? 0;
		return this.#input(
			"scroll",
			`scroll ${x},${y}`,
			() =>
				sendInput(
					this.#session,
					context,
					"scroll",
					native.takeover,
					fallback => this.#session.scroll(this.id, x, y, dx, dy, { ...native, ...fallback }),
					this.pid,
				),
			{ x, y },
		);
	}

	type(text: string, options?: InputOptions): Promise<void> {
		const context = this.#guardInput("type");
		validateString(text, "type(text)");
		const shown = text.length > 24 ? `${text.slice(0, 23)}…` : text;
		const native = pointerOptions(options);
		return this.#input("type", `type ${JSON.stringify(shown)}`, () =>
			sendInput(
				this.#session,
				context,
				"type",
				native.takeover,
				fallback => this.#session.typeText(this.id, text, { ...native, ...fallback }),
				this.pid,
			),
		);
	}

	press(chord: string | string[], options?: InputOptions): Promise<void> {
		const context = this.#guardInput("press");
		const keys = chordKeys(chord);
		const native = pointerOptions(options);
		return this.#input("press", `press ${keys.join("+")}`, () =>
			sendInput(
				this.#session,
				context,
				"press",
				native.takeover,
				fallback => this.#session.keyChord(this.id, keys, { ...native, ...fallback }),
				this.pid,
			),
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
		const context = this.#guardInput("holdKeys");
		// One read of each option, so the `refuse` check and the native call agree.
		const { duration, takeover } = { ...options };
		validateHold({ duration, takeover });
		validateKeys(keys, "keys");
		await sendInput(
			this.#session,
			context,
			"holdKeys",
			takeover,
			fallback => this.#session.holdKeys(this.id, keys, { duration, takeover, ...fallback }),
			this.pid,
		);
	}

	async holdMouse(x: number, y: number, options: HoldMouseOptions): Promise<void> {
		const context = this.#guardInput("holdMouse");
		const { duration, button, keys, takeover } = { ...options };
		validateHold({ duration, takeover });
		if (keys !== undefined) validateKeys(keys, "keys");
		refusePointerMenu(this.#session, context, "holdMouse", { button, keys }, `window ${this.id}`);
		const native: NativeHoldOptions = { duration, button, keys, takeover };
		refuseMenuPress(this.#session, context, native);
		await sendInput(
			this.#session,
			context,
			"holdMouse",
			takeover,
			fallback => this.#session.holdMouse(this.id, x, y, { ...native, ...fallback }),
			this.pid,
		);
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
			items: async (...path: string[] | [path?: string | string[]]): Promise<MenuItem[]> => {
				const context = this.#getContext();
				// On macOS the read makes the window key first, so it is not inspection-only.
				guardRun(context, "menu.items");
				// An omitted path, or one passed on as `undefined`, lists the top-level menus.
				const segments =
					path.length <= 1 && path[0] === undefined
						? undefined
						: menuPath("menu.items", path, { allowEmpty: true });
				return await nativeCall(context.signal, () => this.#session.menuItems(this.id, segments));
			},
			select: async (...path: [string, ...string[]] | [string[]]): Promise<void> => {
				const context = this.#getContext();
				guardRun(context, "menu.select");
				const segments = menuPath("menu.select", path);
				await nativeCall(context.signal, () => this.#session.menuSelect(this.id, segments));
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
		refuseForeground(
			context,
			"raise()",
			"bring the window's application to the front",
			RAISE_ROUTE,
			`window ${this.id}`,
		);
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
		return foundElements(
			(await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map(node =>
				this.#observer.element(this.#getContext, node, window),
			),
		);
	}

	ref(ref: string): ElRef {
		validateString(ref, "ref(ref)", { nonEmpty: true });
		return new ElRef(ref, this.#getContext, async () => {
			const node = await this.#observer.read(this.#getContext().signal, ref, `ref ${ref}`, () =>
				this.#session.axNode(ref),
			);
			return this.#observer.element(this.#getContext, node, this.#observer.windowOf(ref));
		});
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
	/** `#session` as the desktop scope sees it, checking for the user's Escape on every access. */
	#guarded?: NativeDesktopSession;
	/** Settles when this worker's latest `clipboard.write` finished. */
	#clipboardWrite: Promise<void> = Promise.resolve();
	/**
	 * Per-run context, carried through AsyncLocalStorage so async work leaked
	 * from an ended run (timers, dangling promises) keeps that run's aborted
	 * context instead of borrowing the next run's signal and read-only policy.
	 */
	readonly #runContexts = new AsyncLocalStorage<ComputerRunContext>();
	/** Requests wait for the active run; each caller's host deadline bounds its wait. */
	#queue: Array<{ message: Extract<ComputerWorkerInbound, { type: "run" | "settle" }>; ac: AbortController }> = [];
	/** The cell the active request belongs to; `discard` matches against it. */
	#activeCellId: string | undefined;
	#closed = false;
	/** The latest agent turn whose end was sent here; a run of that turn or earlier, arriving late, holds nothing. */
	#releasedTurn = 0;

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
				if (this.#active) this.#queue.push({ message, ac: new AbortController() });
				else void this.#run(message);
				return;
			case "capabilities":
				void this.#capabilities(message);
				return;
			case "abort": {
				if (this.#active?.id === message.id) {
					this.#active.ac.abort(new ToolAbortError());
					return;
				}
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
			case "release-display":
				this.#releasedTurn = Math.max(this.#releasedTurn, message.turn);
				this.#session?.releaseDisplayAwake();
				return;
			case "resume-display":
				if (this.#active?.displayTurn !== message.from) return;
				this.#active.displayTurn = message.turn;
				this.#session?.holdDisplayUntilReleased();
				return;
			case "tool-reply":
				this.#deliverToolReply(message.id, message.reply);
				return;
			case "close":
				void this.#close();
		}
	}

	/** Returns the raw session; the desktop scope gets `#guarded`, which checks for the user's Escape on every access. */
	async #ensureSession(
		snapshot: ComputerSessionSnapshot,
		escape?: ComputerEscapeScope,
	): Promise<NativeDesktopSession> {
		if (this.#session) return this.#session;
		// Single-flight: share one creation promise so a run and a capabilities
		// request racing on a cold worker cannot each build (and leak) a session.
		this.#sessionInit ??= (async () => {
			try {
				// The worker must answer its readiness handshake without loading the native
				// addon; normal CLI startup and selector pings never execute desktop code.
				const createSession =
					this.#createSession ?? (await import("@oh-my-pi/pi-natives/desktop")).createDesktopSession;
				const session = await createSession({ display: snapshot.display, escapeStopKey: escape?.key });
				const guarded = this.#guard(session);
				this.#session = session;
				this.#guarded = guarded;
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
		const deadline = performance.now() + message.timeoutMs;
		const ac = queued ?? new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const cellId = this.#cellIdOf(message);
		const escape = message.type === "run" ? message.escape : undefined;
		const active: ActiveRun = {
			id: message.id,
			acknowledgedEscapeStops: escape?.acknowledged ?? 0,
			ac,
			signal,
			pendingTools: new Map(),
			displayTurn: message.session.displayTurn,
		};
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
			confirmControl: reason =>
				this.#confirmControl(active, reason, deadline - Math.min(CONTROL_ANSWER_RESERVE_MS, message.timeoutMs / 4)),
		};
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let completed = false;
		try {
			throwIfAborted(signal);
			await this.#ensureSession(message.session, escape);
			const session = this.#guarded!;
			throwIfAborted(signal);
			// An Escape after the host's check still ends the run before the script starts.
			this.#checkEscape();
			session.setRunDeadline(deadline - performance.now());
			const { displayTurn } = active;
			if (displayTurn !== undefined && displayTurn > this.#releasedTurn) session.holdDisplayUntilReleased();
			// Revoke a grant acquired before the user chose background-only input.
			if (message.session.backgroundFallback === "refuse" && session.controlState().active) session.releaseControl();
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
				// The user's Escape ends the run with its own message, not as a bare abort, so the host reports it
				// even when the user's next message already lifted the stop.
				const abortError =
					signal.reason === active.escapeStop || signal.reason instanceof ToolAbortError
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
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: false,
				error: this.#withScreenState(errorPayload(failure.error)),
			});
			return;
		}
		if (completed) {
			let capabilities: DesktopCapabilities;
			try {
				capabilities = (await this.#ensureSession(message.session, escape)).capabilities;
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

	#drain(): void {
		const next = this.#queue.shift();
		if (next) void this.#run(next.message, next.ac);
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
	 * The user's physical Escape ends the active run for good: the run is
	 * aborted and this access refused, so a script that catches the cancelled
	 * operation sends nothing more.
	 */
	#checkEscape(cause?: unknown, notice = ESCAPE_STOPPED_MESSAGE): void {
		const active = this.#active;
		if (!active || !this.#session || this.#session.escapeStops <= active.acknowledgedEscapeStops) return;
		if (active.escapeStop) throw active.escapeStop;
		// What the stopped operation reported (a key left held, the user's app not handed back) stays first.
		const stopped = new ToolError(cause === undefined ? notice : `${nativeError(cause).message}\n\n${notice}`);
		active.escapeStop = stopped;
		active.ac.abort(stopped);
		throw stopped;
	}

	/** Checks for the user's Escape before every access to the session and again when each native promise settles. */
	#guard(session: NativeDesktopSession): NativeDesktopSession {
		return new Proxy(session, {
			get: (target, property) => {
				this.#checkEscape();
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]): unknown => {
					this.#checkEscape();
					const result = Reflect.apply(value, target, args);
					if (!(result instanceof Promise)) return result;
					return result.then(
						settled => {
							// The call finished and its input went out; the stop ends the run after it.
							this.#checkEscape(undefined, ESCAPE_AFTER_CALL_MESSAGE);
							return settled;
						},
						error => {
							this.#checkEscape(error);
							throw error;
						},
					);
				};
			},
		});
	}

	/**
	 * A run that fails while the macOS screen is locked or the display asleep
	 * says so after its own message, which stays first and intact. Aborts and
	 * sessions that never started are returned unchanged. The state is read
	 * without queuing, since the failure may be a native request that hangs.
	 */
	#withScreenState(payload: RunErrorPayload): RunErrorPayload {
		if (payload.isAbort || !this.#session) return payload;
		const notice = screenStateNotice(this.#session.screenState);
		if (!notice) return payload;
		const message = payload.message ? `${payload.message}\n${notice}` : notice;
		const stack =
			payload.stack && payload.message ? payload.stack.replace(payload.message, () => message) : payload.stack;
		return { ...payload, message, stack };
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
			const session = await this.#ensureSession(message.session, message.escape);
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
				// A bridged tool acts outside the desktop session, so the user's Escape is checked here too.
				this.#checkEscape();
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

	async #confirmControl(active: ActiveRun, reason: string, answerDeadline: number): Promise<ControlVerdict> {
		throwIfAborted(active.signal);
		const id = `computer-control-${active.id}-${crypto.randomUUID()}`;
		const pending = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, pending);
		const timeoutMs = Math.max(0, Math.floor(answerDeadline - performance.now()));
		this.#transport.send({ type: "control-request", id, runId: active.id, reason, timeoutMs });
		const verdict = await pending.promise;
		return verdict === "approved" || verdict === "no-ui" || verdict === "unanswered" ? verdict : "denied";
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const pending = this.#active?.pendingTools.get(id);
		if (!pending) return;
		this.#active?.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	/** Every desktop facade operation starts here, so the user's Escape stops clipboard and other non-native work too. */
	#currentRunContext = (): ComputerRunContext => {
		const context = this.#runContexts.getStore();
		if (!context) throw new ToolError("no active computer run");
		this.#checkEscape();
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
				open: async (
					id: string,
					options?: ApplicationOpenOptions,
				): Promise<Application & { window: Win | null }> => {
					const context = getContext();
					guardRun(context, "apps.open");
					validateString(id, "apps.open(id)", { nonEmpty: true });
					// One read of each option, so the `refuse` check and the native call agree.
					const open = { ...options };
					if (open.activate === true) {
						refuseForeground(
							context,
							"apps.open with activate: true",
							"bring the application to the front",
							"Call apps.open without activate, which opens the application behind the user's.",
						);
					}
					if (open.reveal === true) {
						refuseForeground(
							context,
							"apps.open with reveal: true",
							"bring Finder to the front",
							"Open the containing folder with apps.open(folder) instead, which opens it behind the user's app.",
						);
					}
					// A relative path names an item in the session's folder, not the omp process's.
					const listed = async (value: string): Promise<boolean> =>
						(await nativeCall(context.signal, () => session.listApplications())).some(
							app => app.id === value || app.path === value,
						);
					const cwd = context.snapshot.cwd;
					const target = await sessionPath(id, cwd, listed);
					if (typeof open.app === "string") open.app = await sessionPath(open.app, cwd, listed);
					const { window: shown, ...application } = await nativeCall(context.signal, () =>
						session.openApplication(target, open),
					);
					return { ...application, window: shown ? makeWin(shown) : null };
				},
			},
			control: {
				acquire: async (options: {
					reason: string;
				}): Promise<{ active: boolean; reason?: Exclude<ControlVerdict, "approved"> }> => {
					const context = getContext();
					guardRun(context, "control.acquire");
					refuseForeground(
						context,
						"control.acquire",
						"hand the agent foreground control of the desktop",
						"Window input needs no control; it runs in the background.",
					);
					strictObject(options, ["reason"], "control.acquire");
					if (typeof options.reason !== "string" || !options.reason.trim())
						throw new ToolError("control.acquire requires a non-empty reason");
					if (session.controlState().active) return { active: true };
					const verdict = await context.confirmControl(options.reason);
					throwIfAborted(context.signal);
					if (verdict !== "approved") return { active: false, reason: verdict };
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
				return (await nativeCall(signal, () => session.listWindows()))
					.filter(window => matchesFilter(window, filter))
					.slice(0, MAX_LISTED_WINDOWS);
			},
			window: async (selector: string | number | WindowFilter): Promise<Win> => {
				const { signal } = getContext();
				const id = typeof selector === "string" || typeof selector === "number" ? String(selector) : undefined;
				const wait = typeof selector === "object" && selector !== null ? windowWait(selector.wait) : 0;
				// Monotonic, like the run deadline: a wall-clock step must not end or stretch the wait.
				const deadline = performance.now() + wait;
				let windows: DesktopWindow[];
				let matches: DesktopWindow[];
				for (;;) {
					windows = await nativeCall(signal, () => session.listWindows());
					matches = windows.filter(window =>
						id !== undefined ? window.id === id : matchesFilter(window, selector as WindowFilter),
					);
					// The last interval sleeps only what is left, so the final listing lands at the deadline.
					const remaining = deadline - performance.now();
					if (matches.length > 0 || remaining <= 0) break;
					await waitForRun(Math.min(WINDOW_WAIT_INTERVAL_MS, remaining), signal);
				}
				// Untyped scripts may pass nothing or `null`, which `matchesFilter` accepts as no filter: a desktop with one
				// window returns it, and otherwise the error names the missing selector.
				const unfiltered =
					selector == null
						? "computer.window() without an id or { app, title } filter matches every open window"
						: "";
				if (matches.length === 0) {
					const app = typeof selector === "object" ? selector?.app : undefined;
					const route = session.capabilities.backend === "quartz" ? "shows-window" : "launches";
					const lead = unfiltered
						? `${unfiltered}, and none is open`
						: `no window matches ${JSON.stringify(selector)}`;
					throw new ToolError(`${lead}\n${describeWindowMiss(windows, app, route)}`);
				}
				if (matches.length > 1) {
					const candidates = matches
						.slice(0, MAX_LISTED_WINDOWS)
						.map(window => `${window.id} ${window.app} ${JSON.stringify(window.title)}`)
						.join("\n");
					const omitted = matches.length - MAX_LISTED_WINDOWS;
					const more = omitted > 0 ? `\n… ${omitted} more` : "";
					const lead = unfiltered
						? `${unfiltered}; pass a window id or filter to pick one`
						: `multiple windows match ${JSON.stringify(selector)}`;
					throw new ToolError(`${lead}:\n${candidates}${more}`);
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
			ref: (ref: string): ElRef => {
				validateString(ref, "ref(ref)", { nonEmpty: true });
				return new ElRef(ref, getContext, async () => {
					const node = await observer.read(getContext().signal, ref, `ref ${ref}`, () => session.axNode(ref));
					return observer.element(getContext, node, observer.windowOf(ref));
				});
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
					validateString(text, "clipboard.write(text)");
					// Clipboard access is part of the native desktop surface and remains
					// outside the worker's readiness-only import graph.
					const { copyToClipboard } = await import("../../utils/clipboard");
					// `copyToClipboard` queues behind the previous write; wait out this worker's own writes
					// first, so the Escape check below is the last step before this one starts.
					const previous = this.#clipboardWrite;
					const { promise, resolve } = Promise.withResolvers<void>();
					this.#clipboardWrite = promise;
					try {
						await previous;
						guardRun(getContext(), "clipboard.write");
						await copyToClipboard(text);
					} finally {
						resolve();
					}
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
			this.#guarded = undefined;
			this.#sessionInit = undefined;
			this.#unsubscribe();
			this.#transport.send({ type: "closed" });
			this.#transport.close();
		}
	}
}
