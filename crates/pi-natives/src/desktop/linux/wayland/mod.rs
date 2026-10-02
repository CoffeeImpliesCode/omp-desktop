#[cfg(feature = "wayland-pipewire")]
mod capture;
mod geometry;
mod libei;
mod niri;
mod portal;
mod xkb;

#[cfg(any(feature = "wayland-pipewire", test))]
use geometry::PortalGeometry;
use image::RgbaImage;

use crate::desktop::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	linux::ax::{AtSpiAx, AtSpiWindow},
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
	},
};

pub struct WaylandBackend {
	#[cfg_attr(
		not(feature = "wayland-pipewire"),
		expect(dead_code, reason = "only read by the pipewire capture path")
	)]
	display:  DisplaySelector,
	ax:       Option<AtSpiAx>,
	ax_error: Option<DesktopError>,
	input:    Option<libei::Libei>,
	displays: Vec<DesktopDisplay>,
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
		Self { display, ax, ax_error, input: None, displays }
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
		Self::window_input_error(target, kind)?;
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

	fn atspi_windows(&self) -> CoreResult<Vec<AtSpiWindow>> {
		self
			.ax
			.as_ref()
			.ok_or_else(|| {
				self
					.ax_error
					.clone()
					.unwrap_or_else(DesktopError::ax_unsupported)
			})?
			.windows()
	}
}

