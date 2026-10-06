# computer Eval prelude

> Drive the real host desktop from Eval through direct `computer` helpers and window/element handles, or persistent JavaScript via `computer.run`: enumerate windows and displays, capture screenshots, send native input, use OS accessibility (AX), and access the clipboard. This is not the `browser` prelude and exposes no DOM.

User setup, permissions, safety guidance, examples, and platform limitations: [Scriptable computer use](../computer-use.md).

## Source

- Prelude factory and host service: `packages/coding-agent/src/tools/computer.ts`
- Direct-helper call renderer and approval policy: `packages/coding-agent/src/tools/computer/call.ts`
- Eval facades: `packages/coding-agent/src/tools/computer/{prelude.js,prelude.py,declarations.d.ts}`
- Model-facing prelude documentation: `packages/coding-agent/src/prompts/tools/computer.md`
- Computer-use prompt: `packages/coding-agent/src/prompts/system/computer-use.md`
- Prelude registration/gate: `packages/coding-agent/src/sdk.ts`
- Live prelude reconciliation: `packages/coding-agent/src/session/agent-session.ts`
- `/computer` toggle: `packages/coding-agent/src/slash-commands/builtin-modes.ts`
- Persistent worker: `packages/coding-agent/src/tools/computer/{supervisor,protocol,worker,worker-entry}.ts`
- Native implementation: `crates/pi-natives/src/desktop/`
- Native public types: `packages/natives/native/index.d.ts`

## Availability and declaration

- `computer.enabled` gates the Eval prelude and defaults to `false`. `/computer` toggles it for the current session without persisting settings.
- The prelude is available only through enabled Eval runtimes; it is not an AgentTool.
- The worker queues direct helpers, runs, and per-cell observation settlement in FIFO order. Capability inspection remains available during a run. Concurrent JS/Python cells keep their own observation and cancellation state. The active Eval documentation and globals update with the current enabled state.
- Unlike `browser`, this prelude can operate IDEs, terminals, native applications, browser windows, and system dialogs. It has no browser DOM or web ARIA surface; its accessibility methods use the host OS.

## Settings

| Setting              | Type    |  Default | Contract                                                                                                                     |
| -------------------- | ------- | -------: | ---------------------------------------------------------------------------------------------------------------------------- |
| `computer.enabled`   | boolean |  `false` | Enable the Eval prelude.                                                                                                     |
| `computer.display`   | string  | `active` | Capture the display with the largest focused-window overlap (primary fallback); use `all` or a native display ID explicitly. |
| `computer.maxWidth`  | number  |   `3840` | Maximum screenshot width.                                                                                                    |
| `computer.maxHeight` | number  |   `2400` | Maximum screenshot height.                                                                                                   |

There is no `computer.backend` setting. The native addon selects the platform backend.

For transports that do not preserve original image detail, and as a Claude-family compatibility fallback, the effective capture caps are `1280×896`. Other models retain the configured limits. The host snapshots cwd, session id, display, effective caps, and `read_only` for every run; the native desktop session itself remains persistent.

## Eval API

The `computer` global exposes the desktop helpers directly. Each helper is one host call (`action: "call"`) carrying an allowlisted method chain of at most two steps — a desktop root method, optionally followed by one method on the window or element handle it resolved — which the host renders into JavaScript and runs in the persistent session:

```js
const win = await computer.window({ app: "Code" });
await win.screenshot();
const tree = await win.ax({ maxDepth: 6 });
await (await win.ref("e12")).press();
await computer.capabilities();
await computer.close();
```

Python uses the same helper names; keyword arguments become the trailing options object, so `win.moveTo(x=120, y=80)` and `win.setFullscreen(enabled=True)` take the same options as JavaScript:

```python
win = await computer.window(app="Code")
await win.screenshot(silent=True)
tree = await win.ax(maxDepth=6)
await (await win.ref("e12")).press()
await win.click(120, 48, button="right")
```

Handles are frozen snapshots plus proxy methods. `computer.window(...)` and `computer.focusedWindow()` resolve to a `ComputerWindow` carrying `id`, `app`, `title`, `pid`, `bounds`, and `focused`; `computer.ref(...)`, `win.ref(...)`, `win.find(...)`, `computer.elementAt(...)`, `computer.focusedElement()`, `el.parent()`, and `el.children()` resolve to `ComputerElement` values carrying `ref`, `role`, `nativeRole`, `title`, `description`, `enabled`, `focused`, and `childCount`. Window methods re-resolve through `desktop.window(id)` and element methods through `desktop.ref(ref)` on every call, so a closed window or expired ref fails at the call. Methods are non-enumerable, so displaying or serializing a handle shows its identity fields only.

