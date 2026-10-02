//! X11 window control over EWMH and ICCCM.
//!
//! Every operation here is a real protocol route on the session's existing
//! connection: client messages for close, geometry, state and desktops, and
//! property reads for the readbacks. Nothing shells out, nothing synthesizes
//! input, and a client that ignores `WM_DELETE_WINDOW` is left alone rather
//! than killed. An operation is advertised only while the window manager
//! actually publishes the properties it needs.

use std::{
	sync::Arc,
	thread,
	time::{Duration, Instant},
};

use smallvec::{SmallVec, smallvec};
use x11rb::{
	protocol::xproto::{Atom, ConnectionExt, Window},
	rust_connection::RustConnection,
};

use super::{
	capture::X11Capture,
	wm::{Atoms, ControlAtoms, ICONIC_STATE, NORMAL_STATE, Rect, Wm},
};
use crate::desktop::{
	control::ControlAction,
	error::{CoreResult, DesktopError},
	types::{DesktopControlCapabilities, DesktopWindowState, DesktopWorkspace},
};

/// Workspace ids are opaque to callers and stable for the session.
const WORKSPACE_PREFIX: &str = "x11-workspace:";
/// Bound on reported desktops: a window manager advertising an absurd desktop
/// count must not turn one read into an unbounded allocation.
const MAX_DESKTOPS: u32 = 64;
/// How long a desktop switch is watched before an activation follows it, so a
/// window manager that applies `_NET_CURRENT_DESKTOP` asynchronously still
/// accepts the focus request that belongs to the new desktop.
const DESKTOP_SWITCH_WATCH: Duration = Duration::from_millis(250);
const DESKTOP_SWITCH_POLL: Duration = Duration::from_millis(25);

/// The operations this window manager genuinely supports, derived from the
/// EWMH atoms it names in `_NET_SUPPORTED`. Each operation is gated on the
/// exact atoms its own route needs, so a window manager that implements
/// desktops but not `_NET_MOVERESIZE_WINDOW` gets workspace control and no
/// geometry control. An empty support list means nothing EWMH is claimed.
///
/// `focusWindow` and `closeWindow` are always offered because they need no
/// window manager: focus is a core-protocol `SetInputFocus` next to the EWMH
/// activation request, and close is an ICCCM `WM_DELETE_WINDOW` the client
/// itself receives. Close is a request, not a guarantee: a client that does
/// not select for `WM_DELETE_WINDOW` is refused rather than killed, so
/// success means the message reached the client, not that the app closed.
///
/// `toggleWindowedFullscreen`, `setFloating`, `focusDisplay` and
/// `moveWorkspaceToDisplay` are absent for good reason: EWMH has no
/// windowed-fullscreen or floating state, X11 has no monitor focus, and an
/// EWMH desktop spans the whole screen rather than one monitor.
pub(super) fn advertised_operations(
	supported: &[Atom],
	control: &ControlAtoms,
	workspace_count: Option<u32>,
) -> SmallVec<[&'static str; 15]> {
	let has = |atom: Atom| supported.contains(&atom);
	let resize = has(control.move_resize_window);
	let geometry = resize && has(control.frame_extents);
	let maximized = has(control.maximized_vert) && has(control.maximized_horz);
	let workspaces = workspace_count.is_some_and(|count| (1..=MAX_DESKTOPS).contains(&count));
	let mut operations = smallvec!["focusWindow", "closeWindow"];
	if geometry {
		operations.extend(["moveWindow", "moveWindowBy"]);
	}
	if resize {
		operations.push("resizeWindow");
	}
	if geometry {
		operations.push("centerWindow");
	}
	if maximized {
		operations.extend(["maximizeWindow", "toggleMaximized", "restoreWindow"]);
	}
	if has(control.fullscreen) {
		operations.extend(["toggleFullscreen", "setFullscreen"]);
	}
	if has(control.hidden) {
		operations.push("minimizeWindow");
	}
	if workspaces && has(control.wm_desktop) {
		operations.push("moveWindowToWorkspace");
	}
	if workspaces && has(control.current_desktop) {
		operations.push("focusWorkspace");
	}
	if geometry {
		operations.push("moveWindowToDisplay");
	}
	operations
}

/// The `_NET_WM_STATE`/ICCCM readback. A property that does not exist leaves
/// its flag absent: X11 cannot tell "no states" from "not reported", and a
/// missing flag must never read as `false`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct StateFlags {
	pub urgent:     Option<bool>,
	pub maximized:  Option<bool>,
	pub fullscreen: Option<bool>,
	pub minimized:  Option<bool>,
}

