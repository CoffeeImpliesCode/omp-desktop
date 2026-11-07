/**
 * What the model last saw of each window, and what a cell's input touched
 * since, so the cell can end with the state its input left behind.
 *
 * Every mutating helper returns nothing, so after an action the model spent a
 * whole call reading the window back, and after a refused action it spent one
 * re-reading the tree its refs came from. The ledger records the inputs a cell
 * sends; when the cell settles the worker re-reads each window they touched
 * and prints that tree once, marked against the tree the model last received.
 *
 * Tree text is the native `ax()` grammar (`crates/pi-natives/src/desktop/ax.rs`
 * `format_tree`): one node per line, two spaces of indent per depth, then
 * `- role "label" [ref=eN] …`.
 */
import type { DesktopDisplay, DesktopWindow, DiffRun } from "@oh-my-pi/pi-natives";
import { elideAxTree } from "./tree-elide";

/**
 * `"42" Code "main.ts"`: the id JSON-quoted, as `window()` takes it (ids are
 * opaque strings, not always digits), then app and title.
 */
function windowLabel(window: DesktopWindow): string {
	return `${JSON.stringify(window.id)} ${window.app} ${JSON.stringify(window.title)}`;
}

/** Options of the `ax()` read a window's baseline came from; re-reads reuse them so trees compare. */
export interface AxReadOptions {
	all?: boolean;
	maxDepth?: number;
}

/** A window an input addressed, as far as the worker knows it. */
export interface InputWindow {
	id: string;
	pid?: number;
}

/** One window a settling cell sent input to. */
export interface TouchedWindow {
	id: string;
	/** Inputs sent to the window, in order: `press e5`, `type "abc"`. */
	labels: string[];
	/** The last failed call on the window, with its error; its refs need renewing. */
	failure?: string;
	/** Tree the model last received for this window, if any. */
	baseline?: string;
	/** Options of that read. */
	options: AxReadOptions;
	/** The model works this window from pixels, so its report repeats a screenshot. */
	screenshot: boolean;
}

/**
 * How an input addressed its target. Pixel input, or a screenshot the model
 * was shown, puts a window in pixel mode: its report repeats a frame. An
 * element action in a cell that neither sent pixel input to the window nor
 * showed the model a screenshot of it takes the window out again. Keys and
 * window/workspace/display mutations leave the mode as they found it. A
 * silent capture is no evidence: nothing was shown.
 */
export type InputKind = "pixel" | "element" | "key" | "control";

/** Pseudo-window that holds the pixel mode of desktop-root input. */
export const DESKTOP_WINDOW_ID = "desktop";

/**
 * Bytes one window's tree may take in a cell's report. Larger trees are
 * elided structurally, dropping unmarked subtrees without controls first, so
 * the rows the input changed survive.
 */
export const REPORT_TREE_BUDGET_BYTES = 16 * 1024;

/** Everything one cell's input left for the settle to report. */
export interface PendingSettle {
	/** Windows whose post-input state the model has not read. */
	touched: TouchedWindow[];
	/** Processes the cell sent window input to; their new windows are reported. */
	pids: Set<number>;
	/**
	 * Inputs whose window is unknown (the roster could not be read, or no
	 * single listed window was under the pointer). They are shown on the
	 * focused window, whose report carries them; a failure among them is the
	 * last entry. With nothing focused, `unattributed` names them on their own.
	 */
	unattributed: string[];
	/** The cell worked the desktop root from pixels, so the report adds a desktop screenshot. */
	desktopScreenshot: boolean;
	/** Roster captured before the cell's first input; absent when it could not be read. */
	rosterBefore?: DesktopWindow[];
	/** When the last input returned (ms since epoch). */
	lastInputAt: number;
}

interface WindowRecord {
	pid?: number;
	/** Tree text the model last received. */
	shown?: string;
	options: AxReadOptions;
	/** Pixel mode (see `InputKind`). */
	pixels: boolean;
}

/** Most refs remembered for mapping an element back to its window. */
const MAX_REFS = 20_000;
const ROW = /^((?: {2})*)[-+~] (\S+)/;
const REF = /^ \[ref=(e\d+)\]/;

/** Row structure of one tree line: where its ref token sits. */
interface ParsedRow {
	indent: number;
	role: string;
	/** Ref token span `[start, end)`, including its leading space. */
	refStart: number;
	refEnd: number;
	ref: string;
}

