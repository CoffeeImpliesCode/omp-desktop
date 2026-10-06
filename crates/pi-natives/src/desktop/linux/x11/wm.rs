//! Window-manager and window-tree queries shared by the X11 input routes:
//! EWMH activation with a real server timestamp, background focus observation,
//! occlusion checks for real pointer input, and popup detection.
//!
//! The same table backs the window-control routes: close, geometry, state and
//! desktops go through EWMH/ICCCM messages on this one connection, never
//! through synthetic input and never through a client kill.

use std::time::{Duration, Instant};

use x11rb::{
	COPY_DEPTH_FROM_PARENT, NONE,
	connection::Connection,
	protocol::{
		Event,
		xproto::{
			Atom, AtomEnum, ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask,
			InputFocus, MapState, PropMode, Window, WindowClass,
		},
	},
	rust_connection::RustConnection,
};

use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
};

/// Bound on ancestor/descendant walks.
const TREE_WALK_LIMIT: usize = 32;
/// How long a background action is watched for a late focus change (the WM
/// processes click-to-focus asynchronously).
const FOCUS_SETTLE_WATCH: Duration = Duration::from_millis(150);
const FOCUS_POLL: Duration = Duration::from_millis(25);
/// Bound on one client-list read.
const MAX_CLIENTS: usize = 4096;
/// Bound on one `_NET_WM_STATE` read.
const MAX_STATES: usize = 64;
/// Bound on one `_NET_SUPPORTED` read. A compliant window manager lists every
/// EWMH atom it knows, so this must be generous: truncating the list would
/// make supported operations look unsupported.
const MAX_SUPPORTED: usize = 512;
/// ICCCM 4.1.4 `WM_STATE` iconified.
pub(super) const ICONIC_STATE: u32 = 3;
/// ICCCM 4.1.4 `WM_STATE` normal.
pub(super) const NORMAL_STATE: u32 = 1;
/// Anchor position requests at the WM frame, then subtract its published
/// extents to place the client's inner origin. `StaticGravity` depends on
/// the original client border, which a reparenting WM can remove from X11.
const NORTH_WEST_GRAVITY: u32 = 1;
/// Bits 8 to 11 of the flags word mark which of x, y, width and height the
/// request carries.
const PRESENT_X: u32 = 1 << 8;
const PRESENT_Y: u32 = 1 << 9;
const PRESENT_WIDTH: u32 = 1 << 10;
const PRESENT_HEIGHT: u32 = 1 << 11;
/// EWMH source indication: the request comes from an application.
const SOURCE_APPLICATION: u32 = 1;
/// EWMH source indication: the request comes from a pager, which is what a
/// desktop-control request is.
const SOURCE_PAGER: u32 = 2;
const MOVE_FLAGS: u32 = NORTH_WEST_GRAVITY | PRESENT_X | PRESENT_Y | (SOURCE_PAGER << 12);

fn frame_origin(x: i32, y: i32, extents: [u32; 4]) -> CoreResult<(i32, i32)> {
	let left = i32::try_from(extents[0]).map_err(|_| {
		DesktopError::control_failed("X11 left frame extent exceeds coordinate range")
	})?;
	let top = i32::try_from(extents[2])
		.map_err(|_| DesktopError::control_failed("X11 top frame extent exceeds coordinate range"))?;
	let x = x
		.checked_sub(left)
		.ok_or_else(|| DesktopError::control_failed("X11 frame x origin underflows"))?;
	let y = y
		.checked_sub(top)
		.ok_or_else(|| DesktopError::control_failed("X11 frame y origin underflows"))?;
	Ok((x, y))
}

const fn resize_message(width: Option<u32>, height: Option<u32>) -> [u32; 5] {
	let mut flags = SOURCE_PAGER << 12;
	let width = match width {
		Some(width) => {
			flags |= PRESENT_WIDTH;
			width
		},
		None => 0,
	};
	let height = match height {
		Some(height) => {
			flags |= PRESENT_HEIGHT;
			height
		},
		None => 0,
	};
	[flags, 0, 0, width, height]
}

/// `_NET_WORKAREA` is four CARDINALs in x, y, width, height order. A zero
/// width or height is not a working area at all.
fn work_area_rect(values: [u32; 4]) -> Option<Rect> {
	let [x, y, width, height] = values;
	if width == 0 || height == 0 {
		return None;
	}
	Some(Rect { x: i32::try_from(x).ok()?, y: i32::try_from(y).ok()?, width, height })
}

pub(super) struct Atoms {
	pub net_active_window:   Atom,
	pub net_wm_pid:          Atom,
	pub net_wm_name:         Atom,
	pub net_wm_window_type:  Atom,
	pub utf8_string:         Atom,
	pub wm_state:            Atom,
	pub time_probe:          Atom,
	/// `_NET_WM_WINDOW_TYPE`s of override-redirect windows that hold no grab.
	pub passive_popup_types: [Atom; 3],
	/// The EWMH/ICCCM atoms of the window-control routes, in one table so every
	/// route reads the same ids.
	pub control:             ControlAtoms,
}

