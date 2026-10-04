/**
 * Ownership regressions for the relay tab lifecycle.
 *
 * A relay tab is either omp's own (`browser.open` created it) or borrowed from
 * the user (`app.target` adopted an existing tab). Managed close must destroy
 * the first and leave the second alone, and it must do so even when the worker
 * reported the page already closed — a debugger detach retracts the relay
 * target while the physical Chrome tab is still open.
 *
 * The relay exposes a root CDP connection but no attachable browser target, so
 * these release paths are driven through that root connection; a real extension
 * is exercised in browser-relay-tab-isolation.test.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Browser } from "puppeteer-core";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	getTabsMapForTest,
	releaseAllTabs,
	releaseTab,
	releaseTabsForOwner,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

const TARGET_ID = "PAGEANON00000009.9";

interface RootCommand {
	method: string;
	params?: Record<string, unknown>;
}

interface RelayHandle {
	browser: PuppeteerBrowserHandle;
	/** Every root-connection command the release path issued. */
	commands: RootCommand[];
	/** Times the release handed the CDP link back by dropping the handle. */
	disconnects: () => number;
}

/** Worker double that reports its page closed the instant it is asked to close. */
class ClosedOnRequestWorker {
	readonly sent: WorkerInbound[] = [];
	/** Terminations observed, so a batch release that abandons a tab is visible. */
	terminations = 0;
	#handlers = new Set<(msg: WorkerOutbound) => void>();
	#closed = false;

	send(msg: WorkerInbound): void {
		this.sent.push(msg);
		if (msg.type !== "close") return;
		this.#closed = true;
		for (const handler of this.#handlers) handler({ type: "closed" });
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		// `waitForClosed` subscribes after the close command was delivered.
		if (this.#closed) handler({ type: "closed" });
		return () => {
			this.#handlers.delete(handler);
		};
	}

	onError(): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {
		this.terminations += 1;
	}
}

/** Distinct relay targets, so a batch can tell which close belongs to which tab. */
const FAILING_TARGET = "PAGEANON00000009.1";
const BORROWED_TARGET = "PAGEANON00000009.2";
const CLEAN_TARGET = "PAGEANON00000009.3";

/** Relay handle whose root CDP connection answers `Target.closeTarget` from `close`. */
function makeRelayHandle(close: (targetId: string) => Promise<unknown>): RelayHandle {
	const commands: RootCommand[] = [];
	const send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
		commands.push({ method, params });
		if (method !== "Target.closeTarget") throw new Error(`Unexpected relay command ${method}`);
		const targetId = String(params?.targetId ?? "");
		return await close(targetId);
	};
	let disconnects = 0;
	const browser = {
		connected: true,
		targets: () => [],
		target: () => ({ createCDPSession: async () => ({ send, detach: async () => undefined }) }),
		disconnect: () => {
			disconnects += 1;
			browser.connected = false;
		},
		_connection: { send },
	};
	return {
		browser: {
			key: "relay:http://127.0.0.1:1",
			kind: { kind: "relay", cdpUrl: "http://127.0.0.1:1" },
			browser: browser as unknown as Browser,
			refCount: 1,
			stealth: { browserSession: null, override: null },
		} as unknown as PuppeteerBrowserHandle,
		commands,
		disconnects: () => disconnects,
	};
}

/** Managed relay tab in the state a worker hands back after closing its page. */
function makeRelayTab(
	name: string,
	handle: RelayHandle,
	ownsPage: boolean,
	targetId = TARGET_ID,
	worker = new ClosedOnRequestWorker(),
): WorkerTabSession {
	return {
		name,
		browser: handle.browser,
		targetId,
		backend: "worker",
		state: "alive",
		info: {},
		pending: new Map(),
		kindTag: "relay",
		ownsPage,
		activateForScreenshot: false,
		ownerSessionId: "session-relay-ownership",
		persist: false,
		lastActivityAt: Date.now(),
		frozen: false,
		worker,
	} as unknown as WorkerTabSession;
}

const names: string[] = [];

/** Publishes a stub tab under its own name and returns that name. */
function register(tab: WorkerTabSession): string {
	names.push(tab.name);
	getTabsMapForTest().set(tab.name, tab);
	return tab.name;
}

afterEach(async () => {
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...names.splice(0)]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
});