/// X11 maximization is two independent atoms, so a window counts as maximized
/// only while both `_NET_WM_STATE_MAXIMIZED_VERT` and
/// `_NET_WM_STATE_MAXIMIZED_HORZ` are set. Minimized is the ICCCM `WM_STATE`
/// iconified flag, which also covers a window manager that does not publish
/// `_NET_WM_STATE_HIDDEN`.
///
/// Every flag mirrors the property's own existence: a client with no
/// `_NET_WM_STATE` reports nothing, because a missing property is unknown
/// state rather than a report that no state is set.
pub(super) fn read_state_flags(
	states: Option<&[Atom]>,
	normal_state: Option<u32>,
	control: &ControlAtoms,
) -> StateFlags {
	let hidden = states.is_some_and(|states| states.contains(&control.hidden));
	StateFlags {
		urgent:     states.map(|states| states.contains(&control.demands_attention)),
		maximized:  states.map(|states| {
			states.contains(&control.maximized_vert) && states.contains(&control.maximized_horz)
		}),
		fullscreen: states.map(|states| states.contains(&control.fullscreen)),
		// ICCCM `WM_STATE` is the authority: iconified is minimized even when
		// the window manager publishes no `_NET_WM_STATE` at all.
		minimized:  normal_state
			.map(|state| state == ICONIC_STATE)
			.or(if hidden { Some(true) } else { None }),
	}
}

pub(super) fn workspace_id(index: u32) -> String {
	format!("{WORKSPACE_PREFIX}{index}")
}

/// Only an id this backend returned is a valid target, so the parse must be
/// canonical: `x11-workspace:0`, no padding, no sign, and inside the range the
/// root window currently advertises.
fn parse_workspace_id(id: &str, desktops: u32) -> CoreResult<u32> {
	let unknown =
		|| DesktopError::invalid_target(format!("workspace {id:?} is not an id from listWorkspaces"));
	let index = id
		.strip_prefix(WORKSPACE_PREFIX)
		.and_then(|rest| rest.parse::<u32>().ok())
		.ok_or_else(unknown)?;
	if workspace_id(index) != id {
		return Err(unknown());
	}
	if index >= desktops {
		return Err(DesktopError::invalid_target(format!(
			"workspace {id} is outside this display's desktop range 0..{desktops}"
		)));
	}
	Ok(index)
}

/// The desktop coordinate space window moves are expressed in.
const COORDINATE_SPACE: &str = "desktop";

pub(super) struct X11Control {
	conn:      Arc<RustConnection>,
	root:      Window,
	root_size: (u32, u32),
	atoms:     Atoms,
}

impl X11Control {
	pub(super) fn new(
		conn: Arc<RustConnection>,
		root: Window,
		root_size: (u32, u32),
	) -> CoreResult<Self> {
		let atoms = Atoms::intern(&conn)?;
		Ok(Self { conn, root, root_size, atoms })
	}

