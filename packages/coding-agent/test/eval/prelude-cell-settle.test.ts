import { afterAll, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/** One settled cell as the counting prelude saw it. */
type Settled = { calls: number; failed: boolean; output?: string };

/** The identity a prelude sees for the eval cell its calls belong to. */
type PreludeCell = { readonly signal: AbortSignal };

/** What a prelude adds to a cell once that cell has ended. */
interface SettleReply {
	text?: string;
	images?: ImageContent[];
}

/** Host context carrying the cell a prelude call belongs to. */
type CellAwareContext = Parameters<EvalPreludeDefinition["invoke"]>[1] & { cell?: PreludeCell };

/** A prelude definition that may also answer once a cell has ended. */
type SettlingPrelude = Omit<EvalPreludeDefinition, "invoke"> & {
	invoke(parameters: unknown, context: CellAwareContext): Promise<AgentToolResult<unknown>>;
	settleCell(cell: PreludeCell, outcome: { failed: boolean; output: string }): Promise<SettleReply | undefined>;
};

/** A prelude that counts its calls per cell and reports the count once the cell settles. */
function countingPrelude(settled: Settled[]): SettlingPrelude {
	const calls = new Map<PreludeCell, number>();
	return {
		name: "counter",
		documentation: "counter",
		javascript: "globalThis.counter = { hit: () => __omp_prelude__('counter', {}) };",
		python:
			"class _Counter:\n    async def hit(self):\n        return await _omp_prelude('counter', {})\n\ncounter = _Counter()\ndel _Counter",
		exports: ["counter"],
		async invoke(_parameters, context) {
			if (context.cell) calls.set(context.cell, (calls.get(context.cell) ?? 0) + 1);
			return { content: [], details: {} };
		},
		async settleCell(cell, outcome) {
			const count = calls.get(cell);
			if (count === undefined) return undefined;
			calls.delete(cell);
			settled.push({ calls: count, failed: outcome.failed, output: outcome.output });
			return { text: `counter: ${count} call(s) this cell` };
		},
	};
}

function evalSession(preludes: SettlingPrelude[], id: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "async.enabled": false }),
		getEvalSessionId: () => id,
		getEvalPreludes: () => preludes,
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

/** Pixel size of a delivered frame, decoded from what the model would receive. */
async function imageSize(block: ImageContent): Promise<{ width: number; height: number }> {
	const { width, height } = await new Bun.Image(Buffer.from(block.data, "base64")).metadata();
	return { width, height };
}