impl Atoms {
	pub(super) fn intern(conn: &RustConnection) -> CoreResult<Self> {
		const NAMES: [&str; 30] = [
			"_NET_ACTIVE_WINDOW",
			"_NET_WM_PID",
			"_NET_WM_NAME",
			"_NET_WM_WINDOW_TYPE",
			"UTF8_STRING",
			"WM_STATE",
			"_OMP_TIME_PROBE",
			"_NET_WM_WINDOW_TYPE_TOOLTIP",
			"_NET_WM_WINDOW_TYPE_NOTIFICATION",
			"_NET_WM_WINDOW_TYPE_DND",
			"_NET_SUPPORTING_WM_CHECK",
			"_NET_NUMBER_OF_DESKTOPS",
			"_NET_CURRENT_DESKTOP",
			"_NET_DESKTOP_NAMES",
			"_NET_WORKAREA",
			"_NET_WM_DESKTOP",
			"_NET_WM_STATE",
			"_NET_WM_STATE_MAXIMIZED_VERT",
			"_NET_WM_STATE_MAXIMIZED_HORZ",
			"_NET_WM_STATE_FULLSCREEN",
			"_NET_WM_STATE_HIDDEN",
			"_NET_WM_STATE_DEMANDS_ATTENTION",
			"_NET_MOVERESIZE_WINDOW",
			"_NET_FRAME_EXTENTS",
			"_NET_CLIENT_LIST",
			"_NET_CLIENT_LIST_STACKING",
			"WM_PROTOCOLS",
			"WM_DELETE_WINDOW",
			"WM_CHANGE_STATE",
			"_NET_SUPPORTED",
		];
		let cookies = NAMES
			.iter()
			.map(|name| conn.intern_atom(false, name.as_bytes()))
			.collect::<Result<Vec<_>, _>>()
			.map_err(wm_failed)?;
		let atoms = cookies
			.into_iter()
			.map(|cookie| cookie.reply().map(|reply| reply.atom))
			.collect::<Result<Vec<_>, _>>()
			.map_err(wm_failed)?;
		let [
			net_active_window,
			net_wm_pid,
			net_wm_name,
			net_wm_window_type,
			utf8_string,
			wm_state,
			time_probe,
			tooltip,
			notification,
			dnd,
			supporting_wm_check,
			number_of_desktops,
			current_desktop,
			desktop_names,
			workarea,
			wm_desktop,
			net_wm_state,
			maximized_vert,
			maximized_horz,
			fullscreen,
			hidden,
			demands_attention,
			move_resize_window,
			frame_extents,
			client_list,
			client_list_stacking,
			wm_protocols,
			delete_window,
			change_state,
			supported,
		] = atoms[..]
		else {
			return Err(wm_failed("interned atom count diverged from the name table"));
		};
		Ok(Self {
			net_active_window,
			net_wm_pid,
			net_wm_name,
			net_wm_window_type,
			utf8_string,
			wm_state,
			time_probe,
			passive_popup_types: [tooltip, notification, dnd],
			control: ControlAtoms {
				supporting_wm_check,
				number_of_desktops,
				current_desktop,
				desktop_names,
				workarea,
				wm_desktop,
				net_wm_state,
				maximized_vert,
				maximized_horz,
				fullscreen,
				hidden,
				demands_attention,
				move_resize_window,
				frame_extents,
				client_list,
				client_list_stacking,
				wm_protocols,
				delete_window,
				change_state,
				supported,
			},
		})
	}
}

/// The atoms a compliant window manager publishes for window control.
pub(super) struct ControlAtoms {
	pub supporting_wm_check:  Atom,
	pub number_of_desktops:   Atom,
	pub current_desktop:      Atom,
	pub desktop_names:        Atom,
	pub workarea:             Atom,
	pub wm_desktop:           Atom,
	pub net_wm_state:         Atom,
	pub maximized_vert:       Atom,
	pub maximized_horz:       Atom,
	pub fullscreen:           Atom,
	pub hidden:               Atom,
	pub demands_attention:    Atom,
	pub move_resize_window:   Atom,
	pub frame_extents:        Atom,
	pub client_list:          Atom,
	pub client_list_stacking: Atom,
	pub wm_protocols:         Atom,
	pub delete_window:        Atom,
	pub change_state:         Atom,
	pub supported:            Atom,
}

fn wm_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("X11 window query failed: {error}"))
}

/// An axis-aligned rectangle in root (desktop) coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Rect {
	pub x:      i32,
	pub y:      i32,
	pub width:  u32,
	pub height: u32,
}

impl Rect {
	pub(super) fn right(self) -> i32 {
		self
			.x
			.saturating_add(i32::try_from(self.width).unwrap_or(i32::MAX))
	}

	pub(super) fn bottom(self) -> i32 {
		self
			.y
			.saturating_add(i32::try_from(self.height).unwrap_or(i32::MAX))
	}

	/// Origin of a `width` x `height` box centered in this rectangle, never
	/// left of its top-left corner when the box does not fit.
	pub(super) fn center_origin(self, width: u32, height: u32) -> (i32, i32) {
		let slack_x = i64::from(self.width).saturating_sub(i64::from(width)) / 2;
		let slack_y = i64::from(self.height).saturating_sub(i64::from(height)) / 2;
		let x = i64::from(self.x)
			.saturating_add(slack_x)
			.clamp(i64::from(self.x), i64::from(self.x) + i64::from(self.width))
			.min(i64::from(i32::MAX)) as i32;
		let y = i64::from(self.y)
			.saturating_add(slack_y)
			.clamp(i64::from(self.y), i64::from(self.y) + i64::from(self.height))
			.min(i64::from(i32::MAX)) as i32;
		(x, y)
	}