	fn wm(&self) -> Wm<'_> {
		Wm { conn: &self.conn, root: self.root, atoms: &self.atoms }
	}

	/// Advertise exactly what this window manager names in `_NET_SUPPORTED`
	/// right now. A screen with no EWMH window manager, or one that publishes
	/// no support list, falls back to the two routes that need neither:
	/// `focusWindow` and `closeWindow`. The coordinate space is reported only
	/// while `_NET_MOVERESIZE_WINDOW` and `_NET_FRAME_EXTENTS` are supported:
	/// resizing needs no frame origin, but exact placement does.
	pub(super) fn capabilities(&self) -> DesktopControlCapabilities {
		let wm = self.wm();
		let supported = Self::supported(&wm);
		let geometry = supported.contains(&self.atoms.control.move_resize_window)
			&& supported.contains(&self.atoms.control.frame_extents);
		let workspace_count = supported
			.contains(&self.atoms.control.number_of_desktops)
			.then(|| wm.desktop_count())
			.flatten();
		DesktopControlCapabilities {
			backend:                "x11".to_string(),
			operations:             advertised_operations(
				&supported,
				&self.atoms.control,
				workspace_count,
			)
			.into_iter()
			.map(str::to_string)
			.collect(),
			coordinate_space:       geometry.then(|| COORDINATE_SPACE.to_string()),
			// Focus never moves the pointer here: activation is a client message
			// plus a core focus change.
			focus_may_warp_pointer: false,
		}
	}

	/// EWMH desktops of the current window manager, with the window that owns
	/// each one. An X11 desktop spans the whole screen, so it has no display.
	pub(super) fn workspaces(&self) -> CoreResult<Vec<DesktopWorkspace>> {
		let wm = self.wm();
		let control = &self.atoms.control;
		let supported = Self::supported(&wm);
		Self::require(&wm, &supported, "listWorkspaces", &[control.number_of_desktops])?;
		let desktops = wm.desktop_count().ok_or_else(|| {
			DesktopError::control_unsupported(
				"the X11 window manager publishes no _NET_NUMBER_OF_DESKTOPS, so it has no EWMH \
				 desktops",
			)
		})?;
		if desktops > MAX_DESKTOPS {
			return Err(DesktopError::control_failed(format!(
				"the X11 window manager advertises {desktops} desktops; refusing to enumerate more \
				 than {MAX_DESKTOPS}"
			)));
		}
		let current = wm.current_desktop();
		let names = wm.desktop_names().unwrap_or_default();
		let active = wm.active_window();
		let mut topmost = vec![None; desktops as usize];
		let mut urgent = vec![false; desktops as usize];
		for client in wm.client_list().into_iter().rev() {
			let Some(desktop) = wm.wm_desktop(client).filter(|&desktop| desktop < desktops) else {
				continue;
			};
			let slot = desktop as usize;
			topmost[slot] = topmost[slot].or(Some(client));
			urgent[slot] = urgent[slot] || wm.has_net_wm_state(client, control.demands_attention);
		}
		Ok((0..desktops)
			.map(|index| {
				let slot = index as usize;
				let on_current = current == Some(index);
				// The active window of the current desktop is the authoritative
				// one; another desktop has no focus, so its topmost client is the
				// closest thing to an active window.
				let active_window_id = match (on_current, active) {
					(true, Some(window)) if wm.wm_desktop(window).is_none_or(|d| d == index) => {
						Some(window.to_string())
					},
					_ => topmost[slot].map(|window| window.to_string()),
				};
				DesktopWorkspace {
					id: workspace_id(index),
					index,
					// Slots are positional, so index i names desktop i; an
					// empty slot is an unnamed desktop, not a name.
					name: names.get(slot).filter(|name| !name.is_empty()).cloned(),
					display_id: None,
					active: on_current,
					focused: on_current,
					urgent: urgent[slot],
					active_window_id,
				}
			})
			.collect())
	}

	/// A fresh read of one window's control state. Only what the window
	/// manager actually publishes is reported; the rest stays absent.
	pub(super) fn window_state(
		&self,
		capture: &X11Capture,
		id: &str,
	) -> CoreResult<DesktopWindowState> {
		let wm = self.wm();
		let window = Self::window(id)?;
		let descriptor = capture
			.windows()?
			.into_iter()
			.find(|candidate| candidate.id == *id)
			.ok_or_else(|| {
				DesktopError::window_not_found(format!(
					"window {id} is no longer managed by this display"
				))
			})?;
		let flags = read_state_flags(
			wm.net_wm_states(window).as_deref(),
			wm.wm_normal_state(window),
			&self.atoms.control,
		);
		let workspace = wm
			.desktop_count()
			.and_then(|desktops| wm.wm_desktop(window).filter(|&desktop| desktop < desktops))
			.map(workspace_id);
		// A minimized window keeps a stale rectangle; where it will appear when
		// restored is the window manager's business, not a fact to report.
		let display_id = if flags.minimized == Some(true) {
			None
		} else {
			Self::display_of(capture, Rect {
				x:      descriptor.x,
				y:      descriptor.y,
				width:  descriptor.width,
				height: descriptor.height,
			})
		};
		Ok(DesktopWindowState {
			window: descriptor,
			workspace_id: workspace,
			display_id,
			// EWMH has no floating window state to read.
			floating: None,
			urgent: flags.urgent,
			maximized: flags.maximized,
			minimized: flags.minimized,
			fullscreen: flags.fullscreen,
		})
	}

	pub(super) fn run(&self, capture: &X11Capture, action: &ControlAction) -> CoreResult<()> {
		let wm = self.wm();
		let supported = Self::supported(&wm);
		let control = &self.atoms.control;
		match action {
			ControlAction::FocusWindow(id) => {
				// Core-protocol focus next to the EWMH activation request. A
				// window manager with focus-stealing prevention may refuse to
				// raise the window, and nothing here moves the pointer.
				let window = Self::window(id)?;
				wm.request_activation(window, wm.active_window())
			},
			ControlAction::CloseWindow(id) => {
				let window = Self::window(id)?;
				// `WM_DELETE_WINDOW` is an ICCCM request the client itself
				// selects for, so it needs no window manager. Success means the
				// message reached the client, not that the application closed:
				// a client may hold unsaved state and keep running. One that
				// never advertises the protocol would have to be killed, and
				// that never happens here.
				if !wm.advertises(window, control.delete_window) {
					return Err(DesktopError::control_failed(format!(
						"window {id} does not advertise WM_DELETE_WINDOW; it would have to be killed, \
						 so nothing was sent"
					)));
				}
				wm.send_to_window(window, control.wm_protocols, [control.delete_window, 0, 0, 0, 0])
			},
			ControlAction::MoveWindow { id, x, y } => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "moveWindow", &[
					control.move_resize_window,
					control.frame_extents,
				])?;
				wm.move_window(window, origin(*x, "x")?, origin(*y, "y")?)
			},
			ControlAction::MoveWindowBy { id, dx, dy } => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "moveWindowBy", &[
					control.move_resize_window,
					control.frame_extents,
				])?;
				let rect = wm.geometry(window)?;
				wm.move_window(
					window,
					origin(f64::from(rect.x) + *dx, "x")?,
					origin(f64::from(rect.y) + *dy, "y")?,
				)
			},
			ControlAction::ResizeWindow { id, width, height } => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "resizeWindow", &[control.move_resize_window])?;
				wm.resize_window(window, *width, *height)
			},
			ControlAction::CenterWindow(id) => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "centerWindow", &[
					control.move_resize_window,
					control.frame_extents,
				])?;
				let rect = wm.geometry(window)?;
				let (x, y) = self
					.work_area(wm, capture, rect)?
					.center_origin(rect.width, rect.height);
				wm.move_window(window, x, y)
			},
			ControlAction::MaximizeWindow(id) => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "maximizeWindow", &[
					control.maximized_vert,
					control.maximized_horz,
				])?;
				wm.set_net_wm_state(window, &[], &[control.maximized_vert, control.maximized_horz])
			},
			ControlAction::MinimizeWindow(id) => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "minimizeWindow", &[control.hidden])?;
				wm.change_state(window, ICONIC_STATE)
			},
			ControlAction::RestoreWindow(id) => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "restoreWindow", &[
					control.maximized_vert,
					control.maximized_horz,
				])?;
				let flags = read_state_flags(
					wm.net_wm_states(window).as_deref(),
					wm.wm_normal_state(window),
					control,
				);
				if flags.minimized == Some(true) {
					wm.change_state(window, NORMAL_STATE)?;
				}
				wm.set_net_wm_state(
					window,
					&[control.maximized_vert, control.maximized_horz, control.fullscreen],
					&[],
				)
			},
			ControlAction::ToggleMaximized(id) => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "toggleMaximized", &[
					control.maximized_vert,
					control.maximized_horz,
				])?;
				let states = wm.net_wm_states(window).unwrap_or_default();
				let maximized =
					states.contains(&control.maximized_vert) && states.contains(&control.maximized_horz);
				let maximized_atoms = [control.maximized_vert, control.maximized_horz];
				wm.set_net_wm_state(
					window,
					if maximized { &maximized_atoms } else { &[] },
					if maximized { &[] } else { &maximized_atoms },
				)
			},
			ControlAction::ToggleFullscreen(id) => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "toggleFullscreen", &[control.fullscreen])?;
				let states = wm.net_wm_states(window).unwrap_or_default();
				let fullscreen = states.contains(&control.fullscreen);
				let fullscreen_atom = [control.fullscreen];
				wm.set_net_wm_state(
					window,
					if fullscreen { &fullscreen_atom } else { &[] },
					if fullscreen { &[] } else { &fullscreen_atom },
				)
			},
			ControlAction::SetFullscreen { id, enabled } => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "setFullscreen", &[control.fullscreen])?;
				let fullscreen_atom = [control.fullscreen];
				wm.set_net_wm_state(
					window,
					if *enabled { &[] } else { &fullscreen_atom },
					if *enabled { &fullscreen_atom } else { &[] },
				)
			},
			ControlAction::MoveWindowToWorkspace { id, workspace, focus } => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "moveWindowToWorkspace", &[control.wm_desktop])?;
				let desktop = Self::desktop(wm, workspace, "moveWindowToWorkspace")?;
				if *focus && wm.current_desktop() != Some(desktop) {
					// The window follows the user: switch first, so the
					// activation is not rejected for arriving on another desktop.
					wm.set_current_desktop(desktop)?;
					Self::wait_for_desktop(wm, desktop);
				}
				wm.move_to_desktop(window, desktop)?;
				if *focus {
					wm.request_activation(window, wm.active_window())?;
				}
				Ok(())
			},
			ControlAction::FocusWorkspace(workspace) => {
				Self::require(&wm, &supported, "focusWorkspace", &[control.current_desktop])?;
				let desktop = Self::desktop(wm, workspace, "focusWorkspace")?;
				wm.set_current_desktop(desktop)
			},
			ControlAction::MoveWindowToDisplay { id, display } => {
				let window = Self::window(id)?;
				Self::require(&wm, &supported, "moveWindowToDisplay", &[
					control.move_resize_window,
					control.frame_extents,
				])?;
				let rect = wm.geometry(window)?;
				let displays = capture.displays()?;
				let target = displays
					.iter()
					.find(|candidate| candidate.id == *display)
					.ok_or_else(|| {
						DesktopError::invalid_target(format!(
							"display {display} is not an enabled monitor of this screen"
						))
					})?;
				let target = Rect {
					x:      target.x,
					y:      target.y,
					width:  target.width,
					height: target.height,
				};
				// Translate the existing placement instead of stacking every
				// window in a target display's top-left corner.
				let current = displays
					.iter()
					.map(|display| Rect {
						x:      display.x,
						y:      display.y,
						width:  display.width,
						height: display.height,
					})
					.max_by_key(|display| overlap_area(*display, rect))
					.filter(|display| overlap_area(*display, rect) > 0);
				let moved = rect.translated_onto(current.unwrap_or(target), target);
				wm.move_window(window, moved.x, moved.y)
			},
			ControlAction::ToggleWindowedFullscreen(_) => Err(DesktopError::control_unsupported(
				"EWMH has no windowed-fullscreen state; use setFullscreen for a real fullscreen window",
			)),
			ControlAction::SetFloating { .. } => Err(DesktopError::control_unsupported(
				"EWMH has no floating window state to set; window placement belongs to the window \
				 manager",
			)),
			ControlAction::FocusDisplay(_) => Err(DesktopError::control_unsupported(
				"X11 has no monitor focus: focus is per window, use focusWindow or focusWorkspace",
			)),
			ControlAction::MoveWorkspaceToDisplay { .. } => Err(DesktopError::control_unsupported(
				"an X11 EWMH desktop spans the whole screen, so it cannot be bound to one monitor",
			)),
		}
	}

	fn window(id: &str) -> CoreResult<Window> {
		let raw = id
			.parse::<u32>()
			.map_err(|_| DesktopError::window_not_found(format!("invalid X11 window id {id}")))?;
		if raw == 0 {
			return Err(DesktopError::window_not_found(format!("invalid X11 window id {id}")));
		}
		Ok(raw)
	}

	/// The EWMH atoms this window manager claims, empty when no EWMH window
	/// manager owns the screen or it publishes no `_NET_SUPPORTED` list. An
	/// empty claim supports nothing, which is what makes a stale or absent
	/// window manager fail closed instead of advertising routes that do nothing.
	fn supported(wm: &Wm<'_>) -> Vec<Atom> {
		if wm.has_ewmh_wm() {
			wm.supported_atoms()
		} else {
			Vec::new()
		}
	}

	/// Refuse before any side effect unless `supported` names every atom the
	/// route needs. The refusal names the missing atoms, because "unsupported"
	/// without them cannot be acted on.
	fn require(
		wm: &Wm<'_>,
		supported: &[Atom],
		operation: &str,
		required: &[Atom],
	) -> CoreResult<()> {
		if required.iter().all(|atom| supported.contains(atom)) {
			return Ok(());
		}
		let missing = required
			.iter()
			.filter(|atom| !supported.contains(atom))
			.map(|&atom| atom_name(wm.conn, atom))
			.collect::<Vec<_>>()
			.join(", ");
		Err(DesktopError::control_unsupported(format!(
			"{operation} needs a window manager whose _NET_SUPPORTED lists {missing}"
		)))
	}

	/// Center on the window's monitor, with desktop panel reservations clipped
	/// to that monitor rather than centering between multiple monitors.
	fn work_area(&self, wm: Wm<'_>, capture: &X11Capture, window: Rect) -> CoreResult<Rect> {
		let displays = capture.displays()?;
		let display = displays
			.iter()
			.map(|display| Rect {
				x:      display.x,
				y:      display.y,
				width:  display.width,
				height: display.height,
			})
			.max_by_key(|display| overlap_area(*display, window))
			.unwrap_or(Rect {
				x:      0,
				y:      0,
				width:  self.root_size.0,
				height: self.root_size.1,
			});
		Ok(clip_work_area(display, wm.work_area()))
	}

	/// Resolve an id from `listWorkspaces` against the current desktop range.
	fn desktop(wm: Wm<'_>, id: &str, operation: &str) -> CoreResult<u32> {
		let desktops = wm.desktop_count().ok_or_else(|| {
			DesktopError::control_unsupported(format!(
				"{operation} needs EWMH desktops; this window manager publishes no \
				 _NET_NUMBER_OF_DESKTOPS"
			))
		})?;
		parse_workspace_id(id, desktops)
	}

	/// Bounded wait for `_NET_CURRENT_DESKTOP` to take effect. Read-only: a
	/// window manager that ignores the request ends the watch instead of
	/// retrying it.
	fn wait_for_desktop(wm: Wm<'_>, desktop: u32) {
		let deadline = Instant::now() + DESKTOP_SWITCH_WATCH;
		while Instant::now() < deadline {
			match wm.current_desktop() {
				Some(current) if current == desktop => return,
				// No desktop bookkeeping at all: nothing to wait for.
				None => return,
				Some(_) => thread::sleep(DESKTOP_SWITCH_POLL),
			}
		}
	}

	/// The listed monitor a window rectangle belongs to, by overlap. `None`
	/// when it overlaps none, which is a real answer for a window dragged off
	/// every monitor.
	fn display_of(capture: &X11Capture, rect: Rect) -> Option<String> {
		capture
			.displays()
			.ok()?
			.into_iter()
			.map(|display| {
				let area = overlap_area(rect, Rect {
					x:      display.x,
					y:      display.y,
					width:  display.width,
					height: display.height,
				});
				(area, display.id)
			})
			.filter(|(area, _)| *area > 0)
			.max_by_key(|(area, _)| *area)
			.map(|(_, id)| id)
	}
}

