# Local build: Wayland PipeWire capture

The shipped `pi_natives` addons are built with `crate_features = []`, so on a
Wayland session `capture()` is compiled down to
`CaptureFailed: Wayland capture requires the wayland-pipewire feature`. The
X11 fallback does not help: niri runs Xwayland rootless, so the X root window
is empty. `~/.omp/agent/{settings.json,config.yml}` have no lever for this —
backend selection reads only `WAYLAND_DISPLAY` / `DISPLAY`
(`crates/pi-natives/src/desktop/linux/mod.rs`).

Fix: rebuild both addon variants with the opt-in feature and bake them into the
binary. Verified on `main` @ 18.4.4 (commit `8ac1309bd`).

## Why the binary must be rebuilt

`~/.local/bin/omp` is a compiled standalone, and it embeds the addon:

```
// packages/natives/native/embedded-addon.js
{ platformTag: "linux-x64", version: "18.4.4",
  files: [ { variant: "modern",  size: 222007736 },
          { variant: "baseline", size: 221913840 } ] }
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
  OMP_NATIVE_X64_VARIANT=baseline bun scripts/build-bindings.ts   # ~20 min
RUSTFLAGS="-C target-cpu=x86-64-v3 -C link-arg=-Wl,-rpath,$RP" \
  OMP_NATIVE_X64_VARIANT=modern  bun scripts/build-bindings.ts   # ~21 min

# 4. Embed, then compile. gen:native must run before the compile.
bun run gen:native
cd ../.. && bun compile-one.ts                  # -> /home/janis/tools/omp-local/omp-linux-x64
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

Confirm what was actually built — cargo records it per variant:

```sh
for f in target/x86_64-unknown-linux-gnu/local/build/pi-natives/*/fingerprint/lib-pi_natives.json; do
  python3 -c "import json;print(json.load(open('$f')).get('rustflags'))"
done
```

Expect one entry with `x86-64-v2` and one with `x86-64-v3`.

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
# The loader extracts the embedded addons on first native load.
PI_DEBUG_STARTUP=1 ~/tools/omp-local/omp-linux-x64 read /etc/hostname 2>&1 \
  | grep startup
stat -c '%n %s' ~/.omp/natives/18.4.4/*.node

# End to end. Approve the ScreenCast consent dialog on the desktop.
node -e '
const {createRequire}=require("module");
const m=createRequire("/home/janis/.omp/natives/18.4.4/x.js")(
  "/home/janis/.omp/natives/18.4.4/pi_natives.linux-x64-modern.node");
console.log(m.__piNativesBuildVersion());
new m.DesktopSession().capture("desktop")
  .then(f=>console.log(f.width+"x"+f.height, f.data.length));
'
```

`capabilities().displayCount` is `0` until the first `capture()` — the
`displays` vec is only populated in `capture()`
(`crates/pi-natives/src/desktop/linux/wayland/mod.rs`). Not a defect.

## Known limits

- Any `omp update` that changes the version drops a new
  `~/.omp/natives/<newversion>/` and stages from `node_modules`; the patched
  addon has to be rebuilt and re-embedded for that version.
- The pipewire capture path needs a working `org.freedesktop.portal.ScreenCast`
  and a compositor exporting an implementation. niri exports
  `org.gnome.Mutter.ScreenCast`; verify with `busctl --user list | grep ScreenCast`
  before blaming the build.
- Upstream keeps `wayland-pipewire` off by default and Bazel addons at
  `crate_features = []`. Until that changes upstream, every build must redo
  this.
