/** Control surface of the legacy ABI: the released addon has none. */
interface AdaptedDesktopControlCapabilities {
	readonly backend: string;
	readonly operations: string[];
	readonly coordinateSpace: string | null;
	readonly focusMayWarpPointer: boolean;
}

interface AdaptedDesktopCapabilities {
	readonly [key: string]: unknown;
	readonly ax: boolean;
	readonly backgroundWindowInput: boolean;
	readonly takeover: boolean;
	readonly axPermission: string;
	readonly windowControl: AdaptedDesktopControlCapabilities;
}

interface AdaptedDesktopSession {
	readonly capabilities: AdaptedDesktopCapabilities;
	listWindows(): Promise<Array<Record<string, unknown>>>;
	capture(target: string, caps?: unknown): Promise<Record<string, unknown>>;
	click(
		target: string,
		x: number,
		y: number,
		options?: { button?: string; count?: number; modifiers?: string[]; takeover?: boolean },
	): Promise<void>;
	typeText(target: string, text: string, options?: { takeover?: boolean }): Promise<void>;
	keyChord(target: string, keys: string[], options?: { takeover?: boolean }): Promise<void>;
	control(action: Record<string, unknown>): Promise<void>;
	listWorkspaces(): Promise<Array<Record<string, unknown>>>;
	windowState(windowId: string): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

interface AdaptedDesktopSessionConstructor {
	new (options: Record<string, unknown>): AdaptedDesktopSession;
}

export function adaptDesktopSession(NativeDesktopSession: unknown): AdaptedDesktopSessionConstructor;