/// An atom's name, so a refusal says which EWMH atom is missing instead of
/// leaving the caller to guess.
fn atom_name(conn: &RustConnection, atom: Atom) -> String {
	conn
		.get_atom_name(atom)
		.ok()
		.and_then(|cookie| cookie.reply().ok())
		.map_or_else(
			|| format!("atom {atom}"),
			|reply| String::from_utf8_lossy(&reply.name).into_owned(),
		)
}

/// Overlapping area of two rectangles in desktop pixels. A negative span
/// means the rectangles are disjoint, and a disjoint pair overlaps by zero.
fn overlap_area(a: Rect, b: Rect) -> u64 {
	let width = i64::from(a.right().min(b.right())) - i64::from(a.x.max(b.x));
	let height = i64::from(a.bottom().min(b.bottom())) - i64::from(a.y.max(b.y));
	u64::try_from(width).unwrap_or(0) * u64::try_from(height).unwrap_or(0)
}

fn clip_work_area(display: Rect, work_area: Option<Rect>) -> Rect {
	let Some(area) = work_area else {
		return display;
	};
	let x = display.x.max(area.x);
	let y = display.y.max(area.y);
	let width =
		u32::try_from(i64::from(display.right().min(area.right())) - i64::from(x)).unwrap_or(0);
	let height =
		u32::try_from(i64::from(display.bottom().min(area.bottom())) - i64::from(y)).unwrap_or(0);
	if width == 0 || height == 0 {
		display
	} else {
		Rect { x, y, width, height }
	}
}

