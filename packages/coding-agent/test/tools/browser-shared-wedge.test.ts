// Supervisor regressions: keep ownership after an unconfirmed CDP close, and tear down each wedged tab once.
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	forgetSharedTarget,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as sharedDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	getTabsMapForTest,
	releaseTab,
	runInTab,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { rejectionOf } from "../helpers/rejection";

const DAEMON_NAME = "omp.browser.headless";
/** The target id the incident log names for the tab whose close never landed. */
const TARGET_ID = "D6895F960DB1F4D842FD7B0286F3F818";
const READY_INFO = { targetId: TARGET_ID, url: "about:blank", viewport: { width: 800, height: 600 } };

/** Unique per-test scope so registry dirs never collide across the suite. */
function makeScope(): SharedTargetScope {
	return { projectDir: path.join(runtimeDir, crypto.randomUUID()), daemonName: DAEMON_NAME };
}

let runtimeDir: string;

/** Targets this process still claims ownership of, straight from the durable record. */
async function ownedTargets(scope: SharedTargetScope): Promise<string[]> {
	// Reading straight after `releaseTab` would race the registry's serialized
	// write chain (the supervisor forgets fire-and-forget). A record→forget pair
	// for a throwaway id joins that chain, so when it returns the earlier write
	// has landed and the file below is stable.
	const probe = `chain-probe-${crypto.randomUUID()}`;
	await recordSharedTarget(scope, probe);
	await forgetSharedTarget(scope, probe);
	const file = path.join(
		piUtils.getDaemonRuntimeDir(scope.projectDir),
		`${scope.daemonName}.targets`,
		`${process.pid}.json`,
	);
	const raw = await Bun.file(file)
		.text()
		.catch(() => null);
	if (raw === null) return [];
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("targets" in parsed)) return [];
	const { targets } = parsed;
	return Array.isArray(targets) ? targets.filter((id): id is string => typeof id === "string") : [];
}

/** How the stub's CDP close behaves: never answers, fails fast, or fails after a gate. */
interface WedgeOptions {
	/** Whether the handle carries the shared-daemon scope (`false` = private launch). */
	shared?: boolean;
	close?: "hang" | "fail" | "gate";
	/** Held by a `gate` close until the test releases it. */
	gate?: Promise<void>;
	/** Fires when a `gate` close starts, so the test can interleave a release. */
	entered?: () => void;
	/** Counts worker terminations instead of the default no-op. */
	onTerminate?: () => void;
}

/** Handle whose root CDP connection cannot confirm a target close. */
function makeWedgeHandle(scope: SharedTargetScope, options: WedgeOptions = {}): PuppeteerBrowserHandle {
	const { shared = true, close = "hang", gate, entered } = options;
	const connection = {
		send: async (method: string): Promise<never> => {
			if (method !== "Target.closeTarget") throw new Error(`CDP not answering ${method}`);
			if (close === "fail") throw new Error("Protocol error (Target.closeTarget): root connection send failed");
			if (close === "gate") {
				entered?.();
				await gate;
				throw new Error("Protocol error (Target.closeTarget): root connection send failed");
			}
			return await new Promise<never>(() => {});
		},
		on: (): void => undefined,
		off: (): void => undefined,
		createSession: async (): Promise<never> => await new Promise<never>(() => {}),
	};
	return {
		key: "headless:1::",
		kind: { kind: "headless", headless: true },
		// Another tab still holds the shared browser: closing this one must not
		// dispose the handle (that is what leaves the target behind in Chrome).
		refCount: 2,
		stealth: { browserSession: null, override: null },
		wsEndpoint: "ws://127.0.0.1:1/devtools/browser/wedge-test",
		sharedDaemon: shared ? { name: scope.daemonName, projectDir: scope.projectDir } : undefined,
		browser: {
			connected: true,
			targets: () => [],
			_connection: connection,
			disconnect: () => undefined,
		} as unknown as PuppeteerBrowserHandle["browser"],
	};
}

/** The worker acknowledges shutdown without proving Chromium removed its page. */
function makeWedgeTab(scope: SharedTargetScope, options: WedgeOptions = {}): WorkerTabSession {
	let receive: ((message: WorkerOutbound) => void) | undefined;
	return {
		name: "logos-b2b",
		browser: makeWedgeHandle(scope, options),
		targetId: TARGET_ID,
		backend: "worker",
		state: "alive",
		info: READY_INFO,
		pending: new Map(),
		kindTag: "headless",
		ownsPage: true,
		uploadDir: path.join(runtimeDir, "uploads"),
		ownerSessionId: "session-wedge",
		persist: false,
		lastActivityAt: Date.now(),
		frozen: false,
		worker: {
			mode: "worker",
			send: message => {
				if (message.type === "close") receive?.({ type: "closed" });
			},
			onMessage: handler => {
				receive = handler;
				return () => {
					receive = undefined;
				};
			},
			onError: () => () => undefined,
			onExit: () => () => undefined,
			terminate: async () => {
				options.onTerminate?.();
			},
		},
	};
}

