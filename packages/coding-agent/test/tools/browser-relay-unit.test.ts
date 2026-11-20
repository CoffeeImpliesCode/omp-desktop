/**
 * Contract of the daemon-supervised browser relay (`tools/browser/relay/daemon.ts`): adopting a
 * manually started relay, replacing an outdated one, and leaving newer or busy relays alone.
 *
 * The relay endpoint is a real loopback HTTP server answering `/json/version` like the relay
 * does; the daemon is a stub `DaemonClient` whose start/stop of the relay unit brings that
 * endpoint up and down, modelling `units.ts` (find-or-start, generation-scoped `stop`).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as daemonClientModule from "@oh-my-pi/pi-coding-agent/daemon/client";
import type {
	DaemonClient,
	DaemonOp,
	DaemonResult,
	OpenRequest,
	OpenResult,
	UnitSnapshot,
} from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { ensureRelayDaemon, restartRelayDaemon } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/daemon";
import { DISCARDED_TABS_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import * as piUtils from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

const OLDER_VERSION = "0.0.1";
const NEWER_VERSION = "999.0.0";

/** What the relay endpoint currently serves; `null` = nothing bound (answers 404, which no probe accepts). */
interface RelayEndpointState {
	version: string;
	cdpClients?: number;
	protocol?: number;
}

class StubDaemon implements DaemonClient {
	readonly welcome = { v: 1, daemon: { pid: 1, build: "test", startedAt: 0 }, caps: {} };
	readonly units = new Map<string, UnitSnapshot>();
	readonly opens: OpenRequest[] = [];
	readonly stops: { generation?: string }[] = [];
	readonly waits: string[] = [];
	readonly leases = new Set<string>();
	#generation = 0;
	describes = 0;
	onDescribe: (count: number) => void = () => {};
	beforeStop: () => void = () => {};
	onWait: (unit: UnitSnapshot) => void = () => {};
	/** Called when the stub starts or stops the relay process. */
	onStart: () => void = () => {};
	onStop: () => void = () => {};

	#find(ref: string | { key: string }): UnitSnapshot {
		const unit =
			typeof ref === "string"
				? [...this.units.values()].find(candidate => candidate.id === ref)
				: this.units.get(ref.key);
		if (!unit) throw new Error(`unknown unit ${JSON.stringify(ref)}`);
		return unit;
	}

	seed(key: string, generation: string): UnitSnapshot {
		const unit: UnitSnapshot = {
			id: `unit-${key}`,
			kind: "proc",
			scope: { kind: "global" },
			key,
			label: key,
			generation,
			state: "running",
			pids: [7070],
			createdAt: 0,
			startedAt: 0,
			restartCount: 0,
			outputBytes: 0,
			leases: 0,
			policy: { hold: "leases", idleMs: 3_000, onIdle: "stop", restart: "no", survive: "exec" },
			supervised: true,
		};
		this.units.set(key, unit);
		return unit;
	}

	async request<O extends DaemonOp>(request: O): Promise<DaemonResult<O["op"]>> {
		const operation: DaemonOp = request;
		switch (operation.op) {
			case "describe":
				this.onDescribe(++this.describes);
				return { unit: { ...this.#find(operation.unit) } } as never;
			case "stop": {
				this.beforeStop();
				const unit = this.#find(operation.unit);
				this.stops.push({ generation: operation.generation });
				if (operation.generation === undefined || operation.generation === unit.generation) {
					unit.state = "exited";
					this.onStop();
				}
				return { unit: { ...unit } } as never;
			}
			case "wait": {
				const unit = this.#find(operation.unit);
				this.waits.push(unit.generation);
				this.onWait(unit);
				return { unit: { ...unit }, matched: true } as never;
			}
			default:
				throw new Error(`stub daemon does not serve ${operation.op}`);
		}
	}

	async open(request: OpenRequest): Promise<OpenResult> {
		this.opens.push(request);
		const current = this.units.get(request.key);
		const live = current !== undefined && current.state !== "exited" && current.state !== "failed";
		let unit = current;
		if (!live || request.replace) {
			unit = this.seed(request.key, `g-new-${++this.#generation}`);
			this.onStart();
		}
		const lease = request.lease === false ? undefined : `lease-${crypto.randomUUID()}`;
		if (lease) this.leases.add(lease);
		return { unit: { ...unit! }, lease, created: !live };
	}

	async release(lease: string): Promise<void> {
		this.leases.delete(lease);
	}

	onReconnect(): () => void {
		return () => {};
	}
	call<T>(): Promise<T> {
		throw new Error("not served");
	}
	attach(): never {
		throw new Error("not served");
	}
	onCompletion(): () => void {
		return () => {};
	}
	onNotify(): () => void {
		return () => {};
	}
	onUnit(): () => void {
		return () => {};
	}
	close(): void {}
}

let server: Bun.Server<undefined>;
let serving: RelayEndpointState | null;
let cdpUrl: string;
let unitKey: string;
let stub: StubDaemon;
let onVersionRequest: () => void;

beforeEach(() => {
	serving = null;
	onVersionRequest = () => {};
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname !== "/json/version") return new Response("", { status: 404 });
			onVersionRequest();
			if (!serving) return new Response("", { status: 404 });
			return Response.json({
				Browser: "omp-relay",
				ompRelayVersion: serving.version,
				ompRelayCdpClients: serving.cdpClients,
				ompRelayDiscardedTabsProtocol: serving.protocol?.toString(),
				ompExtensionDiscardedTabsProtocol: serving.protocol?.toString(),
			});
		},
	});
	cdpUrl = `http://127.0.0.1:${server.port}`;
	unitKey = `omp.browser.relay.${server.port}`;
	stub = new StubDaemon();
	// The daemon-run relay is this build's; stopping it unbinds the port.
	stub.onStart = () => {
		serving = { version: VERSION, cdpClients: 0 };
	};
	stub.onStop = () => {
		serving = null;
	};
	spyOn(daemonClientModule, "daemonClient").mockResolvedValue(stub);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await server.stop(true);
});

