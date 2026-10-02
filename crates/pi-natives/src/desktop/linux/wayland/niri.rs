//! niri compositor state, window control and native per-window capture.
//!
//! niri answers window identity, focus, geometry, workspace and monitor layout
//! on the `$NIRI_SOCKET` Unix socket, and accepts one action per line on that
//! same socket. That IPC is the only source on this platform that knows where
//! the compositor actually put a window — AT-SPI clients answer with
//! window-relative coordinates — so window targets are addressed by `niri:<id>`
//! and never by a toolkit object. It is also the only way to focus, move,
//! resize or close a window here: Wayland itself grants a client no way to do
//! that to another client's surface.
//!
//! Control resolves every target against fresh compositor state before a byte
//! goes out, because niri answers `Handled` to an action it could not apply —
//! an id it does not know included. A precondition this module cannot satisfy
//! is refused before the wire instead of being sent as a no-op that reports
//! success.
//!
//! Capture goes through niri's own `org.gnome.Mutter.ScreenCast` service:
//! `CreateSession`, `Session.RecordWindow`, `Session.Start`, then the
//! `Stream.PipeWireStreamAdded` node. Nothing on that path asks the portal for
//! consent, writes the clipboard, raises a window or moves focus, and the frame
//! is the compositor's render of that one window rather than a crop of
//! whichever monitor happened to be selected.

#[cfg(feature = "wayland-pipewire")]
use std::os::fd::AsRawFd;
use std::{
	collections::{HashMap, HashSet},
	fmt,
	io::{self, Read, Write},
	os::unix::net::UnixStream,
	path::PathBuf,
	time::Duration,
};

#[cfg(feature = "wayland-pipewire")]
use image::RgbaImage;
use serde::{Deserialize, de::DeserializeOwned};
use smallvec::{SmallVec, smallvec};
#[cfg(feature = "wayland-pipewire")]
use {
	futures::StreamExt,
	tokio::runtime::Runtime,
	zbus::{
		Connection, MatchRule, MessageStream, fdo,
		message::Type as MessageType,
		names::{BusName, OwnedUniqueName},
		zvariant::{OwnedObjectPath, Value},
	},
};

use crate::desktop::{
	control::ControlAction,
	error::{CoreResult, DesktopError, ErrorCode},
	types::{
		DesktopControlCapabilities, DesktopDisplay, DesktopWindow, DesktopWindowState,
		DesktopWorkspace,
	},
};

/// Prefix of the workspace ids this module mints.
const WORKSPACE_PREFIX: &str = "niri-workspace:";

/// Environment variable niri publishes its IPC socket path in.
const SOCKET_ENV: &str = "NIRI_SOCKET";

/// Prefix of the window ids this module mints.
pub(super) const ID_PREFIX: &str = "niri:";

/// Largest IPC reply that is buffered, in bytes.
///
/// A full `Windows` reply for a busy session is a few hundred kilobytes; the
/// cap exists so a wedged or hostile compositor cannot make the desktop worker
/// allocate without bound while waiting for a newline that never comes.
const REPLY_LIMIT: usize = 8 * 1024 * 1024;

/// Read and write deadline for one IPC exchange.
const IPC_TIMEOUT: Duration = Duration::from_secs(2);

/// Deadline for the record/start exchange and for the node signal.
#[cfg(feature = "wayland-pipewire")]
const CAST_TIMEOUT: Duration = Duration::from_secs(5);

/// Largest edge, in logical or physical pixels, a capture may have.
///
/// `capture.rs` negotiates at most 16384 per edge, so nothing the compositor
/// can legitimately render is refused here.
const MAX_FRAME_EDGE: u32 = 16384;

/// Oldest niri whose action protocol this module has been verified against.
///
/// The compositor answers `Handled` to an action it parsed but could not
/// apply, so an older niri is refused outright instead of being addressed in a
/// dialect whose shapes it does not parse.
const MINIMUM_NIRI: (u32, u32) = (26, 4);

/// Operations a probed niri really performs.
///
/// niri has no minimize, and no idempotent maximize, fullscreen setter or
/// restore: it exposes explicit toggles only. Those four operations stay out
/// of this list and `control` refuses them, because emulating them would mean
/// guessing state the compositor never publishes.
///
/// `moveWindow` and `moveWindowBy` are refused for a tiled window, and
/// `toggleMaximized` for a floating one, because niri answers those with
/// `Handled` and no change. `resizeWindow` does reach a tiled window: niri
/// applies it to the tile, which may resize the whole column, and the window
/// stays in the tiling layout.
const OPERATIONS: &[&str] = &[
	"focusWindow",
	"closeWindow",
	"moveWindow",
	"moveWindowBy",
	"resizeWindow",
	"toggleMaximized",
	"toggleFullscreen",
	"toggleWindowedFullscreen",
	"setFloating",
	"centerWindow",
	"moveWindowToWorkspace",
	"moveWindowToDisplay",
	"focusWorkspace",
	"focusDisplay",
	"moveWorkspaceToDisplay",
];

/// Why control and state reads are refused outright.
const NO_CONTROL: &str = "this Wayland session has no compatible niri IPC: either it does not run \
                          under niri, its socket is unreachable, or it is older than the verified \
                          protocol";

/// `$NIRI_SOCKET`, absent when this session does not run under niri.
fn socket_path() -> Option<PathBuf> {
	let path = std::env::var_os(SOCKET_ENV)?;
	(!path.is_empty()).then(|| PathBuf::from(path))
}

/// One connection to the compositor's IPC socket.
///
/// niri answers one newline-terminated JSON request per line, so a single
/// connection serves a whole enumeration instead of reconnecting per request.
struct Ipc {
	stream: UnixStream,
}

impl Ipc {
	fn connect() -> CoreResult<Self> {
		let path = socket_path().ok_or_else(|| {
			DesktopError::background_unavailable(format!(
				"{SOCKET_ENV} is unset; this session is not running under niri"
			))
		})?;
		let stream = super::portal::portal_runtime()?
			.block_on(async {
				tokio::time::timeout(IPC_TIMEOUT, tokio::net::UnixStream::connect(&path)).await
			})
			.map_err(|_| {
				DesktopError::timeout(format!("niri IPC connect to {} timed out", path.display()))
			})?
			.map_err(|err| {
				DesktopError::capture_failed(format!("niri IPC socket {}: {err}", path.display()))
			})?
			.into_std()
			.map_err(|err| DesktopError::capture_failed(format!("niri IPC socket: {err}")))?;
		stream
			.set_nonblocking(false)
			.map_err(|err| DesktopError::capture_failed(format!("niri IPC blocking mode: {err}")))?;
		stream
			.set_read_timeout(Some(IPC_TIMEOUT))
			.map_err(|err| DesktopError::capture_failed(format!("niri IPC read deadline: {err}")))?;
		stream
			.set_write_timeout(Some(IPC_TIMEOUT))
			.map_err(|err| DesktopError::capture_failed(format!("niri IPC write deadline: {err}")))?;
		Ok(Self { stream })
	}

	/// Send one request variant and decode its reply.
	///
	/// The variant name is quoted because niri serializes a unit request as a
	/// bare JSON string (`"Windows"`), not as an object.
	fn request<T: DeserializeOwned>(&mut self, request: &str) -> CoreResult<T> {
		let variant = request.trim();
		let body = self
			.exchange(request)
			.map_err(|fault| reply_error(variant, &fault))?;
		decode(&body).map_err(|detail| reply_error(variant, &ReplyFault::malformed(detail)))
	}

	/// Write one newline-terminated request and read its reply bytes.
	///
	/// Transport faults are returned rather than raised so each caller reports
	/// its own kind of failure: a stale listing is a capture problem, while a
	/// silent compositor during a mutation leaves the change in doubt.
	fn exchange(&mut self, request: &str) -> Result<Vec<u8>, ReplyFault> {
		self
			.stream
			.write_all(request.as_bytes())
			.map_err(|err| ReplyFault::transport("write", &err))?;
		read_reply(&mut self.stream, REPLY_LIMIT)
	}

	/// The version string the running compositor reports.
	fn version(&mut self) -> CoreResult<String> {
		Ok(self.request::<VersionPayload>("\"Version\"\n")?.version)
	}

	/// Send one action and require the compositor's handled reply.
	///
	/// A fault here is reported as a change that may already have happened:
	/// niri applies each action as it arrives, so neither a half-written
	/// request nor a reply that never came can be retried without risking
	/// applying the same change twice.
	fn act(&mut self, action: &serde_json::Value) -> CoreResult<()> {
		let request = action_line(action).map_err(|detail| {
			uncertain(ReplyFault::malformed(format!("encoding the action: {detail}")))
		})?;
		let body = self.exchange(&request).map_err(uncertain)?;
		decode::<Handled>(&body).map_err(|detail| {
			uncertain(ReplyFault::malformed(format!("handling the action: {detail}")))
		})?;
		Ok(())
	}
}

/// The exact request line one action puts on the wire.
///
/// niri wraps every action in the `Action` request variant, and takes exactly
/// one per line; the shape here is the compositor's, not a convenience of this
/// module's.
fn action_line(action: &serde_json::Value) -> Result<String, String> {
	let request = serde_json::json!({ "Action": action });
	let mut line = serde_json::to_string(&request).map_err(|err| err.to_string())?;
	line.push('\n');
	Ok(line)
}

fn reply_error(variant: &str, fault: &ReplyFault) -> DesktopError {
	DesktopError::capture_failed(format!("niri IPC {variant}: {fault}"))
}

/// A mutation fault, once its request is on the wire.
fn uncertain(fault: ReplyFault) -> DesktopError {
	let detail = format!("niri IPC Action: {fault}; the change may already have been applied");
	if fault.timed_out {
		DesktopError::timeout(detail)
	} else {
		DesktopError::control_failed(detail)
	}
}

/// Why one reply did not arrive whole.
///
/// Either fault can follow an applied action. An unusable reply never proves
/// that the compositor left the target unchanged.
#[derive(Debug)]
struct ReplyFault {
	timed_out: bool,
	detail:    String,
}

impl ReplyFault {
	/// A socket that answered with nothing usable in time.
	fn transport(operation: &str, err: &io::Error) -> Self {
		Self {
			timed_out: matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut),
			detail:    format!("{operation}: {err}"),
		}
	}

	/// A reply or request that could not be encoded or decoded.
	fn malformed(detail: impl Into<String>) -> Self {
		Self { timed_out: false, detail: detail.into() }
	}
}

impl fmt::Display for ReplyFault {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.detail)
	}
}

/// Read one newline-terminated reply, refusing to buffer past `limit`.
fn read_reply(reader: &mut impl Read, limit: usize) -> Result<Vec<u8>, ReplyFault> {
	let mut reply = Vec::new();
	let mut chunk = [0_u8; 8192];
	loop {
		let read = reader
			.read(&mut chunk)
			.map_err(|err| ReplyFault::transport("read", &err))?;
		if read == 0 {
			return Err(ReplyFault::malformed("closed the connection mid-reply"));
		}
		let end = chunk[..read].iter().position(|byte| *byte == b'\n');
		let length = end.unwrap_or(read);
		if reply
			.len()
			.checked_add(length)
			.is_none_or(|size| size > limit)
		{
			return Err(ReplyFault::malformed(format!("sent more than the {limit} byte reply limit")));
		}
		reply.extend_from_slice(&chunk[..length]);
		if end.is_some() {
			return Ok(reply);
		}
	}
}