/// One desktop-logic coordinate, rounded to the integer grid X11 moves in.
fn origin(value: f64, axis: &str) -> CoreResult<i32> {
	let rounded = value.round();
	if !rounded.is_finite() || rounded < f64::from(i32::MIN) || rounded > f64::from(i32::MAX) {
		return Err(DesktopError::control_failed(format!(
			"window {axis} coordinate {value} is outside the X11 coordinate space"
		)));
	}
	Ok(rounded as i32)
}

#[cfg(test)]
mod tests {
	use x11rb::protocol::xproto::Atom;

	use super::{
		super::wm::{ControlAtoms, Rect},
		MAX_DESKTOPS, advertised_operations, clip_work_area, origin, overlap_area,
		parse_workspace_id, read_state_flags, workspace_id,
	};
	use crate::desktop::error::DesktopError;

	#[test]
	fn centering_keeps_the_window_on_its_monitor_and_outside_panel_reservations() {
		let monitor = Rect { x: -1920, y: 0, width: 1920, height: 1080 };
		let desktop_area = Rect { x: -1920, y: 27, width: 3840, height: 1053 };
		let visible = clip_work_area(monitor, Some(desktop_area));
		assert_eq!(visible.center_origin(800, 600), (-1360, 253));
		let disjoint = Rect { x: 0, ..desktop_area };
		assert_eq!(clip_work_area(monitor, Some(disjoint)), monitor);
		assert_eq!(clip_work_area(monitor, None).center_origin(800, 600), (-1360, 240));
	}