	/// Where this rectangle sits on `target` when the window moves there: its
	/// offset inside `current` is kept, and it stays visible on `target`. A
	/// window that never sat inside `current` is centered instead.
	pub(super) fn translated_onto(self, current: Self, target: Self) -> Self {
		let inside_current = self.x >= current.x
			&& self.y >= current.y
			&& self.right() <= current.right()
			&& self.bottom() <= current.bottom();
		let (x, y) = if inside_current {
			(target.x.saturating_add(self.x - current.x), target.y.saturating_add(self.y - current.y))
		} else {
			target.center_origin(self.width, self.height)
		};
		let max_x = target
			.right()
			.saturating_sub(i32::try_from(self.width).unwrap_or(i32::MAX))
			.max(target.x);
		let max_y = target
			.bottom()
			.saturating_sub(i32::try_from(self.height).unwrap_or(i32::MAX))
			.max(target.y);
		Self {
			x:      x.clamp(target.x, max_x),
			y:      y.clamp(target.y, max_y),
			width:  self.width,
			height: self.height,
		}
	}
}

/// Window-manager view of the X session: one connection, its root, atoms.
#[derive(Clone, Copy)]
pub(super) struct Wm<'a> {
	pub conn:  &'a RustConnection,
	pub root:  Window,
	pub atoms: &'a Atoms,
}