/// niri answers `{"Ok": <response>}` or `{"Err": "<message>"}`.
#[derive(Debug, Deserialize)]
enum Reply<T> {
	Ok(T),
	Err(String),
}

/// The only successful answer to an action.
///
/// `Response::Handled` is a unit variant, so the compositor sends the bare
/// string `"Handled"`. A nested or null payload is a protocol this module does
/// not speak, and reading it as success would report a mutation that never
/// ran.
#[derive(Debug)]
struct Handled;

impl<'de> Deserialize<'de> for Handled {
	fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		struct HandledVisitor;

		impl serde::de::Visitor<'_> for HandledVisitor {
			type Value = Handled;

			fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				formatter.write_str("the string \"Handled\"")
			}

			fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
				if value == "Handled" {
					Ok(Handled)
				} else {
					Err(E::invalid_value(serde::de::Unexpected::Str(value), &self))
				}
			}
		}

		deserializer.deserialize_str(HandledVisitor)
	}
}

/// The payload of a `Version` request.
#[derive(Debug, Deserialize)]
struct VersionPayload {
	#[serde(rename = "Version")]
	version: String,
}

fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
	let reply: Reply<T> =
		serde_json::from_slice(body).map_err(|err| format!("sent an unreadable reply: {err}"))?;
	match reply {
		Reply::Ok(value) => Ok(value),
		Reply::Err(message) => Err(format!("refused the request: {message}")),
	}
}

/// A toplevel window as niri lays it out.
///
/// `is_floating` is the compositor's own split between the tiling layout and
/// floating tiles, and `is_urgent` its own attention request; neither is
/// inferred from geometry.
#[derive(Debug, Deserialize)]
struct IpcWindow {
	id:           u64,
	title:        Option<String>,
	app_id:       Option<String>,
	pid:          Option<i32>,
	workspace_id: Option<u64>,
	is_focused:   bool,
	is_floating:  bool,
	is_urgent:    bool,
	layout:       IpcLayout,
}

/// Position and size properties of a window.
///
/// `tile_pos_in_workspace_view` is set for floating tiles and `None` for tiled
/// ones, which is why a tiled window has no global origin to report.
#[derive(Debug, Deserialize)]
struct IpcLayout {
	window_size:                (i32, i32),
	tile_pos_in_workspace_view: Option<(f64, f64)>,
	window_offset_in_tile:      (f64, f64),
}

/// A workspace as niri lays it out.
///
/// `idx` is the position on its own monitor and changes when workspaces move,
/// so it is reported as a display value only; `id` stays constant and is the
/// only thing callers mutate.
#[derive(Debug, Deserialize)]
struct IpcWorkspace {
	id:               u64,
	idx:              u8,
	name:             Option<String>,
	output:           Option<String>,
	is_urgent:        bool,
	is_active:        bool,
	is_focused:       bool,
	active_window_id: Option<u64>,
}

/// An output's logical placement; `logical` is absent while it is disabled.
#[derive(Debug, Deserialize)]
struct IpcOutput {
	logical: Option<IpcLogicalOutput>,
}

#[derive(Debug, Deserialize)]
struct IpcLogicalOutput {
	x:      i32,
	y:      i32,
	width:  u32,
	height: u32,
	scale:  f64,
}

/// The payload shapes pin the reply variant, so a reply to a different request
/// is rejected instead of decoding as an empty result.
#[derive(Debug, Deserialize)]
struct WindowsPayload {
	#[serde(rename = "Windows")]
	windows: Vec<IpcWindow>,
}

#[derive(Debug, Deserialize)]
struct WorkspacesPayload {
	#[serde(rename = "Workspaces")]
	workspaces: Vec<IpcWorkspace>,
}

#[derive(Debug, Deserialize)]
struct OutputsPayload {
	#[serde(rename = "Outputs")]
	outputs: HashMap<String, IpcOutput>,
}

/// Compositor state a window control request resolves its targets against.
struct State {
	windows:    Vec<IpcWindow>,
	workspaces: Vec<IpcWorkspace>,
	outputs:    HashMap<String, IpcOutput>,
}

impl State {
	fn fetch() -> CoreResult<Self> {
		let mut ipc = Ipc::connect()?;
		let windows: WindowsPayload = ipc.request("\"Windows\"\n")?;
		let workspaces: WorkspacesPayload = ipc.request("\"Workspaces\"\n")?;
		let outputs: OutputsPayload = ipc.request("\"Outputs\"\n")?;
		Ok(Self {
			windows:    unique_ids(windows.windows)?,
			workspaces: workspaces.workspaces,
			outputs:    outputs.outputs,
		})
	}

	fn window(&self, id: u64) -> CoreResult<&IpcWindow> {
		self
			.windows
			.iter()
			.find(|window| window.id == id)
			.ok_or_else(|| {
				DesktopError::window_not_found(format!("niri window {ID_PREFIX}{id} is gone"))
			})
	}

	fn workspace(&self, id: u64) -> Option<&IpcWorkspace> {
		self.workspaces.iter().find(|workspace| workspace.id == id)
	}

	fn output(&self, name: Option<&str>) -> Option<&IpcLogicalOutput> {
		self.outputs.get(name?)?.logical.as_ref()
	}

	/// A window with the state the compositor really publishes about it.
	///
	/// niri exposes floating and urgent but no maximized, minimized or
	/// fullscreen bit, so those stay absent: the toggles that would imply them
	/// have no state to read back and are not guessed from geometry.
	fn window_state(&self, window: &IpcWindow) -> CoreResult<DesktopWindowState> {
		let workspace = window.workspace_id.and_then(|id| self.workspace(id));
		Ok(DesktopWindowState {
			window:       self.descriptor(window).ok_or_else(|| {
				DesktopError::control_failed(format!(
					"niri window {ID_PREFIX}{} reports a size no window can have",
					window.id
				))
			})?,
			workspace_id: window.workspace_id.map(workspace_id_string),
			display_id:   workspace.and_then(|workspace| workspace.output.clone()),
			floating:     Some(window.is_floating),
			urgent:       Some(window.is_urgent),
			maximized:    None,
			minimized:    None,
			fullscreen:   None,
		})
	}

	/// Every workspace, in the order the compositor lists them.
	fn workspaces(&self) -> Vec<DesktopWorkspace> {
		self
			.workspaces
			.iter()
			.map(|workspace| DesktopWorkspace {
				id:               workspace_id_string(workspace.id),
				index:            u32::from(workspace.idx),
				name:             workspace.name.clone(),
				display_id:       workspace.output.clone(),
				active:           workspace.is_active,
				focused:          workspace.is_focused,
				urgent:           workspace.is_urgent,
				active_window_id: workspace.active_window_id.map(window_id_string),
			})
			.collect()
	}

	/// Every window the compositor knows, focused one included.
	///
	/// Foot terminals and other toolkits that expose no AT-SPI frame are listed
	/// here too, which is the point: the compositor, not accessibility, is the
	/// authority on what is open.
	fn windows(&self) -> Vec<NiriWindow> {
		self
			.windows
			.iter()
			.filter_map(|window| self.descriptor(window))
			.map(|window| NiriWindow { window })
			.collect()
	}

	/// A window as a capture target, with the output scale it renders at.
	#[cfg(any(feature = "wayland-pipewire", test))]
	fn capture_target(&self, window: &IpcWindow) -> CoreResult<(DesktopWindow, f64)> {
		let descriptor = self.descriptor(window).ok_or_else(|| {
			DesktopError::capture_failed(format!(
				"niri window {ID_PREFIX}{} reports a size no frame can have",
				window.id
			))
		})?;
		let scale = window
			.workspace_id
			.and_then(|id| self.workspace(id))
			.and_then(|workspace| self.output(workspace.output.as_deref()))
			.map(|output| output.scale)
			.filter(|scale| scale.is_finite() && *scale > 0.0)
			.ok_or_else(|| scale_unknown(window))?;
		Ok((descriptor, scale))
	}

	/// The window descriptor, or `None` when its reported size is unusable.
	fn descriptor(&self, window: &IpcWindow) -> Option<DesktopWindow> {
		let size = size(window.layout.window_size)?;
		let origin = self.origin(window);
		let (x, y) = origin.unwrap_or((0, 0));
		Some(DesktopWindow {
			id: window_id_string(window.id),
			title: window.title.clone().unwrap_or_default(),
			app: window.app_id.clone().unwrap_or_default(),
			pid: window.pid.filter(|pid| *pid > 0).map(|pid| pid as u32),
			position_known: Some(origin.is_some()),
			x,
			y,
			width: size.0,
			height: size.1,
			focused: window.is_focused,
		})
	}

	/// Global screen origin of a window, when the compositor reports enough to
	/// derive one.
	///
	/// `tile_pos_in_workspace_view` is measured from the output's origin, and
	/// `window_offset_in_tile` moves it from the tile to the window surface
	/// inside it (borders, fullscreen centering). A tiled window publishes no
	/// view position at all, and column indices say nothing about pixels, so
	/// those windows keep an unknown origin instead of a reconstructed one. A
	/// window on a workspace that is not the one on screen is laid out but not
	/// shown, so its coordinates describe a view nobody is looking at.
	fn origin(&self, window: &IpcWindow) -> Option<(i32, i32)> {
		let (tile_x, tile_y) = window.layout.tile_pos_in_workspace_view?;
		let (offset_x, offset_y) = window.layout.window_offset_in_tile;
		if !offset_x.is_finite() || !offset_y.is_finite() {
			return None;
		}
		let workspace = self.workspace(window.workspace_id?)?;
		if !workspace.is_active {
			return None;
		}
		let output = self.output(workspace.output.as_deref())?;
		Some((
			to_i32(f64::from(output.x) + tile_x + offset_x)?,
			to_i32(f64::from(output.y) + tile_y + offset_y)?,
		))
	}

	/// Every enabled output, with the focused one marked primary.
	///
	/// niri has no primary-output concept; the workspace holding input focus is
	/// the closest authoritative answer, and it is what a window target resolves
	/// against. Ordering is by logical origin so callers can rely on it.
	fn displays(&self) -> Vec<DesktopDisplay> {
		let primary = self
			.workspaces
			.iter()
			.find(|workspace| workspace.is_focused)
			.and_then(|workspace| workspace.output.as_deref());
		let mut displays: Vec<DesktopDisplay> = self
			.outputs
			.iter()
			.filter_map(|(name, output)| display(name, output, primary == Some(name.as_str())))
			.collect();
		displays.sort_unstable_by_key(|display| (display.x, display.y));
		displays
	}
}

/// A window target resolved against the compositor.
pub(super) struct NiriWindow {
	pub window: DesktopWindow,
}

/// Every window niri has open, or `None` when this session is not niri.
pub(super) fn windows() -> CoreResult<Option<Vec<NiriWindow>>> {
	if socket_path().is_none() {
		return Ok(None);
	}
	Ok(Some(State::fetch()?.windows()))
}

/// Every enabled output, or `None` when this session is not niri.
///
/// This answers display enumeration without a portal prompt, which a
/// `ScreenCast` consent dialog would otherwise demand on every call.
pub(super) fn displays() -> CoreResult<Option<Vec<DesktopDisplay>>> {
	if socket_path().is_none() {
		return Ok(None);
	}
	Ok(Some(State::fetch()?.displays()))
}