describe("ensureRelayDaemon", () => {
	it("adopts a manually started relay already serving the port without starting or leasing a unit", async () => {
		// Regression: starting a daemon relay against a manual one fails its bind and leaks a unit.
		serving = { version: VERSION, cdpClients: 0 };

		const lease = await ensureRelayDaemon({ cdpUrl });

		expect(lease).toBeNull();
		expect(stub.opens).toEqual([]);
		expect(stub.leases.size).toBe(0);
	});
});

describe("restartRelayDaemon", () => {
	it("replaces a daemon relay from an older omp and leases the replacement", async () => {
		stub.seed(unitKey, "g-old");
		serving = { version: OLDER_VERSION, cdpClients: 0 };

		const result = await restartRelayDaemon({ cdpUrl, lease: null });

		expect(result.restarted).toBe(true);
		expect(stub.stops).toEqual([{ generation: "g-old" }]);
		expect(result.lease?.unit.generation).not.toBe("g-old");
		expect(stub.leases.size).toBe(1);
		expect(serving).toEqual({ version: VERSION, cdpClients: 0 });
		await result.lease?.release();
	});

	it("leaves a relay from a newer omp running", async () => {
		// Two omp versions replacing each other's relay would make every session lose its connection in turns.
		stub.seed(unitKey, "g-newer");
		serving = { version: NEWER_VERSION, cdpClients: 0 };

		const result = await restartRelayDaemon({ cdpUrl, lease: null });

		expect(result).toEqual({ restarted: false, lease: null });
		expect(stub.stops).toEqual([]);
		expect(stub.opens).toEqual([]);
		expect(stub.units.get(unitKey)?.state).toBe("running");
	});

	it.each([1, undefined])("refuses an idle-only restart when the relay reports %s CDP clients", async clients => {
		stub.seed(unitKey, "g-not-idle");
		serving = { version: OLDER_VERSION, cdpClients: clients };

		const result = await restartRelayDaemon({ cdpUrl, lease: null, idleOnly: true });

		expect(result.restarted).toBe(false);
		expect(stub.stops).toEqual([]);
		expect(stub.units.get(unitKey)?.state).toBe("running");
		expect(serving).toEqual({ version: OLDER_VERSION, cdpClients: clients });
	});

	it("starts or adopts the replacement after another client stopped the old unit", async () => {
		const old = stub.seed(unitKey, "g-stopped");
		old.state = "exited";

		const result = await restartRelayDaemon({ cdpUrl, lease: null });

		expect(stub.stops).toEqual([]);
		expect(result.restarted).toBe(true);
		expect(result.lease?.unit.generation).not.toBe(old.generation);
		expect(serving).toEqual({ version: VERSION, cdpClients: 0 });
		await result.lease?.release();
	});

	it("does not start over a manually served relay, even if a stopped unit has the same identity", async () => {
		stub.seed(unitKey, "g-stopped").state = "exited";
		serving = { version: OLDER_VERSION, cdpClients: 0 };

		expect(await restartRelayDaemon({ cdpUrl, lease: null, idleOnly: true })).toEqual({
			restarted: false,
			lease: null,
		});
		expect(stub.opens).toEqual([]);
		expect(stub.stops).toEqual([]);
		expect(serving).toEqual({ version: OLDER_VERSION, cdpClients: 0 });
	});

	it("waits for a replacement already starting without restarting it", async () => {
		const current = stub.seed(unitKey, "g-starting");
		current.state = "starting";
		stub.onWait = unit => {
			unit.state = "ready";
			serving = { version: VERSION, cdpClients: 0 };
		};

		const result = await restartRelayDaemon({ cdpUrl, lease: null });

		expect(stub.waits).toEqual([current.generation]);
		expect(stub.stops).toEqual([]);
		expect(result.restarted).toBe(true);
		expect(result.lease?.unit.generation).toBe(current.generation);
		await result.lease?.release();
	});

	it("leases the replacement when another client wins before the generation-scoped stop", async () => {
		stub.seed(unitKey, "g-stale");
		serving = { version: OLDER_VERSION, cdpClients: 0 };
		stub.beforeStop = () => {
			stub.seed(unitKey, "g-replacement");
			serving = { version: VERSION, cdpClients: 0 };
		};

		const result = await restartRelayDaemon({ cdpUrl, lease: null, idleOnly: true });

		expect(stub.stops).toEqual([{ generation: "g-stale" }]);
		expect(stub.units.get(unitKey)).toMatchObject({ generation: "g-replacement", state: "running" });
		expect(result.restarted).toBe(true);
		expect(result.lease?.unit.generation).toBe("g-replacement");
		await result.lease?.release();
	});
});