impl Wm<'_> {
	fn property32(&self, window: Window, property: Atom, type_: impl Into<Atom>) -> Option<u32> {
		self
			.conn
			.get_property(false, window, property, type_, 0, 1)
			.ok()?
			.reply()
			.ok()?
			.value32()?
			.next()
	}

	/// `_NET_ACTIVE_WINDOW`, `None` when unset or zero.
	pub(super) fn active_window(&self) -> Option<Window> {
		self
			.property32(self.root, self.atoms.net_active_window, AtomEnum::WINDOW)
			.filter(|&window| window != NONE)
	}

	/// Whether an EWMH window manager publishes `_NET_ACTIVE_WINDOW` at all.
	pub(super) fn tracks_active_window(&self) -> bool {
		self
			.conn
			.get_property(false, self.root, self.atoms.net_active_window, AtomEnum::ANY, 0, 0)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.is_some_and(|reply| reply.type_ != NONE)
	}

	/// Core keyboard focus and its revert mode.
	pub(super) fn input_focus(&self) -> Option<(Window, InputFocus)> {
		let reply = self.conn.get_input_focus().ok()?.reply().ok()?;
		Some((reply.focus, reply.revert_to))
	}

	fn parent(&self, window: Window) -> Option<Window> {
		let reply = self.conn.query_tree(window).ok()?.reply().ok()?;
		(reply.parent != NONE && reply.parent != window).then_some(reply.parent)
	}

	fn children(&self, window: Window) -> Vec<Window> {
		self
			.conn
			.query_tree(window)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.map_or_default(|reply| reply.children)
	}

	/// Whether `window` is `target` or one of its descendants.
	pub(super) fn is_within(&self, window: Window, target: Window) -> bool {
		let mut current = window;
		for _ in 0..TREE_WALK_LIMIT {
			if current == target {
				return true;
			}
			if current == NONE || current == self.root {
				return false;
			}
			match self.parent(current) {
				Some(parent) => current = parent,
				None => return false,
			}
		}
		false
	}

	/// The root child containing `window`: its WM frame, or the window itself
	/// when unmanaged.
	fn root_child_of(&self, window: Window) -> Option<Window> {
		let mut current = window;
		for _ in 0..TREE_WALK_LIMIT {
			let parent = self.parent(current)?;
			if parent == self.root {
				return Some(current);
			}
			current = parent;
		}
		None
	}

	/// The mapped root child under a screen point (input shapes honoured).
	fn root_child_at(&self, x: i16, y: i16) -> Option<Window> {
		let reply = self
			.conn
			.translate_coordinates(self.root, self.root, x, y)
			.ok()?
			.reply()
			.ok()?;
		(reply.child != NONE).then_some(reply.child)
	}

	/// The ICCCM client window inside a root child (a WM frame nests it one
	/// or two levels deep); the root child itself when it is a client.
	fn client_of(&self, frame: Window) -> Option<Window> {
		let mut level = vec![frame];
		for _ in 0..3 {
			if let Some(&client) = level.iter().find(|&&window| {
				self
					.property32(window, self.atoms.wm_state, AtomEnum::ANY)
					.is_some()
			}) {
				return Some(client);
			}
			level = level
				.iter()
				.flat_map(|&window| self.children(window))
				.collect();
			if level.is_empty() {
				break;
			}
		}
		None
	}

	pub(super) fn window_pid(&self, window: Window) -> Option<u32> {
		self
			.property32(window, self.atoms.net_wm_pid, AtomEnum::CARDINAL)
			.filter(|&pid| pid != 0)
	}

	/// `_NET_WM_PID` of `window` or its nearest ancestor carrying one.
	pub(super) fn owning_pid(&self, window: Window) -> Option<u32> {
		let mut current = window;
		for _ in 0..TREE_WALK_LIMIT {
			if current == NONE || current == self.root {
				return None;
			}
			if let Some(pid) = self.window_pid(current) {
				return Some(pid);
			}
			current = self.parent(current)?;
		}
		None
	}

	/// `_NET_WM_PID` of a root child or the client window inside it.
	fn root_child_pid(&self, child: Window) -> Option<u32> {
		self.window_pid(child).or_else(|| {
			self
				.client_of(child)
				.and_then(|client| self.window_pid(client))
		})
	}

	fn title(&self, window: Window) -> String {
		let read = |property: Atom, type_: Atom| {
			self
				.conn
				.get_property(false, window, property, type_, 0, 256)
				.ok()?
				.reply()
				.ok()
				.filter(|reply| !reply.value.is_empty())
				.map(|reply| String::from_utf8_lossy(&reply.value).into_owned())
		};
		read(self.atoms.net_wm_name, self.atoms.utf8_string)
			.or_else(|| read(AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
			.unwrap_or_default()
	}

	/// Current X server time via the `PropertyNotify` round trip. Activation
	/// requests stamped `CurrentTime` lose to focus-stealing prevention
	/// whenever newer user input exists. Falls back to `CurrentTime` (0).
	fn server_time(&self) -> u32 {
		let Ok(probe) = self.conn.generate_id() else {
			return x11rb::CURRENT_TIME;
		};
		let aux = CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE);
		let created = self.conn.create_window(
			COPY_DEPTH_FROM_PARENT,
			probe,
			self.root,
			-1,
			-1,
			1,
			1,
			0,
			WindowClass::INPUT_ONLY,
			0,
			&aux,
		);
		if created.is_err() {
			return x11rb::CURRENT_TIME;
		}
		let _ = self.conn.change_property(
			PropMode::REPLACE,
			probe,
			self.atoms.time_probe,
			AtomEnum::STRING,
			8,
			1,
			&[0],
		);
		let _ = self.conn.flush();
		let deadline = Instant::now() + Duration::from_millis(300);
		let mut time = x11rb::CURRENT_TIME;
		while Instant::now() < deadline {
			if control::check().is_err() {
				break;
			}
			match self.conn.poll_for_event() {
				Ok(Some(Event::PropertyNotify(event))) if event.window == probe => {
					time = event.time;
					break;
				},
				Ok(Some(_)) => {},
				Ok(None) => {
					if control::wait(Duration::from_millis(2)).is_err() {
						break;
					}
				},
				Err(_) => break,
			}
		}
		let _ = self.conn.destroy_window(probe);
		let _ = self.conn.flush();
		time
	}

	/// Ask the WM to activate `window` (EWMH, source = pager, real timestamp)
	/// and set the core focus as well: WMs with focus-stealing prevention may
	/// treat `_NET_ACTIVE_WINDOW` as raise-only.
	pub(super) fn request_activation(
		&self,
		window: Window,
		current: Option<Window>,
	) -> CoreResult<()> {
		self.activate(window, current, false)
	}

	pub(super) fn restore_activation(&self, window: Window, current: Window) -> CoreResult<()> {
		self.activate(window, Some(current), true)
	}

	fn activate(&self, window: Window, current: Option<Window>, restoring: bool) -> CoreResult<()> {
		control::check()?;
		// Timestamp acquisition can yield to physical input. Re-check the
		// guard immediately before requesting a restore, not just before it.
		if restoring && !current.is_some_and(|current| self.is_focused(current, true)) {
			return Ok(());
		}
		let time = self.server_time();
		self.send_to_root(window, self.atoms.net_active_window, [
			2,
			time,
			current.unwrap_or(NONE),
			0,
			0,
		])?;
		control::check()?;
		// Never override a newer focus switch while the WM handles the request.
		if restoring
			&& !self.is_focused(window, true)
			&& !current.is_some_and(|current| self.is_focused(current, true))
		{
			return Ok(());
		}
		// BadMatch on a not-yet-viewable window is expected; callers confirm.
		if let Ok(cookie) = self.conn.set_input_focus(InputFocus::PARENT, window, time) {
			let _ = cookie.check();
		}
		self.conn.flush().map_err(wm_failed)
	}

	/// Whether `window` is the active window (when an EWMH WM tracks one) and
	/// holds the core focus.
	pub(super) fn is_focused(&self, window: Window, ewmh: bool) -> bool {
		(!ewmh || self.active_window() == Some(window))
			&& self
				.input_focus()
				.is_some_and(|(focus, _)| self.is_within(focus, window))
	}

	/// Refuses a real (position-routed) pointer event at screen point `(x, y)`
	/// unless it would land on `window`. Another window of the same process
	/// and an unowned override-redirect popup are not the requested target.
	pub(super) fn check_pointer_target(&self, window: Window, x: i16, y: i16) -> CoreResult<()> {
		let attributes = self
			.conn
			.get_window_attributes(window)
			.map_err(wm_failed)?
			.reply()
			.map_err(wm_failed)?;
		if attributes.map_state != MapState::VIEWABLE {
			return Err(DesktopError::background_unavailable(format!(
				"window {window} is not viewable; use ax actions or takeover:true"
			)));
		}
		let geometry = self
			.conn
			.get_geometry(window)
			.map_err(wm_failed)?
			.reply()
			.map_err(|_| DesktopError::window_not_found(format!("X11 window {window} is gone")))?;
		let origin = self
			.conn
			.translate_coordinates(window, self.root, 0, 0)
			.map_err(wm_failed)?
			.reply()
			.map_err(wm_failed)?;
		let (left, top) = (i32::from(origin.dst_x), i32::from(origin.dst_y));
		let (px, py) = (i32::from(x), i32::from(y));
		if px < left
			|| py < top
			|| px >= left + i32::from(geometry.width)
			|| py >= top + i32::from(geometry.height)
		{
			return Err(DesktopError::invalid_coordinate_frame(format!(
				"screen point ({x}, {y}) lies outside window {window} (x={left}, y={top}, {}x{}); no \
				 input was sent",
				geometry.width, geometry.height
			)));
		}
		let under = self.root_child_at(x, y).ok_or_else(|| {
			DesktopError::background_unavailable(format!(
				"no input window covers ({x}, {y}); use ax actions or takeover:true"
			))
		})?;
		let frame = self.root_child_of(window).ok_or_else(|| {
			DesktopError::background_unavailable(format!(
				"window {window} is not mapped on this screen; retry with takeover:true or use ax \
				 actions"
			))
		})?;
		if under == frame {
			return Ok(());
		}
		let covering_pid = self.root_child_pid(under);
		let client = self.client_of(under).unwrap_or(under);
		let title = self.title(client);
		Err(DesktopError::background_unavailable(format!(
			"window {window}: screen point ({x}, {y}) is covered by window {client}{}{}, so a real \
			 pointer event would land there; no input was sent; retry with takeover:true or use ax \
			 actions",
			if title.is_empty() {
				String::new()
			} else {
				format!(" \"{title}\"")
			},
			covering_pid.map_or_else(String::new, |pid| format!(" (pid {pid})")),
		)))
	}

	/// A mapped popup is evidence that input may be grabbed, not proof of
	/// who owns the grab. Never use this heuristic to authorize core input.
	pub(super) fn grab_popup_of(&self, pid: u32) -> Option<Window> {
		self.children(self.root).into_iter().rev().find(|&child| {
			let Some(attributes) = self
				.conn
				.get_window_attributes(child)
				.ok()
				.and_then(|cookie| cookie.reply().ok())
			else {
				return false;
			};
			attributes.override_redirect
				&& attributes.map_state == MapState::VIEWABLE
				&& self.root_child_pid(child) == Some(pid)
				&& !self.is_passive_popup(child)
		})
	}

	fn is_passive_popup(&self, window: Window) -> bool {
		let types = self
			.conn
			.get_property(false, window, self.atoms.net_wm_window_type, AtomEnum::ATOM, 0, 8)
			.ok()
			.and_then(|cookie| cookie.reply().ok());
		types
			.as_ref()
			.and_then(|reply| reply.value32())
			.is_some_and(|mut atoms| atoms.any(|atom| self.atoms.passive_popup_types.contains(&atom)))
	}

	/// Whether a window manager that honours EWMH owns this screen. Without
	/// one there is no real route for window control, only bare X requests a
	/// reparenting window manager would swallow.
	pub(super) fn has_ewmh_wm(&self) -> bool {
		self
			.property32(self.root, self.atoms.control.supporting_wm_check, AtomEnum::WINDOW)
			.is_some_and(|check| check != NONE)
	}

	/// `_NET_SUPPORTED`: the atoms this window manager says it implements. A
	/// window manager that names no support cannot be asked for more than the
	/// core protocol, so callers treat the empty answer as "supports nothing
	/// EWMH" and refuse rather than guess.
	pub(super) fn supported_atoms(&self) -> Vec<Atom> {
		self
			.conn
			.get_property(
				false,
				self.root,
				self.atoms.control.supported,
				AtomEnum::ATOM,
				0,
				MAX_SUPPORTED as u32,
			)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.and_then(|reply| reply.value32().map(|values| values.collect()))
			.unwrap_or_default()
	}

	/// Whether `window` advertises `protocol` in its `WM_PROTOCOLS`.
	pub(super) fn advertises(&self, window: Window, protocol: Atom) -> bool {
		self
			.conn
			.get_property(false, window, self.atoms.control.wm_protocols, AtomEnum::ATOM, 0, 32)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.is_some_and(|reply| {
				reply
					.value32()
					.is_some_and(|mut protocols| protocols.any(|advertised| advertised == protocol))
			})
	}

	/// ICCCM `WM_CHANGE_STATE`: `1` returns a normal state, `3` iconifies.
	pub(super) fn change_state(&self, window: Window, state: u32) -> CoreResult<()> {
		self.send_to_root(window, self.atoms.control.change_state, [state, 0, 0, 0, 0])
	}

	/// `_NET_WM_STATE` add/remove for a client window. One message carries two
	/// atoms, so longer lists go out as consecutive messages in order.
	pub(super) fn set_net_wm_state(
		&self,
		window: Window,
		remove: &[Atom],
		add: &[Atom],
	) -> CoreResult<()> {
		for (action, states) in [(0u32, remove), (1u32, add)] {
			// Two atoms fit in one message; a restore clears three, so the
			// list goes out in pairs rather than dropping the tail.
			for pair in states.chunks(2) {
				self.send_to_root(window, self.atoms.control.net_wm_state, [
					action,
					pair[0],
					pair.get(1).copied().unwrap_or(NONE),
					SOURCE_APPLICATION,
					0,
				])?;
			}
		}
		Ok(())
	}

	/// Position the client through the WM's frame without changing its size.
	pub(super) fn move_window(&self, window: Window, x: i32, y: i32) -> CoreResult<()> {
		let (x, y) = frame_origin(x, y, self.frame_extents(window)?)?;
		self.send_to_root(window, self.atoms.control.move_resize_window, [
			MOVE_FLAGS,
			x.cast_unsigned(),
			y.cast_unsigned(),
			0,
			0,
		])
	}

	/// Leave position and every unrequested size axis to the WM.
	pub(super) fn resize_window(
		&self,
		window: Window,
		width: Option<u32>,
		height: Option<u32>,
	) -> CoreResult<()> {
		self.send_to_root(
			window,
			self.atoms.control.move_resize_window,
			resize_message(width, height),
		)
	}

	/// `_NET_WM_DESKTOP` move, as a pager request so the window manager follows
	/// the user rather than the client.
	pub(super) fn move_to_desktop(&self, window: Window, desktop: u32) -> CoreResult<()> {
		self.send_to_root(window, self.atoms.control.wm_desktop, [desktop, SOURCE_PAGER, 0, 0, 0])
	}

	/// `_NET_CURRENT_DESKTOP` client message. EWMH makes the property
	/// window-manager-owned and requires a client that wants to switch to send
	/// this message, so writing the property is not a desktop switch at all.
	/// `data.l[1]` is the requestor's last user-activity timestamp, stamped
	/// with the current server time so a window manager that compares it does
	/// not treat the request as stale.
	pub(super) fn set_current_desktop(&self, desktop: u32) -> CoreResult<()> {
		let time = self.server_time();
		self.send_to_root(
			// Both the delivery target and event subject identify the root.
			self.root,
			self.atoms.control.current_desktop,
			[desktop, time, 0, 0, 0],
		)
	}

	/// Deliver a 32-bit client message to the root window, where a window
	/// manager listens with `SubstructureRedirect`.
	fn send_to_root(&self, window: Window, type_atom: Atom, data: [u32; 5]) -> CoreResult<()> {
		self.send_client_message(
			self.root,
			EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
			window,
			type_atom,
			data,
		)
	}

	/// Deliver a 32-bit client message straight to a client window, which
	/// selects for it itself.
	pub(super) fn send_to_window(
		&self,
		window: Window,
		type_atom: Atom,
		data: [u32; 5],
	) -> CoreResult<()> {
		self.send_client_message(window, EventMask::NO_EVENT, window, type_atom, data)
	}

	fn send_client_message(
		&self,
		target: Window,
		mask: EventMask,
		window: Window,
		type_atom: Atom,
		data: [u32; 5],
	) -> CoreResult<()> {
		let event = ClientMessageEvent::new(32, window, type_atom, data);
		self
			.conn
			.send_event(false, target, mask, event)
			.map_err(wm_failed)?
			.check()
			.map_err(wm_failed)?;
		self.conn.flush().map_err(wm_failed)
	}
}

