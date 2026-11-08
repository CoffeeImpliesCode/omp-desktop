import { afterEach, describe, expect, it, vi } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";
import { desktopEscapeStops, forgetDesktopEscapeStops } from "../native/desktop.js";
import * as loaderState from "../native/loader-state.js";

class CurrentDesktopSession {
	static abiVersion() {
		return 1;
	}
	drag() {
		return { selection: undefined, focusReturn: undefined };
	}
	click() {}
	capture() {}
	captureRegion() {}
	cancel() {}
	retire() {}
	setRunDeadline() {}
	observe() {}
	listApplications() {}
	openApplication() {}
	menuItems() {}
	menuSelect() {}
	holdKeys() {}
	holdMouse() {}
	acquireControl() {}
	releaseControl() {}
	controlState() {}
	bringToCurrentSpace() {}
	axSelectText() {}
	holdDisplayUntilReleased() {}
	releaseDisplayAwake() {}
	control() {}
	listWorkspaces() {}
	windowState() {}
	get escapeStops() {
		return 0;
	}
}

describe("desktop native ABI requirements", () => {
	it("permits current ABI construction without constructing during adaptation", () => {
		let constructions = 0;
		class Compatible extends CurrentDesktopSession {
			constructor() {
				super();
				constructions++;
			}
		}
		const Session = adaptDesktopSession(Compatible);
		expect(constructions).toBe(0);
		new Session();
		expect(constructions).toBe(1);
	});

	it.each([
		undefined,
		() => 0,
		() => 2,
		() => "1",
		() => {
			throw new Error("old");
		},
	])("rejects a method-complete old fork before construction with incompatible ABI %s", abiVersion => {
		let constructions = 0;
		class OldFork extends CurrentDesktopSession {
			constructor() {
				super();
				constructions++;
			}
		}
		Object.defineProperty(OldFork, "abiVersion", { value: abiVersion });
		Object.defineProperty(OldFork.prototype, "drag", {
			value: () => ({ app: "old flat focus return" }),
		});
		// The gate itself must remain safe when the shared entrypoint is imported.
		const Session = adaptDesktopSession(OldFork);
		expect(constructions).toBe(0);
		expect(() => new Session()).toThrow(/^Unsupported: .*desktop ABI/);
		expect(constructions).toBe(0);
	});

	it.each([
		["missing desktop export", undefined],
		[
			"legacy execute ABI",
			class {
				execute() {}
			},
		],
	])("defers rejection of %s until desktop use without constructing the addon", (_label, NativeSession) => {
		// Importing the shared native module must remain safe for non-desktop tools.
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
	});

	it("rejects an addon built before the turn-scoped display hold", () => {
		class StaleDesktopSession extends CurrentDesktopSession {}
		Object.defineProperties(StaleDesktopSession.prototype, {
			holdDisplayUntilReleased: { value: undefined },
			releaseDisplayAwake: { value: undefined },
		});
		const Stale = adaptDesktopSession(StaleDesktopSession);
		expect(() => new Stale({ display: "active" })).toThrow(/holdDisplayUntilReleased, releaseDisplayAwake/);
	});

	it.each(["drag", "control", "listWorkspaces", "windowState"])("rejects an addon missing %s", method => {
		class StaleDesktopSession extends CurrentDesktopSession {}
		Object.defineProperty(StaleDesktopSession.prototype, method, { value: undefined });
		const Stale = adaptDesktopSession(StaleDesktopSession);
		expect(() => new Stale({ display: "active" })).toThrow(`missing ${method}`);
	});

	it("rejects an addon built before the Escape stop count", () => {
		// Every method present, so only the getter can decide; without it the worker reads each run as stopped.
		const prototype = (escapeStops: boolean) =>
			new Proxy(
				{},
				{
					get: () => () => {},
					has: (_target, key) => escapeStops || key !== "escapeStops",
				},
			);
		const Current = { prototype: prototype(true), abiVersion: () => 1 };
		expect<unknown>(adaptDesktopSession(Current)).toBe(Current);
		const Stale = adaptDesktopSession({ prototype: prototype(false), abiVersion: () => 1 });
		expect(() => new Stale({ display: "active" })).toThrow(/^Unsupported: .*\(missing escapeStops\)/);
	});
});

describe("lazy desktop exports", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("report a stale addon's missing Escape exports with the stale-addon stub", () => {
		// A workspace addon built before the Escape exports, which the loader tolerates as stale.
		const missingNativeExport = loaderState.missingNativeExport;
		const stale = {
			path: "/w/packages/natives/native/pi_natives.darwin-arm64.node",
			version: "18.8.7",
			packageVersion: "18.12.1",
			stale: true,
		};
		vi.spyOn(loaderState, "loadNative").mockReturnValue({});
		vi.spyOn(loaderState, "missingNativeExport").mockImplementation(name => missingNativeExport(name, stale));
		for (const [name, call] of [
			["desktopEscapeStops", () => desktopEscapeStops("k")],
			["forgetDesktopEscapeStops", () => forgetDesktopEscapeStops("k")],
		] as const) {
			expect(call).toThrow(`\`${name}\` is missing`);
			expect(call).toThrow("bun run build:native");
		}
	});
});
