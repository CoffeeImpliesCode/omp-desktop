import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

async function runDriver(args: string[]): Promise<{ exitCode: number; stderr: string }> {
	const child = Bun.spawn([process.execPath, "scripts/bazel-natives.ts", ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: "",
			OMP_NATIVE_BUILD_BACKEND: "bazel",
			OMP_NATIVE_FEATURES: "wayland-pipewire",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return { exitCode, stderr };
}

function expectUnsupportedFeatures(result: { exitCode: number; stderr: string }): void {
	expect(result.exitCode, result.stderr).toBe(1);
	expect(result.stderr).toContain("OMP_NATIVE_FEATURES");
	expect(result.stderr).toMatch(/Cargo|N-API/);
}

describe("native build feature requests", () => {
	test("rejects features that a Bazel target would silently discard", async () => {
		expectUnsupportedFeatures(await runDriver(["linux-x64-baseline"]));
	});

	test("rejects feature requests when installing prebuilt addons instead of compiling them", async () => {
		expectUnsupportedFeatures(await runDriver(["linux-x64-baseline", "--source", import.meta.dir]));
	});
});