/// The user's focus state before a background action.
pub(super) struct FocusSnapshot {
	active: Option<Window>,
	focus:  Window,
}

impl FocusSnapshot {
	pub(super) fn capture(wm: Wm<'_>) -> Self {
		let focus = wm.input_focus().map_or(NONE, |(focus, _)| focus);
		Self { active: wm.active_window(), focus }
	}

	fn changed(&self, wm: Wm<'_>) -> bool {
		wm.active_window() != self.active
			|| wm.input_focus().map(|(focus, _)| focus) != Some(self.focus)
	}

	/// Observe only. Re-activation can raise windows, and the old "focus
	/// bounce" deliberately sent the user's keystrokes to the target for
	/// 60ms. Neither belongs in a background operation. An unrelated focus
	/// change is the user's, not permission to undo it.
	pub(super) fn check(&self, wm: Wm<'_>, target: Window) -> CoreResult<()> {
		let watch_until = Instant::now() + FOCUS_SETTLE_WATCH;
		loop {
			control::check()?;
			if self.changed(wm) {
				let moved_to_target = (self.active != Some(target)
					&& wm.active_window() == Some(target))
					|| (!wm.is_within(self.focus, target)
						&& wm
							.input_focus()
							.is_some_and(|(focus, _)| wm.is_within(focus, target)));
				return if moved_to_target {
					Err(DesktopError::input_failed(format!(
						"window {target} changed the desktop focus during background input; the action \
						 may already have landed, so do not retry blindly; use ax actions or \
						 takeover:true for subsequent input"
					)))
				} else {
					Ok(())
				};
			}
			if Instant::now() >= watch_until {
				return Ok(());
			}
			control::wait(FOCUS_POLL)?;
		}
	}
}

