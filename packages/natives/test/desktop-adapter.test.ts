import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

class CurrentDesktopSession {
	click() {}
	capture() {}
	captureRegion() {}
	cancel() {}
	retire() {}
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
	holdDisplayUntilReleased() {}
	releaseDisplayAwake() {}
	control() {}
	listWorkspaces() {}
	windowState() {}
}

describe("desktop native ABI requirements", () => {
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

	it.each(["control", "listWorkspaces", "windowState"])("rejects an addon missing %s", method => {
		class StaleDesktopSession extends CurrentDesktopSession {}
		Object.defineProperty(StaleDesktopSession.prototype, method, { value: undefined });
		const Stale = adaptDesktopSession(StaleDesktopSession);
		expect(() => new Stale({ display: "active" })).toThrow(`missing ${method}`);
	});
});
