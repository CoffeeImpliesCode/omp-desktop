// Local standalone build of the coding-agent CLI. The native addon must be
// embedded before this runs: `bun --cwd=packages/natives run gen:native` stages
// packages/natives/native/embedded-addon.js with the release descriptor, and
// the loader re-extracts the embedded archive over
// ~/.omp/natives/<version>/ whenever the on-disk file size differs. A
// hand-dropped addon with a different size is therefore reverted at every
// launch, so the feature flag has to be baked into the binary.
import { compileCodingAgent } from "./packages/coding-agent/scripts/compile-binary";
import tf from "@huggingface/transformers/package.json";
// `resolveJsonModule` is off in this repo, so the JSON import carries no type.
const transformers = tf as { readonly version: string };

await compileCodingAgent({
	repoRoot: import.meta.dir,
	entrypoint: `${import.meta.dir}/packages/coding-agent/src/cli.ts`,
	outfile: "/home/janis/tools/omp-local/omp-linux-x64",
	target: "bun-linux-x64-baseline",
	minifyIdentifiers: true,
	transformersVersion: transformers.version,
});
console.log("COMPILE OK");