`computer.run(fnOrCode, { args?, read_only?, timeout? })` runs a multi-step function or JavaScript string in the same session and returns the real structured value. JavaScript functions receive `{ desktop, wait, assert }` — `desktop` has the desktop helpers plus synchronous `capabilities()`, but not `run()` or `close()` — and cannot capture Eval-cell closures; `{ args: [...] }` passes plain data, functions, and regular expressions after the scope object. Python `computer.run(code, read_only=..., timeout=...)` accepts a JavaScript string only. Nonempty inner `display` text prints in the outer Eval cell; screenshots surface as Eval images. `read_only` defaults to `false`; `timeout` defaults to 120 seconds, is capped by a positive `tools.maxTimeout`, then clamped to 1–300 seconds. The host invocation schema rejects unknown fields; the JavaScript facade forwards only recognized run options. `computer.capabilities()` reports the native backend and permission state (`action: "capabilities"`); `computer.close()` ends the persistent desktop session.

Approval: direct inspection calls are `read` and run with the worker's read-only guard; this includes `zoom`. Input and mutation calls are `exec`, including `raise`, element actions, window/workspace/display control, and clipboard writes. `computer.run` is `read` only when `read_only === true`; malformed input, an omitted flag, or `false` is `exec`.

Runs have full host access and are not sandboxed. The persistent `JsRuntime` supplies `desktop`, `wait`, and `assert`, plus ordinary helpers such as `display`, `print`, `read`, `write`, `env`, and `tool`. Full Bun/Node files, processes, modules, and network APIs remain available. `wait(ms)` sleeps; `wait(predicate, { timeout?, interval? })` polls until truthy.

## Desktop API

The same surface is reachable as `computer.*` directly and as `desktop.*` inside `computer.run`.

### Discovery

- `desktop.windows({ app?, title? })` returns matching `DesktopWindow[]`; app/title matching is case-insensitive substring matching.
- `desktop.window(id | { id?, app?, title? })` returns one persistent window facade. An id may be a string or a number (`74` is the id `"74"`, never matched against app or title). Zero matches throw with a bounded list of available windows; multiple matches throw with the candidates.
- `desktop.focusedWindow()` returns a window facade or `null`.
- `desktop.displays()` returns `DesktopDisplay[]`.
- `desktop.workspaces()` returns `DesktopWorkspace[]` entries with `{ id, index, name, displayId, active, focused, urgent, activeWindowId }`. Workspace IDs are opaque and stable (`niri-workspace:<n>` on niri, `x11-workspace:<n>` on X11).
- `desktop.capabilities()` returns capture/input/AX availability, `backgroundWindowInput` and `takeover` support, permission states, display server, backend, display count, and the optional `windowControl` block `{ backend, operations, coordinateSpace, focusMayWarpPointer }`. A missing block means the session has no window control.

A window facade exposes immutable `id`, `app`, `title`, optional `pid`, `bounds`, `positionKnown`, and `focused` fields.

### Applications and display handles

- `desktop.apps.list({ query?, runningOnly? })` returns `{ id, name, path, running, pid? }[]`.
- `desktop.apps.open(idOrNameOrNativeAppPath, { activate? })` launches a native application; exact identities/paths precede unique names, and deliberate activation defaults off.
- `desktop.display(id | "active" | "all")` returns a display input target with an independent screenshot frame. A new `"active"` screenshot reselects its monitor; input and zoom use that last frame, and keyboard input cannot silently target another monitor.

macOS uses bundle/Launch Services identity, Windows includes registered/Start-menu/packaged applications, and Linux uses XDG desktop entries with argv or D-Bus activation. Missing platform services fail explicitly. Windows/Linux activation hints are advisory; PID is omitted when process attribution cannot be established.

### Screenshots and input

Both a selected window and `desktop` expose:

- `screenshot({ silent? }) -> { path, width, height, coordinateWidth, coordinateHeight }`
- `zoom({ x, y, width, height }, { silent? }) -> { path, width, height, coordinateWidth, coordinateHeight, region }`
- `click(x, y, { button?, count?, modifiers?, takeover? })`
- `doubleClick(x, y, { button?, modifiers?, takeover? })`
- `move(x, y)`
- `drag([[x, y], ...], { modifiers?, takeover? })`
- `scroll(x, y, { dx?, dy?, takeover? })`
- `type(text, { takeover? })`
- `press(chord | string[], { takeover? })`

