mod capture;
mod geometry;
mod libei;
mod niri;
mod pipewire;
mod portal;
mod xkb;
mod xwayland;

use std::{cell::OnceCell, os::fd::AsRawFd, path::PathBuf};

use geometry::PortalGeometry;
use image::RgbaImage;

use crate::desktop::{
	ax::AxHandle,
	backend::{AxBackend, Backend, DeliveryMode, ElementDelivery, ElementInput, PointerEvent},
	control::{self, ControlAction, OperationToken},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	linux::ax::{self, AtSpiAx, AtSpiWindow, TextRoute, resolve_focus},
	types::{
		CaptureCaps, DesktopCapabilities, DesktopControlCapabilities, DesktopDisplay, DesktopWindow,
		DesktopWindowState, DesktopWorkspace, DisplaySelector, Target,
	},
};

/// Every window niri reports, or `None` without a readable niri.
///
/// AT-SPI uses it to prove that an accessibility connection serves exactly
/// one window before it accepts a frame without the window's title as it.
pub(super) fn compositor_windows() -> Option<Vec<DesktopWindow>> {
	niri::windows()
		.ok()
		.flatten()
		.map(|windows| windows.into_iter().map(|entry| entry.window).collect())
}

pub struct WaylandBackend {
	display:           DisplaySelector,
	pipewire:          pipewire::Loaded,
	ax:                Option<AtSpiAx>,
	ax_error:          Option<DesktopError>,
	input:             Option<libei::Libei>,
	/// Why native input can never work here, probed once without a prompt;
	/// `None` when it may.
	input_unavailable: OnceCell<Option<String>>,
	displays:          Vec<DesktopDisplay>,
	/// The PID that listens on the Wayland socket: gnome-shell on GNOME, whose
	/// own AT-SPI frames never count as the focused application window. On
	/// Plasma it is `kwin_wayland_wrapper`, which owns no frames.
	compositor_pid:    Option<u32>,
	/// Bus names of the applications that did not answer the last window
	/// listing, whose windows it therefore left out.
	unanswered:        Vec<String>,
}

/// Reads the compositor's PID from niri IPC or from peer credentials of the
/// Wayland socket.
pub(super) fn compositor_pid() -> Option<u32> {
	if let Ok(pid) = niri::compositor_pid() {
		return Some(pid);
	}
	let display = PathBuf::from(std::env::var_os("WAYLAND_DISPLAY")?);
	let path = if display.is_absolute() {
		display
	} else {
		PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?).join(display)
	};
	let socket = super::connect_compositor(&path).ok()?;
	let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
	let mut length = size_of::<libc::ucred>() as libc::socklen_t;
	// SAFETY: `credentials` and `length` are live, correctly sized out-params
	// for SO_PEERCRED on a connected Unix socket; the kernel keeps no pointer.
	let status = unsafe {
		libc::getsockopt(
			socket.as_raw_fd(),
			libc::SOL_SOCKET,
			libc::SO_PEERCRED,
			(&raw mut credentials).cast(),
			&raw mut length,
		)
	};
	(status == 0 && credentials.pid > 0).then_some(credentials.pid as u32)
}

impl WaylandBackend {
	pub fn new(display: DisplaySelector) -> Self {
		// Remove the world-readable RemoteDesktop restore token that pre-#7884
		// builds wrote during read-only calls; nothing reads it anymore (#7884).
		portal::remove_orphaned_remote_desktop_token();
		let (ax, ax_error) = match AtSpiAx::new() {
			Ok(ax) => (Some(ax), None),
			Err(err) => (None, Some(err)),
		};
		let mut displays = niri::displays().ok().flatten().unwrap_or_default();
		if !displays.is_empty() && geometry::layout(&mut displays).is_err() {
			displays.clear();
		}
		if let DisplaySelector::Id(id) = &display {
			displays.retain(|d| &d.id == id || &d.name == id);
			if !displays.is_empty() {
				let _ = geometry::layout(&mut displays);
			}
		}
		Self {
			display,
			pipewire: pipewire::library(),
			ax,
			ax_error,
			input: None,
			input_unavailable: OnceCell::new(),
			displays,
			compositor_pid: compositor_pid(),
			unanswered: Vec::new(),
		}
	}

	/// Read on every call: a `LIBEI_SOCKET` set later in the session reaches
	/// EIS directly, whatever the cached portal probe found.
	fn input_unavailable(&self) -> Option<&str> {
		if std::env::var_os("LIBEI_SOCKET").is_some() {
			return None;
		}
		self
			.input_unavailable
			.get_or_init(portal::input_unavailable_reason)
			.as_deref()
	}

	fn window_input_error(target: &Target, kind: &str) -> CoreResult<()> {
		if let Target::Window(id) = target {
			return Err(DesktopError::background_unavailable(format!(
				"window {id} wayland-compositor-focus-only: Wayland cannot programmatically activate \
				 a non-focused window for {kind}; only the currently focused surface is reachable; \
				 use ax actions or desktop input"
			)));
		}
		Ok(())
	}

