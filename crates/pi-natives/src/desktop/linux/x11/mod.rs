mod capture;
mod control;
mod input;
mod keymap;
mod mpx;
mod toolkit;
mod uinput;
mod wm;

use capture::X11Capture;
use control::X11Control;
use image::RgbaImage;
use input::X11Input;

use super::ax::AtSpiAx;
use crate::desktop::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	control::ControlAction,
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopControlCapabilities, DesktopDisplay, DesktopWindow,
		DesktopWindowState, DesktopWorkspace, DisplaySelector, Target,
	},
};

pub struct X11Backend {
	capture:        X11Capture,
	input:          X11Input,
	/// EWMH/ICCCM control on the same connection as capture and input, so a
	/// window request never needs a second session.
	control:        X11Control,
	ax:             Option<AtSpiAx>,
	display_server: Option<String>,
}

impl X11Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		let capture = X11Capture::new(display)?;
		let input = X11Input::new(capture.connection(), capture.root())?;
		let control = X11Control::new(capture.connection(), capture.root(), capture.root_size())?;
		let ax = AtSpiAx::new().ok();
		Ok(Self { capture, input, control, ax, display_server: std::env::var("DISPLAY").ok() })
	}
}

impl Backend for X11Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let displays = self.capture.displays();
		DesktopCapabilities {
			backend: "x11".to_string(),
			display_server: self.display_server.clone(),
			capture: displays.is_ok(),
			input: true,
			ax: self.ax.is_some(),
			background_window_input: true,
			takeover: true,
			capture_permission: if displays.is_ok() {
				"granted"
			} else {
				"unavailable"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: if self.ax.is_some() {
				"granted"
			} else {
				"unavailable"
			}
			.to_string(),
			display_count: displays.map_or(0, |items| u32::try_from(items.len()).unwrap_or(u32::MAX)),
			// The worker attaches the live `control_capabilities()` read; a
			// literal here would go stale the moment the window manager changes.
			window_control: None,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		self.capture.displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		self.capture.windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		self.capture.capture(target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.input.pointer(target, event, mode)
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		self.input.type_text(target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.input.key_chord(target, keys, mode)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		let window = id
			.parse::<u32>()
			.map_err(|_| DesktopError::window_not_found(format!("invalid X11 window id {id}")))?;
		self.input.raise_window(window)
	}

	/// Only what this window manager actually implements. Everything else is
	/// refused instead of being approximated through input or a client kill.
	fn control_capabilities(&mut self) -> DesktopControlCapabilities {
		self.control.capabilities()
	}

	fn control(&mut self, action: &ControlAction) -> CoreResult<()> {
		self.control.run(&self.capture, action)
	}

	fn workspaces(&mut self) -> CoreResult<Vec<DesktopWorkspace>> {
		self.control.workspaces()
	}

	fn window_state(&mut self, id: &str) -> CoreResult<DesktopWindowState> {
		self.control.window_state(&self.capture, id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}