	/// Interned atom ids, so a test can hand the real `_NET_SUPPORTED` and
	/// `_NET_WM_STATE` shapes to the decision code.
	fn atoms() -> ControlAtoms {
		ControlAtoms {
			supporting_wm_check:  10,
			number_of_desktops:   11,
			current_desktop:      12,
			desktop_names:        13,
			workarea:             14,
			wm_desktop:           15,
			net_wm_state:         16,
			maximized_vert:       17,
			maximized_horz:       18,
			fullscreen:           19,
			hidden:               20,
			demands_attention:    21,
			move_resize_window:   22,
			frame_extents:        29,
			client_list:          23,
			client_list_stacking: 24,
			wm_protocols:         25,
			delete_window:        26,
			change_state:         27,
			supported:            28,
		}
	}

	/// Operations X11 has no protocol for, whatever a window manager claims.
	const IMPOSSIBLE: [&str; 4] =
		["toggleWindowedFullscreen", "setFloating", "focusDisplay", "moveWorkspaceToDisplay"];

	/// `_NET_SUPPORTED` is the only evidence of what a window manager
	/// implements, and every operation must be gated on the atoms its own
	/// route sends. A partial implementation that advertises a route anyway
	/// reads as success to every caller while the request goes nowhere.
	#[test]
	fn advertised_operations_follow_the_supported_atom_list() {
		let control = atoms();

		// No window manager, or one that names no support: only the two routes
		// that need neither EWMH nor a reparenting window manager.
		assert_eq!(advertised_operations(&[], &control, Some(4)).as_slice(), [
			"focusWindow",
			"closeWindow"
		]);

		// Geometry support alone must not drag in state or desktop routes.
		let geometry = advertised_operations(
			&[control.move_resize_window, control.frame_extents],
			&control,
			Some(4),
		);
		for offered in
			["moveWindow", "moveWindowBy", "resizeWindow", "centerWindow", "moveWindowToDisplay"]
		{
			assert!(geometry.contains(&offered), "{offered} has all required geometry properties");
		}
		for withheld in
			["maximizeWindow", "minimizeWindow", "focusWorkspace", "moveWindowToWorkspace"]
		{
			assert!(!geometry.contains(&withheld), "{withheld} has no supported atom here");
		}

		// Maximization needs both axes: one supported axis cannot carry a real
		// maximize, so neither toggle nor restore may appear.
		let half =
			[control.maximized_vert, control.fullscreen, control.hidden, control.current_desktop];
		let partial = advertised_operations(&half, &control, Some(4));
		for offered in ["toggleFullscreen", "setFullscreen", "minimizeWindow", "focusWorkspace"] {
			assert!(partial.contains(&offered), "{offered} is fully supported here");
		}
		for withheld in ["maximizeWindow", "toggleMaximized", "restoreWindow"] {
			assert!(!partial.contains(&withheld), "{withheld} needs both maximize axes");
		}

		// Desktop routes stay separate: `_NET_CURRENT_DESKTOP` switches the
		// screen, `_NET_WM_DESKTOP` moves one window.
		assert!(
			advertised_operations(&[control.current_desktop], &control, Some(4))
				.contains(&"focusWorkspace")
		);
		assert!(
			!advertised_operations(&[control.current_desktop], &control, Some(4))
				.contains(&"moveWindowToWorkspace")
		);
		assert!(
			advertised_operations(&[control.wm_desktop], &control, Some(4))
				.contains(&"moveWindowToWorkspace")
		);

		// A complete window manager offers every real route and still nothing
		// X11 has no protocol for.
		let full = [
			control.move_resize_window,
			control.frame_extents,
			control.maximized_vert,
			control.maximized_horz,
			control.fullscreen,
			control.hidden,
			control.wm_desktop,
			control.current_desktop,
		];
		let offered = advertised_operations(&full, &control, Some(4));
		for operation in [
			"focusWindow",
			"closeWindow",
			"moveWindow",
			"moveWindowBy",
			"resizeWindow",
			"centerWindow",
			"moveWindowToDisplay",
			"maximizeWindow",
			"toggleMaximized",
			"restoreWindow",
			"toggleFullscreen",
			"setFullscreen",
			"minimizeWindow",
			"moveWindowToWorkspace",
			"focusWorkspace",
		] {
			assert!(offered.contains(&operation), "{operation} has every atom it needs");
		}
		for operation in IMPOSSIBLE {
			assert!(!offered.contains(&operation), "{operation} is not real on X11");
		}
	}