/// The window-control surface of the live niri behind this session.
///
/// Nothing is advertised before a version handshake succeeds on the socket: a
/// `$NIRI_SOCKET` left behind by a compositor that exited still names a path,
/// and every operation below would fail against it.
pub(super) fn control_capabilities() -> DesktopControlCapabilities {
	if !compatible() {
		return DesktopControlCapabilities {
			backend:                "wayland".to_string(),
			operations:             Vec::new(),
			coordinate_space:       None,
			focus_may_warp_pointer: false,
		};
	}
	DesktopControlCapabilities {
		backend:                "wayland".to_string(),
		operations:             OPERATIONS.iter().map(|name| (*name).to_string()).collect(),
		// niri places and measures a floating window in the working area of
		// its output, in logical pixels.
		coordinate_space:       Some("working-area".to_string()),
		// Focusing warps the pointer to the newly focused window under
		// niri's own cursor-warp policy.
		focus_may_warp_pointer: true,
	}
}

/// Apply one control action through the compositor.
///
/// Every target is resolved against fresh compositor state first: niri answers
/// `Handled` for an id it does not know, so a request sent at a stale target
/// would report success for a mutation that never ran. The resolve and the
/// send are two separate exchanges, not one atomic step.
pub(super) fn control(action: &ControlAction) -> CoreResult<()> {
	let requests = plan(&live_state()?, action)?;
	let mut ipc = Ipc::connect().map_err(control_failure)?;
	for (step, request) in requests.iter().enumerate() {
		if let Err(err) = ipc.act(request) {
			return Err(if step == 0 {
				err
			} else {
				// The compositor applies each action as it arrives, so the
				// axis that got through is already applied and nothing here
				// can tell which half of a resize the user is looking at.
				DesktopError::control_failed(format!(
					"{err}; the earlier part of this request was applied and is not retried"
				))
			});
		}
	}
	Ok(())
}

/// Every workspace the compositor has, addressed by its stable id.
pub(super) fn workspaces() -> CoreResult<Vec<DesktopWorkspace>> {
	Ok(live_state()?.workspaces())
}

/// A fresh read of one window and the state the compositor publishes.
pub(super) fn window_state(id: &str) -> CoreResult<DesktopWindowState> {
	let state = live_state()?;
	let window = window_id(id)?;
	state.window_state(state.window(window)?)
}

/// Focus one window, the native activation primitive behind `raise_window`.
///
/// niri is the one compositor on this platform that will be told to activate
/// a window; a generic Wayland session still cannot move focus at all.
pub(super) fn focus(id: &str) -> CoreResult<()> {
	control(&ControlAction::FocusWindow(id.to_string()))
}

/// Whether a compatible niri is answering this session's socket.
pub(super) fn compatible() -> bool {
	if socket_path().is_none() {
		return false;
	}
	Ipc::connect()
		.and_then(|mut ipc| ipc.version())
		.is_ok_and(|version| supported_version(&version))
}

/// Fresh compositor state, refusing when no compatible niri serves it.
///
/// Control and state reads never fall back to a toolkit or another compositor:
/// an answer from anything else would be about different windows than the ids
/// the caller holds.
fn live_state() -> CoreResult<State> {
	if !compatible() {
		return Err(DesktopError::control_unsupported(NO_CONTROL));
	}
	State::fetch().map_err(control_failure)
}

/// A compositor failure raised on a control path.
///
/// Timeouts keep their own code because "the compositor was slow" is a
/// different answer from "the compositor refused".
fn control_failure(err: DesktopError) -> DesktopError {
	match err.code {
		ErrorCode::Timeout => err,
		_ => DesktopError::control_failed(err.message),
	}
}

/// Whether a version string speaks the protocol this module implements.
///
/// niri reports `26.04 (commit)` for a release and `26.04.1 (commit)` for a
/// point release. Parsing stops at the build metadata and requires two whole
/// leading numbers, so a string this module does not recognize fails closed
/// rather than guessing that an unknown compositor understands these actions.
fn supported_version(raw: &str) -> bool {
	let head = raw.split([' ', '(']).next().unwrap_or_default();
	let mut parts = head.split('.');
	let (Some(major), Some(minor)) = (parts.next(), parts.next()) else {
		return false;
	};
	let (Ok(major), Ok(minor)) = (major.parse::<u32>(), minor.parse::<u32>()) else {
		return false;
	};
	(major, minor) >= MINIMUM_NIRI
}

/// Resolve a window target against fresh compositor state.
fn window_target(state: &State, id: &str) -> CoreResult<u64> {
	let window = window_id(id)?;
	state.window(window)?;
	Ok(window)
}

/// Resolve a floating-window movement target.
///
/// niri positions only floating windows; `MoveFloatingWindow` aimed at a tiled
/// window does nothing and still answers `Handled`. The request is refused
/// before the wire instead, and the window is not turned floating behind the
/// caller's back to make the coordinates mean something.
fn floating_target(state: &State, id: &str) -> CoreResult<u64> {
	let window = window_target(state, id)?;
	if !state.window(window)?.is_floating {
		return Err(DesktopError::invalid_target(format!(
			"niri window {ID_PREFIX}{window} is tiled and niri positions only floating windows; call \
			 setFloating first"
		)));
	}
	Ok(window)
}

/// Resolve a workspace target against fresh compositor state.
fn workspace_target(state: &State, id: &str) -> CoreResult<u64> {
	let workspace = workspace_id(id)?;
	if state.workspace(workspace).is_none() {
		return Err(DesktopError::invalid_target(format!(
			"niri workspace {WORKSPACE_PREFIX}{workspace} is gone; read the workspaces again"
		)));
	}
	Ok(workspace)
}

/// Resolve a display target against the fresh enabled outputs.
///
/// Only ids `listDisplays` returned are accepted, so a name that is connected
/// but switched off cannot be chosen: niri would refuse the action while
/// reporting success.
fn display_target<'a>(state: &State, id: &'a str) -> CoreResult<&'a str> {
	if id.is_empty() || state.output(Some(id)).is_none() {
		return Err(DesktopError::invalid_target(format!(
			"'{id}' is not an enabled niri output; read the displays again"
		)));
	}
	Ok(id)
}

/// A coordinate the wire can carry.
///
/// JSON has no spelling for a non-finite number, so the encoder would fail on
/// a value that reached it; the request is refused before that happens.
fn coordinate(value: f64, axis: &str) -> CoreResult<f64> {
	if value.is_finite() {
		return Ok(value);
	}
	Err(DesktopError::invalid_target(format!("{axis} must be a finite number")))
}

/// An extent niri's `SetFixed` size change can carry.
fn extent(value: u32, axis: &str) -> CoreResult<i32> {
	i32::try_from(value).map_err(|_| {
		DesktopError::invalid_target(format!("{axis} {value} is larger than a window can be"))
	})
}

/// The exact compositor actions one control request sends, in order.
///
/// The whole plan is built against fresh state before the first byte goes out,
/// so a refused precondition cannot leave half of a multi-axis resize applied.
///
/// Only a two-axis resize has more than one action, so the inline capacity is
/// exactly that and no request pays for a heap vector.
fn plan(state: &State, action: &ControlAction) -> CoreResult<SmallVec<[serde_json::Value; 2]>> {
	let plan = match action {
		ControlAction::FocusWindow(id) => {
			smallvec![serde_json::json!({ "FocusWindow": { "id": window_target(state, id)? } })]
		},
		ControlAction::CloseWindow(id) => {
			smallvec![serde_json::json!({ "CloseWindow": { "id": window_target(state, id)? } })]
		},
		ControlAction::MoveWindow { id, x, y } => {
			let window = floating_target(state, id)?;
			smallvec![serde_json::json!({
				"MoveFloatingWindow": {
					"id": window,
					"x": {"SetFixed": coordinate(*x, "x")?},
					"y": {"SetFixed": coordinate(*y, "y")?},
				}
			})]
		},
		ControlAction::MoveWindowBy { id, dx, dy } => {
			let window = floating_target(state, id)?;
			smallvec![serde_json::json!({
				"MoveFloatingWindow": {
					"id": window,
					"x": {"AdjustFixed": coordinate(*dx, "dx")?},
					"y": {"AdjustFixed": coordinate(*dy, "dy")?},
				}
			})]
		},
		ControlAction::ResizeWindow { id, width, height } => {
			// niri has no combined resize action, so a two-axis resize is two
			// independent requests. Each axis reaches the compositor exactly
			// as given; a tiled window keeps its tiling and its column may
			// resize with it.
			let window = window_target(state, id)?;
			let mut axes = SmallVec::new();
			if let Some(width) = width {
				axes.push(serde_json::json!({
					"SetWindowWidth": {"id": window, "change": {"SetFixed": extent(*width, "width")?}}
				}));
			}
			if let Some(height) = height {
				axes.push(serde_json::json!({
					"SetWindowHeight": {"id": window, "change": {"SetFixed": extent(*height, "height")?}}
				}));
			}
			axes
		},
		ControlAction::ToggleMaximized(id) => {
			let window = window_target(state, id)?;
			// MaximizeWindowToEdges only has meaning for a tile; aimed at a
			// floating window it is a no-op the compositor still reports as
			// handled.
			if state.window(window)?.is_floating {
				return Err(DesktopError::invalid_target(format!(
					"niri window {ID_PREFIX}{window} is floating; maximized-to-edges applies to tiled \
					 windows only"
				)));
			}
			smallvec![serde_json::json!({ "MaximizeWindowToEdges": { "id": window } })]
		},
		ControlAction::ToggleFullscreen(id) => {
			smallvec![serde_json::json!({ "FullscreenWindow": { "id": window_target(state, id)? } })]
		},
		ControlAction::ToggleWindowedFullscreen(id) => {
			smallvec![serde_json::json!({
				"ToggleWindowedFullscreen": {"id": window_target(state, id)?}
			})]
		},
		ControlAction::SetFloating { id, enabled } => {
			let window = window_target(state, id)?;
			// A real setter, not a toggle: the end state is what was asked
			// for, whether or not the window was already floating.
			if *enabled {
				smallvec![serde_json::json!({ "MoveWindowToFloating": { "id": window } })]
			} else {
				smallvec![serde_json::json!({ "MoveWindowToTiling": { "id": window } })]
			}
		},
		ControlAction::CenterWindow(id) => {
			smallvec![serde_json::json!({ "CenterWindow": { "id": window_target(state, id)? } })]
		},
		ControlAction::MoveWindowToWorkspace { id, workspace, focus } => {
			smallvec![serde_json::json!({
				"MoveWindowToWorkspace": {
					"window_id": window_target(state, id)?,
					"reference": {"Id": workspace_target(state, workspace)?},
					"focus": focus,
				}
			})]
		},
		ControlAction::MoveWindowToDisplay { id, display } => {
			smallvec![serde_json::json!({
				"MoveWindowToMonitor": {
					"id": window_target(state, id)?,
					"output": display_target(state, display)?,
				}
			})]
		},
		ControlAction::FocusWorkspace(workspace) => {
			smallvec![serde_json::json!({
				"FocusWorkspace": {"reference": {"Id": workspace_target(state, workspace)?}}
			})]
		},
		ControlAction::FocusDisplay(display) => {
			smallvec![
				serde_json::json!({ "FocusMonitor": {"output": display_target(state, display)?} })
			]
		},
		ControlAction::MoveWorkspaceToDisplay { workspace, display } => {
			smallvec![serde_json::json!({
				"MoveWorkspaceToMonitor": {
					"output": display_target(state, display)?,
					"reference": {"Id": workspace_target(state, workspace)?},
				}
			})]
		},
		ControlAction::MaximizeWindow(_)
		| ControlAction::MinimizeWindow(_)
		| ControlAction::RestoreWindow(_)
		| ControlAction::SetFullscreen { .. } => {
			return Err(DesktopError::control_unsupported(
				"niri has no minimize, no idempotent maximize, fullscreen setter or restore; it \
				 exposes the explicit toggleMaximized, toggleFullscreen and toggleWindowedFullscreen \
				 actions instead",
			));
		},
	};
	if plan.is_empty() {
		return Err(DesktopError::invalid_target("resizeWindow needs a width, a height or both"));
	}
	Ok(plan)
}