/** Index just past a quoted, backslash-escaped string starting at `from`, or -1. */
function quotedEnd(line: string, from: number): number {
	for (let index = from + 1; index < line.length; index++) {
		const char = line[index];
		if (char === "\\") index++;
		else if (char === '"') return index + 1;
	}
	return -1;
}

/** Parse a tree row; non-row lines (trailers, headers) return undefined. */
export function parseTreeRow(line: string): ParsedRow | undefined {
	const match = ROW.exec(line);
	if (!match) return undefined;
	let position = match[0].length;
	if (line.startsWith(' "', position)) {
		const end = quotedEnd(line, position + 1);
		if (end < 0) return undefined;
		position = end;
	}
	const ref = REF.exec(line.slice(position));
	if (!ref) return undefined;
	return {
		indent: match[1].length,
		role: match[2],
		refStart: position,
		refEnd: position + ref[0].length,
		ref: ref[1],
	};
}

/** Every ref a tree text names. */
export function treeRefs(text: string): string[] {
	const refs: string[] = [];
	for (const line of text.split("\n")) {
		const row = parseTreeRow(line);
		if (row) refs.push(row.ref);
	}
	return refs;
}

/** Whether the cell's output carries this tree: every ref it names, or the whole text when it names none. */
function printedIn(printedRefs: ReadonlySet<string>, output: string, text: string): boolean {
	const refs = treeRefs(text);
	return refs.length > 0 ? refs.every(ref => printedRefs.has(ref)) : output.includes(text);
}

/**
 * A desktop-root pointer position (pixels of the latest desktop screenshot) in
 * desktop coordinates, through the display regions that screenshot reported;
 * undefined when it falls outside them. Native pointer input maps it the same way.
 */
export function desktopPoint(
	displays: readonly DesktopDisplay[],
	point: { x: number; y: number },
): { x: number; y: number } | undefined {
	const display = displays.find(
		candidate =>
			point.x >= candidate.pixelX &&
			point.x < candidate.pixelX + candidate.pixelWidth &&
			point.y >= candidate.pixelY &&
			point.y < candidate.pixelY + candidate.pixelHeight,
	);
	if (!display) return undefined;
	return {
		x: display.x + ((point.x - display.pixelX) * display.width) / display.pixelWidth,
		y: display.y + ((point.y - display.pixelY) * display.height) / display.pixelHeight,
	};
}

/** Whether a window can be placed at a global desktop point at all. */
function placeable(window: DesktopWindow): boolean {
	return window.positionKnown !== false;
}

/** Whether a window's rectangle contains a desktop point. */
function covers(window: DesktopWindow, point: { x: number; y: number }): boolean {
	return (
		point.x >= window.x &&
		point.x < window.x + window.width &&
		point.y >= window.y &&
		point.y < window.y + window.height
	);
}

/**
 * The window a desktop point lies in, when exactly one listed window contains
 * it. Native window lists promise no stacking order, and a window covering a
 * whole display is an ordinary target (a maximized or fullscreen app), so
 * neither can pick a winner: several candidates stay unattributed rather than
 * guessed at. Windows the platform cannot place in global coordinates are
 * never candidates.
 */
export function windowAt(
	windows: readonly DesktopWindow[],
	point: { x: number; y: number },
): DesktopWindow | undefined {
	const candidates = windows.filter(window => placeable(window) && covers(window, point));
	return candidates.length === 1 ? candidates[0] : undefined;
}

/** A tree line without its ref: what stays equal when a re-read renews refs. */
function withoutRef(line: string): string {
	const row = parseTreeRow(line);
	return row ? line.slice(0, row.refStart) + line.slice(row.refEnd) : line;
}

/**
 * Native object descriptions an AX value can print (`<AXUIElement 0x6000…>`,
 * `<__NSCFNumber 0x…>`): their addresses change on every read without the
 * window changing.
 */
const OBJECT_ADDRESS = /(<(?:AX|CF|NS|__NS)\w*[^<>]*?)0x[0-9a-f]+/gi;

/** A tree line as compared across reads: without its ref or native object addresses. */
function comparable(line: string): string {
	return withoutRef(line).replace(OBJECT_ADDRESS, "$10x…");
}

/** A row as a short reader-facing descriptor: `button "Edit"`, `textfield: "x"`. */
function describeRow(line: string): string {
	const described = withoutRef(line).trimStart().slice(2);
	return described.length > 80 ? `${described.slice(0, 79)}…` : described;
}

