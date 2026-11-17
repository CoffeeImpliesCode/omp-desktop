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
import puppeteer, { type Browser, type Page, type Protocol } from "puppeteer-core";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import type { BrowserDownload } from "@oh-my-pi/pi-coding-agent/tools/browser/downloads";
import {
	browserConnection,
	closeLaunchedBrowser,
	ensureChromiumExecutable,
	RENDERER_PRIORITY_ARGS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { unpackedExtensionId } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import { newUploadStagingDir } from "@oh-my-pi/pi-coding-agent/tools/browser/upload-files";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const ASSETS = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");

interface ChromeTab {
	id: number;
	url: string;
	active: boolean;
}

interface RelayBrowser {
	/** The disposable Chrome that runs the relay extension. */
	browser: Browser;
	/** Runs in a persistent extension page, which can wake its transient service worker. */
	inExtension(expression: string): Promise<unknown>;
}

interface RelayFixture extends RelayBrowser {
	cdpUrl: string;
	server: RelayServer;
	/** Loopback origin serving the fixture pages. */
	origin: string;
	/** Page targets the relay currently advertises over CDP. */
	relayTargets(): Array<Record<string, string>>;
	/** Chrome tabs as the extension sees them — the physical tab list. */
	chromeTabs(): Promise<ChromeTab[]>;
	/** The folder the fixture's browsers save downloads to. */
	downloads: string;
	/** The `index`-th request for `/held.csv`, whose body ends only once the test resolves it. */
	heldDownload(index: number): Promise<PromiseWithResolvers<void>>;
	/** A second disposable Chrome on this relay, with a separate profile. */
	launchBrowser(): Promise<RelayBrowser>;
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
	const defaultPort = "var DEFAULT_PORT = 9224;";
	if (!background.includes(defaultPort)) throw new Error("Relay extension default port not found");
	// Keep listener registration synchronous; an extension page wakes the service worker through runtime messaging.
	await fs.writeFile(
		path.join(dir, "background.js"),
		`${prelude}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
	if (message.op === "refuseRemoves") {
		globalThis.testRefuseRemoves = message.count;
		respond({});
	} else if (message.op === "dismissDebugger") {
		chrome.debugger.detach({ tabId: message.tabId }).then(() => {
			globalThis.replayableDebuggerDetach({ tabId: message.tabId }, "canceled_by_user");
			respond({});
		}, error => respond({ error: String(error) }));
		return true;
	}
});
${background.replace(defaultPort, `var DEFAULT_PORT = ${port};`)}`,
	);
}

/**
 * Captures the extension's real `chrome.debugger.onDetach` listener so a test
 * can replay the infobar-dismissal notification. A programmatic detach is not
 * that UI event, and the retraction under test is the extension's own handler
 * running — not a test-side stand-in for it.
 */
const DETACH_REPLAY_PRELUDE = `
const testRegisterDetach = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
chrome.debugger.onDetach.addListener = listener => {
	globalThis.replayableDebuggerDetach = listener;
	testRegisterDetach(listener);
};`;

/** Make Chrome refuse the next requested removals, to exercise the extension's close retries. */
const REFUSE_REMOVES_PRELUDE = `
const testRemoveTab = chrome.tabs.remove.bind(chrome.tabs);
chrome.tabs.remove = tabId => {
	if (globalThis.testRefuseRemoves > 0) {
		globalThis.testRefuseRemoves--;
		return Promise.reject(new Error("Tabs cannot be edited right now (user may be dragging a tab)."));
	}
	return testRemoveTab(tabId);
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
	/** Additional disposable extensions loaded beside the relay. */
	extensions?: string[];
}

/** Real extension bundle + optional foreign extensions + real relay server + real Chromium, all disposable. */
async function launchRelayFixture(options: FixtureOptions = {}): Promise<RelayFixture> {
	const port = await findFreeCdpPort();
	const server = startRelayServer({ port, group: false, log: options.log });
	const extension = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-isolation-"));
	const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-isolation-xdg-"));
	// Every fixture browser uses Chrome's real download naming and collision handling.
	const downloads = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-downloads-")));
	const profiles: string[] = [];
	const held: Array<PromiseWithResolvers<void>> = [];
	let heldArrived = Promise.withResolvers<void>();
	const pages = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const route = url.pathname;
			const attachment = (name: string) => ({
				"Content-Type": "text/csv",
				"Content-Disposition": `attachment; filename="${name}"`,
			});
			if (route === "/report.csv") return new Response("a,b\n1,2\n", { headers: attachment("report.csv") });
			if (route === "/held.csv") {
				const release = Promise.withResolvers<void>();
				held.push(release);
				heldArrived.resolve();
				heldArrived = Promise.withResolvers<void>();
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("a,b\n"));
						await release.promise;
						controller.enqueue(new TextEncoder().encode("1,2\n"));
						controller.close();
					},
				});
				return new Response(body, { headers: attachment("held.csv") });
			}
			const html =
				route === "/first"
					? `<title>First</title><button onclick="this.textContent='clicked'">First</button><p id="hover" onmouseover="this.textContent='hovered'">Hover</p>`
					: route === "/second"
						? "<title>Second</title><button>Second</button>"
						: route === "/login"
							? `<title>Login ${url.searchParams.get("who")}</title><form onsubmit="event.preventDefault(); document.title = 'Signed in'"><input id="pw" type="password"><button id="go">Log in</button></form>`
							: route === "/download"
								? `<title>Download</title><a id="report" href="/report.csv">Report</a><a id="held" href="/held.csv">Held</a>`
								: route === "/framed"
									? // Another site (localhost, not 127.0.0.1), so Chrome runs the frame in its own process and session.
										`<title>Framed</title><iframe src="http://localhost:${url.port}/download"></iframe>`
									: "<title>Human sentinel</title><h1>Keep me</h1>";
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		},
	});
	const browsers: Browser[] = [];
	async function close(): Promise<void> {
		// A failed test may leave a held download open; release it before stopping Chrome and the server.
		for (const release of held) release.resolve();
		try {
			await Promise.all(browsers.map(browser => closeLaunchedBrowser(browser).catch(() => undefined)));
		} finally {
			server.stop();
			pages.stop(true);
			await Promise.all(
				[extension, xdg, downloads, ...profiles].map(dir => fs.rm(dir, { recursive: true, force: true })),
			);
		}
	}
	async function launchBrowser(): Promise<RelayBrowser> {
		const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-profile-"));
		profiles.push(userDataDir);
		await Bun.write(
			path.join(userDataDir, "Default", "Preferences"),
			JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
		);
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			userDataDir,
			enableExtensions: true,
			// Software compositing avoids host-GPU stalls during background chrome.debugger captures.
			args: [
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				"--disable-gpu",
				...RENDERER_PRIORITY_ARGS,
			],
			env: {
				...process.env,
				XDG_CONFIG_HOME: path.join(xdg, "config"),
				XDG_CACHE_HOME: path.join(xdg, "cache"),
				XDG_DATA_HOME: path.join(xdg, "data"),
			},
		});
		browsers.push(browser);
		// Wait for content-script registration before loading fixture pages.
		for (const extensionPath of [extension, ...(options.extensions ?? [])])
			await browser.installExtension(extensionPath);
		const extensionId = await unpackedExtensionId(extension);
		if (!extensionId) throw new Error("Missing relay extension directory");
		// Registration runs in external Chromium, so fake timers cannot advance this readiness poll.
		const page = await browser.newPage();
		// Unpacked extension registration has no CDP event and can lag behind the launch result.
		const deadline = Date.now() + 10_000;
		for (;;) {
			try {
				await page.goto(`chrome-extension://${extensionId}/options.html`);
				break;
			} catch (error) {
				if (!String(error).includes("ERR_BLOCKED_BY_CLIENT") || Date.now() > deadline) throw error;
				await Bun.sleep(50);
			}
		}
		// The default page context exposes extension APIs; Puppeteer's isolated evaluate context does not.
		const cdp = await page.createCDPSession();
		async function inExtension(expression: string): Promise<unknown> {
			const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
				expression,
				awaitPromise: true,
				returnByValue: true,
			});
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value;
		}
		return { browser, inExtension };
	}
	try {
		await writeExtension(extension, port, `${REFUSE_REMOVES_PRELUDE}\n${options.prelude ?? ""}`);
		const { browser, inExtension } = await launchBrowser();
		const cdpUrl = `http://127.0.0.1:${port}`;
		const outcome = await waitForRelayExtension(cdpUrl);
		if (outcome !== "ready") throw new Error(`Relay fixture handshake failed: ${outcome}`);
		return {
			browser,
			inExtension,
			cdpUrl,
			server,
			launchBrowser,
			origin: `http://127.0.0.1:${pages.port}`,
			relayTargets() {
				return server.bridge.listTargets();
			},
			async chromeTabs() {
				const listed = await inExtension(
					`chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ id: tab.id, url: tab.url ?? "", active: tab.active })))`,
				);
				return listed as ChromeTab[];
			},
			downloads,
			async heldDownload(index) {
				while (held.length <= index) await heldArrived.promise;
				return held[index]!;
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

const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => null,
} as unknown as ToolSession;

/**
 * A stand-in password manager running `contentScript` on the fixture site, which may draw its `menu.html` and
 * `notification.html` into the page as chrome-extension:// frames.
 */
async function writeStandInVault(contentScript: string): Promise<string> {
	const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-vault-"));
	await fs.writeFile(
		path.join(vaultDir, "manifest.json"),
		JSON.stringify({
			manifest_version: 3,
			name: "Stand-in vault",
			version: "1.0",
			content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
			web_accessible_resources: [{ resources: ["menu.html", "notification.html"], matches: ["http://127.0.0.1/*"] }],
		}),
	);
	await fs.writeFile(path.join(vaultDir, "menu.html"), "<button>Fill</button>");
	await fs.writeFile(
		path.join(vaultDir, "notification.html"),
		"<title>Vault: save login</title><h3>Save login?</h3><button>Save</button>",
	);
	// A page the vault does not expose to sites, so no site can frame it.
	await fs.writeFile(path.join(vaultDir, "private.html"), "<title>Vault private</title>");
	await fs.writeFile(path.join(vaultDir, "content.js"), contentScript);
	return vaultDir;
}

/** The text a call showed the agent, or the error it failed with. */
const shown = (result: { displays: Array<{ type: string; text?: string }> }) =>
	result.displays.map(display => display.text ?? "").join("\n");

/** How often `text` holds `part`. */
const occurrences = (text: string, part: string) => text.split(part).length - 1;

/**
 * What the calls on tab `name` showed, starting with what `told` holds so far, until one names `extensionId` and then
 * one more: the relay reports what it hid while the calls go on, so a later call may carry it. At most 20 more calls.
 */
async function untilNamed(name: string, extensionId: string, ...told: string[]): Promise<string[]> {
	const titleCall = { code: "return await tab.title();", timeoutMs: 10_000, session };
	for (let call = 0; call < 20 && !told.some(text => text.includes(extensionId)); call++) {
		told.push(shown(await runInTab(name, titleCall)));
	}
	told.push(shown(await runInTab(name, titleCall)));
	return told;
}

/** The iframes in `page`, closed shadow roots included, that the relay emptied: they carry its blank `srcdoc`. */
async function emptiedFrames(page: Page): Promise<number> {
	const cdp = await page.createCDPSession();
	try {
		const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
		let count = 0;
		const visit = (node: Protocol.DOM.Node) => {
			if (node.nodeName === "IFRAME" && node.attributes?.some((name, i) => i % 2 === 0 && name === "srcdoc"))
				count++;
			for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
		};
		visit(root);
		return count;
	} finally {
		await cdp.detach();
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("relay tab isolation", () => {
	it("keeps another connection's cross-site frame alive when a page disables auto-attach", async () => {
		const fixture = await launchRelayFixture();
		let first: Browser | undefined;
		let second: Browser | undefined;
		try {
			const source = await fixture.browser.newPage();
			await source.goto(`${fixture.origin}/framed`);
			first = await puppeteer.connect({ browserURL: fixture.cdpUrl });
			second = await puppeteer.connect({ browserURL: fixture.cdpUrl });
			const firstPage = (await first.pages()).find(page => page.url() === source.url())!;
			const secondPage = (await second.pages()).find(page => page.url() === source.url())!;
			const frame = secondPage.frames().find(frame => frame.parentFrame())!;
			expect(
				await frame.client.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
			).toMatchObject({
				result: { value: "Download" },
			});
			const detached: string[] = [];
			secondPage.mainFrame().client.on("Target.detachedFromTarget", event => detached.push(event.sessionId));

			await firstPage.mainFrame().client.send("Target.setAutoAttach", {
				autoAttach: false,
				waitForDebuggerOnStart: false,
				flatten: true,
			});
			// A command on the surviving child proves Chrome did not tear down its shared session.
			expect(
				await frame.client.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
			).toMatchObject({
				result: { value: "Download" },
			});
			expect(detached).toEqual([]);
		} finally {
			await first?.disconnect();
			await second?.disconnect();
			await fixture.close();
		}
	});

	it("opens background tabs of its own and leaves borrowed pages open on close", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		await human.bringToFront();
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
			const hovered = await runInTab(names[0]!, {
				code: "await tab.hover('#hover'); return await tab.text('#hover');",
				timeoutMs: 15_000,
				session,
			});
			expect(hovered.returnValue).toBe("hovered");

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

			// `target` borrows the user's page; closing releases it without closing it.
			const borrowed = await acquireTab(names[2]!, relay, { target: "Human sentinel", timeoutMs: 20_000 });
			expect(borrowed.tab.targetId).not.toBe(first.tab.targetId);
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
	it("keeps owned relay identity and background capture after its worker exits", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		await human.goto(`${fixture.origin}/human`);
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-worker-exit-${process.pid}`;
		const session = makeSession();
		try {
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 20_000 });
			if (tab.backend !== "worker") throw new Error("Expected a worker tab");
			const targetId = tab.targetId;
			const uploadDir = tab.uploadDir;
			await runInTab(name, {
				code: "await tab.click('button');",
				timeoutMs: 15_000,
				session,
			});
			await expect(runInTab(name, { code: "process.exit(3);", timeoutMs: 20_000, session })).rejects.toThrow(
				"Browser tab worker exited unexpectedly",
			);
			const recovered = await runInTab(name, {
				code: "const shot = await tab.screenshot({ silent: true }); return { shot, text: await tab.text('button') };",
				timeoutMs: 20_000,
				session,
			});
			const value = recovered.returnValue as { shot: string; text: string };
			try {
				expect(value.text).toBe("clicked");
				expect(await Bun.file(value.shot).exists()).toBe(true);
			} finally {
				await fs.rm(value.shot, { force: true });
			}
			expect(tab.targetId).toBe(targetId);
			expect(tab.uploadDir).toBe(uploadDir);
			expect(tab.ownsPage).toBe(true);
			const listed = await fixture.chromeTabs();
			expect(
				listed.filter(candidate => candidate.url.endsWith("/human")).map(candidate => candidate.active),
			).toEqual([true]);
			expect(listed.find(candidate => candidate.id === chromeTabIdOf(targetId))?.active).toBe(false);
			await releaseTab(name);
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === chromeTabIdOf(targetId))).toBe(false);
			expect(human.isClosed()).toBe(false);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await human.close().catch(() => undefined);
			await fixture.close();
		}
	}, 120_000);

	it("keeps an owned page alive after a failed init so the retry can adopt it", async () => {
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browser)) throw new Error("Expected a Chromium handle");
		const page: Page = await browser.browser.newPage();
		await page.goto("data:text/html,<title>Recovery sentinel</title>");
		const targetId = targetIdOf(page.target());
		if (targetId === undefined) throw new Error("Missing target id");
		const payload: WorkerInitPayload = {
			mode: "attach",
			browserWSEndpoint: browser.wsEndpoint,
			safeDir: getPuppeteerDir(),
			uploadDir: newUploadStagingDir(),
			page: { kind: "owned", targetId },
			recover: true,
		};
		const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recovery-download-"));
		const blockedDownloadPath = path.join(downloadDir, "not-a-directory");
		await fs.writeFile(blockedDownloadPath, "existing file");
		const failed = startWorker({ ...payload, downloadsPath: blockedDownloadPath });
		let retried: TestWorker | undefined;
		try {
			// A retry adopts this same target, so a failed init must not destroy
			// an owned page the supervisor still has to clean up.
			const failure = await failed.outcome;
			expect(failure.type).toBe("init-failed");
			if (failure.type !== "init-failed") throw new Error("Expected initialization to fail on the download path");
			expect(failure.error.message).toContain(blockedDownloadPath);
			expect(page.isClosed()).toBe(false);

			retried = startWorker(payload);
			const ready = await retried.outcome;
			expect(ready.type, JSON.stringify(ready)).toBe("ready");
			if (ready.type === "ready") expect(ready.info.targetId).toBe(targetId);
			await retried.close();
			retried = undefined;
			// Ask Chrome directly: this Puppeteer connection may not have received its target event yet.
			const session = await browser.browser.target().createCDPSession();
			try {
				const { targetInfos } = await session.send("Target.getTargets");
				expect(targetInfos.map(info => info.targetId)).not.toContain(targetId);
			} finally {
				await session.detach();
			}
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await fs.rm(downloadDir, { recursive: true, force: true });
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
			expect(
				await fixture.inExtension(
					`chrome.runtime.sendMessage({ op: "dismissDebugger", tabId: ${ownedChromeTab} })`,
				),
			).toEqual({});
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

describe.skipIf(!CHROMIUM_AVAILABLE)("relay multi-browser placement and cleanup", () => {
	it("opens a default tab in the browser of the tab omp used last, not the first selected one", async () => {
		const secondHello = Promise.withResolvers<void>();
		let hellos = 0;
		const fixture = await launchRelayFixture({
			log(message) {
				if (message === "extension connected" && ++hellos === 2) secondHello.resolve();
			},
		});
		const human = await fixture.browser.newPage();
		await human.goto(`${fixture.origin}/human`);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [
			`relay-near-human-${process.pid}`,
			`relay-near-other-${process.pid}`,
			`relay-near-own-${process.pid}`,
		];
		const browserOf = (targetId: string) => targetId.slice(4, targetId.lastIndexOf("."));
		try {
			const inFirst = await acquireTab(names[0]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			const other = await fixture.launchBrowser();
			await secondHello.promise;
			await (await other.browser.newPage()).goto(`${fixture.origin}/first`);
			const inSecond = await acquireTab(names[1]!, relay, { target: "First", timeoutMs: 15_000 });
			expect(browserOf(inSecond.tab.targetId)).not.toBe(browserOf(inFirst.tab.targetId));
			const owned = await acquireTab(names[2]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 15_000 });
			expect(browserOf(owned.tab.targetId)).toBe(browserOf(inSecond.tab.targetId));
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes an owned tab Chrome refuses to close at first", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-refused-close-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 15_000 });
			// A release sends two closes (the worker's, then the supervisor's by id); Chrome refuses the first two tries.
			await fixture.inExtension('chrome.runtime.sendMessage({ op: "refuseRemoves", count: 2 })');
			await releaseTab(name);
			// The close returned with the tab gone.
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === chromeTabIdOf(tab.targetId))).toBe(
				false,
			);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("leaves a persist tab open in the user's browser when its session ends and closes the others", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const owner = `relay-session-${process.pid}`;
		const names = [`relay-persist-${process.pid}`, `relay-plain-${process.pid}`];
		try {
			const kept = await acquireTab(names[0]!, relay, {
				url: `${fixture.origin}/first`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
				persist: true,
			});
			const closed = await acquireTab(names[1]!, relay, {
				url: `${fixture.origin}/second`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
			});
			// What session dispose runs.
			expect(await releaseTabsForOwner(owner, { kill: true })).toBe(2);
			const keptTabId = chromeTabIdOf(kept.tab.targetId);
			expect((await fixture.chromeTabs()).find(tab => tab.id === keptTabId)?.url).toBe(`${fixture.origin}/first`);
			expect((await fixture.chromeTabs()).some(tab => tab.id === chromeTabIdOf(closed.tab.targetId))).toBe(false);
			expect(getTabsMapForTest().has(names[0]!)).toBeFalse();
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes a persist tab whose close joins its session's end", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const owner = `relay-joined-session-${process.pid}`;
		const name = `relay-joined-close-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, {
				url: `${fixture.origin}/first`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
				persist: true,
			});
			const ending = releaseTabsForOwner(owner, { kill: true });
			expect(await releaseTab(name)).toBe(true);
			await ending;
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === chromeTabIdOf(tab.targetId))).toBe(
				false,
			);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes a persist tab when its close joins after the keep decision and browser disconnect", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		if (!("browser" in relay)) throw new Error("Expected relay Chromium");
		const owner = `relay-late-session-${process.pid}`;
		const name = `relay-late-close-${process.pid}`;
		const disconnect = relay.browser.disconnect.bind(relay.browser);
		let closing: Promise<boolean> | undefined;
		try {
			const { tab } = await acquireTab(name, relay, {
				url: `${fixture.origin}/first`,
				timeoutMs: 15_000,
				ownerSessionId: owner,
				persist: true,
			});
			// releaseBrowser disconnects only after the supervisor has decided to keep the page.
			relay.browser.disconnect = () => {
				const disconnected = disconnect();
				closing = releaseTab(name);
				return disconnected;
			};
			await releaseTabsForOwner(owner, { kill: true });
			expect(closing).toBeDefined();
			expect(await closing).toBe(true);
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === chromeTabIdOf(tab.targetId))).toBe(
				false,
			);
		} finally {
			relay.browser.disconnect = disconnect;
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("empties a password manager's menu only in the tab omp drives", async () => {
		// A stand-in password manager: a focused password field opens its inline menu, a chrome-extension:// frame in
		// a closed shadow root, the way 1Password draws it.
		const vaultDir = await writeStandInVault(
			`document.addEventListener("focusin", event => {
	if (event.target.type !== "password" || document.querySelector("vault-menu")) return;
	const host = document.createElement("vault-menu");
	const menu = document.createElement("iframe");
	menu.src = chrome.runtime.getURL("menu.html");
	host.attachShadow({ mode: "closed" }).append(menu);
	document.body.append(host);
});`,
		);
		const fixture = await launchRelayFixture({ extensions: [vaultDir] });
		const menuOpen = (page: Page) => page.frames().some(frame => frame.url().startsWith("chrome-extension://"));
		const driven = await fixture.browser.newPage();
		await driven.goto(`${fixture.origin}/login?who=driven`);
		// The user's own tab has its menu open when omp connects.
		const user = await fixture.browser.newPage();
		await user.goto(`${fixture.origin}/login?who=user`);
		await user.focus("#pw");
		await user.waitForFrame(frame => frame.url().startsWith("chrome-extension://"));
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-vault-${process.pid}`;
		const fill = {
			code: "await tab.fill('#pw', 'secret'); return await tab.value('#pw');",
			timeoutMs: 10_000,
			session: makeSession(),
		};
		try {
			await acquireTab(name, relay, { target: "Login driven", timeoutMs: 20_000 });
			// Focusing the field opens the menu, and Chrome detaches omp from the tab during the call.
			const failed = await runInTab(name, fill).then(shown, (error: unknown) => String(error));
			const filled = await runInTab(name, fill);
			expect(filled.returnValue).toBe("secret");
			// A call names what omp hid, once: that call, the next or a later one, as the relay reports it. Chrome can
			// also drop omp as the menu starts loading and that load then never commit: omp hid nothing, and says nothing.
			const vaultId = await unpackedExtensionId(vaultDir);
			if (!vaultId) throw new Error("Missing stand-in vault directory");
			if ((await emptiedFrames(driven)) > 0) {
				const told = await untilNamed(name, vaultId, failed, shown(filled));
				expect(occurrences(told.join("\n"), vaultId)).toBe(1);
				expect(told.join("\n")).toContain(`"menu.html"`);
				expect(told.at(-1)).not.toContain(vaultId);
			} else {
				expect(`${failed}\n${shown(filled)}\n${shown(await runInTab(name, fill))}`).not.toContain(vaultId);
			}
			// The menu opened, and its frame was emptied.
			expect(await driven.$("vault-menu")).not.toBeNull();
			expect(menuOpen(driven)).toBeFalse();
			// Chrome refused the relay the user's tab too, yet its menu there is left alone.
			expect(menuOpen(user)).toBeTrue();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
			await fs.rm(vaultDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("says once what it hid when a submit opens a password manager's save card", async () => {
		const vaultDir = await writeStandInVault(
			`document.addEventListener("submit", () => {
	const card = document.createElement("vault-notification");
	const frame = document.createElement("iframe");
	card.attachShadow({ mode: "closed" }).append(frame);
	document.documentElement.append(card);
	frame.src = chrome.runtime.getURL("notification.html");
}, true);`,
		);
		const fixture = await launchRelayFixture({ extensions: [vaultDir] });
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-vault-submit-${process.pid}`;
		const title = { code: "return await tab.title();", timeoutMs: 10_000, session };
		try {
			await acquireTab(name, relay, { url: `${fixture.origin}/login?who=submit`, timeoutMs: 20_000 });
			const page = (await fixture.browser.pages()).find(page => page.url().includes("who=submit"));
			if (!page) throw new Error("omp's tab is gone");
			const vaultId = await unpackedExtensionId(vaultDir);
			if (!vaultId) throw new Error("Missing stand-in vault directory");
			// The page adds frames of its own as the card opens, so one sweep empties them with it: one to an extension
			// that is not installed, one to a vault page no site may load, and one whose `src` carries page text.
			await page.evaluate(`document.addEventListener("submit", () => {
	for (const src of ["chrome-extension://${"p".repeat(32)}/decoy.html", "chrome-extension://${vaultId}/private.html", "chrome-extension://${vaultId}/Page text/../notification.html"]) {
		const frame = document.createElement("iframe");
		frame.src = src;
		document.body.append(frame);
	}
});`);
			// The card starts loading as the click submits, so Chrome may drop omp during this call.
			const submitted = await runInTab(name, { code: "await tab.click('#go');", timeoutMs: 10_000, session }).then(
				shown,
				(error: unknown) => String(error),
			);
			const after = await runInTab(name, title);
			expect(after.returnValue).toBe("Signed in");
			const told = await untilNamed(name, vaultId, submitted, shown(after));
			// The card's page, once, by the title the vault gave it.
			expect(occurrences(told.join("\n"), vaultId)).toBe(1);
			expect(told.join("\n")).toContain(`"notification.html"`);
			expect(told.join("\n")).toContain(`"Vault: save login"`);
			expect(told.at(-1)).not.toContain(vaultId);
			// The page's frames to an extension that is not installed, or to a page the vault does not expose, are emptied
			// but never reported: they could not have shown that extension's page. A `/../` in a planted `src` still
			// loads the vault's page; only the URL that loaded is reported.
			expect(told.join("\n")).not.toContain("decoy.html");
			expect(told.join("\n")).not.toContain("private.html");
			expect(told.join("\n")).not.toContain("Page text");
			expect(page.frames().filter(frame => frame.url().startsWith("chrome-extension://"))).toEqual([]);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
			await fs.rm(vaultDir, { recursive: true, force: true });
		}
	}, 60_000);
	it("closes an owned relay tab whose debugger the user dismissed", async () => {
		const detached = Promise.withResolvers<void>();
		let ownedTabId = 0;
		const fixture = await launchRelayFixture({
			prelude: DETACH_REPLAY_PRELUDE,
			log(message, data) {
				if (
					message === "tab detached" &&
					typeof data?.tabKey === "string" &&
					data.tabKey.endsWith(`:${ownedTabId}`)
				)
					detached.resolve();
			},
		});
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-detached-${process.pid}`;
		const otherName = `relay-detached-other-${process.pid}`;
		try {
			const human = await fixture.browser.newPage();
			await human.goto(`${fixture.origin}/human`);
			const { tab: other } = await acquireTab(otherName, relay, {
				url: `${fixture.origin}/second`,
				timeoutMs: 20_000,
			});
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 20_000 });
			ownedTabId = chromeTabIdOf(tab.targetId);
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeTrue();
			// Replay the infobar dismissal through the extension's real listener.
			expect(
				await fixture.inExtension(`chrome.runtime.sendMessage({ op: "dismissDebugger", tabId: ${ownedTabId} })`),
			).toEqual({});
			await detached.promise;
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeFalse();
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === ownedTabId)).toBe(true);
			await releaseTab(name);
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === ownedTabId)).toBe(false);
			expect((await fixture.chromeTabs()).some(candidate => candidate.id === chromeTabIdOf(other.targetId))).toBe(
				true,
			);
			expect(await human.title()).toBe("Human sentinel");
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseTab(otherName).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("drops a closed owned tab's handle and browser hold when timeout recovery loses its connection", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		if (!("browser" in relay)) throw new Error("Expected relay Chromium connection");
		const name = `relay-closed-recovery-${process.pid}`;
		const referencesBefore = relay.refCount;
		const runAc = new AbortController();
		let unsubscribe: (() => void) | undefined;
		let runFailure: Promise<unknown> | undefined;
		try {
			const { tab } = await acquireTab(name, relay, { timeoutMs: 15_000 });
			expect(tab.backend).toBe("worker");
			if (tab.backend !== "worker") throw new Error("Expected relay tab worker");
			expect(tab.ownsPage).toBe(true);
			const gone = Promise.withResolvers<void>();
			const connection = browserConnection(relay.browser);
			const onGone = (event: { targetId: string }) => {
				if (event.targetId === tab.targetId) gone.resolve();
			};
			// Worker readiness does not mean the registry's separate CDP connection initialized the target.
			connection.on("Target.targetDestroyed", onGone);
			unsubscribe = () => connection.off("Target.targetDestroyed", onGone);
			runFailure = rejectionOf(
				runInTab(name, {
					code: "await page.close(); await wait(60_000);",
					timeoutMs: 5_000,
					signal: runAc.signal,
					session: makeSession(),
				}),
			);
			// An error before page.close must not strand the fixture on an event that can no longer arrive.
			await Promise.race([
				gone.promise,
				runFailure.then(error => {
					throw error;
				}),
			]);
			expect(fixture.relayTargets().some(target => target.id === tab.targetId)).toBe(false);
			relay.browser.disconnect();
			const error = await runFailure;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toStartWith("Browser code execution timed out after 5000ms");
			expect(getTabsMapForTest().has(name)).toBe(false);
			expect(relay.refCount).toBe(referencesBefore);
		} finally {
			runAc.abort();
			unsubscribe?.();
			try {
				await releaseTab(name).catch(() => undefined);
				await runFailure?.catch(() => undefined);
				await releaseBrowser(relay, { kill: false });
			} finally {
				await fixture.close();
			}
		}
	}, 30_000);

	async function waitForDownload(name: string): Promise<BrowserDownload> {
		const result = await runInTab(name, {
			code: "return await tab.waitForDownload({ timeout: 10000 });",
			timeoutMs: 20_000,
			session: makeSession(),
		});
		return result.returnValue as BrowserDownload;
	}

	it("reports a relay tab's downloads, from its page and a cross-site frame, at the path Chrome saved them to", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-download-${process.pid}`;
		const session = makeSession();
		try {
			await acquireTab(name, relay, { url: `${fixture.origin}/download`, timeoutMs: 15_000 });
			// Clicked before any wait: the tab tracks downloads from the moment it opens.
			await runInTab(name, { code: "await tab.click('#report');", timeoutMs: 20_000, session });
			const download = await waitForDownload(name);
			expect(download).toEqual({
				path: path.join(fixture.downloads, "report.csv"),
				suggestedFilename: "report.csv",
				url: `${fixture.origin}/report.csv`,
				bytes: 8,
			});
			expect(await Bun.file(download.path).text()).toBe("a,b\n1,2\n");

			await runInTab(name, {
				code: `await tab.goto(${JSON.stringify(`${fixture.origin}/framed`)}); await (await tab.frame('iframe')).click('#report');`,
				timeoutMs: 20_000,
				session,
			});
			const framed = await waitForDownload(name);
			expect(framed.url).toBe(`http://localhost:${new URL(fixture.origin).port}/report.csv`);
			expect(framed.path).toBe(path.join(fixture.downloads, "report (1).csv"));
			const listed = await runInTab(name, { code: "return await tab.downloads();", timeoutMs: 10_000, session });
			expect(listed.returnValue).toEqual([download, framed]);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("reports each relay download's own file when a later download of the same URL finishes first", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-download-held-${process.pid}`;
		const session = makeSession();
		try {
			await acquireTab(name, relay, { url: `${fixture.origin}/download`, timeoutMs: 15_000 });
			await runInTab(name, { code: "await tab.click('#held');", timeoutMs: 20_000, session });
			const first = await fixture.heldDownload(0);
			await runInTab(name, { code: "await tab.click('#held');", timeoutMs: 20_000, session });
			const second = await fixture.heldDownload(1);
			// Chrome names the first `held.csv` and the second `held (1).csv`; the second finishes first.
			second.resolve();
			const later = await waitForDownload(name);
			expect(later.path).toBe(path.join(fixture.downloads, "held (1).csv"));
			first.resolve();
			const earlier = await waitForDownload(name);
			expect(earlier.path).toBe(path.join(fixture.downloads, "held.csv"));
			expect(await Bun.file(earlier.path).text()).toBe("a,b\n1,2\n");
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("owned tab recovery", () => {
	it("keeps an owned target alive after a failed recovery init so a retry can adopt it", async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected Chromium");
		const page = await launched.browser.newPage();
		await page.goto("data:text/html,<title>Recovery sentinel</title>");
		const target = page.target();
		if (!("_targetId" in target) || typeof target._targetId !== "string") throw new Error("Missing target ID");
		const payload: WorkerInitPayload = {
			mode: "attach",
			browserWSEndpoint: launched.wsEndpoint,
			safeDir: getPuppeteerDir(),
			uploadDir: newUploadStagingDir(),
			page: { kind: "owned", targetId: target._targetId },
			recover: true,
		};
		const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recovery-download-"));
		const blockedDownloadPath = path.join(downloadDir, "not-a-directory");
		await fs.writeFile(blockedDownloadPath, "existing file");
		const failed = startWorker({ ...payload, downloadsPath: blockedDownloadPath });
		let retried: TestWorker | undefined;
		try {
			expect((await failed.outcome).type).toBe("init-failed");
			expect(page.isClosed()).toBeFalse();
			retried = startWorker(payload);
			const ready = await retried.outcome;
			if (ready.type !== "ready") throw new Error("Expected the retry to adopt the owned target");
			expect(ready.info.targetId).toBe(target._targetId);
			await retried.close();
			retried = undefined;
			// Closing the worker that owns the page closes it. Ask Chrome: this connection's `page`
			// learns of the close only once its own target event arrives.
			const session = await launched.browser.target().createCDPSession();
			try {
				const { targetInfos } = await session.send("Target.getTargets");
				expect(targetInfos.map(info => info.targetId)).not.toContain(target._targetId);
			} finally {
				await session.detach();
			}
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await fs.rm(downloadDir, { recursive: true, force: true });
			await releaseBrowser(launched, { kill: true });
		}
	}, 30_000);
});