/// Capture one window through niri's own screen cast service.
///
/// The compositor renders the window itself, so the frame is that window's
/// pixels and not a rectangle of somebody else's monitor, and no consent
/// dialog, clipboard write or focus change happens on the way.
#[cfg(feature = "wayland-pipewire")]
pub(super) fn capture_window(id: &str) -> CoreResult<(RgbaImage, DesktopWindow)> {
	let window = window_id(id)?;
	let before = State::fetch()?;
	let target = before.window(window)?;
	let (descriptor, scale) = before.capture_target(target)?;
	let expected = expected_pixels(descriptor.width, descriptor.height, scale)
		.ok_or_else(|| scale_unknown(target))?;
	let image = capture_frame(window, id)?;
	let after = State::fetch()?;
	let current = after.descriptor(after.window(window)?).ok_or_else(|| {
		DesktopError::capture_failed(format!("niri window {id} vanished mid-capture"))
	})?;
	if current.width != descriptor.width || current.height != descriptor.height {
		return Err(DesktopError::capture_failed(format!(
			"niri window {id} was resized during capture; capture it again"
		)));
	}
	verify_source(id, image.dimensions(), expected, descriptor.width, descriptor.height, scale)?;
	Ok((image, current))
}

/// The `niri:<id>` handle of a compositor window id.
fn window_id_string(id: u64) -> String {
	format!("{ID_PREFIX}{id}")
}

/// The `niri-workspace:<id>` handle of a compositor workspace id.
///
/// Workspace ids stay constant while a workspace moves between monitors and
/// reorders, which is why callers address workspaces by this handle and never
/// by the index niri also publishes.
fn workspace_id_string(id: u64) -> String {
	format!("{WORKSPACE_PREFIX}{id}")
}

/// Decode an opaque id this module minted.
///
/// The digits after the prefix are the compositor's own id, so a bare number, a
/// padded one, or another backend's handle is refused instead of being coerced
/// into an id that may name something else.
fn decode_id(id: &str, prefix: &str, kind: &str) -> CoreResult<u64> {
	let raw = id.strip_prefix(prefix).ok_or_else(|| {
		DesktopError::invalid_target(format!(
			"'{id}' is not a niri {kind} target; niri {kind}s are addressed as {prefix}<id>"
		))
	})?;
	if raw.is_empty()
		|| (raw.len() > 1 && raw.starts_with('0'))
		|| !raw.bytes().all(|byte| byte.is_ascii_digit())
	{
		return Err(DesktopError::invalid_target(format!(
			"'{id}' does not name a niri {kind}; expected {prefix} followed by the compositor's \
			 {kind} id"
		)));
	}
	raw.parse::<u64>()
		.map_err(|_| DesktopError::invalid_target(format!("niri {kind} id '{raw}' is out of range")))
}

/// Decode a `niri:<id>` target.
fn window_id(id: &str) -> CoreResult<u64> {
	decode_id(id, ID_PREFIX, "window")
}

/// Decode a `niri-workspace:<id>` target.
fn workspace_id(id: &str) -> CoreResult<u64> {
	decode_id(id, WORKSPACE_PREFIX, "workspace")
}

/// Reject a reply that names the same window twice.
///
/// niri builds its reply from a map, so this cannot happen honestly; two
/// entries with one id would make `niri:<id>` ambiguous, and a capture would
/// pick whichever the compositor happened to list first.
fn unique_ids(windows: Vec<IpcWindow>) -> CoreResult<Vec<IpcWindow>> {
	let mut seen = HashSet::with_capacity(windows.len());
	for window in &windows {
		if !seen.insert(window.id) {
			return Err(DesktopError::capture_failed(format!(
				"niri reported window {} twice, so its id is ambiguous",
				window.id
			)));
		}
	}
	Ok(windows)
}

/// Logical size a frame can have.
///
/// Wayland toplevels are positive and far below the `PipeWire` negotiation
/// ceiling. Zero, negative or absurd values are malformed replies, not windows:
/// casting `i32` to `u32` would turn a negative into a multi-gigabyte crop.
fn size(window_size: (i32, i32)) -> Option<(u32, u32)> {
	let width = u32::try_from(window_size.0).ok()?;
	let height = u32::try_from(window_size.1).ok()?;
	(width > 0 && height > 0 && width <= MAX_FRAME_EDGE && height <= MAX_FRAME_EDGE)
		.then_some((width, height))
}

/// One logical extent scaled to physical pixels and checked against the frame
/// ceiling.
///
/// Both extents below refuse exactly these values, so the bounds are stated
/// once: an extent a frame cannot hold is refused instead of cast into a crop
/// the frame could not carry.
fn scaled_extent(logical: u32, scale: f64) -> Option<f64> {
	let pixels = f64::from(logical) * scale;
	(pixels.is_finite() && pixels >= 1.0 && pixels <= f64::from(MAX_FRAME_EDGE)).then_some(pixels)
}

/// One logical extent rendered at `scale`, rounded to the nearest whole pixel.
///
/// This is display metadata, so it follows the logical extent the compositor
/// published rather than any buffer it allocated.
fn physical(logical: u32, scale: f64) -> Option<u32> {
	Some(scaled_extent(logical, scale)?.round() as u32)
}

/// The extent niri allocates for a window's capture buffer, rounded up.
///
/// niri sizes that buffer from the window's bounding box placed at a zero
/// origin, so each edge is rounded up on its own: 957 logical px at 1.25 needs
/// 1197 px, and a buffer one pixel narrower would drop window pixels.
#[cfg(any(feature = "wayland-pipewire", test))]
fn allocated_extent(logical: u32, scale: f64) -> Option<u32> {
	Some(scaled_extent(logical, scale)?.ceil() as u32)
}

/// Physical size of a window's capture buffer.
#[cfg(any(feature = "wayland-pipewire", test))]
fn expected_pixels(width: u32, height: u32, scale: f64) -> Option<(u32, u32)> {
	Some((allocated_extent(width, scale)?, allocated_extent(height, scale)?))
}

/// Round a logical coordinate, refusing values no screen can hold.
fn to_i32(value: f64) -> Option<i32> {
	if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
		return None;
	}
	let rounded = value.round();
	(rounded >= f64::from(i32::MIN) && rounded <= f64::from(i32::MAX)).then_some(rounded as i32)
}

fn display(name: &str, output: &IpcOutput, primary: bool) -> Option<DesktopDisplay> {
	let logical = output.logical.as_ref()?;
	Some(DesktopDisplay {
		id:           name.to_string(),
		name:         name.to_string(),
		x:            logical.x,
		y:            logical.y,
		width:        logical.width,
		height:       logical.height,
		scale:        logical.scale,
		pixel_x:      0,
		pixel_y:      0,
		pixel_width:  physical(logical.width, logical.scale)?,
		pixel_height: physical(logical.height, logical.scale)?,
		is_primary:   primary,
	})
}

#[cfg(any(feature = "wayland-pipewire", test))]
fn scale_unknown(window: &IpcWindow) -> DesktopError {
	DesktopError::capture_failed(format!(
		"niri window {ID_PREFIX}{} is not on an output with a known scale, so its capture size \
		 cannot be verified",
		window.id
	))
}

/// Check the buffer against the geometry the compositor published.
///
/// niri sizes a window cast from the window's bounding box, which grows with
/// popups and shadows and is not published over IPC, so a buffer that is not
/// exactly the window cannot be cropped to it: the window's offset inside the
/// buffer is unknown, and cropping would invent pixels. `Stream.Parameters` is
/// no help either — niri reports the placeholder `(0,0)/(1,1)` for windows.
#[cfg(any(feature = "wayland-pipewire", test))]
fn verify_source(
	id: &str,
	buffer: (u32, u32),
	expected: (u32, u32),
	width: u32,
	height: u32,
	scale: f64,
) -> CoreResult<()> {
	if buffer == expected {
		return Ok(());
	}
	Err(DesktopError::capture_failed(format!(
		"niri window {id} rendered a {}x{} px buffer but the compositor reports {width}x{height} \
		 logical px at scale {scale}, so {}x{} px was expected; the buffer is sized from the window \
		 bounding box, which grows with popups and shadows, and that box is not published",
		buffer.0, buffer.1, expected.0, expected.1
	)))
}

#[cfg(feature = "wayland-pipewire")]
const SERVICE: &str = "org.gnome.Mutter.ScreenCast";
#[cfg(feature = "wayland-pipewire")]
const SERVICE_PATH: &str = "/org/gnome/Mutter/ScreenCast";
#[cfg(feature = "wayland-pipewire")]
const STREAM_INTERFACE: &str = "org.gnome.Mutter.ScreenCast.Stream";
#[cfg(feature = "wayland-pipewire")]
const NODE_SIGNAL: &str = "PipeWireStreamAdded";

/// Property dict niri's `RecordWindow` expects.
///
/// niri rejects a `remote-desktop-session-id`, which is what keeps this a
/// screen cast with no remote-control grant. The cursor mode is left out so
/// niri defaults to hidden and no pointer is composited into the frame.
#[cfg(feature = "wayland-pipewire")]
type Properties<'a> = HashMap<&'a str, Value<'a>>;

