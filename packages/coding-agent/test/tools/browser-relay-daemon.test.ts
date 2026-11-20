import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { DAEMON_DIR_ENV, DAEMON_RESUME_ENV, DAEMON_TCP_ENV, GLOBAL_SCOPE } from "../../src/daemon/protocol";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import { probeRelayServer } from "../../src/tools/browser/relay/daemon";
import { DEFAULT_RELAY_URL } from "../../src/tools/browser/relay/kind";
import { DISCARDED_TABS_PROTOCOL_VERSION, type ExtToRelayMessage } from "../../src/tools/browser/relay/protocol";
import { TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 75_000;
const PROTOCOL = String(DISCARDED_TABS_PROTOCOL_VERSION);

interface RelayConsumer {
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	result(): Promise<string>;
	dispose(): Promise<void>;
}

function relayIdentity(port: number) {
	const isDefault = String(port) === new URL(DEFAULT_RELAY_URL).port;
	return { kind: "proc", scope: GLOBAL_SCOPE, key: isDefault ? "omp.browser.relay" : "omp.browser.relay." + port };
}

function relayUrl(port: number): string {
	return "http://127.0.0.1:" + port;
}

async function writeConsumer(root: string): Promise<string> {
	const script = path.join(root, "relay-consumer.ts");
	const source = (file: string) => JSON.stringify(path.resolve(import.meta.dir, "../../src", file));
	const utils = JSON.stringify(path.resolve(import.meta.dir, "../../../utils/src/worker-host.ts"));
	await Bun.write(
		script,
		`import { declareWorkerHostEntry } from ${utils};
import { runBrowserRelayCommand } from ${source("cli/browser-relay-cli.ts")};
import { closeDaemonClient } from ${source("daemon/client.ts")};
import { acquireBrowser, releaseBrowser } from ${source("tools/browser/registry.ts")};
import { ensureRelayDaemon, probeRelayServer } from ${source("tools/browser/relay/daemon.ts")};
import { probeCdpResponse } from ${source("tools/browser/attach.ts")};

const [mode, ...args] = process.argv.slice(2);
if (mode === "browser-relay") {
	await runBrowserRelayCommand({ action: "serve", port: Number(args[1]) });
} else {
	const urls = args.map(port => "http://127.0.0.1:" + port);
	try {
		if (mode === "acquire") {
			declareWorkerHostEntry();
			const cdpUrl = urls[0]!;
			const handle = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() });
			try {
				const response = await probeCdpResponse(cdpUrl + "/json/version", { timeoutMs: 2_000 });
				if (response?.status !== 200) throw new Error("replacement relay not ready");
				const body = JSON.parse(response.body);
				console.log(JSON.stringify({
					connected: "browser" in handle && handle.browser.connected,
					generation: "daemonLease" in handle ? handle.daemonLease?.unit.generation : undefined,
					version: body.ompRelayVersion,
					clients: body.ompRelayCdpClients,
				}));
			} finally {
				await releaseBrowser(handle, { kill: false });
			}
		} else {
			const leases = [];
			for (const cdpUrl of urls) {
				const lease = await ensureRelayDaemon({ cdpUrl });
				if (!lease) throw new Error("relay did not start at " + cdpUrl);
				leases.push(lease);
			}
			if (mode === "hold") {
				for await (const _ of process.stdin) { /* Hold the lease until EOF. */ }
			} else {
				console.log(JSON.stringify({
					units: leases.map(lease => lease.unit.id),
					serving: await Promise.all(urls.map(probeRelayServer)),
				}));
			}
		}
	} finally {
		await closeDaemonClient();
	}
}`,
	);
	return script;
}

function spawnConsumer(
	daemon: TestDaemon,
	cwd: string,
	script: string,
	mode: "hold" | "check" | "acquire",
	...ports: number[]
): RelayConsumer {
	// HOME alone does not isolate XDG hosts. Pin the daemon socket too, regardless of inherited config.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[DAEMON_DIR_ENV]: daemon.dir,
		[DAEMON_TCP_ENV]: undefined,
		[DAEMON_RESUME_ENV]: undefined,
		HOME: daemon.root,
		USERPROFILE: daemon.root,
		OMP_PROFILE: path.basename(cwd),
		PI_CONFIG_DIR: path.join(daemon.root, "omp"),
		PI_CODING_AGENT_DIR: path.join(daemon.root, "agent"),
		XDG_CONFIG_HOME: path.join(daemon.root, "config"),
		XDG_STATE_HOME: path.join(daemon.root, "state"),
		XDG_DATA_HOME: path.join(daemon.root, "data"),
		XDG_CACHE_HOME: path.join(daemon.root, "cache"),
		NO_PROXY: "127.0.0.1",
		no_proxy: "127.0.0.1",
	};
	const timeoutMs = mode === "acquire" ? 40_000 : mode === "check" ? 35_000 : 5_000;
	const proc = Bun.spawn([process.execPath, script, mode, ...ports.map(String)], {
		cwd,
		env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	return {
		proc,
		async result() {
			const [exit, out, err] = await withTimeout(
				Promise.all([proc.exited, stdout, stderr]),
				timeoutMs,
				`Relay consumer (${mode}) did not exit`,
			);
			expect(exit, err).toBe(0);
			return out;
		},
		async dispose() {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill();
			await Promise.all([proc.exited, stdout, stderr]);
		},
	};
}

function extensionHello(port: number, signal: AbortSignal): Promise<WebSocket> {
	const hello: ExtToRelayMessage = {
		t: "hello",
		userAgent: "test",
		browserVersion: "Chrome/150",
		tabs: [],
		attachedTabIds: [],
		discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
	};
	return until(async () => {
		signal.throwIfAborted();
		const socket = new WebSocket("ws://127.0.0.1:" + port + "/ext");
		const opened = Promise.withResolvers<boolean>();
		socket.addEventListener("open", () => opened.resolve(true), { once: true });
		socket.addEventListener("error", () => opened.resolve(false), { once: true });
		const cancel = () => {
			socket.close();
			opened.resolve(false);
		};
		signal.addEventListener("abort", cancel, { once: true });
		try {
			if (!(await opened.promise)) return undefined;
			socket.send(JSON.stringify(hello));
			return socket;
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	}, "replacement relay to accept its extension", 25_000, 50);
}

describe("loopback relay probe", () => {
	it("bypasses HTTP_PROXY when probing the loopback relay", async () => {
		let relayHits = 0;
		let proxyHits = 0;
		const relay = Bun.serve({
			port: 0,
			fetch: () => {
				relayHits++;
				return new Response("waiting", { status: 503 });
			},
		});
		const proxy = Bun.serve({
			port: 0,
			fetch: () => {
				proxyHits++;
				return new Response("Bad Gateway", { status: 502 });
			},
		});
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { probeRelayServer } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/daemon.ts"))};
const url = Bun.env.OMP_TEST_RELAY_URL;
if (!url) throw new Error("missing relay URL");
process.stdout.write(String(await probeRelayServer(url)));`,
			],
			{
				env: {
					...process.env,
					HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
					http_proxy: `http://127.0.0.1:${proxy.port}`,
					NO_PROXY: "",
					no_proxy: "",
					OMP_TEST_RELAY_URL: `http://127.0.0.1:${relay.port}`,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toBe("true");
			expect(relayHits).toBe(1);
			expect(proxyHits).toBe(0);
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await relay.stop(true);
			await proxy.stop(true);
		}
	});
});

describe("daemon-supervised browser relay", () => {
	it("shares one global relay across projects until the last consumer disconnects", async () => {
		const { daemon, conn } = await TestDaemon.start();
		let first: RelayConsumer | undefined;
		let second: RelayConsumer | undefined;
		try {
			const port = await findFreeCdpPort();
			const unit = relayIdentity(port);
			const script = await writeConsumer(daemon.root);
			const a = path.join(daemon.root, "project-a");
			const b = path.join(daemon.root, "project-b");
			await Promise.all([fs.mkdir(a), fs.mkdir(b)]);
			const withLeases = (count: number, consumer: RelayConsumer) =>
				until(async () => {
					if (consumer.proc.exitCode !== null || consumer.proc.signalCode !== null) {
						await consumer.result();
						throw new Error("Relay consumer exited before acquiring its lease");
					}
					const { units } = await conn.request({ op: "list", scope: GLOBAL_SCOPE, kind: "proc" });
					return units.find(
						candidate => candidate.key === unit.key && candidate.state === "ready" && candidate.leases === count,
					);
				}, `${count} relay leases`, 15_000);

			first = spawnConsumer(daemon, a, script, "hold", port);
			const started = await withLeases(1, first);
			second = spawnConsumer(daemon, b, script, "hold", port);
			expect((await withLeases(2, second)).generation).toBe(started.generation);

			first.proc.stdin.end();
			await first.result();
			const retained = await withLeases(1, second);
			expect(retained.generation).toBe(started.generation);
			// The daemon is a child process: test survival past a full real idle grace while the second lease remains.
			await Bun.sleep(retained.policy.idleMs + 100);
			expect(await probeRelayServer(relayUrl(port))).toBe(true);

			second.proc.stdin.end();
			await second.result();
			const { unit: stopped } = await conn.request({ op: "wait", unit, for: "exit", timeoutMs: 10_000 });
			expect(stopped.state).toBe("exited");
			expect(await probeRelayServer(relayUrl(port))).toBe(false);
		} finally {
			await Promise.all([first?.dispose(), second?.dispose()]);
			await daemon.dispose();
		}
	}, TEST_TIMEOUT_MS);

	it("keeps relays on different ports in separate live units", async () => {
		const { daemon, conn } = await TestDaemon.start();
		let child: RelayConsumer | undefined;
		try {
			const first = await findFreeCdpPort();
			let second = await findFreeCdpPort();
			while (second === first) second = await findFreeCdpPort();
			child = spawnConsumer(daemon, daemon.root, await writeConsumer(daemon.root), "check", first, second);
			const { units, serving } = JSON.parse(await child.result());
			expect(serving).toEqual([true, true]);
			const snapshots = await Promise.all(
				[first, second].map(port => conn.request({ op: "describe", unit: relayIdentity(port) })),
			);
			expect(units).toEqual(snapshots.map(({ unit }) => unit.id));
			expect(new Set(units).size).toBe(2);
		} finally {
			await child?.dispose();
			await daemon.dispose();
		}
	}, TEST_TIMEOUT_MS);

	it("connects to the replacement for a compatible idle relay from an older version", async () => {
		const { daemon, conn } = await TestDaemon.start();
		const abort = new AbortController();
		let child: RelayConsumer | undefined;
		let extension: Promise<WebSocket> | undefined;
		try {
			const port = await findFreeCdpPort();
			const unit = relayIdentity(port);
			const older = await conn.openProc(unit.key, {
				application: process.execPath,
				args: ["-e", `Bun.serve({
	hostname: "127.0.0.1",
	port: ${port},
	fetch: () => Response.json({
		ompRelayVersion: "0.0.1",
		ompRelayDiscardedTabsProtocol: ${JSON.stringify(PROTOCOL)},
		ompExtensionDiscardedTabsProtocol: ${JSON.stringify(PROTOCOL)},
		ompRelayCdpClients: 0,
	}),
});
console.log("listening");`],
				cwd: daemon.root,
				env: {},
				pty: false,
				ready: { log: "listening", timeoutMs: 10_000 },
			});
			expect(older.unit.state).toBe("ready");
			extension = extensionHello(port, abort.signal);
			void extension.catch(() => undefined);
			child = spawnConsumer(daemon, daemon.root, await writeConsumer(daemon.root), "acquire", port);
			const result = JSON.parse(await child.result());
			const { unit: replacement } = await conn.request({ op: "describe", unit });
			expect(result).toEqual({ connected: true, generation: replacement.generation, version: VERSION, clients: 1 });
			expect(replacement.generation).not.toBe(older.unit.generation);
		} finally {
			abort.abort();
			(await extension?.catch(() => undefined))?.close();
			await child?.dispose();
			await daemon.dispose();
		}
	}, TEST_TIMEOUT_MS);
});