/// `_NET_DESKTOP_NAMES` is one NUL-terminated string per desktop, positional:
/// slot `i` names desktop `i`, and an unnamed desktop is an empty slot rather
/// than a missing one. Dropping empty slots would shift every later name onto
/// the wrong desktop. Only the trailing empty piece produced by the final
/// terminator is not a desktop. The list is read as raw bytes: the property
/// type follows the requesting client's locale, and a name that is not valid
/// UTF-8 still identifies a slot.
pub(super) fn split_desktop_names(value: &[u8]) -> Vec<String> {
	let mut slots: Vec<&[u8]> = value.split(|&byte| byte == 0).collect();
	if slots.last().is_some_and(|last| last.is_empty()) {
		slots.pop();
	}
	slots
		.iter()
		.map(|name| String::from_utf8_lossy(name).into_owned())
		.collect()
}

/// The EWMH property reads behind window discovery and state readback.
impl Wm<'_> {
	pub(super) fn client_list(&self) -> Vec<Window> {
		let atoms = &self.atoms.control;
		let read = |property: Atom| {
			self
				.conn
				.get_property(false, self.root, property, AtomEnum::WINDOW, 0, MAX_CLIENTS as u32)
				.ok()
				.and_then(|cookie| cookie.reply().ok())
				.and_then(|reply| {
					reply
						.value32()
						.map(|values| values.filter(|&window| window != NONE).collect::<Vec<_>>())
				})
		};
		read(atoms.client_list_stacking)
			.or_else(|| read(atoms.client_list))
			.unwrap_or_default()
	}

	/// `_NET_WM_STATE` of a client window. `None` when the property does not
	/// exist at all: that is unknown state, not "no states".
	pub(super) fn net_wm_states(&self, window: Window) -> Option<Vec<Atom>> {
		let reply = self
			.conn
			.get_property(
				false,
				window,
				self.atoms.control.net_wm_state,
				AtomEnum::ATOM,
				0,
				MAX_STATES as u32,
			)
			.ok()?
			.reply()
			.ok()?;
		if reply.type_ == NONE {
			return None;
		}
		Some(
			reply
				.value32()
				.map(|values| values.collect())
				.unwrap_or_default(),
		)
	}

	/// Whether `state` is in the client's `_NET_WM_STATE`.
	pub(super) fn has_net_wm_state(&self, window: Window, state: Atom) -> bool {
		self
			.net_wm_states(window)
			.is_some_and(|states| states.contains(&state))
	}

	/// ICCCM `WM_STATE`: `None` for a window the window manager does not
	/// manage, `3` for an iconified one.
	pub(super) fn wm_normal_state(&self, window: Window) -> Option<u32> {
		let reply = self
			.conn
			.get_property(false, window, self.atoms.wm_state, AtomEnum::ANY, 0, 2)
			.ok()?
			.reply()
			.ok()?;
		reply.value32()?.next()
	}

	/// `_NET_WM_DESKTOP`, `0xFFFFFFFF` meaning "all desktops".
	pub(super) fn wm_desktop(&self, window: Window) -> Option<u32> {
		self
			.conn
			.get_property(false, window, self.atoms.control.wm_desktop, AtomEnum::CARDINAL, 0, 1)
			.ok()?
			.reply()
			.ok()?
			.value32()?
			.next()
	}

	/// `_NET_NUMBER_OF_DESKTOPS` when the window manager publishes desktops.
	pub(super) fn desktop_count(&self) -> Option<u32> {
		self
			.property32(self.root, self.atoms.control.number_of_desktops, AtomEnum::CARDINAL)
			.filter(|&count| count > 0)
	}

	/// `_NET_CURRENT_DESKTOP`.
	pub(super) fn current_desktop(&self) -> Option<u32> {
		self.property32(self.root, self.atoms.control.current_desktop, AtomEnum::CARDINAL)
	}

	/// `_NET_DESKTOP_NAMES`, absent when the window manager names no desktop.
	pub(super) fn desktop_names(&self) -> Option<Vec<String>> {
		let reply = self
			.conn
			.get_property(
				false,
				self.root,
				self.atoms.control.desktop_names,
				AtomEnum::ANY,
				0,
				MAX_CLIENTS as u32,
			)
			.ok()?
			.reply()
			.ok()?;
		(reply.type_ != NONE).then(|| split_desktop_names(&reply.value))
	}

	/// `_NET_WORKAREA` of the current desktop, in x, y, width, height order.
	pub(super) fn work_area(&self) -> Option<Rect> {
		let offset = self.current_desktop()?.checked_mul(4)?;
		let reply = self
			.conn
			.get_property(false, self.root, self.atoms.control.workarea, AtomEnum::CARDINAL, offset, 4)
			.ok()?
			.reply()
			.ok()?;
		let mut values = reply.value32()?;
		work_area_rect([values.next()?, values.next()?, values.next()?, values.next()?])
	}

	fn frame_extents(&self, window: Window) -> CoreResult<[u32; 4]> {
		let missing = || {
			DesktopError::control_failed(format!(
				"X11 window {window} has no complete _NET_FRAME_EXTENTS; client placement is unknown"
			))
		};
		let reply = self
			.conn
			.get_property(false, window, self.atoms.control.frame_extents, AtomEnum::CARDINAL, 0, 4)
			.map_err(wm_failed)?
			.reply()
			.map_err(wm_failed)?;
		let mut values = reply.value32().ok_or_else(missing)?;
		let mut extents = [0; 4];
		for value in &mut extents {
			*value = values.next().ok_or_else(missing)?;
		}
		if values.next().is_some() || reply.bytes_after != 0 {
			return Err(missing());
		}
		Ok(extents)
	}

	/// Client geometry in root coordinates, valid while the window lives.
	pub(super) fn geometry(&self, window: Window) -> CoreResult<Rect> {
		let geometry = self
			.conn
			.get_geometry(window)
			.map_err(wm_failed)?
			.reply()
			.map_err(|_| DesktopError::window_not_found(format!("X11 window {window} is gone")))?;
		let origin = self
			.conn
			.translate_coordinates(window, self.root, 0, 0)
			.map_err(wm_failed)?
			.reply()
			.map_err(|_| {
				DesktopError::control_failed(format!("X11 window {window} has no root position"))
			})?;
		Ok(Rect {
			x:      i32::from(origin.dst_x),
			y:      i32::from(origin.dst_y),
			width:  u32::from(geometry.width),
			height: u32::from(geometry.height),
		})
	}
}

