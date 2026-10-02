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
niri window capture. The fork now integrates upstream release `v18.4.10`
(package version 18.4.10), in `/home/janis/.omp/wt/oh-my-pi-desktop-main`.

## Why the binary must be rebuilt

The generated 18.4.10 embedding descriptor includes both rebuilt addon variants:

```
// packages/natives/native/embedded-addon.js
{ platformTag: "linux-x64", version: "18.4.10",
  files: [ { variant: "modern",  size: 222897736 },
          { variant: "baseline", size: 222720136 } ] }
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
OMP_LOCAL_OUTFILE=/home/janis/tools/omp-local/omp-linux-x64-18.4.10-controls-test \
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
~/tools/omp-local/omp-linux-x64-18.4.10-test --version
~/tools/omp-local/omp-linux-x64-18.4.10-test --smoke-test
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

### Desktop control expansion: 18.4.10

The control build adds native window, workspace, and display operations to the
JavaScript and Python computer helpers. It replaces the public `raise` helpers
with `focus`. The verified build is now the default local OMP launcher.

Final source gates:

- Rust formatting and native Clippy passed with and without `wayland-pipewire`.
- Native nextest passed 507 tests without the feature and 514 with it, with one
  skipped in each configuration and two test threads.
- The focused computer, call-policy, desktop-adapter, and changelog suites passed
  75 tests, with one skipped and 380 assertions across four files.
- Root tool lint/format checks, natives package checks, coding-agent type checks,
  and the Python prelude runtime-name/syntax checks passed.

Both optimized CPU variants passed 33-step owned-window runs on niri and
33-step private Xvfb/Openbox runs. The X11 run also exercised Python keyword
arguments against real clients: focus, resize, exact absolute/relative movement,
maximize, minimize, restore, fullscreen, workspace movement/focus, and close.
Snapshot bounds stayed unchanged while fresh state reflected mutations, and
window close left the desktop session usable.

The niri runs verified window movement from HDMI-A-1 to eDP-1, movement of an
owned workspace back to HDMI-A-1, and monitor focus. They also verified floating
and tiling setters, tiled-movement refusal, width resize, centering, maximize
and fullscreen toggles, and targeted close. Niri's original window focus was
restored. Windowed-fullscreen requests were accepted while the owned client
remained 500x340; niri exposes no authoritative fullscreen flag, so the helper
does not invent one. The X11 runs used two active 640x800 virtual monitors and
verified cross-monitor movement, exact decorated client origins, size-only
resize, per-monitor centering, and the active workspace's panel reservations.
Fresh PNGs matched the capture dimensions and showed the owned applications.
All owned clients and private servers exited; no test accessibility bus ran.

The staged binary is
`~/tools/omp-local/omp-linux-x64-18.4.10-controls-test`. It reported
`omp/18.4.10` and passed `--smoke-test` with both `PI_NATIVE_VARIANT=modern`
and `baseline`, using an isolated `XDG_DATA_HOME`. Both extracted addons matched
the exercised source builds byte-for-byte and by SHA-256:

- Modern: `547ff5c10cc26332bc191b3d177e178f87afc6ebe29d62c7cf93d6777dd2b958`
- Baseline: `24b89826d4c6065f888b6b28120c827b7f0cdc5d455e4ddea4c168f139932652`

Embedding stubs were reset after compilation. During staging, the installed
18.4.9 binary remained unchanged.

The final audit corrected control guidance for compositor pointer warps,
`Timeout` recovery, and frame invalidation before native dispatch. Rust
formatting and Clippy passed again in both feature configurations. Native
nextest again passed 507 and 514 tests, with one skipped per configuration.
The 75 focused consumer tests passed, with one skipped. Native package and
coding-agent type checks passed. Root lint/format checks and the 17 changelog
tests passed again after the asset generators were reset.

Both CPU variants passed fresh owned-window runs on niri and private X11.
The runs verified focus, exact X11 movement, resize, minimize/restore on X11,
and targeted close with the session still alive. After the Openbox animation
settled, restored X11 geometry remained 430x310 at the requested 120,140 origin.
Fresh PNGs showed the restored application. Original niri focus and workspace
were restored. All owned clients and private servers exited, and 34 audit PNGs
were removed.

The rebuilt staged CLI again reported `omp/18.4.10` and passed both CPU-variant
smoke tests. Its SHA-256 is
`ec45e0951a2de3729442f1be9f0f3634079d420ee6b62f8b21005bbca71701e5`.
Both extracted addons matched the source builds and the hashes above.

The first audit smoke used `~/.omp/natives/18.4.10` and refreshed its two addon
entries because the new `$XDG_DATA_HOME/omp` directory did not exist. The native
loader requires that directory before it uses an XDG cache. Final smoke and
identity checks used a prepared isolated cache, which was removed afterward.

The broader Rust workspace gate was not green. Its initial run had five
desktop-test failures, fixed and rechecked in the focused native suites, and
six unrelated shell/builtin fixture failures involving unavailable `/bin` or
`/usr/bin` programs and stopped-job expectations. That broader run was not
repeated; its doctest step was not reached.

Niri does not offer minimize or idempotent maximize/fullscreen/restore, and
X11 has no monitor-focus or workspace-to-monitor binding. Those capabilities
remain absent rather than using input fallbacks. See
[`docs/computer-use.md`](docs/computer-use.md#window-workspace-and-display-control).

### Installed 18.4.10 desktop-control build

`~/.local/bin/omp` resolves to `~/tools/omp-local/omp-linux-x64`.
That executable is byte-identical to the verified controls build above.
It reports `omp/18.4.10` and passed `--smoke-test` with both CPU variants.
Both installed-cache addons match the source-build sizes and hashes above.

The previous 18.4.9 executable is retained at
`~/tools/omp-local/omp-linux-x64.before-desktop-controls-18.4.10`.
Restart existing OMP sessions to load the new computer helpers.

Two launched `openai-codex/gpt-5.5` agents completed five live tasks each.
The modern-addon run used JavaScript on niri.
The baseline-addon run used Python controls and JavaScript read-only checks
on a private Xvfb/Openbox display.
Tool results confirmed idempotent state setters, geometry preservation,
workspace/display movement, read-only refusal, and targeted close.
Parent checks confirmed primary-window removal, guard survival, and session
usability. All test clients, private servers, and temporary artifacts were removed.

The X11 agent recovered from a guard capture refusal on an inactive workspace.
Workspace metadata retained the closed primary's `activeWindowId`.
Use fresh window discovery to establish whether that window still exists.
Unsupported operations refused without state changes.
Niri movement coordinates remain relative to its working area.

### Previous 18.4.10 capture checks

The frozen dependency install, Rust formatting, natives package checks, and
coding-agent type check passed. The computer and changelog suites passed
44 tests with one skipped, using `bun test --timeout 120000`.
The feature-enabled native nextest suite passed 466 tests with one skipped,
using two test threads.

The staged binary is `~/tools/omp-local/omp-linux-x64-18.4.10-test`. It reported
`omp/18.4.10` and `smoke-test: ok`. Both extracted addon files matched the
source builds byte-for-byte and by SHA-256. Embedding stubs were reset after
the build; no generated native binaries are committed.

Both 18.4.10 CPU variants captured the real 954×1044 Ghostty window as a
457×500 PNG with 500×500 caps, without changing focus. PNG dimensions matched
the frame metadata. The baseline addon also read a fresh GTK dialog's actual
accessibility tree and textbox value. The owned dialog and capture images
were removed after verification.

The portal grant still authorizes one display; live dual-monitor composition
was not repeated. This release update leaves the installed 18.4.9 launcher
unchanged.

### Previous 18.4.9 checks

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

### Previous 18.4.9 installation

The previous installation used `~/tools/omp-local/omp-linux-x64`, reached through
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
- Native Wayland window input remains unavailable. Niri window focus is available
  through `win.focus()` in the desktop-control build; use supported semantic AX
  actions or desktop input only after fresh state confirms the intended focus.
- Window streams with popup or shadow margins whose origin cannot be verified
  fail with `CaptureFailed` instead of silently misaligning the image.