describe("acquireBrowser relay restart", () => {
	it("reports cancellation during a manual relay probe, not an outdated relay", async () => {
		spyOn(piUtils, "workerHostEntry").mockReturnValue(import.meta.path);
		serving = { version: OLDER_VERSION };
		const controller = new AbortController();
		let restartProbes = 0;
		onVersionRequest = () => {
			// Once restart describes the absent unit, it checks whether the port
			// is served, then reads the serving relay's version.
			if (stub.describes === 2 && ++restartProbes === 2) controller.abort();
		};

		await expect(
			acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd(), signal: controller.signal }),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(restartProbes).toBe(2);
		expect(stub.stops).toEqual([]);
		expect(serving).toEqual({ version: OLDER_VERSION });
	});

	it("re-probes when an incompatible newer relay replaces the compatible idle relay mid-acquire", async () => {
		spyOn(piUtils, "workerHostEntry").mockReturnValue(import.meta.path);
		serving = { version: OLDER_VERSION, cdpClients: 0, protocol: DISCARDED_TABS_PROTOCOL_VERSION };
		const replacement = {
			version: NEWER_VERSION,
			cdpClients: 0,
			protocol: DISCARDED_TABS_PROTOCOL_VERSION + 1,
		};
		stub.onDescribe = count => {
			if (count === 2) serving = replacement;
		};

		await expect(acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() })).rejects.toThrow("is out of date");
		expect(stub.stops).toEqual([]);
		expect(stub.opens).toEqual([]);
		expect(serving).toBe(replacement);
	});
});