Windows also expose `raise()`, `focus()`, `ax(...)`, `find(...)`, `ref(...)`, `state()`, and the window-control helpers. Window input defaults to background delivery without deliberate activation or pointer movement. `takeover: true` briefly activates the target and posts real input; use it only after `BackgroundUnavailable` or a screenshot proves a no-op and AX cannot perform the action. Never replay uncertain input blindly. Desktop-root pointer helpers drive the user's real pointer, so prefer window handles.

`positionKnown` indicates whether window bounds have a verified global origin. If false, exact window capture may still work, but input requiring that origin fails with `InvalidCoordinateFrame`; AT-SPI window-relative bounds are not a safe substitute.

Screenshots are PNGs saved under the OS temp directory. Native capture is resized to the effective caps before saving and display; both Eval runtimes preserve the original-detail image bytes and metadata without another resize or encode. A screenshot reports captured dimensions, original source dimensions, and target. Unless silent, it emits status and image blocks and enables automatic after-input screenshots for that target.

`zoom({ x, y, width, height }, { silent? })` uses a rectangle from the last full screenshot, captures and crops the target afresh, and does not replace the full click frame. Returned `width`/`height` describe the zoom image; `coordinateWidth`/`coordinateHeight` remain those of the full frame. Desktop zoom stays pinned to the captured display. Resize or display-layout changes invalidate stale input and zoom frames.

Window/workspace controls call the compositor or window manager, not synthetic input: `state()`, `focus()`, `close()`, `moveTo()`, `moveBy()`, `resize()`, `maximize()`, `minimize()`, `restore()`, the three toggles, `setFullscreen()`, `setFloating()`, `center()`, `moveToWorkspace()`, and `moveToDisplay()`. Desktop helpers include `workspaces()`, `focusWorkspace()`, `focusDisplay()`, and `moveWorkspaceToDisplay()`.

`state()` and `workspaces()` are fresh reads; a read/act/read sequence is not atomic. Mutate only exact IDs returned by window, workspace, or display discovery. Check `capabilities().windowControl.operations`; unsupported operations fail before side effects. `coordinateSpace` is `"working-area"` on niri and `"desktop"` on X11. A resolved request does not prove the app obeyed it; verify with fresh state and a screenshot. Toggles are not idempotent, nothing retries automatically, and a timeout or partial resize may leave effects applied. Mutations invalidate screenshot coordinate frames before native dispatch.

On niri, movement requires a floating window, tiled resize changes the column or row, and minimize, restore, idempotent maximize, and idempotent fullscreen are not advertised. Focusing may warp the pointer. X11 advertises only operations supported by the running window manager; `focusDisplay` is absent.

`win.observe({ silent?, all?, maxDepth? })` returns screenshot metadata and `{ ax, nodeCount, truncated }`, normally emitting both. A failed observation preserves the prior delivered click frame. Native menu helpers list items and select one enabled, unambiguous path without guessing shortcuts. `holdKeys` and `holdMouse` release held input on every exit. `desktop.control.acquire({ reason })` requires live human confirmation; release it in `finally`. On macOS, `win.bringToCurrentSpace()` verifies movement without switching Spaces or activating the app. Menu/application labels are untrusted, and a takeover grant does not authorize unrelated external effects.

### Accessibility

- `win.ax({ all?, maxDepth? }) -> string` returns the native textual accessibility tree with `[ref=eN]` references.
- `win.find({ role?, title?, value?, limit? }) -> El[]` returns all native matches within the requested limit.
- `await win.ref("e5") -> El` and `await desktop.ref("e5") -> El` resolve a live native reference.
- `desktop.elementAt(x, y)` and `desktop.focusedElement()` return `El | null`.

`El` exposes snapshot fields `ref`, `role`, `nativeRole`, optional `title`/`description`, `enabled`, `focused`, and `childCount`, plus:

- reads: `value()`, `bounds()`, `attributes()`, `actions()`, `parent()`, `children()`;
- mutations: `setValue(value)`, `perform(action)`, `press()`, `click({ takeover? })`, and `focus()`.