/** How a re-read differs from the tree the model last saw. */
export interface TreeChange {
	/** The new tree, rows marked `+` (added) or `~` (changed, with what it was). */
	text: string;
	added: number;
	changed: number;
	/** Descriptors of rows the new tree no longer has. */
	removed: string[];
}

/**
 * Mark `after` against `before`. Refs are ignored: every read renews them. A
 * removed row and an added row of the same depth and role inside one change
 * are one row that changed.
 */
export function diffTree(
	before: string,
	after: string,
	diffLineRuns: (oldText: string, newText: string) => DiffRun[],
): TreeChange {
	const oldLines = before.split("\n");
	const newLines = after.split("\n");
	const runs = diffLineRuns(oldLines.map(comparable).join("\n"), newLines.map(comparable).join("\n"));
	const out: string[] = [];
	const removed: string[] = [];
	let added = 0;
	let changed = 0;
	let oldIndex = 0;
	let newIndex = 0;
	// Removed rows of the current change, waiting for an added row to pair with.
	let pending: string[] = [];
	const flush = (): void => {
		for (const line of pending) if (parseTreeRow(line)) removed.push(describeRow(line));
		pending = [];
	};
	for (const run of runs) {
		if (run.removed) {
			pending.push(...oldLines.slice(oldIndex, oldIndex + run.count));
			oldIndex += run.count;
			continue;
		}
		if (!run.added) {
			flush();
			out.push(...newLines.slice(newIndex, newIndex + run.count));
			oldIndex += run.count;
			newIndex += run.count;
			continue;
		}
		for (const line of newLines.slice(newIndex, newIndex + run.count)) {
			const row = parseTreeRow(line);
			if (!row) {
				out.push(line);
				continue;
			}
			const pair = pending.findIndex(candidate => {
				const old = parseTreeRow(candidate);
				return old !== undefined && old.indent === row.indent && old.role === row.role;
			});
			if (pair >= 0) {
				const [old] = pending.splice(pair, 1);
				out.push(`${line.slice(0, row.indent)}~${line.slice(row.indent + 1)} (was: ${describeRow(old!)})`);
				changed++;
			} else {
				out.push(`${line.slice(0, row.indent)}+${line.slice(row.indent + 1)}`);
				added++;
			}
		}
		newIndex += run.count;
	}
	flush();
	return { text: out.join("\n"), added, changed, removed };
}

/** What one cell left behind before its settle: its inputs, reads and captures. */
interface CellPending {
	/** Windows input or a failure touched, `sequence` ordering them against reads. */
	touched: Map<string, { labels: string[]; failure?: string; sequence: number }>;
	/** `ax()` reads the cell made, latest per window; they count as shown once its output carries them. */
	reads: Map<string, { window: InputWindow; text: string; options: AxReadOptions; sequence: number }>;
	/** Processes the cell sent window input to; their new windows are reported. */
	pids: Set<number>;
	unattributed: string[];
	inputs: number;
	/** Whether an input went to the desktop root. */
	rootInput: boolean;
	/** Targets this cell showed a screenshot of, or sent pixel input to. */
	pixelsThisCell: Set<string>;
	rosterBefore?: DesktopWindow[];
	rosterClaimed: boolean;
	/** When the cell's last input returned (ms since epoch). */
	lastInputAt: number;
}

/**
 * Per-session record of what the model saw, and what each cell touched since.
 *
 * The seen state (trees, refs, pixel mode) is the session's: one window is one
 * window. The pending state belongs to the cell that produced it, keyed by the
 * opaque cell identity that travels with its run and its settle, so two cells
 * that overlap — or a cell whose turn was cancelled and never settles — cannot
 * drain each other's input.
 */
export class ObservationLedger {
	readonly #windows = new Map<string, WindowRecord>();
	/** Ref → window id, for elements resolved without their window. Oldest first. */
	readonly #refs = new Map<string, string>();
	/** Pending state per cell, created by its first input or read. */
	readonly #cells = new Map<string, CellPending>();
	/** Orders inputs and reads across the whole session, so a cell's own order still holds. */
	#sequence = 0;