/** Minimal tool session for the `runInTab` entry point. */
function makeSession(): ToolSession {
	return {
		cwd: "/tmp/omp-wedge-session",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

beforeEach(() => {
	runtimeDir = mkdtempSync(path.join(os.tmpdir(), "omp-wedge-"));
	spyOn(piUtils, "getDaemonRuntimeDir").mockImplementation(projectDir => path.join(projectDir, "runtime"));
});

afterEach(async () => {
	vi.useRealTimers();
	try {
		await releaseTab("logos-b2b", { kill: false, timeoutMs: 60 }).catch(() => undefined);
	} finally {
		vi.restoreAllMocks();
		resetOrphanRegistryForTest();
		await fs.rm(runtimeDir, { recursive: true, force: true });
	}
});

describe("browser cleanup — timed-out target close in a shared browser", () => {
	it("keeps the ownership record and re-checks the shared browser", async () => {
		const scope = makeScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);

		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope));
		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).rejects.toThrow(
			`Timed out after 60ms closing headless browser tab "logos-b2b"; pending resource: owned CDP target ${JSON.stringify(TARGET_ID)} (Target.closeTarget)`,
		);

		// The tab still leaves the map (the close is reported as failed)...
		expect(getTabsMapForTest().has("logos-b2b")).toBe(false);
		// ...but the target it never closed stays owned, so a later reap can
		// still find it, and the browser itself is re-checked for reachability.
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(healthCheck.mock.calls[0]?.[0]).toEqual(scope);
	});

	it("forgets the retained target once the browser it belonged to is stopped", async () => {
		const scope = makeScope();
		// The check proves the whole browser gone: the target that could not be
		// closed died with it, so its record must not linger until this process
		// exits and be rewritten on every later write.
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(true);
		await recordSharedTarget(scope, TARGET_ID);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(await ownedTargets(scope)).toEqual([]);
	});

	it("still forgets a tab that was already dead when it was released", async () => {
		const scope = makeScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		const tab = makeWedgeTab(scope);
		tab.state = "dead";
		getTabsMapForTest().set("logos-b2b", tab);

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(await ownedTargets(scope)).toEqual([]);
		expect(healthCheck).not.toHaveBeenCalled();
	});

	it("force-kills a wedged tab without forgetting the target it could not close", async () => {
		const scope = makeScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		// `runInTab` reaching its grace period is one of the two real entry points
		// into `forceKillTab` (the other is a failed worker recycle — the
		// incident's "Failed to recycle browser tab worker; killing tab").
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(
			runInTab("logos-b2b", { code: "await wait(60_000);", timeoutMs: 20, session: makeSession() }),
		).rejects.toThrow('hung past its 20ms budget, so omp released tab "logos-b2b"');

		expect(getTabsMapForTest().has("logos-b2b")).toBe(false);
		// The next call names the kill once, without the advice the failed call already gave.
		await expect(runInTab("logos-b2b", { code: "", timeoutMs: 20, session: makeSession() })).rejects.toThrow(
			/Tab "logos-b2b" was killed:.*Reopen/i,
		);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(healthCheck.mock.calls[0]?.[0]).toEqual(scope);
	});

	it("terminates an unresponsive cancelled run after the abort grace, not its inherited budget", async () => {
		const scope = makeScope();
		spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		const terminated = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		const tab = makeWedgeTab(scope, { close: "fail", onTerminate: () => terminated.resolve() });
		tab.worker.send = message => {
			if (message.type === "run") sent.resolve();
		};
		getTabsMapForTest().set(tab.name, tab);
		vi.useFakeTimers();
		const controller = new AbortController();
		const failure = rejectionOf(
			runInTab(tab.name, {
				code: "while (true) {}",
				timeoutMs: 300_000,
				signal: controller.signal,
				session: makeSession(),
			}),
		);
		await sent.promise;
		controller.abort();
		vi.advanceTimersByTime(749);
		expect(getTabsMapForTest().has(tab.name)).toBe(true);
		vi.advanceTimersByTime(1);
		await terminated.promise;
		expect(await failure).toBeInstanceOf(ToolAbortError);
		expect(getTabsMapForTest().has(tab.name)).toBe(false);
	});

	it.each([
		{ expired: true, cancel: false, label: "caps startup after an expired run" },
		{ expired: false, cancel: false, label: "preserves the startup budget of recovery before a run expires" },
		{ expired: false, cancel: true, label: "cancels a stalled replacement and terminates its worker" },
	])("$label", async ({ expired, cancel }) => {
		const scope = makeScope();
		spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		const tab = makeWedgeTab(scope, { close: "fail" });
		const runSent = Promise.withResolvers<string>();
		tab.worker.send = message => {
			if (message.type === "run") runSent.resolve(message.id);
		};
		getTabsMapForTest().set(tab.name, tab);
		const RealWorker = globalThis.Worker;
		const readyWait = Promise.withResolvers<void>();
		const replacementTerminated = Promise.withResolvers<void>();
		const controller = new AbortController();
		let replacement: EventTarget | undefined;
		vi.useFakeTimers();
		let now = 0;
		spyOn(performance, "now").mockImplementation(() => now);
		const setTimer = globalThis.setTimeout;
		let setupSent = false;
		spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign((...args: Parameters<typeof setTimeout>) => {
				const timer = setTimer(...args);
				if (setupSent && args[1] !== 2_000) readyWait.resolve();
				return timer;
			}, setTimer),
		);
		globalThis.Worker = class extends EventTarget {
			constructor() {
				super();
				replacement = this;
			}
			postMessage(message: WorkerInbound): void {
				if (message.type === "init") {
					setupSent = true;
					this.dispatchEvent(new MessageEvent("message", { data: { type: "setup" } }));
				}
				if (message.type === "close") {
					this.dispatchEvent(new MessageEvent("message", { data: { type: "closed" } }));
				}
			}
			terminate(): void {
				replacementTerminated.resolve();
			}
		} as unknown as typeof Worker;
		try {
			const run = runInTab(tab.name, {
				code: "",
				timeoutMs: cancel ? 300_000 : expired ? 120_000 : 10_000,
				signal: controller.signal,
				session: makeSession(),
			});
			const result = run.catch(error => error);
			const id = await runSent.promise;
			const pending = tab.pending.get(id)!;
			if (expired) pending.reject(new ToolError("Browser code execution timed out after 120000ms"));
			else pending.resolve({ displays: [], screenshots: [], returnValue: true, recoverTab: true });
			await readyWait.promise;
			if (cancel) {
				controller.abort();
				vi.advanceTimersByTime(749);
				expect(getTabsMapForTest().has(tab.name)).toBe(true);
				vi.advanceTimersByTime(1);
			} else {
				now = 6_000;
				vi.advanceTimersByTime(6_000);
			}
			if (!expired && !cancel) {
				replacement!.dispatchEvent(new MessageEvent("message", { data: { type: "ready", info: READY_INFO } }));
			}
			const outcome = await result;
			if (cancel) {
				expect(outcome).toBeInstanceOf(ToolAbortError);
				await replacementTerminated.promise;
			} else if (expired) {
				expect(outcome).toBeInstanceOf(ToolError);
				expect(String(outcome)).toContain("released");
				expect(String(outcome)).toContain("tools.maxTimeout");
			} else {
				expect(outcome).toMatchObject({ returnValue: true });
			}
			expect(getTabsMapForTest().has(tab.name)).toBe(!expired && !cancel);
		} finally {
			globalThis.Worker = RealWorker;
		}
	});

	it("lets a release join an in-flight force-kill instead of tearing the tab down twice", async () => {
		const scope = makeScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let terminations = 0;
		const tab = makeWedgeTab(scope, {
			close: "gate",
			gate: gate.promise,
			entered: () => entered.resolve(),
			onTerminate: () => terminations++,
		});
		getTabsMapForTest().set("logos-b2b", tab);

		const killed = runInTab("logos-b2b", {
			code: "await wait(60_000);",
			timeoutMs: 20,
			session: makeSession(),
		}).catch((error: Error) => error.message);
		// Force-kill is now parked inside the CDP close: the release that lands
		// here must join it, not release the browser hold a second time or make
		// its own ownership decision.
		await entered.promise;
		expect(tab.state).toBe("dead");
		expect(tab.browser.refCount).toBe(2);
		// The release must join the in-flight force-kill, so it settles only when
		// that teardown does — hence starting it, not awaiting it, before the gate.
		const released = releaseTab("logos-b2b", { timeoutMs: 40 });
		gate.resolve();
		// The join reports the release contract, not the target-close outcome:
		// the tab is gone either way, and a surviving target is kept in the
		// registry (asserted below) rather than reported as an unreleased tab.
		expect(await released).toBe(true);
		await killed;

		expect(terminations).toBe(1);
		expect(tab.browser.refCount).toBe(1);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	});

	it("bounds the close a joining release waits on when force-kill is stuck on a wedged browser", async () => {
		const scope = makeScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		// Never resolves: the CDP close hangs exactly as it does against a wedged
		// Chromium, so only the supervisor's own close budget can end this wait.
		const wedged = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		getTabsMapForTest().set(
			"logos-b2b",
			makeWedgeTab(scope, { close: "gate", gate: wedged.promise, entered: () => entered.resolve() }),
		);

		const killed = runInTab("logos-b2b", {
			code: "await wait(60_000);",
			timeoutMs: 20,
			session: makeSession(),
		}).catch((error: Error) => error.message);
		await entered.promise;

		// A release joining the force-kill must not inherit an unbounded CDP wait
		// (Puppeteer's protocol timeout is 60 s); the supervisor's 5 s close
		// budget ends it, and the join still reports the tab as released.
		const joined = await piUtils.withTimeout(
			releaseTab("logos-b2b", { timeoutMs: 50 }),
			9_000,
			"joined release outlived the force-kill close budget",
		).catch(() => "timed-out" as const);
		expect(joined).toBe(true);

		await killed;
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	}, 20_000);

	it("never checks a browser that is not the shared one", async () => {
		const scope = makeScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { shared: false }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).rejects.toThrow("Timed out after 60ms");

		expect(healthCheck).not.toHaveBeenCalled();
	});

	it("treats an unconfirmed close (failed root-connection send) as unclosed too", async () => {
		const scope = makeScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	});
});