impl Backend for WaylandBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let input_permission = if self.input.is_some() {
			"granted"
		} else {
			"prompt-or-granted"
		};
		DesktopCapabilities {
			backend: "wayland".to_string(),
			display_server: Some("wayland".to_string()),
			// The PipeWire screencast path is compiled in only under the
			// wayland-pipewire feature; without it capture() hard-errors, so the
			// capability report must not advertise a capture the binary cannot do.
			capture: cfg!(feature = "wayland-pipewire"),
			input: true,
			ax: self.ax.is_some(),
			background_window_input: false,
			takeover: false,
			capture_permission: if cfg!(feature = "wayland-pipewire") {
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
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		Ok(self.displays.clone())
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		// niri is the authority on what is open, but its IPC is optional
		// metadata for a listing: a restarting compositor leaves a
		// `$NIRI_SOCKET` that no longer connects, and that must degrade to the
		// accessibility listing instead of failing every window query.
		if let Ok(Some(windows)) = niri::windows() {
			return Ok(windows.into_iter().map(|entry| entry.window).collect());
		}
		Ok(self
			.atspi_windows()?
			.into_iter()
			.map(|entry| entry.window)
			.collect())
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		#[cfg(not(feature = "wayland-pipewire"))]
		{
			let _ = target;
			Err(DesktopError::capture_failed("Wayland capture requires the wayland-pipewire feature"))
		}
		#[cfg(feature = "wayland-pipewire")]
		{
			if let Target::Window(id) = target
				&& id.starts_with("niri:")
			{
				let (image, window) = niri::capture_window(id)?;
				let frame = FrameGeometry::for_window(&window, image.width(), image.height());
				return Ok((image, frame));
			}
			// Known displays only name and match the streams the portal
			// authorized, so an unreachable compositor leaves the portal's own
			// geometry to stand on rather than refusing a screenshot it can
			// take.
			let known = niri::displays().ok().flatten().unwrap_or_default();
			let frames = capture::capture()?;
			match target {
				Target::Desktop => {
					let (image, displays) = geometry::compose(frames, &self.display, &known)?;
					let frame = FrameGeometry::for_displays(&displays);
					self.displays = displays;
					Ok((image, frame))
				},
				Target::Window(id) => {
					let entry = self
						.atspi_windows()?
						.into_iter()
						.find(|entry| &entry.window.id == id)
						.ok_or_else(|| {
							DesktopError::window_not_found(format!("Wayland window {id} not found"))
						})?;
					if !entry.position_known {
						return Err(DesktopError::capture_failed(format!(
							"Wayland window {id} has no known screen position; native compositor capture \
							 is unavailable"
						)));
					}
					let displays = geometry::metadata(&frames, &known);
					for ((image, geometry), display) in frames.iter().zip(&displays) {
						if matches!(&self.display, DisplaySelector::Id(id) if id != &display.id && id != &display.name)
						{
							continue;
						}
						if let Ok((x, y, width, height)) = geometry.window_crop(&entry) {
							let cropped = image::imageops::crop_imm(image, x, y, width, height).to_image();
							let frame = FrameGeometry::for_window(&entry.window, width, height);
							return Ok((cropped, frame));
						}
					}
					Err(DesktopError::capture_failed(format!(
						"Wayland window {id} is not fully inside an authorized monitor"
					)))
				},
			}
		}
	}

	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		_frame: &FrameGeometry,
		_mode: DeliveryMode,
	) -> CoreResult<()> {
		self.run_input(target, "pointer input", |input| input.pointer(ev))
	}

	fn type_text(&mut self, target: &Target, text: &str, _mode: DeliveryMode) -> CoreResult<()> {
		self.run_input(target, "keyboard input", |input| input.type_text(text))
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		_mode: DeliveryMode,
	) -> CoreResult<()> {
		self.run_input(target, "keyboard input", |input| input.key_chord(keys))
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		Err(DesktopError::background_unavailable(format!(
			"window {id} wayland-compositor-focus-only: Wayland cannot programmatically activate a \
			 non-focused window; only the currently focused surface is reachable"
		)))
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
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

	static LIBEI_ENV_LOCK: Mutex<()> = Mutex::new(());

	fn backend_without_services() -> WaylandBackend {
		WaylandBackend {
			display:  DisplaySelector::All,
			ax:       None,
			ax_error: None,
			input:    None,
			displays: Vec::new(),
		}
	}
	fn with_fake_libei(action: impl FnOnce(&mut WaylandBackend)) -> bool {
		let _guard = LIBEI_ENV_LOCK.lock().expect("lock LIBEI_SOCKET test");
		let socket = std::env::temp_dir().join(format!("omp-libei-test-{}", std::process::id()));
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
		let previous = std::env::var_os("LIBEI_SOCKET");
		let previous_bus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS");
		let previous_niri = std::env::var_os("NIRI_SOCKET");
		// This input contract must not depend on the user's live AX or compositor
		// services.
		unsafe {
			std::env::set_var("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent-omp-test-bus");
			std::env::remove_var("NIRI_SOCKET");
		}
		unsafe { std::env::set_var("LIBEI_SOCKET", &socket) };
		let mut backend = WaylandBackend::new(DisplaySelector::All);
		action(&mut backend);
		let _ = stop_tx.send(());
		if let Some(previous) = previous {
			unsafe { std::env::set_var("LIBEI_SOCKET", previous) };
		} else {
			unsafe { std::env::remove_var("LIBEI_SOCKET") };
		}
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
		connected
	}

	/// A `$NIRI_SOCKET` left behind by a compositor that already exited: the
	/// path is set, so niri attempts the IPC and the connect fails the way a
	/// restarting compositor's does. The accessibility bus is unreachable too,
	/// so the fallback listing is what decides the outcome.
	fn with_unreachable_compositor(action: impl FnOnce(&mut WaylandBackend)) {
		let guard = LIBEI_ENV_LOCK.lock().expect("lock LIBEI_SOCKET test");
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
			let _ = backend.type_text(&Target::Desktop, "hello", DeliveryMode::Foreground);
		});
		assert!(connected, "desktop input did not connect to libei");
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
				.type_text(&Target::Desktop, "hello", DeliveryMode::Foreground)
				.expect_err("missing socket must fail");
			assert_eq!(first.code.as_str(), "PermissionDenied");
			let caps = backend.capabilities();
			assert!(caps.input);
			assert_eq!(caps.input_permission, "prompt-or-granted");
			unsafe { std::env::set_var("LIBEI_SOCKET", socket) };
			let _ = backend.type_text(&Target::Desktop, "hello", DeliveryMode::Foreground);
		});
		assert!(connected, "a failed input request prevented the next connection attempt");
	}

	#[test]
	fn window_foreground_delivery_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let target = Target::Window("w1".to_string());
		let err = backend
			.type_text(&target, "hello", DeliveryMode::Foreground)
			.expect_err("window foreground input must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
	}

	#[test]
	fn window_raise_reports_compositor_constraint() {
		let mut backend = backend_without_services();
		let err = backend
			.raise_window("w1")
			.expect_err("Wayland window raise must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
	}

	#[test]
	#[cfg(not(feature = "wayland-pipewire"))]
	fn capabilities_report_no_capture_without_pipewire_feature() {
		let mut backend = WaylandBackend {
			display:  DisplaySelector::All,
			ax:       None,
			ax_error: None,
			input:    None,
			displays: Vec::new(),
		};
		let caps = backend.capabilities();
		// Shipped builds compile without wayland-pipewire, so the capture path is
		// absent; capabilities() must not advertise capture the binary cannot do.
		assert!(!caps.capture, "capture must be false when the pipewire feature is off");
		assert_eq!(caps.capture_permission, "unavailable");
		let err = backend
			.capture(&Target::Desktop, &CaptureCaps::default())
			.expect_err("capture must fail without the pipewire feature");
		assert_eq!(err.code.as_str(), "CaptureFailed");
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
		let display = geometry.display(0);
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
		let frame = FrameGeometry::for_displays(&[geometry.display(0)]);
		assert_eq!(frame.map_point(1280.0, 1440.0, None).unwrap(), (740.0, 770.0));
	}

	#[test]
	fn missing_portal_size_falls_back_to_buffer_scale_one() {
		let geometry = PortalGeometry::new(None, None, 1920, 1080);
		let display = geometry.display(0);
		assert_eq!((display.x, display.y), (0, 0));
		assert_eq!((display.width, display.height), (1920, 1080));
		assert!((display.scale - 1.0).abs() < f64::EPSILON);
		// Degenerate (zero) portal dimensions take the same fallback.
		let degenerate = PortalGeometry::new(Some((0, 0)), Some((0, 0)), 1920, 1080);
		assert_eq!(degenerate.display(0).width, 1920);
	}

	#[test]
	fn window_crop_scales_logical_bounds_to_buffer_pixels() {
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		let crop = geometry
			.window_crop(&portal_window(100, 200, 300, 400, true))
			.expect("window inside monitor");
		assert_eq!(crop, (200, 400, 600, 800));
	}

	#[test]
	fn window_crop_rejects_window_outside_monitor() {
		let geometry = PortalGeometry::new(Some((0, 0)), Some((1280, 1440)), 2560, 2880);
		for window in [portal_window(2000, 0, 100, 100, true), portal_window(-10, 0, 100, 100, true)]
		{
			let err = geometry
				.window_crop(&window)
				.expect_err("window outside monitor");
			assert_eq!(err.code.as_str(), "CaptureFailed");
		}
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
}
