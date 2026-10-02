# Local build: Wayland PipeWire capture

The shipped `pi_natives` addons are built with `crate_features = []`, so on a
Wayland session `capture()` is compiled down to
`CaptureFailed: Wayland capture requires the wayland-pipewire feature`. The
X11 fallback does not help: niri runs Xwayland rootless, so the X root window
is empty. `~/.omp/agent/{settings.json,config.yml}` have no lever for this —
backend selection reads only `WAYLAND_DISPLAY` / `DISPLAY`
(`crates/pi-natives/src/desktop/linux/mod.rs`).

Rebuild both addon variants with the opt-in feature and embed them in the
binary. This fork also retains all authorized monitor streams and adds exact
niri window capture. The implementation is based on upstream `main` commit
`f7055447f2021d20e718f76510ba1bda0da09287` (package version 18.4.9), in
`/home/janis/.omp/wt/oh-my-pi-desktop-main`.

## Why the binary must be rebuilt

`~/.local/bin/omp` is a compiled standalone, and it embeds the addon:

```
// packages/natives/native/embedded-addon.js
{ platformTag: "linux-x64", version: "18.4.9",
  files: [ { variant: "modern",  size: 222394280 },
          { variant: "baseline", size: 222281768 } ] }
```

`isEmbeddedAddonFileCurrent` (`packages/natives/native/loader-state.js`) is a
bare size comparison, and `maybeExtractEmbeddedAddon` re-extracts the embedded
archive over `~/.omp/natives/<version>/` whenever the size differs. A
hand-dropped addon whose size differs from the embedded descriptor is therefore
silently reverted on the next launch. The feature flag has to live in the
binary.

Note the source-tree `embedded-addon.js` reads `embeddedAddon = null` — that is
the post-build `--reset` stub, not what a shipped binary contains. Reading it
to decide whether the binary embeds an addon is wrong.

## Steps

```sh
cd /home/janis/.omp/wt/oh-my-pi-desktop-main
export PATH="$HOME/tools/bun-1.3.14:$HOME/.local/share/rustup/toolchains/nightly-2026-08-12-x86_64-unknown-linux-gnu/bin:$PATH"
export RUSTUP_TOOLCHAIN=nightly-2026-08-12
export RUSTC="$HOME/.local/share/rustup/toolchains/nightly-2026-08-12-x86_64-unknown-linux-gnu/bin/rustc"
export RUSTDOC="$HOME/.local/share/rustup/toolchains/nightly-2026-08-12-x86_64-unknown-linux-gnu/bin/rustdoc"
export CARGO_TARGET_DIR=/home/janis/projects/oh-my-pi/target
export CARGO_BUILD_JOBS=2

# 1. Feature flag. crates/pi-natives/Cargo.toml has default = [] on purpose:
#    the pipewire crate hard-links system libpipewire-0.3 via pkg-config,
#    which no CI/cross triple can satisfy.
#    packages/natives/scripts/build-bindings.ts, napiArgs:
#      "--features", "wayland-pipewire",

# 2. NixOS: no sudo, resolve dev + runtime libs from the store.
export PKG_CONFIG_PATH=/nix/store/jrmk7s69c1ydqqsq0a751m57621rm6v6-pipewire-1.6.8-dev/lib/pkgconfig
export LIBCLANG_PATH=/nix/store/a3kjvvlm7f8abcmxh6f8dndiwc4vp726-clang-21.1.8-lib/lib
RP=/nix/store/rvgcqlnpq9lv4vbq85zvv51bkk4izpbl-pipewire-1.6.8/lib
export LIBRARY_PATH=$RP

cd packages/natives

# 3. Build BOTH variants. See the target-cpu note below — pass RUSTFLAGS
#    yourself, including the ISA floor, or the pinning is skipped.
RUSTFLAGS="-C target-cpu=x86-64-v2 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=baseline bun scripts/build-bindings.ts
RUSTFLAGS="-C target-cpu=x86-64-v3 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=modern bun scripts/build-bindings.ts

# 4. Prepare all binary assets, then compile to a staging path.
bun run gen:native
cd ../..
bun --cwd=packages/stats run gen:stats
bun --cwd=packages/coding-agent run gen:tool-views
OMP_LOCAL_OUTFILE=/home/janis/tools/omp-local/omp-linux-x64-18.4.9-test \
  bun compile-one.ts
```

`bun run gen:native:reset` restores the `embeddedAddon = null` stub afterwards.
Only do that when not about to compile — a compile without a preceding
`gen:native` produces a binary that reverts the addon.

### Why `RUSTFLAGS` is set explicitly

`build-bindings.ts` only pins the ISA floor under `if (!Bun.env.RUSTFLAGS)`. The
NixOS rpath has to come in through `RUSTFLAGS`, so setting it for the linker
silently suppresses the script's own `-C target-cpu=` pinning and the emitted
"modern" and "baseline" binaries become the same build under two names. Put
both in one `RUSTFLAGS`.


### Both variants are required

`gen:native` embeds whichever `.node` files are present and `embed-native.ts`
rejects any addon whose version stamp does not match `package.json`. The
`latest` published `@oh-my-pi/pi-natives-linux-x64` lags `main`, so when
building from a `main` checkout there is no published addon to fall back on —
build both. A fork that embeds only `modern` leaves non-AVX2 hosts loading an
AVX2 binary.

`OMP_NATIVE_X64_VARIANT` is an addition in this fork. Upstream derives the
variant purely from host AVX2 detection, so one machine can only ever emit one
of the two. Unset, behaviour is unchanged.