	#[test]
	fn position_controls_require_reported_frame_extents() {
		let control = atoms();
		let operations = advertised_operations(&[control.move_resize_window], &control, Some(4));
		assert!(operations.contains(&"resizeWindow"));
		for operation in ["moveWindow", "moveWindowBy", "centerWindow", "moveWindowToDisplay"] {
			assert!(!operations.contains(&operation), "{operation} cannot prove a client origin");
		}
	}

	/// A window manager can exit between the capability read and the request.
	/// Once its support list is gone the surface must collapse to the core
	/// routes rather than keep promising state control it no longer has.
	#[test]
	fn losing_the_supported_list_drops_every_ewmh_operation() {
		let control = atoms();
		let running = [control.move_resize_window, control.maximized_vert, control.maximized_horz];
		let gone: &[Atom] = &[];
		assert!(advertised_operations(&running, &control, Some(4)).contains(&"resizeWindow"));
		assert!(advertised_operations(&running, &control, Some(4)).contains(&"maximizeWindow"));
		assert_eq!(advertised_operations(gone, &control, Some(4)).as_slice(), [
			"focusWindow",
			"closeWindow"
		]);
	}
	/// Workspace mutations require ids that discovery can actually enumerate.
	#[test]
	fn workspace_controls_disappear_when_discovery_cannot_return_ids() {
		let control = atoms();
		let supported = [control.current_desktop, control.wm_desktop, control.move_resize_window];
		let at_limit = advertised_operations(&supported, &control, Some(MAX_DESKTOPS));
		assert!(at_limit.contains(&"focusWorkspace"));
		assert!(at_limit.contains(&"moveWindowToWorkspace"));

		let over_limit = advertised_operations(&supported, &control, Some(MAX_DESKTOPS + 1));
		assert!(!over_limit.contains(&"focusWorkspace"));
		assert!(!over_limit.contains(&"moveWindowToWorkspace"));
		assert!(over_limit.contains(&"resizeWindow"), "geometry support is independent");

		let absent = advertised_operations(&supported, &control, None);
		assert!(!absent.contains(&"focusWorkspace"));
		assert!(!absent.contains(&"moveWindowToWorkspace"));
	}