describe("relay tab ownership on managed close", () => {
	it("closes an omp-owned relay tab whose worker already reported the page closed", async () => {
		// A debugger detach retracts the relay target, so the worker sends
		// `closed` while the physical Chrome tab is still open. Dropping it
		// there leaves a tab the agent created and can never close again.
		const handle = makeRelayHandle(() => Promise.resolve({ success: true }));
		const name = register(makeRelayTab(`relay-owned-${process.pid}`, handle, true));

		expect(await releaseTab(name, { kill: false })).toBe(true);
		expect(handle.commands).toEqual([{ method: "Target.closeTarget", params: { targetId: TARGET_ID } }]);
		expect(getTabsMapForTest().has(name)).toBe(false);
		// The tab held the relay's only reference: cleanup must hand it back
		// even when the tab close itself needed a root-connection retry.
		expect(handle.browser.refCount).toBe(0);
		expect(handle.disconnects()).toBe(1);
	});

	it("never closes a borrowed user tab, even when the relay would refuse", async () => {
		// `app.target` borrowed this page from the user; the release must not
		// even ask, or the user's tab is one failed cleanup away from vanishing.
		const handle = makeRelayHandle(() => Promise.reject(new Error("Refusing to close a borrowed user tab")));
		const name = register(makeRelayTab(`relay-borrowed-${process.pid}`, handle, false));

		expect(await releaseTab(name, { kill: false })).toBe(true);
		expect(handle.commands).toEqual([]);
		expect(getTabsMapForTest().has(name)).toBe(false);
		expect(handle.browser.refCount).toBe(0);
		expect(handle.disconnects()).toBe(1);
	});

	it("surfaces a relay refusal instead of reporting a clean close", async () => {
		// A refusal means the owned tab outlived its release. Swallowing it
		// tells the agent the tab is gone while Chrome still shows it.
		const handle = makeRelayHandle(() => Promise.reject(new Error("Refusing to close a borrowed user tab")));
		const name = register(makeRelayTab(`relay-refused-${process.pid}`, handle, true));

		await expect(releaseTab(name, { kill: false })).rejects.toThrow("Refusing to close a borrowed user tab");
		expect(handle.commands).toEqual([{ method: "Target.closeTarget", params: { targetId: TARGET_ID } }]);
		expect(getTabsMapForTest().has(name)).toBe(false);
	});

	it("treats an owned target the relay already forgot as a completed close", async () => {
		// The worker closed the page through the page session before the root
		// connection was asked; the relay answers "no such target", which is
		// the desired end state rather than a cleanup failure.
		const handle = makeRelayHandle(targetId => Promise.reject(new Error(`No target with id ${targetId}`)));
		const name = register(makeRelayTab(`relay-missing-${process.pid}`, handle, true));

		expect(await releaseTab(name, { kill: false })).toBe(true);
		expect(handle.commands).toEqual([{ method: "Target.closeTarget", params: { targetId: TARGET_ID } }]);
	});

	it("reports an unknown relay failure rather than claiming the tab closed", async () => {
		const handle = makeRelayHandle(() => Promise.reject(new Error("relay extension is not connected")));
		const name = register(makeRelayTab(`relay-offline-${process.pid}`, handle, true));

		await expect(releaseTab(name, { kill: false })).rejects.toThrow("relay extension is not connected");
	});
});

describe("relay batch release", () => {
	it("releases every tab in the batch when one owned close is refused", async () => {
		// An unreachable relay is the common case, not an edge: the MV3 service
		// worker reconnects on a backoff, so a refusal must not strand the tabs
		// queued behind it with a live worker and browser hold.
		const failing = makeRelayHandle(() => Promise.reject(new Error("relay extension is not connected")));
		const borrowed = makeRelayHandle(() => Promise.reject(new Error("Refusing to close a borrowed user tab")));
		const clean = makeRelayHandle(() => Promise.resolve({ success: true }));
		const workers = [new ClosedOnRequestWorker(), new ClosedOnRequestWorker(), new ClosedOnRequestWorker()];
		register(makeRelayTab("relay-batch-failing", failing, true, FAILING_TARGET, workers[0]!));
		register(makeRelayTab("relay-batch-borrowed", borrowed, false, BORROWED_TARGET, workers[1]!));
		register(makeRelayTab("relay-batch-clean", clean, true, CLEAN_TARGET, workers[2]!));

		// Count reports only the tabs that actually closed; the borrowed tab is
		// released without ever asking the relay to close it.
		expect(await releaseAllTabs({ kill: false })).toBe(2);
		expect(getTabsMapForTest().size).toBe(0);
		for (const worker of workers) expect(worker.terminations).toBe(1);
		expect(failing.commands).toEqual([{ method: "Target.closeTarget", params: { targetId: FAILING_TARGET } }]);
		expect(borrowed.commands).toEqual([]);
		expect(clean.commands).toEqual([{ method: "Target.closeTarget", params: { targetId: CLEAN_TARGET } }]);
		for (const handle of [failing, borrowed, clean]) {
			expect(handle.browser.refCount).toBe(0);
			expect(handle.disconnects()).toBe(1);
		}
	});

	it("releases a session's remaining tabs after one owned close is refused", async () => {
		const failing = makeRelayHandle(() => Promise.reject(new Error("relay extension is not connected")));
		const borrowed = makeRelayHandle(() => Promise.reject(new Error("Refusing to close a borrowed user tab")));
		const worker = new ClosedOnRequestWorker();
		register(makeRelayTab("relay-owner-failing", failing, true, FAILING_TARGET, worker));
		register(makeRelayTab("relay-owner-borrowed", borrowed, false, BORROWED_TARGET));

		expect(await releaseTabsForOwner("session-relay-ownership", { kill: false })).toBe(1);
		expect(getTabsMapForTest().size).toBe(0);
		expect(worker.terminations).toBe(1);
		expect(borrowed.commands).toEqual([]);
		expect(failing.browser.refCount).toBe(0);
		expect(borrowed.browser.refCount).toBe(0);
	});
});