#[cfg(test)]
mod tests {
	use super::{Rect, frame_origin, resize_message, split_desktop_names, work_area_rect};

	/// Desktop names are positional: slot `i` names desktop `i`, so an unnamed
	/// desktop keeps its place and the names after it stay on their own
	/// desktops. Only the terminator's trailing empty piece is not a desktop.
	#[test]
	fn desktop_names_keep_one_slot_per_desktop() {
		assert_eq!(split_desktop_names(b"one\0two\0"), ["one", "two"]);
		assert_eq!(split_desktop_names(b"one\0two"), ["one", "two"]);
		// Desktop 1 is unnamed; "two" is desktop 2, not desktop 1.
		assert_eq!(split_desktop_names(b"one\0\0two\0"), ["one", "", "two"]);
		assert_eq!(split_desktop_names(b"\0"), [""]);
		assert!(split_desktop_names(b"").is_empty());
	}

	#[test]
	fn frame_coordinates_preserve_client_origin_and_reject_overflow() {
		let (x, y) = frame_origin(-120, 140, [4, 7, 24, 9]).expect("decorated client");
		assert_eq!((x + 4, y + 24), (-120, 140));
		assert!(frame_origin(i32::MIN, 140, [1, 0, 0, 0]).is_err());
		assert!(frame_origin(-120, i32::MIN, [0, 0, 1, 0]).is_err());
		assert!(frame_origin(0, 0, [u32::MAX, 0, 0, 0]).is_err());
		assert_eq!(
			frame_origin(i32::MIN, i32::MAX, [0; 4]).expect("borderless client"),
			(i32::MIN, i32::MAX)
		);
	}

