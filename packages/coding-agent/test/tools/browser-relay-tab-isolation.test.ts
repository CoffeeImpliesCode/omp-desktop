/**
 * Relay tab-ownership contracts, proved against a real Chromium running the
 * real bundled MV3 extension.
 *
 * A default relay `browser.open` used to adopt whichever user tab was visible
 * and navigate it. The contract now is: an open without `app.target` gets its
 * own background tab, the user's tabs are never navigated or raised, an open
 * with `app.target` borrows a page and releases it without closing, and an
 * omp-created tab is destroyed on release even when its worker already reported
 * the page closed.
 *
 * Every Chromium here is disposable (`puppeteer.launch` with its own temp
 * profile, extension copied into a temp dir): the developer's installed Chrome,
 * profile, and relay extension are never touched.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser, type Page, type WebWorker } from "puppeteer-core";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const ASSETS = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");

interface ChromeTab {
	id: number;
	url: string;
	active: boolean;
}

interface RelayFixture {
	/** The disposable Chrome that runs the relay extension. */
	browser: Browser;
	/** The extension's MV3 service worker. */
	worker: WebWorker;
	cdpUrl: string;
	/** Loopback origin serving the fixture pages. */
	origin: string;
	/** Page targets the relay currently advertises over CDP. */
	relayTargets(): Array<Record<string, string>>;
	/** Chrome tabs as the extension sees them — the physical tab list. */
	chromeTabs(): Promise<ChromeTab[]>;
	close(): Promise<void>;
}

/** Minimal tool session for the `runInTab` entry point. */
function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

/** Copies the committed extension into a temp dir, pointed at this test's relay. */
async function writeExtension(dir: string, port: number, prelude = ""): Promise<void> {
	for (const file of ["manifest.json", "options.html", "options.js"]) {
		await fs.copyFile(path.join(ASSETS, `${file}.txt`), path.join(dir, file));
	}
	const background = await fs.readFile(path.join(ASSETS, "background.js.txt"), "utf8");
	// The bundle connects on load, so the disposable relay port must be in
	// storage before it runs or the extension dials the developer's own relay.
	await fs.writeFile(
		path.join(dir, "background.js"),
		`${prelude}\nchrome.storage.local.set({ port: ${port} }).then(() => {\n${background}\n});`,
	);
}

/**
 * Captures the extension's real `chrome.debugger.onDetach` listener so a test
 * can replay the infobar-dismissal notification. A programmatic detach is not
 * that UI event, and the retraction under test is the extension's own handler
 * running — not a test-side stand-in for it.
 */
const DETACH_REPLAY_PRELUDE = `
const registerDetach = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
chrome.debugger.onDetach.addListener = listener => {
	globalThis.replayableDebuggerDetach = listener;
	registerDetach(listener);
};`;

/** Puppeteer keeps the CDP target id in a private field; relay page ids come from it. */
function targetIdOf(target: object): string | undefined {
	return "_targetId" in target && typeof target._targetId === "string" ? target._targetId : undefined;
}

