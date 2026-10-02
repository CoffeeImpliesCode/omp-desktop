// Local standalone build of the coding-agent CLI. Prepare assets first:
// `bun --cwd=packages/natives run gen:native`,
// `bun --cwd=packages/stats run gen:stats`, and
// `bun --cwd=packages/coding-agent run gen:tool-views`.
// The embedded native descriptor replaces cached addons when sizes differ.
// A hand-dropped addon is therefore not enough: bake the feature into the binary.
import { compileCodingAgent } from "./packages/coding-agent/scripts/compile-binary";
import tf from "@huggingface/transformers/package.json";
// `resolveJsonModule` is off in this repo, so the JSON import carries no type.
const transformers = tf as { readonly version: string };

await compileCodingAgent({
	repoRoot: import.meta.dir,
	entrypoint: `${import.meta.dir}/packages/coding-agent/src/cli.ts`,
	outfile: Bun.env.OMP_LOCAL_OUTFILE || "/home/janis/tools/omp-local/omp-linux-x64",
	target: "bun-linux-x64-baseline",
	minifyIdentifiers: true,
	transformersVersion: transformers.version,
});
console.log("COMPILE OK");