	#[test]
	fn resize_keeps_position_and_the_unrequested_axis() {
		// Interpret presence bits as the WM does; ignored words must not
		// overwrite a live origin or the axis the caller left unspecified.
		fn apply(rect: Rect, [flags, x, y, width, height]: [u32; 5]) -> Rect {
			Rect {
				x:      if flags & (1 << 8) != 0 {
					x.cast_signed()
				} else {
					rect.x
				},
				y:      if flags & (1 << 9) != 0 {
					y.cast_signed()
				} else {
					rect.y
				},
				width:  if flags & (1 << 10) != 0 {
					width
				} else {
					rect.width
				},
				height: if flags & (1 << 11) != 0 {
					height
				} else {
					rect.height
				},
			}
		}
		let before = Rect { x: -120, y: 140, width: 480, height: 320 };
		assert_eq!(apply(before, resize_message(Some(640), None)), Rect { width: 640, ..before });
		assert_eq!(apply(before, resize_message(None, Some(360))), Rect { height: 360, ..before });
	}

	/// `_NET_WORKAREA` is `x, y, width, height`. Reading it as width/height
	/// first turns a top-left panel inset into a tiny origin and sends a
	/// centered window into the corner.
	#[test]
	fn work_area_keeps_the_specified_field_order() {
		let inset = work_area_rect([24, 27, 1872, 1013]).expect("panel-inset work area");
		assert_eq!(inset, Rect { x: 24, y: 27, width: 1872, height: 1013 });
		assert_eq!(
			work_area_rect([0, 0, 1920, 1080]),
			Some(Rect { x: 0, y: 0, width: 1920, height: 1080 })
		);
		assert_eq!(work_area_rect([0, 0, 0, 0]), None, "an empty area is no working area");
	}

	/// Centering is the geometry a `centerWindow` request sends: the box lands
	/// mid-area, and a box larger than the area starts at its top-left corner
	/// instead of at a negative offset the X server would refuse.
	#[test]
	fn centering_places_the_window_mid_area() {
		let area = Rect { x: 0, y: 0, width: 1920, height: 1080 };
		assert_eq!(area.center_origin(800, 600), (560, 240));
		let inset = Rect { x: 24, y: 40, width: 1872, height: 1000 };
		assert_eq!(inset.center_origin(400, 400), (760, 340));
		assert_eq!(area.center_origin(2400, 1200), (0, 0));
	}

	/// Moving a window to another display keeps its placement inside the
	/// current one; a window that was never inside a display is centered on the
	/// target instead of landing at the same absolute offset.
	#[test]
	fn display_move_preserves_placement_or_centers() {
		let current = Rect { x: 0, y: 0, width: 1920, height: 1080 };
		let target = Rect { x: 1920, y: 0, width: 1280, height: 1024 };
		let placed = Rect { x: 100, y: 200, width: 800, height: 600 };
		assert_eq!(placed.translated_onto(current, target), Rect {
			x:      2020,
			y:      200,
			width:  800,
			height: 600,
		});

		// A window dragged off every display has no placement to preserve.
		let off_screen = Rect { x: 3000, y: 2000, width: 800, height: 600 };
		assert_eq!(off_screen.translated_onto(current, target), Rect {
			x:      2160,
			y:      212,
			width:  800,
			height: 600,
		});
	}

	/// A window wider than the target display cannot fit, so the clamp keeps
	/// its top-left corner on the display instead of pushing it off-screen.
	#[test]
	fn display_move_clamps_a_window_larger_than_the_target() {
		let current = Rect { x: 0, y: 0, width: 1920, height: 1080 };
		let target = Rect { x: 1920, y: 0, width: 1280, height: 1024 };
		let oversized = Rect { x: 0, y: 0, width: 2000, height: 1200 };
		assert_eq!(oversized.translated_onto(current, target), Rect {
			x:      1920,
			y:      0,
			width:  2000,
			height: 1200,
		});
	}
}