## Bun version

`packages/coding-agent/package.json` requires `engines.bun >= 1.3.14`, and
`target: "bun-linux-x64-baseline"` embeds the compiling bun as the runtime. A
binary compiled with 1.3.13 refuses to start:

```
error: Bun runtime must be >= 1.3.14 (found v1.3.13). Please upgrade: bun upgrade
```

Compile with a newer bun than the one in `PATH`. Local copy:
`~/tools/bun-1.3.14/bun` (sha256-verified against the release `SHASUMS256.txt`).

## Verify

```sh
~/tools/omp-local/omp-linux-x64-18.4.9-test --version
~/tools/omp-local/omp-linux-x64-18.4.9-test --smoke-test
```

The standalone smoke checks worker startup and bundled assets. Exercise real
capture through the computer interface as well:

```js
display(await computer.displays());
const win = await computer.window({ app: "ghostty", title: "btop" });
display({ id: win.id, bounds: win.bounds, positionKnown: win.positionKnown });
await win.screenshot();
await computer.screenshot();
```

Approve any ScreenCast portal selection on the desktop yourself. The grant
controls which monitor streams may be captured. On niri, window screenshots
use the compositor's native ScreenCast service without a portal picker; normal
computer read approval still applies.

On niri, `capabilities().displayCount` is populated from IPC before capture.
Unknown window origins report `positionKnown: false`; exact capture does not
depend on those origins, and unsafe global coordinate input is refused.

The native suites passed with the feature (466 tests, one skipped) and without
it (459 tests, one skipped), using two test threads. The computer and changelog
suites passed 73 tests with one skipped and `bun test --timeout 120000`.
The initial run hit the default five-second timeout in two oversized-changelog
cases. Production Rust clippy and the natives package checks passed.
Regression tests cover composition, mixed scales, negative origins, display
selection, and rejection of ambiguous or unsafe coordinate frames.

The full workspace runner was not green: 3097 passed, five failed, six skipped.
Three fixtures still require missing `/bin/pwd`, `/bin/cat`, and
`/usr/bin/head`. The tty-writer partial-progress and shell pidwait tests also
failed in that broader run. Both focused native suites passed. The runner's
doctest step was not reached.

Live checks captured the real Ghostty window at 954×1044 without changing
focus. Both addons extracted by the standalone binary captured that window
and the authorized `eDP-1` desktop at 1920×1080. The extracted hashes matched the source
builds, and the images showed the expected window and desktop content.
Niri reported both HDMI-A-1 and eDP-1 enabled, but the existing portal grant
authorized only eDP-1. Live dual-monitor composition remains unverified;
no grant was reset or widened.

Fresh JavaScript and Python Eval helpers also captured `niri:47` through the
real supervisor and native addon. With 500×500 caps, both saved and displayed
the same 457×500 PNG from a 954×1044 source frame; neither capture changed focus.
Silent capture, missing and ambiguous selectors, and read-only mutation
rejection passed. The source and installed-cache addon hashes matched for
both CPU variants.

The corrected window extent rule passed a failing-before/passing-after
fractional-scale regression. Both rebuilt CPU variants captured the exact
Ghostty window. With a child-only invalid `NIRI_SOCKET`, desktop capture
still returned the authorized 1920×1080 portal frame, while a direct niri
target failed closed. Window listing reached AT-SPI instead of failing at
niri IPC; the live accessibility registry was unavailable and returned
`AxFailed`. Its fallback regression passed in both feature configurations.

The installed binary is `~/tools/omp-local/omp-linux-x64`, reached through
`~/.local/bin/omp`. The pre-rebase binary is retained at
`~/tools/omp-local/omp-linux-x64.before-18.4.9-f7055447f2`.
The binary from before the native review corrections is also retained at
`~/tools/omp-local/omp-linux-x64.before-direct-window-corrections-18.4.9`.
An older running omp of the same version can replace the shared native cache
with its own embedded addons. Restart existing sessions after installing.

## Release versions

`omp --version` reports the executable's package version. What's New uses the
numbered headings in the bundled coding-agent changelog, not that version.
The 18.4.8 source's newest heading was 18.4.6, so that heading did not establish
that an 18.4.6 executable was running. Upstream 18.4.9 adds matching release notes.
The rebuilt standalone's fresh interactive startup showed
`Updated to v18.4.9 · 19 changes in 1 release`.

The installed launcher reported `omp/18.4.9` and passed its smoke test.
`omp update --check` reported `Current version: 18.4.9` and `Already up to date`.


## Known limits

- Any `omp update` that changes the version drops a new
  `~/.omp/natives/<newversion>/` and stages from `node_modules`; the patched
  addon has to be rebuilt and re-embedded for that version.
- Desktop capture needs a working `org.freedesktop.portal.ScreenCast`
  implementation. Exact niri window capture requires niri's
  `org.gnome.Mutter.ScreenCast` service to belong to the same compositor as its
  IPC socket. Missing or mismatched services fail closed.
- Upstream keeps `wayland-pipewire` off by default and Bazel addons at
  `crate_features = []`. Until that changes upstream, every build must redo
  this.
- Native Wayland window input and `raise()` remain unavailable. Use supported
  semantic AX actions or desktop input after focusing the target yourself.
- Window streams with popup or shadow margins whose origin cannot be verified
  fail with `CaptureFailed` instead of silently misaligning the image.