	fn run_input(
		&mut self,
		target: &Target,
		kind: &str,
		action: impl FnOnce(&mut libei::Libei) -> CoreResult<()>,
	) -> CoreResult<()> {
		control::check()?;
		Self::window_input_error(target, kind)?;
		self.refuse_input()?;
		if self.input.is_none() {
			self.input = Some(libei::Libei::new()?);
		}
		let input = self.input.as_mut().expect("libei was initialized");
		let result = action(input);
		if input.disconnected() {
			self.input = None;
		}
		result
	}

	fn atspi_windows(&mut self) -> CoreResult<Vec<AtSpiWindow>> {
		let listed = self
			.ax
			.as_ref()
			.ok_or_else(|| {
				self
					.ax_error
					.clone()
					.unwrap_or_else(DesktopError::ax_unsupported)
			})?
			.windows()?;
		self.unanswered = listed.unanswered;
		Ok(listed.windows)
	}
}

impl Backend for WaylandBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let input_unavailable = self.input.is_none() && self.input_unavailable().is_some();
		let input_permission = if self.input.is_some() {
			"granted"
		} else if input_unavailable {
			"unavailable"
		} else {
			"prompt-or-granted"
		};
		DesktopCapabilities {
			backend: "wayland".to_string(),
			display_server: Some("wayland".to_string()),
			// Without libpipewire the addon still loads, but capture() fails, so
			// the report must not advertise it.
			capture: self.pipewire.is_ok(),
			input: !input_unavailable,
			ax: self.ax.is_some(),
			background_window_input: false,
			takeover: false,
			applications: crate::desktop::applications::supported(),
			menus: self.ax.is_some(),
			held_input: !input_unavailable,
			secure_input: false,
			secure_input_app: None,
			spaces: false,
			global_escape: false,
			capture_permission: if self.pipewire.is_ok() {
				"prompt-or-granted".to_string()
			} else {
				"unavailable".to_string()
			},
			input_permission: input_permission.to_string(),
			ax_permission: if self.ax.is_some() {
				"granted".to_string()
			} else {
				"unavailable".to_string()
			},
			display_count: self.displays.len() as u32,
			// The live window-control surface is attached centrally from
			// `Backend::control_capabilities`, which probes niri itself.
			window_control: None,
			screen_locked: false,
			display_asleep: false,
		}
	}

	fn refuse_input(&mut self) -> CoreResult<()> {
		if self.input.is_some() {
			return Ok(());
		}
		self
			.input_unavailable()
			.map_or(Ok(()), |reason| Err(DesktopError::permission_denied(reason)))
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		Ok(self.displays.clone())
	}

	fn validate_frame_layout(&mut self, frame: &FrameGeometry) -> CoreResult<()> {
		control::check()?;
		// A niri window frame is the compositor's render of that window; no
		// monitor stream backs it, so refreshing portal geometry would only ask
		// for monitor consent the frame never needed.
		if !frame.display_bound() {
			return Ok(());
		}
		// ScreenCast exposes geometry only when opening a stream. Enumeration can
		// use the last snapshot, but coordinate delivery needs fresh bounds.
		let geometry = capture::geometry(self.pipewire);
		control::check()?;
		let geometry = geometry.map_err(|error| {
			DesktopError::invalid_coordinate_frame(format!(
				"could not refresh Wayland display geometry: {error}"
			))
		})?;
		let known = niri::displays().ok().flatten().unwrap_or_default();
		self.displays = geometry::fresh_layout(&geometry, &known)?;
		frame.validate_layout(&self.displays)
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		// niri is the authority on what is open, but its IPC is optional
		// metadata for a listing: a restarting compositor leaves a
		// `$NIRI_SOCKET` that no longer connects, and that must degrade to the
		// accessibility listing instead of failing every window query.
		if let Ok(Some(windows)) = niri::windows() {
			return Ok(windows.into_iter().map(|entry| entry.window).collect());
		}
		let mut windows = self.atspi_windows()?;
		if let Some(ax) = self.ax.as_ref() {
			resolve_focus(&mut windows, self.compositor_pid, !self.unanswered.is_empty(), |window| {
				ax.holds_focus(window)
			});
		}
		Ok(windows.into_iter().map(|entry| entry.window).collect())
	}

	fn missing_window(&self, target: &Target) -> Option<DesktopError> {
		// Window ids are `atspi:{bus name}:{object path}`.
		let skipped = match target {
			Target::Window(id) => {
				let bus = id.strip_prefix("atspi:")?.split_once(":/")?.0;
				self.unanswered.iter().any(|name| name == bus)
			},
			Target::Desktop | Target::Display(_) => !self.unanswered.is_empty(),
		};
		skipped.then(ax::not_answering)
	}

	/// Reads the unresolved list. A native app's frame has no known position,
	/// so it must keep failing this check until the real outputs are counted;
	/// resolving focus here would refuse GNOME display typing that `main` allows
	/// through the shell frame, or, with a one-monitor shortcut, type on a
	/// monitor the agent cannot see.
	fn focused_keyboard_window(&mut self) -> CoreResult<DesktopWindow> {
		let entry = self
			.atspi_windows()?
			.into_iter()
			.find(|entry| entry.window.focused)
			.ok_or_else(|| {
				self.missing_window(&Target::Desktop).unwrap_or_else(|| {
					DesktopError::invalid_target("no focused Wayland window was found")
				})
			})?;
		if !entry.position_known {
			return Err(DesktopError::invalid_target(
				"the focused Wayland surface has no known global position; cannot safely target \
				 display keyboard input",
			));
		}
		Ok(entry.window)
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		if let Target::Window(id) = target
			&& id.starts_with(niri::ID_PREFIX)
		{
			let (image, window) = niri::capture_window(self.pipewire, id)?;
			let frame = FrameGeometry::for_compositor_window(&window, image.width(), image.height());
			return Ok((image, frame));
		}
		// The portal reports the authorized stream geometry. Use niri only
		// to enrich display names and match known monitors.
		let known = niri::displays().ok().flatten().unwrap_or_default();
		let frames = capture::capture(self.pipewire)?;
		self.displays = geometry::metadata(&frames, &known)?;
		let explicit = target.display_selector();
		let selected = selector
			.or(explicit.as_ref())
			.unwrap_or(&self.display)
			.clone();
		match target {
			Target::Desktop | Target::Display(_) => {
				let (image, displays) = geometry::compose(frames, &selected, &known)?;
				let frame = FrameGeometry::for_displays(&displays);
				Ok((image, frame))
			},
			Target::Window(id) => {
				let entry = self
					.atspi_windows()?
					.into_iter()
					.find(|entry| &entry.window.id == id)
					.ok_or_else(|| {
						self.missing_window(target).unwrap_or_else(|| {
							DesktopError::window_not_found(format!("Wayland window {id} not found"))
						})
					})?;
				if !entry.position_known {
					return Err(DesktopError::capture_failed(format!(
						"Wayland window {id} has no known screen position; native compositor capture is \
						 unavailable"
					)));
				}
				let mut best = None;
				for ((image, geometry), display) in frames.iter().zip(&self.displays) {
					if matches!(&selected, DisplaySelector::Id(id) if id != &display.id && id != &display.name)
					{
						continue;
					}
					let Ok(crop) = geometry.window_crop(&entry) else { continue };
					// Prefer a complete crop even when an earlier stream contains a part.
					if (crop.part.2, crop.part.3) == (entry.window.width, entry.window.height) {
						best = Some((image, crop));
						break;
					}
					best.get_or_insert((image, crop));
				}
				let (image, crop) = best.ok_or_else(|| {
					DesktopError::capture_failed(format!(
						"Wayland window {id} is outside the selected authorized monitor streams"
					))
				})?;
				let (x, y, width, height) = crop.pixels;
				let cropped = image::imageops::crop_imm(image, x, y, width, height).to_image();
				let frame = FrameGeometry::for_window_part(&entry.window, crop.part, width, height);
				Ok((cropped, frame))
			},
		}
	}

	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		_frame: &FrameGeometry,
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "pointer input", |input| input.pointer(ev))
	}

	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "keyboard input", |input| input.type_text(text))
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "keyboard input", |input| input.key_chord(keys))
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: std::time::Duration,
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		self.run_input(target, "held keyboard input", |input| input.hold_keys(keys, duration))
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<crate::desktop::menus::DesktopMenuItem>> {
		super::menus::items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		super::menus::select(window, path)
	}

	/// Text goes in through the element's AT-SPI text interface, which needs
	/// neither focus nor keys. Anything else is refused before anything
	/// reaches the element's app: the default focuses the element and then
	/// sends through its window's keyboard path, which Wayland always refuses,
	/// so the refused call still moved focus inside that app (GNOME announced
	/// "… is ready").
	fn element_input(
		&mut self,
		element: &AxHandle,
		input: &ElementInput,
		_mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		token.check()?;
		let route = match (input, &self.ax) {
			(ElementInput::Text(text), Some(ax)) => Some(ax.type_text(element, text)?),
			(ElementInput::Text(_), None) => Some(TextRoute::Absent),
			(ElementInput::Chord(_), _) => None,
		};
		element_input_outcome(route)
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		if id.starts_with(niri::ID_PREFIX) && niri::compatible() {
			return niri::focus(id);
		}
		Err(DesktopError::background_unavailable(format!(
			"window {id} wayland-compositor-focus-only: Wayland cannot programmatically activate a \
			 non-focused window; only the currently focused surface is reachable"
		)))
	}

	fn control_capabilities(&mut self) -> DesktopControlCapabilities {
		niri::control_capabilities()
	}

	fn control(&mut self, action: &ControlAction) -> CoreResult<()> {
		niri::control(action)
	}

	fn workspaces(&mut self) -> CoreResult<Vec<DesktopWorkspace>> {
		niri::workspaces()
	}

	fn window_state(&mut self, id: &str) -> CoreResult<DesktopWindowState> {
		niri::window_state(id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}

/// What `el.type` gets on Wayland from the element's AT-SPI text `route`, or
/// `el.press(keys)` when there is none: only inserted text goes in, since keys
/// need the element's window focused, which Wayland leaves to the user.
fn element_input_outcome(route: Option<TextRoute>) -> CoreResult<ElementDelivery> {
	Err(DesktopError::background_unavailable(match route {
		Some(TextRoute::Inserted) => return Ok(ElementDelivery::Delivered),
		Some(TextRoute::Declined(why)) => format!(
			"wayland-compositor-focus-only: Wayland cannot programmatically activate the element's \
			 window, and its accessibility text route was not used, since {why}, so el.type is \
			 refused before the element is focused; nothing was sent. Click the field where a \
			 desktop screenshot shows it (AX bounds are window-relative here) and then type with \
			 desktop input"
		),
		Some(TextRoute::Absent) => "wayland-compositor-focus-only: Wayland cannot programmatically \
		                            activate the element's window, and the element took no text \
		                            through its AT-SPI text interface, so el.type is refused before \
		                            the element is focused; nothing was sent. Use setValue, or \
		                            click the field where a desktop screenshot shows it (AX bounds \
		                            are window-relative here) and then type with desktop input"
			.to_owned(),
		None => "wayland-compositor-focus-only: Wayland cannot programmatically activate the \
		         element's window, so el.type and el.press(keys) are refused before the element is \
		         focused; nothing was sent. Use setValue, or click the field where a desktop \
		         screenshot shows it (AX bounds are window-relative here) and then type with \
		         desktop input"
			.to_owned(),
	}))
}

#[cfg(test)]
mod tests {
	use std::{
		io::ErrorKind,
		os::unix::net::UnixListener,
		panic::{AssertUnwindSafe, catch_unwind},
		sync::{Mutex, mpsc},
		thread,
	};

	use super::*;

	/// Serializes the tests that move process-global environment variables.
	///
	/// `NIRI_SOCKET` is moved by the niri compositor tests too, and two threads
	/// racing on it would read each other's socket.
	pub(super) static ENV_LOCK: Mutex<()> = Mutex::new(());

	fn backend_without_services() -> WaylandBackend {
		WaylandBackend {
			display:           DisplaySelector::All,
			pipewire:          Err("libpipewire-0.3.so.0 could not be loaded (not installed)"),
			ax:                None,
			ax_error:          None,
			input:             None,
			input_unavailable: OnceCell::from(None),
			displays:          Vec::new(),
			compositor_pid:    None,
			unanswered:        Vec::new(),
		}
	}
	/// Holds `ENV_LOCK` with `LIBEI_SOCKET` set to a test's value (removed
	/// for `None`) and puts the previous value back when dropped, also while a
	/// failing test unwinds, so no later test sees a leaked value.
	struct LibeiSocket {
		previous: Option<std::ffi::OsString>,
		_lock:    std::sync::MutexGuard<'static, ()>,
	}

	impl LibeiSocket {
		fn set(value: Option<&std::ffi::OsStr>) -> Self {
			let lock = ENV_LOCK
				.lock()
				.unwrap_or_else(std::sync::PoisonError::into_inner);
			let previous = std::env::var_os("LIBEI_SOCKET");
			// SAFETY: ENV_LOCK is held, and every test that writes
			// LIBEI_SOCKET or asserts on what it reads takes it first; std
			// serializes the other env reads.
			unsafe {
				match value {
					Some(value) => std::env::set_var("LIBEI_SOCKET", value),
					None => std::env::remove_var("LIBEI_SOCKET"),
				}
			}
			Self { previous, _lock: lock }
		}
	}

	impl Drop for LibeiSocket {
		fn drop(&mut self) {
			// SAFETY: as in `set`; the lock field is released only after this
			// body.
			unsafe {
				match self.previous.take() {
					Some(previous) => std::env::set_var("LIBEI_SOCKET", previous),
					None => std::env::remove_var("LIBEI_SOCKET"),
				}
			}
		}
	}

	#[test]
	fn a_window_of_an_application_that_did_not_answer_reports_the_timeout() {
		use crate::desktop::error::ErrorCode;
		let code = |backend: &WaylandBackend, target: &str| {
			backend
				.missing_window(&Target::parse(target))
				.map(|error| error.code)
		};
		let mut backend = backend_without_services();
		backend.unanswered = vec![":1.8".to_owned()];
		assert_eq!(
			code(&backend, "atspi::1.8:/org/a11y/atspi/accessible/2"),
			Some(ErrorCode::Timeout)
		);
		assert_eq!(code(&backend, "atspi::1.7:/org/a11y/atspi/accessible/2"), None);
		assert_eq!(
			backend
				.missing_window(&Target::Desktop)
				.map(|error| error.code),
			Some(ErrorCode::Timeout)
		);
		backend.unanswered.clear();
		assert_eq!(code(&backend, "atspi::1.8:/org/a11y/atspi/accessible/2"), None);
		assert_eq!(
			backend
				.missing_window(&Target::Desktop)
				.map(|error| error.code),
			None
		);
	}
	fn with_fake_libei(action: impl FnOnce(&mut WaylandBackend)) -> bool {
		let socket = std::env::temp_dir().join(format!("omp-libei-test-{}", std::process::id()));
		let _env = LibeiSocket::set(Some(socket.as_os_str()));
		let _ = std::fs::remove_file(&socket);
		let listener = UnixListener::bind(&socket).expect("bind fake libei socket");
		listener
			.set_nonblocking(true)
			.expect("make fake libei socket nonblocking");
		let (stop_tx, stop_rx) = mpsc::channel();
		let accepted = thread::spawn(move || {
			loop {
				match listener.accept() {
					Ok(_) => return true,
					Err(err) if err.kind() == ErrorKind::WouldBlock => {
						if !matches!(
							stop_rx.recv_timeout(std::time::Duration::from_millis(10)),
							Err(mpsc::RecvTimeoutError::Timeout)
						) {
							return false;
						}
					},
					Err(err) => panic!("fake libei listener: {err}"),
				}
			}
		});
		let previous_bus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS");
		let previous_niri = std::env::var_os("NIRI_SOCKET");
		// This input contract must not depend on the user's live AX or compositor
		// services.
		unsafe {
			std::env::set_var("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent-omp-test-bus");
			std::env::remove_var("NIRI_SOCKET");
		}
		let outcome = catch_unwind(AssertUnwindSafe(|| {
			let mut backend = WaylandBackend::new(DisplaySelector::All);
			action(&mut backend);
		}));
		let _ = stop_tx.send(());
		for (name, value) in
			[("DBUS_SESSION_BUS_ADDRESS", previous_bus), ("NIRI_SOCKET", previous_niri)]
		{
			unsafe {
				if let Some(value) = value {
					std::env::set_var(name, value);
				} else {
					std::env::remove_var(name);
				}
			}
		}
		let connected = accepted.join().expect("fake libei listener");
		let _ = std::fs::remove_file(socket);
		drop(_env);
		if let Err(payload) = outcome {
			std::panic::resume_unwind(payload);
		}
		connected
	}

	/// A `$NIRI_SOCKET` left behind by a compositor that already exited: the
	/// path is set, so niri attempts the IPC and the connect fails the way a
	/// restarting compositor's does. The accessibility bus is unreachable too,
	/// so the fallback listing is what decides the outcome.
	fn with_unreachable_compositor(action: impl FnOnce(&mut WaylandBackend)) {
		let guard = ENV_LOCK.lock().expect("lock the compositor environment");
		let previous_bus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS");
		let previous_niri = std::env::var_os("NIRI_SOCKET");
		unsafe {
			std::env::set_var("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent-omp-test-bus");
			std::env::set_var("NIRI_SOCKET", "/nonexistent-omp-test-niri.sock");
		}
		let mut backend = WaylandBackend::new(DisplaySelector::All);
		// A failing assertion must not leave the process-global environment
		// pointing at this test, so the callback is contained and the panic is
		// resumed only after both variables are back.
		let outcome = catch_unwind(AssertUnwindSafe(|| action(&mut backend)));
		for (name, value) in
			[("DBUS_SESSION_BUS_ADDRESS", previous_bus), ("NIRI_SOCKET", previous_niri)]
		{
			unsafe {
				if let Some(value) = value {
					std::env::set_var(name, value);
				} else {
					std::env::remove_var(name);
				}
			}
		}

		// The lock is released before the panic resumes, so one failed assertion
		// cannot poison it for the other tests that move the same variables.
		drop(guard);

		if let Err(payload) = outcome {
			std::panic::resume_unwind(payload);
		}
	}

	#[test]
	fn readonly_backend_creation_does_not_connect_to_libei() {
		let mut capabilities = None;
		let connected = with_fake_libei(|backend| capabilities = Some(backend.capabilities()));
		assert!(!connected, "read-only backend construction connected to libei");
		let capabilities = capabilities.expect("Wayland capabilities");
		assert!(capabilities.input);
		assert_eq!(capabilities.input_permission, "prompt-or-granted");
	}

	/// Runs `action` with `LIBEI_SOCKET` unset, under the same lock as
	/// `with_fake_libei`: `input_unavailable` reads the variable on every call,
	/// so a fake socket from a test on another thread would otherwise report
	/// input as reachable.
	fn without_libei_socket(action: impl FnOnce()) {
		let _env = LibeiSocket::set(None);
		let outcome = catch_unwind(AssertUnwindSafe(action));
		drop(_env);
		if let Err(payload) = outcome {
			std::panic::resume_unwind(payload);
		}
	}

	#[test]
	fn a_desktop_without_a_remote_desktop_portal_reports_and_refuses_input() {
		without_libei_socket(|| {
			let mut backend = backend_without_services();
			backend.input_unavailable = OnceCell::from(Some("no RemoteDesktop portal".to_owned()));
			let capabilities = backend.capabilities();
			assert!(!capabilities.input);
			assert!(!capabilities.held_input);
			assert_eq!(capabilities.input_permission, "unavailable");
			let source = control::CancellationSource::default();
			let error = backend
				.type_text(&Target::Desktop, "x", DeliveryMode::Foreground, &source.token())
				.unwrap_err();
			assert_eq!(error.code.as_str(), "PermissionDenied");
			assert!(error.message.contains("no RemoteDesktop portal"), "{}", error.message);
			assert!(backend.input.is_none());
		});
	}

	#[test]
	fn unreachable_niri_ipc_falls_back_to_the_accessibility_listing() {
		with_unreachable_compositor(|backend| {
			// The compositor socket cannot be connected to, so it cannot answer
			// the inventory. That IPC is optional metadata: the listing has to
			// reach the accessibility fallback and report what went wrong there
			// instead of the compositor's connect failure.
			let err = backend
				.windows()
				.expect_err("the fallback listing has no accessibility bus to answer it");
			assert_eq!(err.code.as_str(), "AxFailed");
		});
	}

	#[test]
	fn desktop_input_connects_to_libei_lazily() {
		let connected = with_fake_libei(|backend| {
			let _ = backend.type_text(
				&Target::Desktop,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			);
		});
		assert!(connected, "desktop input did not connect to libei");
	}

	/// A probe that already found no portal must not hide an EIS socket set
	/// later in the session.
	#[test]
	fn a_socket_set_after_the_portal_probe_still_reaches_libei() {
		let connected = with_fake_libei(|backend| {
			backend.input_unavailable = OnceCell::from(Some("no RemoteDesktop portal".to_owned()));
			assert!(backend.capabilities().input);
			let _ = backend.type_text(
				&Target::Desktop,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			);
		});
		assert!(connected, "a cached portal absence blocked the LIBEI_SOCKET route");
	}

	#[test]
	fn failed_input_request_allows_another_connection_attempt() {
		let connected = with_fake_libei(|backend| {
			let socket = std::env::var_os("LIBEI_SOCKET").expect("fake libei socket");
			unsafe {
				std::env::set_var(
					"LIBEI_SOCKET",
					std::path::Path::new(&socket).with_extension("missing"),
				)
			};
			let first = backend
				.type_text(
					&Target::Desktop,
					"hello",
					DeliveryMode::Foreground,
					&control::CancellationSource::default().token(),
				)
				.expect_err("missing socket must fail");
			assert_eq!(first.code.as_str(), "PermissionDenied");
			let caps = backend.capabilities();
			assert!(caps.input);
			assert_eq!(caps.input_permission, "prompt-or-granted");
			unsafe { std::env::set_var("LIBEI_SOCKET", socket) };
			let _ = backend.type_text(
				&Target::Desktop,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			);
		});
		assert!(connected, "a failed input request prevented the next connection attempt");
	}

	#[test]
	fn display_enumeration_preserves_last_capture_snapshot() {
		let mut backend = backend_without_services();
		backend
			.displays
			.push(PortalGeometry::new(None, None, 1920, 1080).display(0, &[]));
		let displays = backend.displays().unwrap();
		assert_eq!(displays.len(), 1);
		assert_eq!((displays[0].width, displays[0].height), (1920, 1080));
	}

	#[test]
	fn display_validation_never_trusts_cached_portal_geometry() {
		let mut backend = backend_without_services();
		backend
			.displays
			.push(PortalGeometry::new(None, None, 1920, 1080).display(0, &[]));
		let frame = FrameGeometry::for_displays(&backend.displays);
		let error = backend.validate_frame_layout(&frame).unwrap_err();
		assert_eq!(error.code.as_str(), "InvalidCoordinateFrame");
	}

	/// The refusal comes before any AT-SPI call: the default path's first step,
	/// the window lookup, would fail `AxUnsupported` here instead, and its next
	/// step focuses the element.
	#[test]
	fn element_input_is_refused_before_anything_reaches_the_app() {
		let mut backend = backend_without_services();
		let source = control::CancellationSource::default();
		for input in [ElementInput::Text("zz".into()), ElementInput::Chord(vec![KeyName::Enter])] {
			let error = backend
				.element_input(&AxHandle::Test(1), &input, DeliveryMode::Foreground, &source.token())
				.err()
				.expect("Wayland element input is refused");
			assert_eq!(error.code.as_str(), "BackgroundUnavailable");
			assert!(error.message.contains("nothing was sent"), "{}", error.message);
		}
		assert!(backend.input.is_none());
	}

	#[test]
	fn cancelled_mutations_stop_before_initializing_input() {
		let mut backend = backend_without_services();
		let source = control::CancellationSource::default();
		let token = source.token();
		source.cancel();
		assert!(
			backend
				.type_text(&Target::Desktop, "hello", DeliveryMode::Foreground, &token)
				.is_err()
		);
		assert!(backend.input.is_none());
		assert!(
			backend
				.key_chord(&Target::Desktop, &[KeyName::Enter], DeliveryMode::Foreground, &token)
				.is_err()
		);
		assert!(backend.input.is_none());
	}

	#[test]
	fn window_foreground_delivery_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let target = Target::Window("w1".to_string());
		let err = backend
			.type_text(
				&target,
				"hello",
				DeliveryMode::Foreground,
				&control::CancellationSource::default().token(),
			)
			.expect_err("window foreground input must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
	}

	#[test]
	fn window_raise_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let err = backend
			.raise_window("w1", &control::CancellationSource::default().token())
			.expect_err("Wayland window raise must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
	}

	#[test]
	fn capabilities_report_no_capture_without_libpipewire() {
		let mut backend = backend_without_services();
		let caps = backend.capabilities();
		assert!(!caps.capture);
		assert_eq!(caps.capture_permission, "unavailable");
		let err = backend
			.capture(&Target::Desktop, &CaptureCaps::default(), None)
			.expect_err("capture must fail without libpipewire");
		assert_eq!(err.code.as_str(), "CaptureFailed");
		assert!(
			err.message
				.contains("libpipewire-0.3.so.0 could not be loaded"),
			"{}",
			err.message
		);
	}

	fn portal_window(x: i32, y: i32, width: u32, height: u32, position_known: bool) -> AtSpiWindow {
		AtSpiWindow {
			window: DesktopWindow {
				id: "w".into(),
				title: "T".into(),
				app: "A".into(),
				pid: None,
				position_known: Some(position_known),
				x,
				y,
				width,
				height,
				focused: false,
			},
			position_known,
		}
	}

	#[test]
	fn scaled_monitor_maps_screenshot_pixel_to_logical_point() {
		// 2560x2880 buffer for a 1280x1440 logical region at scale 2 (issue
		// #11540).
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		let display = geometry.display(0, &[]);
		assert_eq!((display.width, display.height), (1280, 1440));
		assert!((display.scale - 2.0).abs() < f64::EPSILON);
		let frame = FrameGeometry::for_displays(&[display]);
		// A lower-half click that the old identity mapping pushed outside the
		// 1280x1440 input region now lands inside it.
		let (lx, ly) = frame.map_point(1066.0, 1867.0, None).unwrap();
		assert!((lx - 533.0).abs() < 1e-6, "logical x {lx}");
		assert!((ly - 933.5).abs() < 1e-6, "logical y {ly}");
		assert!(lx < 1280.0 && ly < 1440.0, "mapped point must stay inside the logical region");
	}

	#[test]
	fn monitor_offset_is_added_to_logical_point() {
		let geometry = PortalGeometry::new(Some((100, 50)), Some((1280, 1440)), 2560, 2880);
		let frame = FrameGeometry::for_displays(&[geometry.display(0, &[])]);
		assert_eq!(frame.map_point(1280.0, 1440.0, None).unwrap(), (740.0, 770.0));
	}

	#[test]
	fn missing_portal_size_falls_back_to_buffer_scale_one() {
		let geometry = PortalGeometry::new(None, None, 1920, 1080);
		let display = geometry.display(0, &[]);
		assert_eq!((display.x, display.y), (0, 0));
		assert_eq!((display.width, display.height), (1920, 1080));
		assert!((display.scale - 1.0).abs() < f64::EPSILON);
		// Degenerate (zero) portal dimensions take the same fallback.
		let degenerate = PortalGeometry::new(Some((0, 0)), Some((0, 0)), 1920, 1080);
		assert_eq!(degenerate.display(0, &[]).width, 1920);
	}

	#[test]
	fn window_crop_scales_logical_bounds_to_buffer_pixels() {
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		let crop = geometry
			.window_crop(&portal_window(100, 200, 300, 400, true))
			.expect("window inside monitor");
		assert_eq!(crop.pixels, (200, 400, 600, 800));
	}

	#[test]
	fn window_crop_rejects_window_outside_monitor() {
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		for window in [portal_window(2000, 0, 100, 100, true), portal_window(-100, 0, 100, 100, true)]
		{
			let err = geometry
				.window_crop(&window)
				.expect_err("window outside monitor");
			assert_eq!(err.code.as_str(), "CaptureFailed");
		}
	}

	#[test]
	fn window_crop_clips_window_to_monitor_and_frames_the_visible_part() {
		// Monitors left of and above the primary, at 1x and 1.5x; windows run
		// past the right, bottom, bottom-right and top-left edges. Rows: window,
		// visible part, pixel crop.
		let cases = [
			((-1920, -1080, 1920, 1080), 1920, 1080, [
				((-101, -980, 400, 200), (-101, -980, 101, 200), (1819, 100, 101, 200)),
				((-1820, -51, 400, 200), (-1820, -51, 400, 51), (100, 1029, 400, 51)),
				((-101, -51, 400, 200), (-101, -51, 101, 51), (1819, 1029, 101, 51)),
				((-2221, -1131, 400, 200), (-1920, -1080, 99, 149), (0, 0, 99, 149)),
			]),
			((-1280, -720, 1280, 720), 1920, 1080, [
				((-101, -621, 400, 200), (-101, -621, 101, 200), (1769, 149, 151, 300)),
				((-1179, -51, 400, 200), (-1179, -51, 400, 51), (152, 1004, 600, 76)),
				((-101, -51, 400, 200), (-101, -51, 101, 51), (1769, 1004, 151, 76)),
				((-1381, -821, 400, 200), (-1280, -720, 299, 99), (0, 0, 449, 149)),
			]),
		];
		for ((origin_x, origin_y, logical_width, logical_height), pixel_width, pixel_height, rows) in
			cases
		{
			let geometry = PortalGeometry::new(
				Some((origin_x, origin_y)),
				Some((logical_width, logical_height)),
				pixel_width,
				pixel_height,
			);
			let scale = f64::from(pixel_width) / f64::from(logical_width);
			for (bounds, visible, expected_crop) in rows {
				let (x, y, width, height) = bounds;
				let entry = portal_window(x, y, width, height, true);
				let crop = geometry
					.window_crop(&entry)
					.unwrap_or_else(|err| panic!("{bounds:?}: {err}"));
				let pixels = crop.pixels;
				let frame =
					FrameGeometry::for_window_part(&entry.window, crop.part, pixels.2, pixels.3);
				assert_eq!(pixels, expected_crop, "{bounds:?}");
				assert_eq!(frame.window_part(&entry.window), visible, "{bounds:?}");
				assert!(frame.validate_window(Some(&entry.window)).is_ok(), "{bounds:?}");
				// The crop's last pixel shows the monitor point at its buffer
				// pixel.
				let (px, py) = (f64::from(pixels.2 - 1), f64::from(pixels.3 - 1));
				let (lx, ly) = frame.map_point(px, py, Some(&entry.window)).unwrap();
				let expected_x = f64::from(origin_x) + (f64::from(pixels.0) + px) / scale;
				let expected_y = f64::from(origin_y) + (f64::from(pixels.1) + py) / scale;
				assert!(
					(lx - expected_x).abs() < 0.5 && (ly - expected_y).abs() < 0.5,
					"{bounds:?}: ({lx}, {ly}) != ({expected_x}, {expected_y})"
				);
			}
		}
	}

	#[test]
	fn window_crop_accepts_fractional_scale_rounding_at_monitor_edges() {
		let geometry = PortalGeometry::new(Some((-1280, -720)), Some((1280, 720)), 1920, 1080);
		let window = portal_window(-279, -219, 279, 219, true);
		let crop = geometry
			.window_crop(&window)
			.expect("fully contained window at the monitor edges");
		assert_eq!(crop.pixels, (1502, 752, 418, 328));
		let (_, _, width, height) = crop.pixels;
		let frame = FrameGeometry::for_window_part(&window.window, crop.part, width, height);
		assert_eq!(frame.window_part(&window.window), (-279, -219, 279, 219));
	}

	#[test]
	fn window_crop_refuses_unknown_screen_position() {
		// Native Wayland clients report AT-SPI Screen extents of 0,0 wherever
		// the compositor placed them; cropping there captured whatever sat at the
		// monitor's top-left instead of the window (issue #13854).
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1920, 1080)), 1920, 1080);
		let err = geometry
			.window_crop(&portal_window(0, 0, 1159, 896, false))
			.expect_err("unknown position must not be cropped");
		assert_eq!(err.code.as_str(), "CaptureFailed");
	}

	#[test]
	fn element_input_goes_in_only_as_inserted_text() {
		assert!(matches!(
			element_input_outcome(Some(TextRoute::Inserted)),
			Ok(ElementDelivery::Delivered)
		));
		let Err(declined) =
			element_input_outcome(Some(TextRoute::Declined("it skips the validator")))
		else {
			panic!("a declined route reported delivery");
		};
		assert_eq!(declined.code.as_str(), "BackgroundUnavailable");
		assert!(declined.message.contains("since it skips the validator"), "{declined}");
		for route in [Some(TextRoute::Absent), None] {
			let Err(err) = element_input_outcome(route) else {
				panic!("{route:?} reported delivery");
			};
			assert_eq!(err.code.as_str(), "BackgroundUnavailable");
			assert!(err.message.contains("nothing was sent"), "{err}");
		}
	}
}