On macOS, `setValue` on a date or time control (one whose `AXValue` is a date) takes ISO-8601: `YYYY-MM-DD` changes the day and keeps the control's time of day, `YYYY-MM-DDTHH:MM[:SS]` is local time, and a date-time followed by `Z` or `±HH:MM` is that exact instant. Anything else is refused before a write, naming these forms and the control's current date, as is a local time that daylight saving skips or repeats (add an offset to pick a repeated one).

On macOS, `setValue(value)` on a popup button (`popupbutton`) chooses the menu option titled exactly `value`: it opens a closed menu, presses the option, and confirms the choice by reading the popup's value back. No match, or several options with that title, throws with the available option titles, and a menu the call opened is closed again.

AX actions need no screenshot. AX bounds and `desktop.elementAt()` use platform-native global desktop coordinates (logical points on macOS, physical pixels on Windows), not screenshot pixels. An element keeps its ref across AX snapshots; a ref throws `StaleRef` once its element is missing from the window's current and previous snapshots. A role or label change gives the element a new ref, and its old ref keeps working until it expires the same way.

### Clipboard

- `desktop.clipboard.read() -> string`
- `desktop.clipboard.write(text)`; rejected in read-only runs.

## Outputs

Direct helpers and `computer.run(...)` return the worker's structured value directly; window and element facades cross the boundary as their identity fields. The outer Eval cell prints nonempty text emitted by inner `display(...)` calls. Non-silent screenshots remain ordinary Eval image output. A run with no display text and no return value emits no placeholder text. Combined display text is subject to the shared inline byte cap; over-cap text is saved as a session artifact.

Result details contain the resolved `code`, `readOnly`, `screenshots`, optional structured `value`, and capability metadata (`backend`, `capturePermission`, `inputPermission`, `axPermission`). Each screenshot detail contains `path`, `width`, `height`, `coordinateWidth`, `coordinateHeight`, optional `sourceWidth`/`sourceHeight` and `region`, and `target`. Provider delivery uses ordinary text/image content with image detail `original`; it does not use provider Files or native `computer_call_output` metadata.

After input, Eval waits until 500 ms after the last input completes, then appends
fresh AX feedback for affected windows and window-roster changes. Explicitly
printed AX reads take precedence over older automatic baselines. Targets whose
screenshots have been shown also receive after-input images. Automatic full
window/root AX trees use a 16 KiB UTF-8 budget, retain complete rows, and mark
truncation.

The usage guide appears once per prelude session after the first direct window
lookup, even if the cell catches a lookup failure. Cancelled cells discard only
their pending observations; late callbacks cannot contribute to another cell.

## Flow and lifecycle

1. `createComputerPrelude(session)` defines the enabled-only global and its host-side invoker.
2. A direct helper renders its allowlisted call chain, and `computer.run(fnOrCode, options)` serializes a function when needed; the host resolves the JavaScript, clamps the timeout, computes effective image caps, creates the per-run snapshot (read-only for inspection chains), and asks the supervisor to execute it.
3. The supervisor lazily starts one crash-isolated Bun worker (10-second startup deadline), queues execution and observation settlement in FIFO order, and forwards cancellation to the owning cell.
4. The worker lazily creates one native `DesktopSession` and one persistent `JsRuntime`. Handles, screenshot coordinate frames, runtime variables, and recent AX refs survive successful calls.
5. Each run installs a run-scoped `desktop` facade plus `wait`/`assert`. AsyncLocalStorage prevents leaked asynchronous work from borrowing a later run's signal or read-only policy.
6. Native operations run in the worker with cancellation tokens captured before NAPI scheduling. Mutations acquire an OS-backed cross-process input/focus lease; reads do not. Runtime `tool.*` calls cross back through the supervisor into the owning session tool bridge and inherit cancellation.
7. Abort, timeout, and normal run teardown synchronously retire that run's native generation, including unawaited queued operations. Delivery checks cancellation between events and releases held input during cleanup; later runs use a fresh generation. Clone-safe displays, return value, and capabilities return to the host, and the worker remains alive. Observation settlement stays tied to its Eval cell and cannot consume another cell's feedback.
8. A run timeout is followed by a 750 ms supervisor grace period. If the worker does not finish, it is terminated with `computer worker restarted; captures and ax refs were reset`; a later call starts a fresh worker.
9. Session cleanup sends `close`, waits up to 1.5 seconds, then force-terminates as a bounded fallback. Owner-scoped cleanup closes every registered computer controller.

## Side effects

