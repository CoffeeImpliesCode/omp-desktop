# Linux Wayland build: PipeWire capture

Released builds compile the native addons with `crate_features = []`. On a
Wayland session `capture()` is then reduced to
`CaptureFailed: Wayland capture requires the wayland-pipewire feature`. The X11
fallback does not help: niri runs Xwayland rootless, so the X root window is
empty. Backend selection reads only `WAYLAND_DISPLAY` / `DISPLAY`
(`crates/pi-natives/src/desktop/linux/mod.rs`), so neither
`~/.omp/agent/settings.json` nor `config.yml` turns the feature on. The build
below compiles both addons with `wayland-pipewire` and embeds them in the
executable. The fork also keeps every authorized monitor stream, adds exact
niri window capture, and integrates upstream v18.8.6.

## Why a hand-dropped addon is not enough

`packages/natives/native/loader-state.js` compares a cached addon with the
embedded descriptor by file size only, and `maybeExtractEmbeddedAddon`
re-extracts the embedded archive over `~/.omp/natives/<version>/` whenever the
size differs. A patched addon copied into that cache is therefore reverted on
the next launch, and the feature flag has to live in the binary. The
`embeddedAddon = null` in the source tree is the state left by `--reset`.

## Prerequisites

- Bun at or above the `engines.bun` minimum in
  `packages/coding-agent/package.json`, currently `>= 1.3.14`.
- The Rust toolchain pinned by `rust-toolchain.toml`.
- `pkg-config`, Clang, and the PipeWire development libraries.
- On NixOS, `nix develop path:.` loads the pinned tools and native libraries.

On NixOS, enter the development shell first so dependency installation and the
build use the pinned Bun, Rust toolchain, and PipeWire libraries:

```sh
nix develop path:.
bun install --frozen-lockfile --ignore-scripts
```

## Build

Run every command from the checkout root. Both native variants are required
because the executable may run on x64 hosts with different ISA support:

```sh
export CARGO_TARGET_DIR="$PWD/target"
export CARGO_BUILD_JOBS=2

# Check that pkg-config can find PipeWire. The native build enables the feature.
pkg-config --modversion libpipewire-0.3
RP="$(pkg-config --variable=libdir libpipewire-0.3)"

# Build baseline and modern addons. RUSTFLAGS must include the ISA floor.
cd packages/natives
RUSTFLAGS="-C target-cpu=x86-64-v2 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=baseline bun scripts/build-bindings.ts
RUSTFLAGS="-C target-cpu=x86-64-v3 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=modern bun scripts/build-bindings.ts
cd ../..

# Builds docs, stats, and tool views, then embeds the matching native addons
# in memory and writes the standalone binary to packages/coding-agent/dist/omp.
bun --cwd=packages/coding-agent run build
```

The coding-agent build script generates and resets the stats asset itself.
`compile-binary.ts` embeds both addons and the manifest in memory; do not run
the removed `gen:native` scripts or reset native files before the build.

### Why `RUSTFLAGS` is set explicitly

`build-bindings.ts` pins the ISA floor only while `RUSTFLAGS` is unset. The Nix
rpath must arrive through `RUSTFLAGS`, so include the ISA flag in the same value
or the baseline and modern files can contain the same host-specific build.

### Both variants are required

`embed-native.ts` embeds each available addon and rejects a version stamp that
does not match `packages/natives/package.json`. Embedding only `modern` leaves
hosts without AVX2 loading an AVX2 binary. The fork's
`OMP_NATIVE_X64_VARIANT` override builds both variants on one host.

**Bun runtime.** The standalone binary embeds the Bun used to compile it.
`packages/coding-agent/package.json` declares the minimum version. The project
Nix development shell supplies Bun 1.4.2; check `bun --version` before building.

## Verify

```sh
packages/coding-agent/dist/omp --version
packages/coding-agent/dist/omp --smoke-test
PI_NATIVE_VARIANT=modern packages/coding-agent/dist/omp --smoke-test
PI_NATIVE_VARIANT=baseline packages/coding-agent/dist/omp --smoke-test
```

`--version` prints the package version compiled into the executable. What is New
uses the headings of the bundled coding-agent changelog, not that string.

The standalone smoke checks worker startup and bundled assets, not native
capture. Exercise capture with one screenshot and without interacting with the
desktop:

```sh
PI_NATIVE_VARIANT=modern packages/coding-agent/dist/omp -p --no-session \
  'Call computer.capabilities(). If capture is supported, call computer.screenshot() once. Do not click, type, focus, or interact with apps. Do not quote or describe visible content. Report only capture support and screenshot dimensions or the exact failure. If a permission prompt appears, stop.'
```

Confirm the reported screenshot dimensions. A screenshot exercises capture but
does not prove that coordinate mapping is safe; use discovered targets and
verified geometry before testing input.

### Permission boundaries

- Approve the ScreenCast portal selection yourself. The grant decides which
  monitor streams capture may use, and a rebuild does not widen it.
- RemoteDesktop input permission is requested lazily on first native input, is
  not persisted, and ends with the desktop session. Read-only window and
  accessibility reads never request it.
- On niri, window capture uses the compositor's own ScreenCast service and
  opens no portal picker. Normal computer read approval still applies.
- On niri, `capabilities().displayCount` is filled from IPC before capture.
  Windows whose global origin niri does not publish report `positionKnown:
  false`. Exact capture still works for them, and unsafe global coordinate
  input is refused.
- An unusable `NIRI_SOCKET` fails closed. Desktop capture keeps returning the
  authorized portal frame, while a direct niri target does not.

## Known limits

- Any `omp update` that changes the version drops a new
  `~/.omp/natives/<newversion>/` directory and stages from `node_modules`, so
  the addon has to be rebuilt and re-embedded for that version. An older running
  `omp` of the same version can also replace the shared native cache, so restart
  running sessions after installing.
- Desktop capture needs a working `org.freedesktop.portal.ScreenCast`, and exact
  niri window capture needs niri's `org.gnome.Mutter.ScreenCast` service on the
  same compositor as its IPC socket. Missing or mismatched services fail closed.
- Upstream keeps `wayland-pipewire` off by default, so every build redoes the
  steps above.
- Native Wayland window input stays unavailable. Niri window focus is available
  through `win.focus()`; use semantic accessibility actions or desktop input
  only after fresh state confirms the intended focus.
- Niri offers no minimize and no idempotent maximize/fullscreen/restore, and
  X11 has no monitor-focus or workspace-to-monitor binding. Those stay
  unsupported instead of falling back to synthesized input. See
  [docs/computer-use.md](docs/computer-use.md#window-workspace-and-display-control).
- Window streams with popup or shadow margins whose origin cannot be verified
  fail with `CaptureFailed` instead of silently misaligning the image.
