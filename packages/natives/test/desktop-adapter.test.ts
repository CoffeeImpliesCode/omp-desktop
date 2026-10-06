import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

class LegacyDesktopSession {
	static instances: LegacyDesktopSession[] = [];

	readonly actions: Array<Record<string, unknown>> = [];
	readonly options: Record<string, unknown>;
	readonly capabilities = {
		backend: "unavailable",
		capture: true,
		input: true,
		capturePermission: "unknown",
		inputPermission: "unknown",
		displayCount: 0,
	};
	closed = false;

	constructor(options: Record<string, unknown>) {
		this.options = options;
		LegacyDesktopSession.instances.push(this);
	}

	async capture() {
		return {
			width: (this.options.maxWidth as number | undefined) ?? 20,
			height: (this.options.maxHeight as number | undefined) ?? 10,
			data: new Uint8Array(),
		};
	}

	async execute(
		actions: Array<Record<string, unknown>>,
	): Promise<{ width: number; height: number; data: Uint8Array } | undefined> {
		this.actions.push(...actions);
		return undefined;
	}

	async close() {
		this.closed = true;
	}
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
		[
			"pre-zoom ABI",
			class {
				click() {}
				cancel() {}
			},
		],
		[
			"uncancellable ABI",
			class {
				click() {}
				captureRegion() {}
			},
		],
	])("defers rejection of %s until desktop use without constructing the addon", (_label, NativeSession) => {
		// Importing the shared native module must remain safe for non-desktop tools.
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
	});

	it("refuses control, workspace and state calls with a coded error", async () => {
		const DesktopSession = adaptDesktopSession(LegacyDesktopSession);
		const session = new DesktopSession({ display: "all" });

		// A resolved promise or a raw TypeError here would let callers believe a
		// window was closed, moved or inspected, so every refusal carries the
		// control code and never reaches the addon.
		await expect(session.control({ operation: "closeWindow", windowId: "42" })).rejects.toThrow(
			/^ControlUnsupported: /,
		);
		await expect(session.listWorkspaces()).rejects.toThrow(/^ControlUnsupported: /);
		await expect(session.windowState("42")).rejects.toThrow(/^ControlUnsupported: /);
		expect(LegacyDesktopSession.instances.at(-1)?.actions).toEqual([]);
	});

	it("reports a closed session ahead of the unsupported control refusal", async () => {
		const DesktopSession = adaptDesktopSession(LegacyDesktopSession);
		const session = new DesktopSession({ display: "all" });
		await session.close();

		// Run scope ends on `Closed`; a retained handle must not be told the
		// control surface is merely unavailable.
		await expect(session.control({ operation: "focusWindow", windowId: "42" })).rejects.toThrow(/^Closed: /);
	});
});