#[cfg(feature = "wayland-pipewire")]
#[zbus::proxy(
	default_service = "org.gnome.Mutter.ScreenCast",
	default_path = "/org/gnome/Mutter/ScreenCast",
	interface = "org.gnome.Mutter.ScreenCast",
	gen_blocking = false
)]
trait ScreenCast {
	fn create_session(&self, properties: Properties<'_>) -> zbus::Result<OwnedObjectPath>;
}

#[cfg(feature = "wayland-pipewire")]
#[zbus::proxy(
	default_service = "org.gnome.Mutter.ScreenCast",
	interface = "org.gnome.Mutter.ScreenCast.Session",
	gen_blocking = false
)]
trait Session {
	fn record_window(&self, properties: Properties<'_>) -> zbus::Result<OwnedObjectPath>;
	fn start(&self) -> zbus::Result<()>;
	fn stop(&self) -> zbus::Result<()>;
}

/// Record one window and publish its `PipeWire` node.
///
/// The proxies are built against the verified unique name rather than the
/// well-known one, so a name owner that changes between the check and the call
/// cannot receive the cast.
#[cfg(feature = "wayland-pipewire")]
async fn start_window_cast(
	connection: &Connection,
	session: &SessionProxy<'_>,
	window: u64,
) -> CoreResult<u32> {
	let stream_path = session
		.record_window(Properties::from([("window-id", Value::U64(window))]))
		.await
		.map_err(|err| {
			DesktopError::capture_failed(format!("niri RecordWindow for window {window}: {err}"))
		})?;
	// Subscribe before Start so the node signal cannot be missed.
	let rule = MatchRule::builder()
		.msg_type(MessageType::Signal)
		.sender(session.inner().destination().to_owned())
		.map_err(bus_error)?
		.interface(STREAM_INTERFACE)
		.map_err(bus_error)?
		.member(NODE_SIGNAL)
		.map_err(bus_error)?
		.path(stream_path.as_str())
		.map_err(bus_error)?
		.build();
	let mut added = MessageStream::for_match_rule(rule, connection, Some(1))
		.await
		.map_err(bus_error)?;
	session
		.start()
		.await
		.map_err(|err| DesktopError::capture_failed(format!("niri Session.Start: {err}")))?;
	let node = added
		.next()
		.await
		.ok_or_else(|| {
			DesktopError::timeout(format!("niri dropped the window {window} cast before its node"))
		})?
		.map_err(bus_error)?;
	node
		.body()
		.deserialize::<(u32,)>()
		.map(|body| body.0)
		.map_err(|err| DesktopError::capture_failed(format!("niri {NODE_SIGNAL} body: {err}")))
}

#[cfg(feature = "wayland-pipewire")]
async fn create_session<'a>(
	connection: &'a Connection,
	owner: &OwnedUniqueName,
) -> CoreResult<SessionProxy<'a>> {
	let screen_cast = ScreenCastProxy::builder(connection)
		.destination(owner.clone())
		.map_err(bus_error)?
		.path(SERVICE_PATH)
		.map_err(bus_error)?
		.cache_properties(zbus::proxy::CacheProperties::No)
		.build()
		.await
		.map_err(bus_error)?;
	let path = screen_cast
		.create_session(Properties::new())
		.await
		.map_err(|err| DesktopError::capture_failed(format!("niri CreateSession: {err}")))?;
	SessionProxy::builder(connection)
		.destination(owner.clone())
		.map_err(bus_error)?
		.path(path)
		.map_err(bus_error)?
		.cache_properties(zbus::proxy::CacheProperties::No)
		.build()
		.await
		.map_err(bus_error)
}

/// Refuse unless the compositor is the one serving the screen cast service.
///
/// The well-known name is replaceable, so on a session that also runs Mutter or
/// a portal screencast backend somebody else may own it. Recording that service
/// would stream another program's pixels into a frame labelled with a niri
/// window id, so both ends must be the same process: `$NIRI_SOCKET`'s peer is
/// the compositor, and the bus name owner has to be that same process.
#[cfg(feature = "wayland-pipewire")]
async fn service_owner(connection: &Connection, compositor: u32) -> CoreResult<OwnedUniqueName> {
	let bus = fdo::DBusProxy::new(connection).await.map_err(bus_error)?;
	let service: BusName<'static> = SERVICE
		.try_into()
		.map_err(|_| DesktopError::internal(format!("'{SERVICE}' is not a well-known bus name")))?;
	let owner = bus.get_name_owner(service).await.map_err(|err| {
		DesktopError::capture_failed(format!("no session bus owner for {SERVICE}: {err}"))
	})?;
	let pid = bus
		.get_connection_unix_process_id(BusName::from(&owner))
		.await
		.map_err(|err| DesktopError::capture_failed(format!("{SERVICE} owner process id: {err}")))?;
	if pid != compositor {
		return Err(DesktopError::capture_failed(format!(
			"{SERVICE} is served by process {pid}, not the niri compositor on {SOCKET_ENV} (process \
			 {compositor}); refusing to label another program's pixels as a niri window"
		)));
	}
	Ok(owner)
}

#[cfg(feature = "wayland-pipewire")]
fn bus_error(err: zbus::Error) -> DesktopError {
	DesktopError::capture_failed(format!("niri screen cast session: {err}"))
}

/// PID of the process that accepted the IPC connection.
///
/// `SO_PEERCRED` reports the process on the far end of the socket, so this is
/// the compositor itself rather than anything that merely forwarded the path.
#[cfg(feature = "wayland-pipewire")]
fn compositor_pid() -> CoreResult<u32> {
	let Ipc { stream } = Ipc::connect()?;
	let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
	let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
	// SAFETY: `credentials` and `length` describe a live, correctly sized
	// `struct ucred` for the socket, which is only read.
	let result = unsafe {
		libc::getsockopt(
			stream.as_raw_fd(),
			libc::SOL_SOCKET,
			libc::SO_PEERCRED,
			(&raw mut credentials).cast::<libc::c_void>(),
			&raw mut length,
		)
	};
	if result != 0 {
		return Err(DesktopError::capture_failed(format!(
			"niri IPC peer credentials: {}",
			std::io::Error::last_os_error()
		)));
	}
	u32::try_from(credentials.pid)
		.map_err(|_| DesktopError::capture_failed("niri IPC peer pid is out of range"))
}

/// Run one full window cast and always end the session.
///
/// The session is closed on every outcome, including the failure paths: a cast
/// left running keeps a compositor-side stream alive after the caller gave up.
#[cfg(feature = "wayland-pipewire")]
fn capture_frame(window: u64, id: &str) -> CoreResult<RgbaImage> {
	let runtime = super::portal::portal_runtime()?;
	let compositor = compositor_pid()?;
	let connection = runtime
		.block_on(Connection::session())
		.map_err(|err| DesktopError::capture_failed(format!("session bus: {err}")))?;
	let owner = runtime.block_on(service_owner(&connection, compositor))?;
	let session = runtime.block_on(create_session(&connection, &owner))?;
	let node = runtime.block_on(async {
		tokio::time::timeout(CAST_TIMEOUT, start_window_cast(&connection, &session, window))
			.await
			.map_err(|_| {
				DesktopError::timeout(format!(
					"niri window {id} cast handshake exceeded {CAST_TIMEOUT:?}"
				))
			})?
	});
	let frame = match node {
		Ok(node) => super::capture::grab_pipewire_frame(node, None),
		Err(err) => {
			stop(runtime, &session);
			return Err(err);
		},
	};
	stop(runtime, &session);
	frame.map_err(|err| DesktopError::capture_failed(format!("niri window {id} capture: {err}")))
}

/// End a cast session, bounded so a wedged compositor cannot hang the worker.
#[cfg(feature = "wayland-pipewire")]
fn stop(runtime: &Runtime, session: &SessionProxy<'_>) {
	let _ = runtime.block_on(async {
		tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.stop()).await
	});
}

#[cfg(test)]
mod tests {
	use std::{
		io::{BufRead as _, BufReader},
		os::unix::net::UnixListener,
		panic::{AssertUnwindSafe, catch_unwind},
		thread,
	};

	use super::*;