interface FixtureOptions {
	/** Runs before the extension bundle inside the service worker. */
	prelude?: string;
	/** Relay-side diagnostics, e.g. the retraction caused by a debugger detach. */
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Real extension bundle + real relay server + real Chromium, all disposable. */
async function launchRelayFixture(options: FixtureOptions = {}): Promise<RelayFixture> {
	const port = await findFreeCdpPort();
	const server = startRelayServer({ port, group: false, log: options.log });
	const extension = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-isolation-"));
	const pages = Bun.serve({
		port: 0,
		fetch(request) {
			const route = new URL(request.url).pathname;
			const html =
				route === "/first"
					? `<title>First</title><button onclick="this.textContent='clicked'">First</button>`
					: route === "/second"
						? "<title>Second</title><button>Second</button>"
						: "<title>Human sentinel</title><h1>Keep me</h1>";
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		},
	});
	let browser: Browser | undefined;
	async function close(): Promise<void> {
		try {
			await browser?.close().catch(() => undefined);
		} finally {
			server.stop();
			pages.stop(true);
			await fs.rm(extension, { recursive: true, force: true });
		}
	}
	try {
		await writeExtension(extension, port, options.prelude);
		browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			enableExtensions: [extension],
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
		});
		const target = await browser.waitForTarget(candidate => candidate.type() === "service_worker", {
			timeout: 15_000,
		});
		const worker = await target.worker();
		if (!worker) throw new Error("Missing relay extension service worker");
		const cdpUrl = `http://127.0.0.1:${port}`;
		const outcome = await waitForRelayExtension(cdpUrl);
		if (outcome !== "ready") throw new Error(`Relay fixture handshake failed: ${outcome}`);
		return {
			browser,
			worker,
			cdpUrl,
			origin: `http://127.0.0.1:${pages.port}`,
			relayTargets() {
				return server.bridge.listTargets();
			},
			async chromeTabs() {
				const listed = await worker.evaluate(
					`chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ id: tab.id, url: tab.url ?? "", active: tab.active })))`,
				);
				return listed as ChromeTab[];
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

/** Chrome tab id the relay minted for a managed page target (`PAGE<code>.<tabId>`). */
function chromeTabIdOf(targetId: string): number {
	const tabId = Number(targetId.slice(targetId.lastIndexOf(".") + 1));
	if (!Number.isInteger(tabId)) throw new Error(`Managed target ${targetId} carries no Chrome tab id`);
	return tabId;
}

describe.skipIf(!CHROMIUM_AVAILABLE)("relay tab isolation", () => {
	it("opens background tabs of its own and leaves borrowed pages open on close", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [`relay-first-${process.pid}`, `relay-second-${process.pid}`, `relay-borrowed-${process.pid}`];
		const session = makeSession();
		try {
			const first = await acquireTab(names[0]!, relay, { url: `${fixture.origin}/first`, timeoutMs: 20_000 });
			const second = await acquireTab(names[1]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 20_000 });

			// Two opens are two pages. Adoption returned the same target twice and
			// navigated the user's tab, so the second open clobbered the first.
			expect(first.tab.targetId).not.toBe(second.tab.targetId);
			expect(await human.title()).toBe("Human sentinel");
			expect(human.url()).toBe(humanUrl);

			// Creating a tab must not steal the user's foreground tab: an open is
			// a background operation, so the sentinel stays active and the owned
			// pages never activate themselves.
			const afterOpen = await fixture.chromeTabs();
			expect(afterOpen.filter(tab => tab.url.endsWith("/human")).map(tab => tab.active)).toEqual([true]);
			expect(afterOpen.filter(tab => tab.url.endsWith("/first")).map(tab => tab.active)).toEqual([false]);
			expect(afterOpen.filter(tab => tab.url.endsWith("/second")).map(tab => tab.active)).toEqual([false]);

			// Input must reach a background tab: the handler's DOM write is the
			// only evidence that the click was actually dispatched.
			const clicked = await runInTab(names[0]!, {
				code: "await tab.click('button'); return await tab.text('button');",
				timeoutMs: 15_000,
				session,
			});
			expect(clicked.returnValue).toBe("clicked");

			// A screenshot of an owned background page must work and must not
			// raise the user's window to do it.
			const shot = await runInTab(names[0]!, {
				code: "return await tab.screenshot({ silent: true });",
				timeoutMs: 20_000,
				session,
			});
			const savedPath = shot.returnValue;
			expect(typeof savedPath).toBe("string");
			if (typeof savedPath !== "string") throw new Error("tab.screenshot() returned no path");
			try {
				expect(await Bun.file(savedPath).exists()).toBe(true);
			} finally {
				await fs.rm(savedPath, { force: true });
			}
			expect((await fixture.chromeTabs()).filter(tab => tab.url.endsWith("/human")).map(tab => tab.active)).toEqual([
				true,
			]);

			const firstChromeTab = chromeTabIdOf(first.tab.targetId);
			expect((await fixture.chromeTabs()).some(tab => tab.id === firstChromeTab)).toBe(true);
			await releaseTab(names[0]!);
			// Releasing one owned tab removes exactly that Chrome tab; the other
			// automation page and the user's tab both survive.
			expect((await fixture.chromeTabs()).some(tab => tab.id === firstChromeTab)).toBe(false);
			expect(await human.title()).toBe("Human sentinel");
			const surviving = await runInTab(names[1]!, { code: "return await tab.title();", timeoutMs: 15_000, session });
			expect(surviving.returnValue).toBe("Second");

			// `app.target` borrows a page the user owns: release returns it, it
			// does not close it.
			await acquireTab(names[2]!, relay, { target: "Human sentinel", timeoutMs: 20_000 });
			await releaseTab(names[2]!);
			expect(human.isClosed()).toBe(false);
			expect(await human.title()).toBe("Human sentinel");
			expect(human.url()).toBe(humanUrl);
		} finally {
			// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
			for (const name of [...names]) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await human.close().catch(() => undefined);
			await fixture.close();
		}
	}, 120_000);
});

interface TestWorker {
	outcome: Promise<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>;
	close(): Promise<void>;
}

/** Drives a {@link WorkerCore} in-process so its page lifecycle is observable. */
function startWorker(payload: WorkerInitPayload): TestWorker {
	const outcome = Promise.withResolvers<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>();
	const closed = Promise.withResolvers<void>();
	let receive!: (message: WorkerInbound) => void;
	new WorkerCore(
		{
			send(message) {
				if (message.type === "ready" || message.type === "init-failed") outcome.resolve(message);
				if (message.type === "closed") closed.resolve();
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {
				closed.resolve();
			},
		},
		false,
	);
	receive({ type: "init", payload });
	return {
		outcome: outcome.promise,
		async close() {
			receive({ type: "close" });
			await closed.promise;
		},
	};
}

describe.skipIf(!CHROMIUM_AVAILABLE)("relay page ownership across worker recovery", () => {
	it("keeps an owned page alive after a failed init so the retry can adopt it", async () => {
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browser)) throw new Error("Expected a Chromium handle");
		const page: Page = await browser.browser.newPage();
		await page.goto("data:text/html,<title>Recovery sentinel</title>");
		const targetId = targetIdOf(page.target());
		if (targetId === undefined) throw new Error("Missing target id");
		const payload: WorkerInitPayload = {
			mode: "attach",
			browserWSEndpoint: browser.browser.wsEndpoint(),
			safeDir: getPuppeteerDir(),
			targetId,
			ownsPage: true,
			recover: true,
			emulateFocus: true,
		};
		const failed = startWorker({ ...payload, downloadsPath: "/dev/null/notadir" });
		let retried: TestWorker | undefined;
		try {
			// A retry adopts this same target, so a failed init must not destroy
			// an owned page the supervisor still has to clean up.
			const failure = await failed.outcome;
			expect(failure.type).toBe("init-failed");
			expect(page.isClosed()).toBe(false);

			retried = startWorker(payload);
			const ready = await retried.outcome;
			expect(ready.type).toBe("ready");
			if (ready.type === "ready") expect(ready.info.targetId).toBe(targetId);
			await retried.close();
			retried = undefined;
			// Ownership survived the recovery, so the worker's own close still
			// destroys the page it was told it owns.
			if (!page.isClosed()) {
				const { promise, resolve } = Promise.withResolvers<void>();
				page.once("close", () => resolve());
				await promise;
			}
			expect(page.isClosed()).toBe(true);
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await releaseBrowser(browser, { kill: true });
		}
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("relay tab cleanup after a debugger detach", () => {
	it("still removes the owned Chrome tab when the user dismisses the debugging infobar", async () => {
		const detached = Promise.withResolvers<void>();
		let ownedChromeTab = 0;
		const fixture = await launchRelayFixture({
			prelude: DETACH_REPLAY_PRELUDE,
			log(message, data) {
				const tabKey = data?.tabKey;
				if (message === "tab detached" && typeof tabKey === "string" && tabKey.endsWith(`:${ownedChromeTab}`)) {
					detached.resolve();
				}
			},
		});
		const human = await fixture.browser.newPage();
		const name = `relay-detached-${process.pid}`;
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		try {
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/second`, timeoutMs: 20_000 });
			ownedChromeTab = chromeTabIdOf(tab.targetId);
			expect(fixture.relayTargets().some(target => target.id === tab.targetId)).toBe(true);

			// Dismissing Chrome's "being controlled" infobar is a user action the
			// relay must honour: the target is retracted, so the worker's page
			// looks closed while the Chrome tab omp created is still on screen.
			await fixture.worker.evaluate(`(async () => {
				await chrome.debugger.detach({ tabId: ${ownedChromeTab} }).catch(() => {});
				globalThis.replayableDebuggerDetach({ tabId: ${ownedChromeTab} }, "canceled_by_user");
			})()`);
			await detached.promise;
			expect(fixture.relayTargets().some(target => target.id === tab.targetId)).toBe(false);
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === ownedChromeTab)).toBe(true);

			// Managed close must still destroy the tab omp created, and must not
			// reach past it to the user's own tab.
			await releaseTab(name);
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === ownedChromeTab)).toBe(false);
			expect(human.isClosed()).toBe(false);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await human.close().catch(() => undefined);
			await fixture.close();
		}
	}, 90_000);
});
