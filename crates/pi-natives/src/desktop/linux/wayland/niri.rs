//! Read-only niri compositor state and native per-window capture.
//!
//! niri answers window identity, focus and geometry on the `$NIRI_SOCKET` Unix
//! socket. That IPC is the only source on this platform that knows where the
//! compositor actually put a window — AT-SPI clients answer with
//! window-relative coordinates — so window targets are addressed by `niri:<id>`
//! and never by a toolkit object.
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
	io::{Read, Write},
	os::unix::net::UnixStream,
	path::PathBuf,
	time::Duration,
};

#[cfg(feature = "wayland-pipewire")]
use image::RgbaImage;
use serde::{Deserialize, de::DeserializeOwned};
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
	error::{CoreResult, DesktopError},
	types::{DesktopDisplay, DesktopWindow},
};

/// Environment variable niri publishes its IPC socket path in.
const SOCKET_ENV: &str = "NIRI_SOCKET";

/// Prefix of the window ids this module mints.
const ID_PREFIX: &str = "niri:";

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
		self
			.stream
			.write_all(request.as_bytes())
			.map_err(|err| DesktopError::capture_failed(format!("niri IPC {variant} write: {err}")))?;
		let body =
			read_reply(&mut self.stream, REPLY_LIMIT).map_err(|err| reply_error(variant, &err))?;
		decode(&body).map_err(|err| reply_error(variant, &err))
	}
}

fn reply_error(variant: &str, err: &str) -> DesktopError {
	DesktopError::capture_failed(format!("niri IPC {variant}: {err}"))
}

/// Read one newline-terminated reply, refusing to buffer past `limit`.
fn read_reply(reader: &mut impl Read, limit: usize) -> Result<Vec<u8>, String> {
	let mut reply = Vec::new();
	let mut chunk = [0_u8; 8192];
	loop {
		let read = reader.read(&mut chunk).map_err(|err| err.to_string())?;
		if read == 0 {
			return Err("closed the connection mid-reply".to_string());
		}
		let end = chunk[..read].iter().position(|byte| *byte == b'\n');
		let length = end.unwrap_or(read);
		if reply
			.len()
			.checked_add(length)
			.is_none_or(|size| size > limit)
		{
			return Err(format!("sent more than the {limit} byte reply limit"));
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

fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
	let reply: Reply<T> =
		serde_json::from_slice(body).map_err(|err| format!("sent an unreadable reply: {err}"))?;
	match reply {
		Reply::Ok(value) => Ok(value),
		Reply::Err(message) => Err(format!("refused the request: {message}")),
	}
}

/// A toplevel window as niri lays it out.
#[derive(Debug, Deserialize)]
struct IpcWindow {
	id:           u64,
	title:        Option<String>,
	app_id:       Option<String>,
	pid:          Option<i32>,
	workspace_id: Option<u64>,
	is_focused:   bool,
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

#[derive(Debug, Deserialize)]
struct IpcWorkspace {
	id:         u64,
	output:     Option<String>,
	is_active:  bool,
	is_focused: bool,
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

/// State needed to resolve window capture geometry.
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

	#[cfg(any(feature = "wayland-pipewire", test))]
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
			id: format!("{ID_PREFIX}{}", window.id),
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

/// Decode a `niri:<id>` target.
///
/// The id is the compositor's own window id, so anything else — an AT-SPI
/// object path, a bare number, a truncated prefix — is refused instead of being
/// coerced into a window that may not exist.
#[cfg(any(feature = "wayland-pipewire", test))]
fn window_id(id: &str) -> CoreResult<u64> {
	let raw = id.strip_prefix(ID_PREFIX).ok_or_else(|| {
		DesktopError::invalid_target(format!(
			"'{id}' is not a niri window target; niri windows are addressed as {ID_PREFIX}<id>"
		))
	})?;
	if raw.is_empty()
		|| (raw.len() > 1 && raw.starts_with('0'))
		|| !raw.bytes().all(|byte| byte.is_ascii_digit())
	{
		return Err(DesktopError::invalid_target(format!(
			"'{id}' does not name a niri window; expected {ID_PREFIX} followed by the compositor's \
			 window id"
		)));
	}
	raw.parse::<u64>()
		.map_err(|_| DesktopError::invalid_target(format!("niri window id '{raw}' is out of range")))
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
}