- Captures real windows or the selected desktop composite into provider context and writes PNGs to the OS temp directory.
- Sends real keyboard/pointer input. Window background delivery is intended to preserve focus, pointer, and window order; `takeover: true` may temporarily activate the target. Desktop-root pointer calls affect the user's real pointer.
- Reads or writes the system clipboard.
- Executes full-access JavaScript and may invoke other session tools through `tool.*`.
- Keeps a native desktop session and Bun worker alive across calls.
- Does not launch a browser or fall back to browser automation.

## Errors and recovery

Native errors are surfaced as `ToolError` text prefixed by the stable code name:

- `PermissionDenied`, `CaptureFailed`, `InputFailed`, `BackgroundUnavailable`, `InputBusy`, `Cancelled`
- `WindowNotFound`, `InvalidTarget`, `InvalidKey`, `InvalidCoordinateFrame`, `ControlUnsupported`, `ControlFailed`
- `StaleRef`, `AxUnsupported`, `AxFailed`, `Timeout`, `Closed`, `Internal`
- `Unsupported`, `SpaceUnsupported`, `SpaceMoveDenied`

Prelude/worker errors include `Computer session is closed`, `Timed out starting computer worker`, `Computer code execution timed out after <ms>ms`, read-only mutation errors, and the worker-restart message above.

`InputBusy` means another native operation owns input/focus and no input was sent. On macOS a listen-only, operation-scoped Escape monitor cancels physical Escape but ignores synthetic events. An unavailable monitor refuses input with `PermissionDenied`. `Cancelled` may follow partial input or an atomic OS/AX operation: cancellation cannot undo effects already delivered.

Recover by refreshing the exact target screenshot after coordinate-frame errors, taking a new AX snapshot after `StaleRef`, and inspecting `desktop.capabilities()` for platform/permission failures. After `BackgroundUnavailable`, prefer AX; use `takeover: true` only for the refused call when supported. After partial-delivery or restoration errors, inspect the target before retrying because input may already have landed. After `ControlUnsupported`, check `windowControl.operations` and change approach. After `ControlFailed` or `Timeout`, read `state()` or capture a screenshot before deciding; the request may already have been applied.

## Platform constraints

Current native backends support macOS, Linux X11, Linux Wayland portal capture/input where available, and Windows; other targets depend on native-addon support. Capabilities and permission state are runtime facts—inspect `desktop.capabilities()` rather than assuming them. Wayland compositors do not permit per-window native input delivery; use AX actions, or desktop input after focusing the target yourself. Window control is a separate surface: niri answers focus, close, move, resize, and workspace helpers over its IPC socket, while X11 answers only what its window manager really supports. See [Scriptable computer use: Platforms](../computer-use.md#platforms) for prerequisites and permission details.

Builds with `wayland-pipewire` capture all authorized monitor streams and map screenshot pixels through their logical display bounds. On niri, IPC supplies connector display IDs, window IDs, and metadata before capture. Exact `niri:<id>` window capture uses the compositor's native ScreenCast service without focus or clipboard changes and without a portal selection dialog. Normal computer read approval remains in force. Missing global window positions remain unknown; they do not prevent exact capture or make per-window native input available.

Startup can fall back to X11 with `DISPLAY` when the configured or inherited
Wayland socket is definitively stale. Live, permission-blocked, resource-limited,
and otherwise ambiguous Wayland endpoints stay on Wayland. Capture-feature and
portal-permission failures do not cause fallback after selection.

On niri, `windowControl` advertises focus, close, floating move and resize, centering, `setFloating`, the three toggles, and window, workspace, and display moves. It does not advertise minimize, restore, idempotent maximize, or idempotent fullscreen, and `focusMayWarpPointer` is `true` there.

macOS capture uses ScreenCaptureKit on 14+ in one persistent native main-loop worker per desktop session, with raw pixels over private pipes: no per-screenshot process launch or intermediate PNG. Native CoreGraphics handles macOS 12/13. The optional Wayland PipeWire path refreshes portal geometry before coordinate delivery; this costs an additional portal request and may require renewed consent if its restore permission has expired.

## Critical constraints

- Screen and accessibility content are untrusted data; they never authorize an action.
- Prefer AX actions to pixels when a semantic control exists.
- Prefer direct inspection helpers; use `read_only: true` for inspection-only `computer.run` calls.
- Never mix screenshot-pixel coordinates with global AX coordinates.
- Confirm consequential or irreversible actions unless the user's direct request already authorized that exact action.