	/// eDP-1 is enabled at 1920,0; HDMI-A-1 is connected but disabled, which is
	/// how niri reports an output with no `logical` block.
	const OUTPUTS: &str = r#"{"Ok":{"Outputs":{
		"eDP-1":{"name":"eDP-1","make":"BOE","model":"0x084D","serial":null,
			"physical_size":[340,190],"modes":[{"width":1920,"height":1080,
			"refresh_rate":143999,"is_preferred":true}],"current_mode":0,
			"is_custom_mode":false,"vrr_supported":true,"vrr_enabled":false,
			"logical":{"x":1920,"y":0,"width":1920,"height":1080,"scale":1.0,
			"transform":"Normal"},"max_bpc":null},
		"HDMI-A-1":{"name":"HDMI-A-1","make":"Samsung","model":"C27F398",
			"serial":"HTSJ700028","physical_size":[600,340],
			"modes":[{"width":1920,"height":1080,"refresh_rate":60000,"is_preferred":true}],
			"current_mode":null,"is_custom_mode":false,"vrr_supported":false,
			"vrr_enabled":false,"logical":null,"max_bpc":null}}}}"#;

	/// Workspace 2 holds focus, workspace 3 is on the same output but is not the
	/// one on screen.
	const WORKSPACES: &str = r#"{"Ok":{"Workspaces":[
		{"id":1,"idx":1,"name":null,"output":"eDP-1","is_urgent":false,"is_active":true,
			"is_focused":false,"active_window_id":47},
		{"id":2,"idx":1,"name":null,"output":"eDP-1","is_urgent":false,"is_active":true,
			"is_focused":true,"active_window_id":69},
		{"id":3,"idx":2,"name":null,"output":"eDP-1","is_urgent":false,"is_active":false,
			"is_focused":false,"active_window_id":null}]}}"#;

	/// A tiled terminal: niri 26.04 publishes no workspace-view position, which
	/// is what made the old AT-SPI crop impossible to place.
	const TILED: &str = r#"{"id":47,"title":"btop","app_id":"com.mitchellh.ghostty","pid":5663,
		"workspace_id":1,"is_focused":false,"is_floating":false,"is_urgent":false,
		"layout":{"pos_in_scrolling_layout":[1,1],"tile_size":[954.0,1044.0],
			"window_size":[954,1044],"tile_pos_in_workspace_view":null,
			"window_offset_in_tile":[0.0,0.0]},
		"focus_timestamp":{"secs":30144,"nanos":650238679}}"#;

	/// A floating window: the only kind niri publishes a position for.
	const FLOATING: &str = r#"{"id":69,"title":"omp","app_id":"footclient","pid":4247,
		"workspace_id":2,"is_focused":true,"is_floating":true,"is_urgent":false,
		"layout":{"pos_in_scrolling_layout":null,"tile_size":[862.0,1028.0],
			"window_size":[862,1028],"tile_pos_in_workspace_view":[396.0,41.0],
			"window_offset_in_tile":[0.0,0.0]},
		"focus_timestamp":{"secs":30621,"nanos":477211063}}"#;

	fn parse_windows(windows: &[&str]) -> CoreResult<Vec<IpcWindow>> {
		let reply = format!(r#"{{"Ok":{{"Windows":[{}]}}}}"#, windows.join(","));
		let payload: WindowsPayload =
			decode(reply.as_bytes()).map_err(DesktopError::capture_failed)?;
		unique_ids(payload.windows)
	}

	fn state(windows: &[&str]) -> State {
		let workspaces: WorkspacesPayload =
			decode(WORKSPACES.as_bytes()).expect("workspace fixture decodes");
		let outputs: OutputsPayload = decode(OUTPUTS.as_bytes()).expect("output fixture decodes");
		State {
			windows:    parse_windows(windows).expect("window fixture decodes"),
			workspaces: workspaces.workspaces,
			outputs:    outputs.outputs,
		}
	}

	/// A floating window's origin is its output's origin plus the position niri
	/// publishes, rounded to whole logical pixels.
	#[test]
	fn floating_window_on_a_visible_workspace_gets_its_global_origin() {
		let state = state(&[FLOATING]);
		let window = state
			.descriptor(state.window(69).expect("window 69"))
			.expect("descriptor");
		assert_eq!(window.position_known, Some(true));
		// eDP-1 sits at 1920,0 and the tile is at 396,41 inside it.
		assert_eq!((window.x, window.y), (2316, 41));
	}

	/// Tiled windows publish no position on 26.04. Reconstructing one from the
	/// column index would fabricate a global origin, so it stays unknown.
	#[test]
	fn tiled_window_without_a_view_position_keeps_an_unknown_origin() {
		let state = state(&[TILED]);
		let window = state
			.descriptor(state.window(47).expect("window 47"))
			.expect("descriptor");
		assert_eq!(window.position_known, Some(false));
	}

	/// A workspace that is not the one on screen lays its windows out but shows
	/// none of them, so its coordinates are not a screen position.
	#[test]
	fn floating_window_on_a_hidden_workspace_keeps_an_unknown_origin() {
		let hidden = r#"{"id":70,"title":"hidden","app_id":"footclient","pid":4247,
			"workspace_id":3,"is_focused":false,"is_floating":true,"is_urgent":false,
			"layout":{"pos_in_scrolling_layout":null,"tile_size":[862.0,1028.0],
				"window_size":[862,1028],"tile_pos_in_workspace_view":[396.0,41.0],
				"window_offset_in_tile":[0.0,0.0]},"focus_timestamp":null}"#;
		let state = state(&[hidden]);
		let window = state
			.descriptor(state.window(70).expect("window 70"))
			.expect("descriptor");
		assert_eq!(window.position_known, Some(false));
	}

	/// A window without a workspace has no output origin to add.
	#[test]
	fn window_without_a_workspace_keeps_an_unknown_origin() {
		let orphan = r#"{"id":71,"title":"orphan","app_id":"footclient","pid":null,
			"workspace_id":null,"is_focused":true,"is_floating":true,"is_urgent":false,
			"layout":{"pos_in_scrolling_layout":null,"tile_size":[862.0,1028.0],
				"window_size":[862,1028],"tile_pos_in_workspace_view":[396.0,41.0],
				"window_offset_in_tile":[0.0,0.0]},"focus_timestamp":null}"#;
		let state = state(&[orphan]);
		let window = state
			.descriptor(state.window(71).expect("window 71"))
			.expect("descriptor");
		assert_eq!(window.position_known, Some(false));
	}

	/// A disabled output has no logical placement, so it is not a display, and
	/// the enumeration still marks the output holding focus as primary.
	#[test]
	fn disabled_output_is_not_a_display_and_focus_marks_the_primary() {
		let displays = state(&[TILED]).displays();
		assert_eq!(displays.len(), 1, "only the enabled output is listed");
		let display = &displays[0];
		assert_eq!(display.id, "eDP-1");
		assert!(display.is_primary);
	}

	/// A fractional scale is reflected in the display's pixel size, so a
	/// consumer mapping screenshot pixels back to logical points stays correct.
	#[test]
	fn fractional_scale_maps_logical_extents_to_physical_pixels() {
		let output = IpcOutput {
			logical: Some(IpcLogicalOutput {
				x:      0,
				y:      0,
				width:  1536,
				height: 864,
				scale:  1.25,
			}),
		};
		let display = display("DP-1", &output, false).expect("enabled output");
		assert_eq!((display.width, display.height), (1536, 864));
		assert_eq!((display.pixel_width, display.pixel_height), (1920, 1080));
	}

	/// A reply to a different request must not decode as an empty result: that
	/// would silently enumerate nothing, or capture nothing.
	#[test]
	fn reply_for_another_request_is_rejected() {
		assert!(decode::<WindowsPayload>(br#"{"Ok":{"Outputs":{}}}"#).is_err());
		assert!(decode::<WorkspacesPayload>(br#"{"Ok":{"Windows":[]}}"#).is_err());
	}

	/// niri answers a rejected request with a message, not with silence.
	#[test]
	fn refused_request_is_an_error() {
		assert!(decode::<WindowsPayload>(br#"{"Err":"unknown request"}"#).is_err());
	}

	/// Two entries with one id make `niri:<id>` ambiguous, and a capture would
	/// pick whichever was listed first.
	#[test]
	fn duplicate_window_ids_are_rejected() {
		let reply = format!(r#"{{"Ok":{{"Windows":[{TILED},{TILED}]}}}}"#);
		let payload: WindowsPayload = decode(reply.as_bytes()).expect("fixture decodes");
		let err = unique_ids(payload.windows).expect_err("a duplicate id must be rejected");
		assert_eq!(err.code.as_str(), "CaptureFailed");
	}

	/// A malformed size must not reach a capture: casting a negative `i32` to
	/// `u32` would ask for a four-gigabyte frame.
	#[test]
	fn unsafe_window_sizes_are_rejected() {
		assert_eq!(size((954, 1044)), Some((954, 1044)));
		let rejected: [(i32, i32); 5] =
			[(0, 100), (100, 0), (-1, 100), (100, -1), (MAX_FRAME_EDGE as i32 + 1, 100)];
		for bad in rejected {
			assert_eq!(size(bad), None, "{bad:?} must not describe a frame");
		}
	}

	/// The buffer has to be the window: niri sizes it from a bounding box that
	/// grows with popups and shadows, and that box is not published.
	#[test]
	fn capture_source_must_match_the_compositor_window_geometry() {
		let expected = expected_pixels(954, 1044, 1.0).expect("scale 1 renders exactly");
		assert_eq!(expected, (954, 1044));
		verify_source("niri:47", (954, 1044), expected, 954, 1044, 1.0)
			.expect("an exact buffer is the window");
		// A fractional scale still has to line up.
		let scaled = expected_pixels(1536, 864, 1.25).expect("1.25 scale");
		assert_eq!(scaled, (1920, 1080));
		verify_source("niri:47", (1920, 1080), scaled, 1536, 864, 1.25)
			.expect("a scaled buffer is the window");
		for grown in [(1000, 1044), (954, 1200), (800, 900)] {
			let err = verify_source("niri:47", grown, expected, 954, 1044, 1.0)
				.expect_err("a bounding-box buffer cannot be cropped to the window");
			assert_eq!(err.code.as_str(), "CaptureFailed");
		}
	}

	/// niri allocates the capture buffer from the window's bounding box with
	/// every edge rounded up, because a buffer narrower than that extent drops
	/// window pixels. Both edges of 957x801 at 1.25 land on a quarter, so the
	/// compositor allocates 1197x1002; a nearest rounding predicts 1196x1001 and
	/// rejects the buffer the compositor really did hand over.
	#[test]
	fn fractional_window_extent_is_allocated_rounded_up() {
		let expected = expected_pixels(957, 801, 1.25).expect("957x801 logical is a real window");
		assert_eq!(expected, (1197, 1002), "niri ceils the edge it has to cover");
		verify_source("niri:47", (1197, 1002), expected, 957, 801, 1.25)
			.expect("the compositor's own allocation is the window");
	}

	/// One pixel short of the allocated extent is a bounding-box buffer just as
	/// much as one past it, and neither can be cropped to the window because
	/// the window's offset inside the buffer is not published.
	#[test]
	fn bbox_buffers_around_the_allocated_extent_fail_closed() {
		let expected = expected_pixels(957, 801, 1.25).expect("957x801 logical is a real window");
		for grown in [(1196, 1002), (1198, 1002)] {
			let err = verify_source("niri:47", grown, expected, 957, 801, 1.25)
				.expect_err("a bounding-box buffer cannot be cropped to the window");
			assert_eq!(err.code.as_str(), "CaptureFailed", "{grown:?}");
		}
	}

	/// Half- and upper-fraction products keep the same extent under both
	/// rounding rules.
	#[test]
	fn half_pixel_products_keep_their_extents() {
		// 958 at 1.25 is 1197.5 px, a half pixel both roundings take up.
		assert_eq!(expected_pixels(958, 958, 1.25), Some((1198, 1198)));
		// 955 at 1.25 is 1193.75 px, a three-quarter product that stays whole.
		assert_eq!(expected_pixels(955, 955, 1.25), Some((1194, 1194)));
	}

	/// An extent the frame cannot hold is refused rather than cast into a crop
	/// it could not carry, and an extent under a whole pixel cannot cover one.
	#[test]
	fn unsafe_extents_are_refused_before_casting() {
		assert_eq!(expected_pixels(2, 2, 0.25), None);
		// The ceiling edge itself is still a frame; past it is not.
		assert_eq!(expected_pixels(MAX_FRAME_EDGE, 16, 1.0), Some((MAX_FRAME_EDGE, 16)));
		assert_eq!(expected_pixels(MAX_FRAME_EDGE, 16, 1.25), None);
	}

	/// A scale the compositor does not publish leaves nothing to check the
	/// buffer against, so the capture must not fall back on the placeholder
	/// `Stream.Parameters` size.
	#[test]
	fn unverifiable_scale_is_refused_before_casting() {
		assert_eq!(expected_pixels(954, 1044, f64::NAN), None);
		assert_eq!(expected_pixels(954, 1044, 0.0), None);
		assert_eq!(expected_pixels(954, 1044, f64::INFINITY), None);
		let orphan = r#"{"id":73,"title":"x","app_id":"y","pid":1,"workspace_id":404,
			"is_focused":false,"is_floating":true,"is_urgent":false,
			"layout":{"pos_in_scrolling_layout":null,"tile_size":[10.0,10.0],
				"window_size":[10,10],"tile_pos_in_workspace_view":[1.0,1.0],
				"window_offset_in_tile":[0.0,0.0]},"focus_timestamp":null}"#;
		let state = state(&[orphan]);
		let err = state
			.capture_target(state.window(73).expect("window 73"))
			.expect_err("a window with no output scale must not be captured");
		assert_eq!(err.code.as_str(), "CaptureFailed");
	}

	/// Only the compositor's own window ids address a niri window.
	#[test]
	fn window_targets_must_be_canonical_niri_ids() {
		assert_eq!(window_id("niri:38").expect("canonical id"), 38);
		for bad in [
			"38",
			"niri:",
			"niri:abc",
			"niri:-1",
			"niri: 38",
			"niri:38 ",
			"niri:+38",
			"niri:038",
			"atspi::1.31:/x",
		] {
			let err = window_id(bad).expect_err("non-canonical id must be rejected");
			assert_eq!(err.code.as_str(), "InvalidTarget", "{bad}");
		}
		let err = window_id("niri:99999999999999999999").expect_err("out of range");
		assert_eq!(err.code.as_str(), "InvalidTarget");
	}

	/// A reply is one line and is bounded, so a compositor that never sends a
	/// newline cannot grow the buffer without limit.
	#[test]
	fn reply_reader_splits_the_line_and_bounds_the_buffer() {
		let mut reply = b"{\"Ok\":1}\nignored".as_slice();
		assert_eq!(read_reply(&mut reply, 64).expect("line"), b"{\"Ok\":1}".to_vec());
		// A reply split across reads is still one reply.
		let mut chunked = Chunked { chunks: vec![b"{\"Ok\"".to_vec(), b":1}\n".to_vec()] };
		assert_eq!(read_reply(&mut chunked, 64).expect("chunked line"), b"{\"Ok\":1}".to_vec());
		// No newline: the cap fires instead of buffering forever.
		let mut endless = std::io::repeat(b'x').take(4096);
		assert!(read_reply(&mut endless, 128).is_err());
		let mut oversized_line = b"123456789\n".as_slice();
		assert!(read_reply(&mut oversized_line, 8).is_err());
		// A closed connection mid-reply is an error, not an empty result.
		let mut closed = std::io::empty();
		assert!(read_reply(&mut closed, 64).is_err());
	}

	struct Chunked {
		chunks: Vec<Vec<u8>>,
	}

	impl Read for Chunked {
		fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
			match self.chunks.first_mut() {
				Some(chunk) => {
					let len = chunk.len().min(buf.len());
					buf[..len].copy_from_slice(&chunk[..len]);
					chunk.drain(..len);
					if chunk.is_empty() {
						self.chunks.remove(0);
					}
					Ok(len)
				},
				None => Ok(0),
			}
		}
	}

	/// Window 47 is tiled and window 69 floats, both on enabled workspaces of
	/// the single enabled output.
	fn control_state() -> State {
		state(&[TILED, FLOATING])
	}

	/// The exact wire line one control request sends.
	fn request_line(action: &ControlAction) -> String {
		let plan = plan(&control_state(), action).expect("the action resolves");
		assert_eq!(plan.len(), 1, "this action is one compositor request");
		action_line(&plan[0]).expect("the action encodes")
	}

	/// Every targeted action carries the compositor's own id, and the
	/// compositor is told nothing about which window is focused first.
	#[test]
	fn targeted_actions_name_their_window_explicitly() {
		assert_eq!(
			request_line(&ControlAction::FocusWindow("niri:69".to_string())),
			"{\"Action\":{\"FocusWindow\":{\"id\":69}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::CloseWindow("niri:47".to_string())),
			"{\"Action\":{\"CloseWindow\":{\"id\":47}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::CenterWindow("niri:69".to_string())),
			"{\"Action\":{\"CenterWindow\":{\"id\":69}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::ToggleFullscreen("niri:47".to_string())),
			"{\"Action\":{\"FullscreenWindow\":{\"id\":47}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::ToggleWindowedFullscreen("niri:47".to_string())),
			"{\"Action\":{\"ToggleWindowedFullscreen\":{\"id\":47}}}\n"
		);
	}

	/// A window that no longer exists is answered with `Handled` and no
	/// mutation, so it has to be refused while resolving, and the same goes
	/// for a workspace or output the fresh state does not contain.
	#[test]
	fn dead_targets_are_refused_before_any_request_is_built() {
		let state = control_state();
		let err = plan(&state, &ControlAction::FocusWindow("niri:999".to_string()))
			.expect_err("a closed window cannot be focused");
		assert_eq!(err.code.as_str(), "WindowNotFound");
		let err = plan(&state, &ControlAction::FocusWorkspace("niri-workspace:9".to_string()))
			.expect_err("a removed workspace cannot be focused");
		assert_eq!(err.code.as_str(), "InvalidTarget");
		let err = plan(&state, &ControlAction::FocusDisplay("HDMI-A-1".to_string()))
			.expect_err("a disabled output is not a display");
		assert_eq!(err.code.as_str(), "InvalidTarget");
		// A handle this module never minted is not a niri target at all.
		let err = plan(&state, &ControlAction::FocusWindow("47".to_string()))
			.expect_err("a bare number names no niri window");
		assert_eq!(err.code.as_str(), "InvalidTarget");
	}

	/// A workspace target is the compositor's own id behind this module's
	/// handle, never the index niri also publishes for it.
	#[test]
	fn workspace_moves_carry_the_workspace_id_not_its_index() {
		assert_eq!(
			request_line(&ControlAction::FocusWorkspace("niri-workspace:3".to_string())),
			"{\"Action\":{\"FocusWorkspace\":{\"reference\":{\"Id\":3}}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::MoveWindowToWorkspace {
				id:        "niri:69".to_string(),
				workspace: "niri-workspace:3".to_string(),
				focus:     false,
			}),
			"{\"Action\":{\"MoveWindowToWorkspace\":{\"window_id\":69,\"reference\":{\"Id\":3},\"\
			 focus\":false}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::MoveWorkspaceToDisplay {
				workspace: "niri-workspace:3".to_string(),
				display:   "eDP-1".to_string(),
			}),
			"{\"Action\":{\"MoveWorkspaceToMonitor\":{\"output\":\"eDP-1\",\"reference\":{\"Id\":\
			 3}}}}\n"
		);
	}

	/// Display moves address an output by name and take no focus option: niri
	/// has no way to move focus along with a window.
	#[test]
	fn display_targets_name_the_output_the_compositor_published() {
		assert_eq!(
			request_line(&ControlAction::FocusDisplay("eDP-1".to_string())),
			"{\"Action\":{\"FocusMonitor\":{\"output\":\"eDP-1\"}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::MoveWindowToDisplay {
				id:      "niri:69".to_string(),
				display: "eDP-1".to_string(),
			}),
			"{\"Action\":{\"MoveWindowToMonitor\":{\"id\":69,\"output\":\"eDP-1\"}}}\n"
		);
	}

	/// Absolute placement is a working-area position and relative placement is
	/// a logical delta; niri spells them with different position changes.
	#[test]
	fn floating_movement_uses_position_changes() {
		assert_eq!(
			request_line(&ControlAction::MoveWindow {
				id: "niri:69".to_string(),
				x:  120.5,
				y:  -8.0,
			}),
			"{\"Action\":{\"MoveFloatingWindow\":{\"id\":69,\"x\":{\"SetFixed\":120.5},\"y\":{\"\
			 SetFixed\":-8.0}}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::MoveWindowBy {
				id: "niri:69".to_string(),
				dx: 0.0,
				dy: 40.0,
			}),
			"{\"Action\":{\"MoveFloatingWindow\":{\"id\":69,\"x\":{\"AdjustFixed\":0.0},\"y\":{\"\
			 AdjustFixed\":40.0}}}}\n"
		);
	}

	/// niri positions only floating windows. Aiming a move at a tiled window
	/// would be answered with `Handled` and no movement, so it is refused —
	/// and the window is not turned floating to make the coordinates mean
	/// something.
	#[test]
	fn tiled_windows_cannot_be_positioned() {
		let state = control_state();
		for action in [
			ControlAction::MoveWindow { id: "niri:47".to_string(), x: 10.0, y: 10.0 },
			ControlAction::MoveWindowBy { id: "niri:47".to_string(), dx: 10.0, dy: 0.0 },
		] {
			let err = plan(&state, &action).expect_err("a tile has no position to set");
			assert_eq!(err.code.as_str(), "InvalidTarget");
		}
	}

	/// A coordinate JSON cannot spell must not reach the encoder, which would
	/// fail on a value that is already on its way to the compositor.
	#[test]
	fn non_finite_coordinates_are_refused() {
		let state = control_state();
		for (x, y) in [(f64::NAN, 0.0), (0.0, f64::NEG_INFINITY)] {
			let err = plan(&state, &ControlAction::MoveWindow { id: "niri:69".to_string(), x, y })
				.expect_err("a non-finite coordinate cannot be encoded");
			assert_eq!(err.code.as_str(), "InvalidTarget");
		}
	}

	/// `MaximizeWindowToEdges` only has meaning for a tile; on a floating
	/// window it changes nothing while still being reported as handled.
	#[test]
	fn maximizing_a_floating_window_is_refused() {
		let state = control_state();
		let err = plan(&state, &ControlAction::ToggleMaximized("niri:69".to_string()))
			.expect_err("a floating window has no edges to grow into");
		assert_eq!(err.code.as_str(), "InvalidTarget");
		assert_eq!(
			request_line(&ControlAction::ToggleMaximized("niri:47".to_string())),
			"{\"Action\":{\"MaximizeWindowToEdges\":{\"id\":47}}}\n"
		);
	}

	/// niri has no minimize and no idempotent setter for maximized,
	/// fullscreen or a restored state. Emulating one would mean reading state
	/// the compositor never publishes, so the four operations are refused.
	#[test]
	fn operations_niri_cannot_perform_are_refused() {
		let state = control_state();
		for action in [
			ControlAction::MaximizeWindow("niri:47".to_string()),
			ControlAction::MinimizeWindow("niri:47".to_string()),
			ControlAction::RestoreWindow("niri:47".to_string()),
			ControlAction::SetFullscreen { id: "niri:47".to_string(), enabled: true },
		] {
			let err = plan(&state, &action).expect_err("niri has no such primitive");
			assert_eq!(err.code.as_str(), "ControlUnsupported");
		}
		// An advertised operation is a promise, so none of these may appear
		// in the surface handed to callers.
		for absent in ["maximizeWindow", "minimizeWindow", "restoreWindow", "setFullscreen"] {
			assert!(!OPERATIONS.contains(&absent), "{absent} is advertised but refused");
		}
	}

	/// A floating setter is not a toggle: the end state is what was asked for
	/// whether or not the window was already floating.
	#[test]
	fn floating_setters_name_the_end_state() {
		assert_eq!(
			request_line(&ControlAction::SetFloating {
				id:      "niri:47".to_string(),
				enabled: true,
			}),
			"{\"Action\":{\"MoveWindowToFloating\":{\"id\":47}}}\n"
		);
		assert_eq!(
			request_line(&ControlAction::SetFloating {
				id:      "niri:69".to_string(),
				enabled: false,
			}),
			"{\"Action\":{\"MoveWindowToTiling\":{\"id\":69}}}\n"
		);
	}

	/// A resize is one compositor request per axis, in a fixed order, so the
	/// caller can tell which half landed when the second one fails.
	#[test]
	fn resize_is_one_request_per_axis() {
		let state = control_state();
		let both = plan(&state, &ControlAction::ResizeWindow {
			id:     "niri:69".to_string(),
			width:  Some(800),
			height: Some(600),
		})
		.expect("resize plan");
		assert_eq!(
			both
				.iter()
				.map(|action| action_line(action).expect("encode"))
				.collect::<Vec<_>>(),
			[
				"{\"Action\":{\"SetWindowWidth\":{\"id\":69,\"change\":{\"SetFixed\":800}}}}\n",
				"{\"Action\":{\"SetWindowHeight\":{\"id\":69,\"change\":{\"SetFixed\":600}}}}\n",
			]
		);
		// One axis alone is one request; the untouched axis is not guessed.
		let width_only = plan(&state, &ControlAction::ResizeWindow {
			id:     "niri:69".to_string(),
			width:  Some(800),
			height: None,
		})
		.expect("width-only resize plan");
		assert_eq!(width_only.len(), 1);
		// Neither axis names no change at all, which must not report success.
		let err = plan(&state, &ControlAction::ResizeWindow {
			id:     "niri:69".to_string(),
			width:  None,
			height: None,
		})
		.expect_err("an empty resize changes nothing");
		assert_eq!(err.code.as_str(), "InvalidTarget");
	}

	/// `Response::Handled` is a unit variant, so success is the bare string.
	/// A nested or null payload means the protocol changed, and reading it as
	/// success would report a mutation that never ran.
	#[test]
	fn only_the_handled_string_is_success() {
		assert!(decode::<Handled>(br#"{"Ok":"Handled"}"#).is_ok());
		for wrong in [
			&br#"{"Ok":{"Handled":null}}"#[..],
			&br#"{"Ok":null}"#[..],
			&br#"{"Ok":"Handled "}"#[..],
			&br#"{"Ok":"Ignored"}"#[..],
			&br#"{"Err":"unknown action"}"#[..],
		] {
			assert!(decode::<Handled>(wrong).is_err(), "{:?}", String::from_utf8_lossy(wrong));
		}
	}

	/// Only a version this module has been verified against may be talked to.
	/// An older or unrecognized build answers `Handled` to actions it did not
	/// apply, so it is refused instead of being advertised as controllable.
	#[test]
	fn only_a_version_this_module_speaks_passes_the_probe() {
		assert!(supported_version("26.04 (1f03391)"));
		assert!(supported_version("26.04.2 (abc1234)"));
		assert!(supported_version("26.4"));
		assert!(supported_version("27.01 (deadbee)"));
		for unverified in ["26.03 (1f03391)", "25.11 (1f03391)", "26.04-rc1", "", "unknown", "26"] {
			assert!(!supported_version(unverified), "{unverified}");
		}
	}

	/// Workspaces are addressed by the id that survives moving between
	/// monitors, and their index is reported as the position it currently
	/// holds rather than as a target.
	#[test]
	fn workspaces_report_stable_ids_and_own_flags() {
		let workspaces = control_state().workspaces();
		assert_eq!(workspaces.len(), 3);
		assert_eq!(workspaces[2].id, "niri-workspace:3");
		assert_eq!(workspaces[2].index, 2, "the index is its current position");
		assert_eq!(workspaces[2].display_id.as_deref(), Some("eDP-1"));
		assert!(!workspaces[2].active, "a workspace that is not on screen");
		assert_eq!(workspaces[2].active_window_id, None);
		assert!(workspaces[1].focused, "one workspace holds focus");
		assert_eq!(workspaces[1].active_window_id.as_deref(), Some("niri:69"));
		assert_eq!(workspaces[0].id, "niri-workspace:1");
		assert_eq!(workspaces[0].index, 1, "two monitors can share an index");
	}

	/// A window's state carries what niri publishes and nothing more: it has
	/// no maximized, minimized or fullscreen bit to report, so those stay
	/// absent instead of being read off geometry.
	#[test]
	fn window_state_publishes_only_what_niri_knows() {
		let state = control_state();
		let floating = state
			.window_state(state.window(69).expect("window 69"))
			.expect("floating window state");
		assert_eq!(floating.floating, Some(true));
		assert_eq!(floating.urgent, Some(false));
		assert_eq!(floating.workspace_id.as_deref(), Some("niri-workspace:2"));
		assert_eq!(floating.display_id.as_deref(), Some("eDP-1"));
		assert_eq!(floating.maximized, None);
		assert_eq!(floating.minimized, None);
		assert_eq!(floating.fullscreen, None);
		let tiled = state
			.window_state(state.window(47).expect("window 47"))
			.expect("tiled window state");
		assert_eq!(tiled.floating, Some(false));
		assert_eq!(tiled.workspace_id.as_deref(), Some("niri-workspace:1"));
	}

	/// One answer to a compositor.
	enum Scripted {
		/// Written back after the newline.
		Answer(String),
		/// The request was taken and never answered.
		Silent,
	}

	/// A compositor socket that answers one scripted reply per request line and
	/// records everything it was sent.
	struct FakeNiri {
		path:     std::path::PathBuf,
		requests: std::sync::mpsc::Receiver<String>,
		previous: Option<std::ffi::OsString>,
		_worker:  thread::JoinHandle<()>,
	}

	impl FakeNiri {
		fn start(replies: Vec<Scripted>) -> Self {
			static SOCKETS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
			let path = std::env::temp_dir().join(format!(
				"omp-niri-test-{}-{}",
				std::process::id(),
				SOCKETS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
			));
			let _ = std::fs::remove_file(&path);
			let listener = UnixListener::bind(&path).expect("bind fake niri socket");
			let (seen, requests) = std::sync::mpsc::channel();
			let mut script = replies
				.into_iter()
				.collect::<std::collections::VecDeque<_>>();
			let worker = thread::spawn(move || {
				for stream in listener.incoming() {
					let mut stream = stream.expect("accept fake niri connection");
					let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
					let mut line = String::new();
					while reader.read_line(&mut line).unwrap_or(0) > 0 {
						let _ = seen.send(std::mem::take(&mut line));
						match script.pop_front() {
							Some(Scripted::Answer(body)) => {
								let json: serde_json::Value =
									serde_json::from_str(&body).expect("valid fake compositor reply");
								let _ = serde_json::to_writer(&mut stream, &json);
								let _ = stream.write_all(b"\n");
								let _ = stream.flush();
							},
							Some(Scripted::Silent) | None => {},
						}
					}
				}
			});
			let previous = std::env::var_os(SOCKET_ENV);
			unsafe { std::env::set_var(SOCKET_ENV, &path) };
			Self { path, requests, previous, _worker: worker }
		}

		/// Every request line the compositor was sent so far.
		fn sent(&self) -> Vec<String> {
			self.requests.try_iter().collect()
		}
	}

	impl Drop for FakeNiri {
		fn drop(&mut self) {
			match self.previous.take() {
				Some(previous) => unsafe { std::env::set_var(SOCKET_ENV, previous) },
				None => unsafe { std::env::remove_var(SOCKET_ENV) },
			}
			let _ = std::fs::remove_file(&self.path);
		}
	}

	/// The one answer to a version probe.
	fn version() -> Scripted {
		Scripted::Answer(r#"{"Ok":{"Version":"26.04 (1f03391)"}}"#.to_string())
	}

	fn handles() -> Scripted {
		Scripted::Answer(r#"{"Ok":"Handled"}"#.to_string())
	}

	/// The two windows the fake compositor lists, as one reply body.
	fn windows_reply() -> String {
		format!(r#"{{"Ok":{{"Windows":[{TILED},{FLOATING}]}}}}"#)
	}

	/// The state a control call reads before it resolves its targets.
	fn state_replies() -> Vec<Scripted> {
		vec![
			Scripted::Answer(windows_reply()),
			Scripted::Answer(WORKSPACES.to_string()),
			Scripted::Answer(OUTPUTS.to_string()),
		]
	}

	/// The whole handshake a control call performs: one version probe, then
	/// the state its targets resolve against, then one answer per action.
	fn control_script(actions: Vec<Scripted>) -> Vec<Scripted> {
		let mut script = vec![version()];
		script.extend(state_replies());
		script.extend(actions);
		script
	}

	/// The same handshake, with the caller's own probe ahead of it.
	fn probed_control_script(actions: Vec<Scripted>) -> Vec<Scripted> {
		let mut script = vec![version()];
		script.extend(control_script(actions));
		script
	}

	/// A control call reaches the compositor as the exact request line, behind
	/// the probe that decides whether this compositor may be spoken to at all.
	#[test]
	fn a_focus_reaches_the_compositor_as_one_action_request() {
		let _guard = super::super::tests::ENV_LOCK
			.lock()
			.expect("lock the compositor environment");
		// The test's own probe consumes a handshake of its own, ahead of the
		// one `control` performs before it resolves any target.
		let compositor = FakeNiri::start(probed_control_script(vec![handles()]));
		assert!(compatible(), "the probe accepts a 26.04 compositor");
		control(&ControlAction::FocusWindow("niri:69".to_string())).expect("focus is handled");
		let sent = compositor.sent();
		assert_eq!(sent.len(), 6, "two probes, three state reads, one action");
		assert_eq!(sent[0], "\"Version\"\n");
		assert_eq!(sent[2], "\"Windows\"\n");
		assert_eq!(
			sent.last().map(String::as_str),
			Some("{\"Action\":{\"FocusWindow\":{\"id\":69}}}\n")
		);
	}

	/// A compositor that takes an action and never answers leaves the change
	/// in doubt: it may already have applied it, so the failure says so and
	/// keeps its own timeout code instead of inviting a retry.
	#[test]
	fn a_silent_compositor_leaves_the_change_in_doubt() {
		let _guard = super::super::tests::ENV_LOCK
			.lock()
			.expect("lock the compositor environment");
		let compositor = FakeNiri::start(control_script(vec![Scripted::Silent]));
		let err = control(&ControlAction::FocusWindow("niri:69".to_string()))
			.expect_err("a silent compositor does not confirm the action");
		assert_eq!(err.code.as_str(), "Timeout");
		assert!(err.message.contains("may already have been applied"), "{}", err.message);
		assert_eq!(compositor.sent().len(), 5, "one request per exchange, none retried");
	}

	/// A reply this module does not recognize is a protocol change, not a
	/// handled action.
	#[test]
	fn an_unrecognized_handled_reply_is_refused() {
		let _guard = super::super::tests::ENV_LOCK
			.lock()
			.expect("lock the compositor environment");
		let _compositor = FakeNiri::start(control_script(vec![Scripted::Answer(
			r#"{"Ok":{"Handled":null}}"#.to_string(),
		)]));
		let err = control(&ControlAction::FocusWindow("niri:69".to_string()))
			.expect_err("a nested payload is not this protocol's handled reply");
		assert_eq!(err.code.as_str(), "ControlFailed");
	}

	/// A resize that gets its width through and loses its height leaves the
	/// window half resized, and the failure has to say which half that was.
	#[test]
	fn a_second_resize_axis_failing_reports_the_partial_change() {
		let _guard = super::super::tests::ENV_LOCK
			.lock()
			.expect("lock the compositor environment");
		let compositor = FakeNiri::start(control_script(vec![handles(), Scripted::Silent]));
		let err = control(&ControlAction::ResizeWindow {
			id:     "niri:69".to_string(),
			width:  Some(800),
			height: Some(600),
		})
		.expect_err("the height request never comes back");
		assert_eq!(err.code.as_str(), "ControlFailed");
		assert!(err.message.contains("earlier part"), "{}", err.message);
		let sent = compositor.sent();
		assert_eq!(sent.len(), 6, "the width request was applied before the height failed");
		assert!(sent[4].contains("SetWindowWidth"), "{}", sent[4]);
	}

	/// A `$NIRI_SOCKET` that no compositor answers must not advertise a
	/// control surface, and every control read has to refuse instead of
	/// falling back to something that is not this compositor.
	#[test]
	fn a_dead_socket_advertises_nothing_and_refuses_every_control_read() {
		let _guard = super::super::tests::ENV_LOCK
			.lock()
			.expect("lock the compositor environment");
		let previous = std::env::var_os(SOCKET_ENV);
		unsafe {
			std::env::set_var(SOCKET_ENV, "/nonexistent-omp-test-niri.sock");
		}
		let outcome = catch_unwind(AssertUnwindSafe(|| {
			assert!(!compatible(), "an unreachable socket cannot advertise control");
			let capabilities = control_capabilities();
			assert!(capabilities.operations.is_empty());
			assert_eq!(capabilities.coordinate_space, None);
			assert!(!capabilities.focus_may_warp_pointer);
			assert_eq!(
				control(&ControlAction::FocusWindow("niri:1".to_string()))
					.expect_err("focus needs a live compositor")
					.code
					.as_str(),
				"ControlUnsupported"
			);
			assert_eq!(
				workspaces()
					.expect_err("workspaces need a live compositor")
					.code
					.as_str(),
				"ControlUnsupported"
			);
			assert_eq!(
				window_state("niri:1")
					.expect_err("state needs a live compositor")
					.code
					.as_str(),
				"ControlUnsupported"
			);
		}));
		match previous {
			Some(previous) => unsafe { std::env::set_var(SOCKET_ENV, previous) },
			None => unsafe { std::env::remove_var(SOCKET_ENV) },
		}
		if let Err(payload) = outcome {
			std::panic::resume_unwind(payload);
		}
	}
}
