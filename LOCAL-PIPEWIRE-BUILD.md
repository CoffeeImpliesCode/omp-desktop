# Linux Wayland build: PipeWire capture

Linux native addons now load `libpipewire-0.3.so.0` at runtime; no Cargo feature
is required. Without a loadable library, capture is unavailable. The native
backend probes the inherited Wayland socket or configured socket path; only a
conclusively stale endpoint permits X11 fallback. Xwayland is rootless on niri,
so an X11 root-window capture cannot replace native Wayland capture.

The build below embeds both native addon variants. The fork keeps every
authorized monitor stream and exact niri window capture, and integrates upstream
commit `6425ef0e` after v18.22.0.

## Why a hand-dropped addon is not enough

`packages/natives/native/loader-state.js` compares a cached addon with the
embedded descriptor by file size only, and `maybeExtractEmbeddedAddon`
re-extracts the embedded archive over `~/.omp/natives/<version>/` whenever the
size differs. A patched addon copied into that cache is therefore reverted on
the next launch, so fork changes must be embedded in the executable. The
`embeddedAddon = null` in the source tree is the state left by `--reset`.

## Prerequisites

- Bun at or above the `engines.bun` minimum in
  `packages/coding-agent/package.json`, currently `>= 1.4.4`.
- The Rust toolchain pinned by `rust-toolchain.toml`.
- `pkg-config`, Clang, and the PipeWire development libraries.
- On NixOS, `nix develop .` loads the pinned tools and native libraries.
- Linux voice mode uses PulseAudio client libraries with `pipewire-pulse`, or
  ALSA. The Nix shell supplies both and `patchelf`; local native builds retain
  their paths through `OMP_NATIVE_RUNTIME_LIBRARY_PATH` before embedding.

On NixOS, enter the development shell first so dependency installation and the
build use the pinned Bun, Rust toolchain, and PipeWire libraries:

```sh
nix develop .
bun install --frozen-lockfile --ignore-scripts
```

## Build

Run every command from the checkout root. Both native variants are required
because the executable may run on x64 hosts with different ISA support:

```sh
export CARGO_BUILD_JOBS=2

# Locate the runtime PipeWire library for the addon's RUNPATH.
pkg-config --modversion libpipewire-0.3
RP="$(pkg-config --variable=libdir libpipewire-0.3)"

# Build baseline and modern addons. RUSTFLAGS must include the ISA floor.
# Each variant keeps its own target dir: different rustflags invalidate
# cargo's fingerprints, so a shared dir recompiles everything twice.
cd packages/natives
CARGO_TARGET_DIR="$PWD/../../target/baseline" \
RUSTFLAGS="-C target-cpu=x86-64-v2 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=baseline bun scripts/build-bindings.ts
CARGO_TARGET_DIR="$PWD/../../target/modern" \
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

**Desktop ABI.** The JavaScript adapter requires desktop ABI 1 before it
constructs a native session. Method names alone cannot prove compatible drag
results or control semantics. A stale addon leaves non-desktop tools usable,
but computer use fails with a rebuild-and-restart instruction. Rebuild both
variants before compiling the executable; restart existing omp processes.

**Bun runtime.** The standalone binary embeds the Bun used to compile it.
`packages/coding-agent/package.json` declares the minimum version. The project
Nix development shell supplies Bun 1.4.4; check `bun --version` before building.

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

### Browser regression checks

Flatpak Chrome cannot read a Nix shell's private `/tmp` paths. Set the test
process's `TMPDIR` to a temporary child of Chrome's existing `XDG_CACHE_HOME`
(`flatpak run --command=printenv com.google.Chrome XDG_CACHE_HOME`). Pass it
after `nix develop . --command env` so the shell does not replace it. Remove
that test directory afterwards; no Flatpak permission changes are needed.
For cold-start browser cases, use `bun test --timeout 30000` rather than the
default five-second budget.

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
- Native Wayland window input stays unavailable. Niri window focus is available
  through `win.focus()`; use semantic accessibility actions or desktop input
  only after fresh state confirms the intended focus.
- Niri offers no minimize and no idempotent maximize/fullscreen/restore, and
  X11 has no monitor-focus or workspace-to-monitor binding. Those stay
  unsupported instead of falling back to synthesized input. See
  [docs/computer-use.md](docs/computer-use.md#window-workspace-and-display-control).
- niri window streams are sized from the window's bounding box, which includes
  client-side shadows and popups. The window is cropped out of that box by its
  opaque pixels; a popup reaching past the window or a translucent window edge
  fails with `CaptureFailed` instead of silently misaligning the image.