	/// Absent properties are unknown state, not `false`: a client that
	/// publishes no `_NET_WM_STATE` must not read as not fullscreen, not
	/// maximized and not urgent.
	#[test]
	fn state_readback_stays_absent_until_the_window_manager_reports_it() {
		let control = atoms();
		let unknown = read_state_flags(None, None, &control);
		assert_eq!(unknown.urgent, None);
		assert_eq!(unknown.maximized, None);
		assert_eq!(unknown.fullscreen, None, "a missing _NET_WM_STATE is not 'not fullscreen'");
		assert_eq!(unknown.minimized, None);

		let maximized = read_state_flags(
			Some(&[control.maximized_vert, control.maximized_horz]),
			Some(1),
			&control,
		);
		assert_eq!(maximized.maximized, Some(true));
		assert_eq!(maximized.minimized, Some(false));
		assert_eq!(maximized.fullscreen, Some(false));
		assert_eq!(maximized.urgent, Some(false));

		// Half-maximized is not maximized: EWMH tracks the axes separately.
		let half = read_state_flags(Some(&[control.maximized_vert]), Some(1), &control);
		assert_eq!(half.maximized, Some(false));

		// ICCCM `WM_STATE` reports minimization on its own and stays the
		// authority when no `_NET_WM_STATE` exists at all.
		assert_eq!(
			read_state_flags(Some(&[control.hidden]), Some(3), &control).minimized,
			Some(true)
		);
		assert_eq!(read_state_flags(None, Some(3), &control).minimized, Some(true));
		assert_eq!(read_state_flags(None, Some(1), &control).minimized, Some(false));

		// `_NET_WM_STATE` alone cannot say whether a window is iconified.
		let without_wm_state = read_state_flags(Some(&[control.fullscreen]), None, &control);
		assert_eq!(without_wm_state.fullscreen, Some(true));
		assert_eq!(without_wm_state.minimized, None, "no WM_STATE means unknown, not visible");

		let demanding = read_state_flags(
			Some(&[control.demands_attention, control.fullscreen]),
			Some(1),
			&control,
		);
		assert_eq!(demanding.urgent, Some(true));
		assert_eq!(demanding.fullscreen, Some(true));

		// An existing but empty `_NET_WM_STATE` is a report of no states.
		let empty: Vec<Atom> = vec![];
		let reported = read_state_flags(Some(empty.as_slice()), Some(1), &control);
		assert_eq!(reported.maximized, Some(false));
		assert_eq!(reported.fullscreen, Some(false));
		assert_eq!(reported.minimized, Some(false));
		assert_eq!(reported.urgent, Some(false));
	}

	/// Workspace ids are the only accepted target, so a near-miss must fail
	/// instead of silently hitting a different desktop.
	#[test]
	fn workspace_ids_must_be_canonical_and_in_range() {
		assert_eq!(workspace_id(2), "x11-workspace:2");
		assert_eq!(parse_workspace_id("x11-workspace:3", 4).expect("id from listWorkspaces"), 3);
		for rejected in [
			"x11-workspace:4",
			"x11-workspace:",
			"x11-workspace:-1",
			"x11-workspace:03",
			"x11-workspace:+1",
			"x11-workspace: 1",
			"x11-workspace:1.0",
			"workspace:1",
			"2",
			"1",
		] {
			let error = parse_workspace_id(rejected, 4).expect_err("not an id from listWorkspaces");
			assert_eq!(error.code, DesktopError::invalid_target("").code, "{rejected}");
		}
	}

	/// Screen coordinates must land on the X11 pixel grid and stay inside the
	/// signed 32-bit protocol range.
	#[test]
	fn move_coordinates_round_and_stay_in_range() {
		assert_eq!(origin(10.4, "x").expect("pixel grid"), 10);
		assert_eq!(origin(-3.5, "y").expect("pixel grid"), -4);
		let error = origin(1e30, "x").expect_err("outside the X11 coordinate space");
		assert_eq!(error.code, DesktopError::control_failed("").code);
		assert!(origin(f64::NAN, "y").is_err(), "the parser rejects this first");
	}

	/// Display membership decides which monitor a window belongs to, so a
	/// window on a second display must not be attributed to the first.
	#[test]
	fn display_membership_uses_real_overlap() {
		let primary = Rect { x: 0, y: 0, width: 1920, height: 1080 };
		let secondary = Rect { x: 1920, y: 0, width: 1280, height: 1024 };
		let on_secondary = Rect { x: 2000, y: 100, width: 800, height: 600 };
		assert_eq!(overlap_area(primary, on_secondary), 0);
		assert_eq!(overlap_area(secondary, on_secondary), 800 * 600);
		let straddling = Rect { x: 1800, y: 100, width: 400, height: 200 };
		assert_eq!(overlap_area(primary, straddling), 120 * 200);
		assert_eq!(overlap_area(secondary, straddling), 280 * 200);
	}
}
