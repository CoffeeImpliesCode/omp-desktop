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
niri window capture, and integrates upstream v18.6.2.

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

Install the workspace dependencies before any build. `--ignore-scripts` keeps
install-time scripts from generating assets, so the steps below stay the only
build:

```sh
bun install --frozen-lockfile --ignore-scripts
```

## Build

Run every command from the checkout root.

```sh
export CARGO_TARGET_DIR="$PWD/target"
export CARGO_BUILD_JOBS=2

# 1. Check that pkg-config can find PipeWire. The build enables the feature.
pkg-config --modversion libpipewire-0.3
RP="$(pkg-config --variable=libdir libpipewire-0.3)"

# 2. Build BOTH variants. Explicit RUSTFLAGS must include the ISA floor.
cd packages/natives
RUSTFLAGS="-C target-cpu=x86-64-v2 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=baseline bun scripts/build-bindings.ts
RUSTFLAGS="-C target-cpu=x86-64-v3 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=modern bun scripts/build-bindings.ts

# 3. Prepare all binary assets, then compile inside the checkout.
bun run gen:native
cd ../..
bun --cwd=packages/stats run gen:stats
bun --cwd=packages/coding-agent run gen:tool-views
bun compile-one.ts
```

The default output is `packages/coding-agent/dist/omp-linux-x64`. Set
`OMP_LOCAL_OUTFILE` to write somewhere else.

Restore the generated embedding stubs after compilation:

```sh
bun --cwd=packages/natives run gen:native:reset
bun --cwd=packages/stats run gen:stats:reset
```

Do not reset the native stub before compiling. A compile without a preceding
`gen:native` embeds no addon.

### Why `RUSTFLAGS` is set explicitly

`build-bindings.ts` pins the ISA floor only while `RUSTFLAGS` is unset. The Nix
rpath has to arrive through `RUSTFLAGS`, so setting it for the linker alone
suppresses that pinning and both addons become the same build under two names.

### Both variants are required

`gen:native` embeds whichever `.node` files are present, and `embed-native.ts`
rejects any addon whose version stamp does not match `package.json`. The
published `@oh-my-pi/pi-natives-linux-x64` release can lag `main`, so a `main`
checkout has no published addon to fall back on. Embedding only `modern` leaves
hosts without AVX2 loading an AVX2 binary. `OMP_NATIVE_X64_VARIANT` is a fork
addition: upstream derives the variant from host AVX2 detection, so one machine
can emit only one of the two. Unset, behaviour matches upstream.

**Bun runtime.** `target: "bun-linux-x64-baseline"` embeds the compiling bun as
the runtime, so a binary built with 1.3.13 refuses to start with `error: Bun
runtime must be >= 1.3.14`. Check `bun --version` before compiling.

## Verify

```sh
packages/coding-agent/dist/omp-linux-x64 --version
packages/coding-agent/dist/omp-linux-x64 --smoke-test
PI_NATIVE_VARIANT=modern  packages/coding-agent/dist/omp-linux-x64 --smoke-test
PI_NATIVE_VARIANT=baseline packages/coding-agent/dist/omp-linux-x64 --smoke-test
```

`--version` prints the package version compiled into the executable. What is New
uses the headings of the bundled coding-agent changelog, not that string.

The standalone smoke checks worker startup and bundled assets. It does not
capture anything. Exercise real capture through the computer interface, and
resolve the target from discovery instead of a hardcoded name or identifier:

```js
display(await computer.displays());
display(await computer.capabilities());

// Discover the windows first, then resolve the one you selected. Replace the
// app with that window's exact application id; an ambiguous filter throws.
const selected = { app: "<application id of the window you selected>" };
const candidates = await computer.windows(selected);
if (candidates.length !== 1) throw new Error("Select exactly one window");

const win = await computer.window(candidates[0].id);
display({ id: win.id, bounds: win.bounds, positionKnown: win.positionKnown });
await win.screenshot();
await computer.screenshot();
```

The reported image dimensions have to match the frame metadata, the frame has to
show the selected window, and capture must not change focus. `computer.displays()`
reports the desktop's displays and grants no capture authorization on its own.
The `computer.display` session setting chooses the desktop capture target:
every authorized stream, or one display by the id that `computer.displays()`
returned.

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