	#record(id: string): WindowRecord {
		let record = this.#windows.get(id);
		if (!record) this.#windows.set(id, (record = { options: {}, pixels: false }));
		return record;
	}

	#cell(cellId: string): CellPending {
		let cell = this.#cells.get(cellId);
		if (!cell) {
			this.#cells.set(
				cellId,
				(cell = {
					touched: new Map(),
					reads: new Map(),
					pids: new Set(),
					unattributed: [],
					inputs: 0,
					rootInput: false,
					pixelsThisCell: new Set(),
					rosterClaimed: false,
					lastInputAt: 0,
				}),
			);
		}
		return cell;
	}

	/** Remember which window these refs belong to. */
	recordRefs(windowId: string, refs: Iterable<string>): void {
		for (const ref of refs) {
			this.#refs.delete(ref);
			this.#refs.set(ref, windowId);
		}
		for (const ref of this.#refs.keys()) {
			if (this.#refs.size <= MAX_REFS) break;
			this.#refs.delete(ref);
		}
	}

	/** The window a ref was read from, when the session read it. */
	windowOf(ref: string): InputWindow | undefined {
		const id = this.#refs.get(ref);
		return id === undefined ? undefined : { id, pid: this.#windows.get(id)?.pid };
	}

	/**
	 * The model received this tree of the window: it is the baseline the next
	 * read-back is marked against, and the window's post-input state is known.
	 */
	recordShown(cellId: string, window: InputWindow, text: string, options: AxReadOptions): void {
		const record = this.#record(window.id);
		if (window.pid !== undefined) record.pid = window.pid;
		record.shown = text;
		record.options = { ...options };
		this.recordRefs(window.id, treeRefs(text));
		this.#cells.get(cellId)?.touched.delete(window.id);
	}

	/**
	 * The cell's code read this tree of the window. Its refs map to the window
	 * at once; it becomes what the model saw only if the cell's output carries
	 * it (see `take`), since code can read a tree without printing it.
	 */
	recordRead(cellId: string, window: InputWindow, text: string, options: AxReadOptions): void {
		this.recordRefs(window.id, treeRefs(text));
		this.#cell(cellId).reads.set(window.id, {
			window,
			text,
			options: { ...options },
			sequence: this.#sequence,
		});
	}

	/**
	 * The model was shown a screenshot of the window (`desktop` for the root):
	 * it works the window from pixels and its post-input state is known. Only a
	 * shown capture reaches here; a silent one changes nothing.
	 */
	recordCapture(cellId: string, window: InputWindow): void {
		const record = this.#record(window.id);
		if (window.pid !== undefined) record.pid = window.pid;
		record.pixels = true;
		this.#cell(cellId).pixelsThisCell.add(window.id);
		this.#cells.get(cellId)?.touched.delete(window.id);
	}

	/** Whether this cell's input has yet to claim its roster-before read. */
	wantsRoster(cellId: string): boolean {
		return this.#cell(cellId).rosterClaimed === false;
	}

	/** Claim the roster-before read; resolve it with the roster, or undefined when it could not be read. */
	claimRoster(cellId: string): { resolve(roster: DesktopWindow[] | undefined): void } {
		const cell = this.#cell(cellId);
		cell.rosterClaimed = true;
		return {
			resolve: roster => {
				cell.rosterBefore = roster;
			},
		};
	}

	/**
	 * An input is being sent. `window` is the window it reaches, undefined when
	 * that is unknown. `root` input went to the desktop root, whose pixel mode
	 * it sets or keeps in place of the window's; an element action also ends
	 * the root's pixel mode unless this cell worked the root by pixels.
	 */
	noteInput(cellId: string, window: InputWindow | undefined, label: string, kind: InputKind, root = false): void {
		const cell = this.#cell(cellId);
		cell.inputs++;
		if (root) cell.rootInput = true;
		const targetId = root || !window ? DESKTOP_WINDOW_ID : window.id;
		const target = this.#record(targetId);
		if (kind === "pixel") {
			target.pixels = true;
			cell.pixelsThisCell.add(targetId);
		} else if (kind === "element") {
			for (const id of [targetId, DESKTOP_WINDOW_ID])
				if (!cell.pixelsThisCell.has(id)) this.#record(id).pixels = false;
		}
		if (!window) {
			cell.unattributed.push(label);
			return;
		}
		const record = this.#record(window.id);
		const pid = window.pid ?? record.pid;
		if (pid !== undefined) {
			record.pid = pid;
			cell.pids.add(pid);
		}
		const touched = cell.touched.get(window.id);
		if (touched) {
			touched.labels.push(label);
			touched.sequence = ++this.#sequence;
		} else cell.touched.set(window.id, { labels: [label], sequence: ++this.#sequence });
	}

	/** An input returned or threw: the settle's delay is measured from here. */
	noteInputEnded(cellId: string): void {
		this.#cell(cellId).lastInputAt = Date.now();
	}

	/** A call failed: the settle prints its window's current tree so refs renew. */
	noteFailure(cellId: string, window: InputWindow | undefined, label: string, message: string): void {
		const failure = `${label} failed: ${message}`;
		const cell = this.#cell(cellId);
		if (!window) {
			cell.unattributed.push(failure);
			return;
		}
		const touched = cell.touched.get(window.id);
		if (touched) {
			touched.failure = failure;
			touched.sequence = ++this.#sequence;
		} else cell.touched.set(window.id, { labels: [], failure, sequence: ++this.#sequence });
	}

	/**
	 * Take what this cell left to settle, or undefined when it sent no input and
	 * nothing failed. First, each `ax()` read whose tree the cell's `output`
	 * carries becomes what the model saw, and settles its window unless input
	 * reached the window after the read. The cell's pending state is gone either
	 * way: a settle is the last thing a cell owes its report.
	 */
	take(cellId: string, output: string): PendingSettle | undefined {
		const cell = this.#cells.get(cellId);
		if (!cell) return undefined;
		if (cell.reads.size > 0) {
			const printedRefs = new Set(Array.from(output.matchAll(/\[ref=(e\d+)\]/g), match => match[1]!));
			for (const read of cell.reads.values()) {
				if (!printedIn(printedRefs, output, read.text)) continue;
				const touched = cell.touched.get(read.window.id);
				this.recordShown(cellId, read.window, read.text, read.options);
				if (touched && touched.sequence > read.sequence) cell.touched.set(read.window.id, touched);
			}
		}
		this.#cells.delete(cellId);
		if (cell.inputs === 0 && cell.touched.size === 0 && cell.unattributed.length === 0) return undefined;
		const touched: TouchedWindow[] = [...cell.touched].map(([id, { labels, failure }]) => {
			const record = this.#windows.get(id);
			return {
				id,
				labels,
				failure,
				baseline: record?.shown,
				options: { ...record?.options },
				screenshot: record?.pixels === true,
			};
		});
		return {
			touched,
			pids: cell.pids,
			unattributed: cell.unattributed,
			desktopScreenshot: cell.rootInput && this.#windows.get(DESKTOP_WINDOW_ID)?.pixels === true,
			rosterBefore: cell.rosterBefore,
			lastInputAt: cell.lastInputAt,
		};
	}

	/**
	 * Forget a cell that will never settle — its turn was cancelled, or its run
	 * failed before it could report. Nothing it did is attributed anywhere, and
	 * the next cell answers only for its own input.
	 */
	discard(cellId: string): void {
		const cell = this.#cells.get(cellId);
		if (!cell) return;
		this.#cells.delete(cellId);
	}

	/**
	 * The touched-window entry for the focused window, carrying the cell's
	 * unattributed inputs: merged into the window's own entry when the cell
	 * also addressed it.
	 */
	attributeToFocused(pending: PendingSettle, window: DesktopWindow): void {
		if (pending.unattributed.length === 0) return;
		const labels = [...pending.unattributed];
		labels[labels.length - 1] += " (its window is unknown; shown on the focused window)";
		const own = pending.touched.find(touched => touched.id === window.id);
		if (own) {
			own.labels.push(...labels);
			pending.unattributed = [];
			return;
		}
		const record = this.#windows.get(window.id);
		pending.touched.push({
			id: window.id,
			labels,
			baseline: record?.shown,
			options: { ...record?.options },
			screenshot: record?.pixels === true,
		});
		pending.unattributed = [];
	}
}

/** `window "42" Code "main.ts"`, or `window "42"` when the roster did not list it: the id as `window()` takes it. */
function windowName(window: DesktopWindow | undefined, id: string): string {
	return `window ${window ? windowLabel(window) : JSON.stringify(id)}`;
}

/** `press e5, type "abc"` — the inputs a read-back answers, then the failure that renewed it. */
function describeCause(touched: TouchedWindow): string {
	const inputs =
		touched.labels.length > 4
			? [...touched.labels.slice(0, 4), `+${touched.labels.length - 4} more`]
			: [...touched.labels];
	if (touched.failure !== undefined) inputs.push(touched.failure);
	return inputs.join(", ");
}

/** One touched window, re-read after the cell. */
export interface ReadBack {
	touched: TouchedWindow;
	/** The window as the roster lists it now; absent when the roster could not be read. */
	window?: DesktopWindow;
	/** The re-read tree. */
	text: string;
	/** Marks against the model's last tree of the window; absent when it had none. */
	change?: TreeChange;
	/** How long after the cell's last input the tree was read. */
	sinceInputMs: number;
}

/** Whether a re-read found nothing different from the model's last tree. */
function isUnchanged(change: TreeChange | undefined): boolean {
	return change !== undefined && change.added === 0 && change.changed === 0 && change.removed.length === 0;
}

/** Count the marked (`+`/`~`) rows a tree text still carries. */
function markedRows(text: string): number {
	return text.split("\n").filter(line => /^(?: {2})*[+~] /.test(line)).length;
}

/** The post-input section for one window: a header saying what changed, then its current tree. */
export function renderReadBack(readBack: ReadBack): string {
	const { touched, change } = readBack;
	const name = windowName(readBack.window, touched.id);
	let summary: string;
	// Without an input (a call failed on a stale ref) there is no input to have changed nothing.
	if (change === undefined || (isUnchanged(change) && touched.labels.length === 0)) summary = "current tree";
	else if (isUnchanged(change))
		summary = `no accessibility change visible ${(readBack.sinceInputMs / 1000).toFixed(1)} s after the input (the app may still be working); refs renewed`;
	else
		summary = `${change.changed} changed, ${change.added} added, ${change.removed.length} removed (rows marked ~ changed, + added)`;
	if (touched.screenshot) summary += "; screenshot below";
	const tree = change?.text ?? readBack.text;
	const elided = elideAxTree(tree, REPORT_TREE_BUDGET_BYTES);
	if (elided) {
		const lost = markedRows(tree) - markedRows(elided.text);
		summary += `; ${elided.elidedRows} rows elided to fit (${lost === 0 ? "every changed row kept" : `${lost} changed rows among them`}) — \`win.ax()\`/\`win.find()\` reach them`;
	}
	const lines = [`${name} after ${describeCause(touched)} — ${summary}:`, elided?.text ?? tree];
	if (change && change.removed.length > 0) {
		const shown = change.removed.slice(0, 8).join("; ");
		const more = change.removed.length > 8 ? `; +${change.removed.length - 8} more` : "";
		lines.push(`removed: ${shown}${more}`);
	}
	return lines.join("\n");
}

/** A touched window whose tree could not be read back. */
export function renderUnreadable(touched: TouchedWindow, window: DesktopWindow | undefined, message: string): string {
	const screenshot = touched.screenshot ? "; screenshot below" : "";
	return `${windowName(window, touched.id)} after ${describeCause(touched)} — could not be read back through AX: ${message}${screenshot}`;
}

/** A touched window the roster no longer lists. */
export function renderGone(touched: TouchedWindow): string {
	return `${windowName(undefined, touched.id)} after ${describeCause(touched)} — gone from the window list (closed, minimized or off screen)`;
}

/** Inputs no window could be blamed for, and that no focused window could carry either. */
export function renderUnattributed(labels: readonly string[]): string {
	return `could not attribute ${labels.join(", ")} to a window; read the desktop before continuing`;
}

/**
 * Windows the cell's input opened, closed or focused: new and vanished
 * windows of the processes it sent window input to, and a new focused window
 * of any process. Windows with their own read-back section are skipped.
 */
export function describeRosterChanges(
	before: readonly DesktopWindow[],
	after: readonly DesktopWindow[],
	pids: ReadonlySet<number>,
	reported: ReadonlySet<string>,
): string[] {
	const beforeIds = new Set(before.map(window => window.id));
	const afterIds = new Set(after.map(window => window.id));
	const acted = (window: DesktopWindow): boolean => window.pid !== undefined && pids.has(window.pid);
	const lines: string[] = [];
	for (const window of after) {
		if (beforeIds.has(window.id) || reported.has(window.id) || !(acted(window) || window.focused)) continue;
		lines.push(
			`new window ${windowLabel(window)} ${Math.round(window.width)}×${Math.round(window.height)}${window.focused ? " (focused)" : ""}`,
		);
	}
	for (const window of before) {
		if (afterIds.has(window.id) || reported.has(window.id) || !acted(window)) continue;
		lines.push(`window ${windowLabel(window)} closed`);
	}
	const focusedBefore = before.find(window => window.focused);
	const focusedAfter = after.find(window => window.focused);
	if (focusedAfter && focusedAfter.id !== focusedBefore?.id && beforeIds.has(focusedAfter.id))
		lines.push(`focus moved to window ${windowLabel(focusedAfter)}`);
	return lines;
}