describe("eval prelude cell settlement", () => {
	afterAll(async () => {
		await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
	});

	it("groups a JavaScript cell's prelude calls and appends the settle text after the cell's own output", async () => {
		const settled: Settled[] = [];
		const tool = new EvalTool(evalSession([countingPrelude(settled)], `prelude-settle-js-${crypto.randomUUID()}`));

		const first = await tool.execute("settle-js-1", {
			language: "js",
			code: "await counter.hit(); await counter.hit(); console.log('cell body');",
		});
		expect(text(first)).toBe("cell body\n\ncounter: 2 call(s) this cell");

		const quiet = await tool.execute("settle-js-2", { language: "js", code: "console.log('no prelude')" });
		expect(text(quiet)).toBe("no prelude");

		const failed = await tool.execute("settle-js-3", {
			language: "js",
			code: "await counter.hit(); throw new Error('boom');",
		});
		expect(text(failed)).toContain("counter: 1 call(s) this cell");
		expect(settled).toEqual([
			{ calls: 2, failed: false, output: expect.stringContaining("cell body") },
			{ calls: 1, failed: true, output: expect.any(String) },
		]);
	});

	it("groups a Python cell's prelude calls under one cell", async () => {
		const settled: Settled[] = [];
		const tool = new EvalTool(evalSession([countingPrelude(settled)], `prelude-settle-py-${crypto.randomUUID()}`));

		const result = await tool.execute("settle-py-1", {
			language: "py",
			code: "await counter.hit()\nawait counter.hit()\nawait counter.hit()\nprint('cell body')",
		});
		expect(text(result)).toBe("cell body\n\ncounter: 3 call(s) this cell");
		expect(settled).toEqual([{ calls: 3, failed: false, output: expect.stringContaining("cell body") }]);
	});

	it("keeps the cell's output and the other preludes' replies when one settle throws", async () => {
		const settled: Settled[] = [];
		const throwing: SettlingPrelude = {
			name: "broken",
			documentation: "broken",
			javascript: "",
			python: "",
			exports: [],
			async invoke() {
				return { content: [] };
			},
			async settleCell() {
				throw new Error("settle exploded");
			},
		};
		const tool = new EvalTool(
			evalSession([throwing, countingPrelude(settled)], `prelude-settle-throw-${crypto.randomUUID()}`),
		);

		const result = await tool.execute("settle-throw-1", {
			language: "js",
			code: "await counter.hit(); console.log('cell body');",
		});
		expect(text(result)).toBe("cell body\n\ncounter: 1 call(s) this cell");
	});

	it("does not settle a prelude the session disabled after a cell made its calls", async () => {
		const settled: Settled[] = [];
		let enabled = true;
		const prelude: SettlingPrelude = { ...countingPrelude(settled), enabled: () => enabled };
		const tool = new EvalTool(evalSession([prelude], `prelude-settle-off-${crypto.randomUUID()}`));

		const on = await tool.execute("settle-off-1", { language: "js", code: "await counter.hit()" });
		expect(text(on)).toContain("counter: 1 call(s) this cell");
		enabled = false;
		const off = await tool.execute("settle-off-2", { language: "js", code: "await counter.hit()" });
		expect(text(off)).not.toContain("counter:");
		expect(settled).toHaveLength(1);
	});

	it("does not settle a cell that timed out", async () => {
		const settled: Settled[] = [];
		const tool = new EvalTool(
			evalSession([countingPrelude(settled)], `prelude-settle-timeout-${crypto.randomUUID()}`),
		);

		const result = await tool.execute("settle-timeout-1", {
			language: "js",
			code: "await counter.hit(); while (true) {}",
			timeout: 1,
		});
		expect(text(result)).not.toContain("counter:");
		expect(settled).toEqual([]);
	});

	it("ends a cell cancelled while it settles as cancelled", async () => {
		const abort = new AbortController();
		const cancelling: SettlingPrelude = {
			name: "cancelling",
			documentation: "cancelling",
			javascript: "",
			python: "",
			exports: [],
			async invoke() {
				return { content: [] };
			},
			async settleCell() {
				abort.abort();
				return undefined;
			},
		};
		const tool = new EvalTool(evalSession([cancelling], `prelude-settle-cancel-${crypto.randomUUID()}`));

		const result = await tool.execute(
			"settle-cancel-1",
			{ language: "js", code: "console.log('cell body')" },
			abort.signal,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("cell body");
	});

	it("delivers settlement frames marked original as captured, and resizes every other one", async () => {
		// 8×8: the generic path upscales anything under 200 px, so an `original`
		// frame proves it skipped that path and a plain one proves it did not.
		const frame =
			"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8DwnwEPYMInOXwUAAASWwIOH0pJXQAAAABJRU5ErkJggg==";
		const settled: Settled[] = [];
		const base = countingPrelude(settled);
		const prelude: SettlingPrelude = {
			...base,
			async settleCell(cell, outcome) {
				const reply = await base.settleCell(cell, outcome);
				return reply === undefined
					? undefined
					: {
							...reply,
							images: [
								{ type: "image", data: frame, mimeType: "image/png", detail: "original" },
								{ type: "image", data: frame, mimeType: "image/png" },
							],
						};
			},
		};
		const tool = new EvalTool(evalSession([prelude], `prelude-settle-frame-${crypto.randomUUID()}`));

		const result = await tool.execute("settle-frame-1", { language: "js", code: "await counter.hit()" });
		const original = result.content.filter(
			(block): block is ImageContent => block.type === "image" && block.detail === "original",
		);
		const plain = result.content.filter(
			(block): block is ImageContent => block.type === "image" && block.detail !== "original",
		);
		expect(original).toHaveLength(1);
		expect(plain).toHaveLength(1);
		// The `original` frame is the very capture saved beside it; the plain one goes
		// through the generic path, which lifts anything under 200 px to that edge.
		expect(await imageSize(original[0]!)).toEqual({ width: 8, height: 8 });
		expect(Math.min(...Object.values(await imageSize(plain[0]!)))).toBe(200);
	});

	it("keeps an explicitly shown JavaScript frame at its captured resolution", async () => {
		const tool = new EvalTool(evalSession([], `prelude-display-original-${crypto.randomUUID()}`));
		const frame =
			"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8DwnwEPYMInOXwUAAASWwIOH0pJXQAAAABJRU5ErkJggg==";
		const shown = async (language: "js" | "py", code: string): Promise<ImageContent[]> => {
			const result = await tool.execute(`display-original-${language}-${crypto.randomUUID()}`, { language, code });
			return result.content.filter((block): block is ImageContent => block.type === "image");
		};

		const js = await shown(
			"js",
			`display({ type: "image", data: ${JSON.stringify(frame)}, mimeType: "image/png", detail: "original" });`,
		);
		expect(js).toHaveLength(1);
		expect(await imageSize(js[0]!)).toEqual({ width: 8, height: 8 });
	});

	it("keeps a prelude-returned frame's original marker through the Python bridge", async () => {
		const frame =
			"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8DwnwEPYMInOXwUAAASWwIOH0pJXQAAAABJRU5ErkJggg==";
		const prelude: SettlingPrelude = {
			...countingPrelude([]),
			// What `computer.window(…).screenshot()` answers the Python kernel with.
			async invoke() {
				return { content: [{ type: "image", data: frame, mimeType: "image/png", detail: "original" }] };
			},
		};
		const tool = new EvalTool(evalSession([prelude], `prelude-py-original-${crypto.randomUUID()}`));

		const result = await tool.execute("py-original-1", { language: "py", code: "await counter.hit()" });
		const images = result.content.filter((block): block is ImageContent => block.type === "image");
		expect(images).toHaveLength(1);
		expect(images[0]?.detail).toBe("original");
		expect(await imageSize(images[0]!)).toEqual({ width: 8, height: 8 });
	});
});
