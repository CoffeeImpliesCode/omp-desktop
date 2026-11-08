import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort, gracefulKillTreeOnce, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable, RENDERER_PRIORITY_ARGS } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	acquireBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	decodePng,
	type DiffScreenshotResult,
	type ScreenshotChangeResult,
} from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => null,
} as unknown as ToolSession;

const page = (title: string, color: string): string =>
	`data:text/html,${encodeURIComponent(`<title>${title}</title><body style="margin:0;background:${color}"></body>`)}`;

/**
 * Paint the tab a fresh color and capture it in the same run: the PNG proves the
 * capture shows that tab's current pixels, not a sibling's or a stale frame.
 */
async function repaintAndCapture(name: string, color: string): Promise<[number, number, number]> {
	const result = await runInTab(name, {
		code: `
			await tab.evaluate(${JSON.stringify(`document.body.style.background = "${color}"`)});
			return await tab.screenshot({ format: "png", silent: true });
		`,
		timeoutMs: 15_000,
		session,
	});
	const { pixels } = decodePng(await fs.readFile(result.returnValue as string));
	return [pixels[0], pixels[1], pixels[2]];
}

const visibility = (target: Page): Promise<string> => target.evaluate("document.visibilityState") as Promise<string>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

/** A headless Chromium on a CDP port, attached the way `app.cdp_url` attaches a user's browser. */
async function connectedBrowser(): Promise<PuppeteerBrowserHandle> {
	const exe = await ensureChromiumExecutable();
	if (!exe) throw new Error("Expected a Chromium executable");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-screenshot-background-"));
	const port = await findFreeCdpPort();
	const child = Bun.spawn(
		[
			exe,
			"--headless=new",
			"--no-sandbox",
			"--no-startup-window",
			"--no-first-run",
			"--no-default-browser-check",
			"--use-mock-keychain",
			"--password-store=basic",
			...RENDERER_PRIORITY_ARGS,
			`--user-data-dir=${root}`,
			`--remote-debugging-port=${port}`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	cleanups.push(async () => {
		await gracefulKillTreeOnce(child.pid);
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	});
	const cdpUrl = `http://127.0.0.1:${port}`;
	await waitForCdp(cdpUrl, 15_000);
	const handle = await acquireBrowser({ kind: "connected", cdpUrl }, { cwd: process.cwd() });
	if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
	cleanups.push(() => releaseBrowser(handle, { kill: false }));
	return handle;
}

describe.skipIf(!CHROMIUM_AVAILABLE)("browser screenshots of background tabs", () => {
	it("captures a targeted background tab without switching the user's visible tab", async () => {
		const handle = await connectedBrowser();
		const agentPage = await handle.browser.newPage();
		await agentPage.goto(page("agent-tab", "#0000ff"));
		const userPage = await handle.browser.newPage();
		await userPage.goto(page("user-tab", "#ffffff"));
		await userPage.bringToFront();
		const name = `background-target-${process.pid}`;
		cleanups.push(async () => {
			await releaseTab(name);
		});
		await acquireTab(name, handle, { target: "agent-tab", timeoutMs: 30_000 });

		expect(await repaintAndCapture(name, "#00ff00")).toEqual([0, 255, 0]);
		expect(await visibility(userPage)).toBe("visible");
		expect(await visibility(agentPage)).toBe("hidden");
	}, 45_000);

	it.each(["selector", "fullPage"] as const)(
		"captures a background %s without selecting the borrowed tab",
		async scope => {
			const handle = await connectedBrowser();
			const agentPage = await handle.browser.newPage();
			await agentPage.setViewport({ width: 320, height: 240, deviceScaleFactor: 1 });
			const html = `<title>scoped-tab</title><body style="margin:0;height:2400px;background:#00ff00">
				<div id="capture" style="position:absolute;top:1800px;width:80px;height:60px;background:#0000ff"></div>
			</body>`;
			await agentPage.goto(`data:text/html,${encodeURIComponent(html)}`);
			const userPage = await handle.browser.newPage();
			await userPage.goto(page("user-tab", "#ffffff"));
			await userPage.bringToFront();
			const name = `background-${scope}-${process.pid}`;
			cleanups.push(async () => {
				await releaseTab(name);
			});
			await acquireTab(name, handle, { target: "scoped-tab", timeoutMs: 30_000 });

			const options = scope === "selector" ? { selector: "#capture" } : { fullPage: true };
			const result = await runInTab(name, {
				code: `
					await tab.evaluate("document.querySelector('#capture').style.background = '#ff0000'");
					return await tab.screenshot(${JSON.stringify({ ...options, format: "png", silent: true })});
				`,
				timeoutMs: 15_000,
				session,
			});
			const dest = result.returnValue as string;
			cleanups.push(() => fs.rm(dest, { force: true }));
			const image = decodePng(await fs.readFile(dest));
			if (scope === "selector") {
				expect([image.width, image.height]).toEqual([80, 60]);
				expect([...image.pixels.subarray(0, 3)]).toEqual([255, 0, 0]);
			} else {
				expect(image.height).toBe(2400);
				expect([...image.pixels.subarray(0, 3)]).toEqual([0, 255, 0]);
				const targetPixel = (1800 * image.width + 1) * 4;
				expect([...image.pixels.subarray(targetPixel, targetPixel + 3)]).toEqual([255, 0, 0]);
			}
			expect(await visibility(userPage)).toBe("visible");
			expect(await visibility(agentPage)).toBe("hidden");
		},
		45_000,
	);

	it("diffs and tracks changed pixels after the user switches away from an adopted tab", async () => {
		const handle = await connectedBrowser();
		const adopted = await handle.browser.newPage();
		await adopted.goto(page("diff-tab", "#0000ff"));
		await adopted.bringToFront();
		const name = `background-diff-${process.pid}`;
		cleanups.push(async () => {
			await releaseTab(name);
		});
		await acquireTab(name, handle, { timeoutMs: 30_000 });
		const baseline = await runInTab(name, {
			code: `return await tab.screenshot({ format: "png", ifChanged: true, silent: true });`,
			timeoutMs: 15_000,
			session,
		});
		const baselineCapture = baseline.returnValue as ScreenshotChangeResult;
		if (!baselineCapture.path) throw new Error("Expected the first tracked capture to save an image");
		const baselinePath = baselineCapture.path;
		cleanups.push(() => fs.rm(baselinePath, { force: true }));
		const userPage = await handle.browser.newPage();
		await userPage.goto(page("user-tab", "#ffffff"));
		await userPage.bringToFront();

		const diff = await runInTab(name, {
			code: `
				await tab.evaluate("document.body.style.background = '#ff0000'");
				return await tab.diffScreenshot(${JSON.stringify(baselinePath)});
			`,
			timeoutMs: 15_000,
			session,
		});
		const difference = diff.returnValue as DiffScreenshotResult;
		cleanups.push(() => fs.rm(difference.diffPath, { force: true }));
		expect(difference.changed).toBe(true);
		expect(difference.pixelChangeRatio).toBe(1);
		expect(decodePng(await fs.readFile(difference.diffPath)).width).toBeGreaterThan(0);
		expect(await visibility(userPage)).toBe("visible");
		expect(await visibility(adopted)).toBe("hidden");

		const tracked = await runInTab(name, {
			code: `
				const changed = await tab.screenshot({ format: "png", ifChanged: true, silent: true });
				const unchanged = await tab.screenshot({ format: "png", ifChanged: true, silent: true });
				return { changed, unchanged };
			`,
			timeoutMs: 15_000,
			session,
		});
		const captures = tracked.returnValue as { changed: ScreenshotChangeResult; unchanged: ScreenshotChangeResult };
		if (!captures.changed.path) throw new Error("Expected a changed capture to save an image");
		const changedPath = captures.changed.path;
		cleanups.push(() => fs.rm(changedPath, { force: true }));
		expect(captures.changed).toMatchObject({ changed: true, revision: 2, pixelChangeRatio: 1 });
		expect(captures.unchanged).toEqual({ changed: false, revision: 2, pixelChangeRatio: 0 });
		const image = decodePng(await fs.readFile(changedPath));
		expect([...image.pixels.subarray(0, 3)]).toEqual([255, 0, 0]);
		expect(await visibility(userPage)).toBe("visible");
		expect(await visibility(adopted)).toBe("hidden");
	}, 45_000);

	it("captures the adopted tab after the user switched away from it", async () => {
		const handle = await connectedBrowser();
		const adopted = await handle.browser.newPage();
		await adopted.goto(page("adopted-tab", "#0000ff"));
		await adopted.bringToFront();
		const name = `background-adopted-${process.pid}`;
		cleanups.push(async () => {
			await releaseTab(name);
		});
		await acquireTab(name, handle, { timeoutMs: 30_000 });
		const userPage = await handle.browser.newPage();
		await userPage.goto(page("user-tab", "#ffffff"));
		await userPage.bringToFront();

		expect(await repaintAndCapture(name, "#ff0000")).toEqual([255, 0, 0]);
		expect(await visibility(userPage)).toBe("visible");
	}, 45_000);

	it("captures an OMP-owned tab without bringing it in front of another page", async () => {
		const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
		cleanups.push(async () => {
			if (handle.browser.connected) await releaseBrowser(handle, { kill: true });
		});
		const name = `background-owned-${process.pid}`;
		cleanups.push(async () => {
			await releaseTab(name, { kill: true });
		});
		await acquireTab(name, handle, { url: page("owned-tab", "#0000ff"), timeoutMs: 30_000 });
		const foreground = await handle.browser.newPage();
		cleanups.push(() => foreground.close());
		await foreground.goto(page("foreground", "#ffffff"));
		await foreground.bringToFront();

		expect(await repaintAndCapture(name, "#ffff00")).toEqual([255, 255, 0]);
		expect(await visibility(foreground)).toBe("visible");
	}, 45_000);
});
