use image::RgbaImage;

use super::{
	ax::{AxHandle, AxProps},
	control::ControlAction,
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopControlCapabilities, DesktopDisplay, DesktopWindow,
		DesktopWindowState, DesktopWorkspace, Target,
	},
};

/// How window-targeted input reaches its target.
///
/// `Background` avoids deliberate activation and physical pointer movement;
/// unsupported routes refuse, and detected focus side effects surface as
/// potentially delivered input. `Foreground` is the explicit `takeover: true`
/// escalation: it activates the target and restores state where the OS allows,
/// without overwriting a newer user focus choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeliveryMode {
	#[default]
	Background,
	Foreground,
}

impl DeliveryMode {
	pub(crate) const fn from_takeover(takeover: Option<bool>) -> Self {
		if matches!(takeover, Some(true)) {
			Self::Foreground
		} else {
			Self::Background
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseButton {
	#[default]
	Left,
	Right,
	Middle,
}

impl MouseButton {
	pub(crate) fn parse(value: Option<&str>) -> CoreResult<Self> {
		match value.map(str::trim) {
			None => Ok(Self::Left),
			Some(value) if value.eq_ignore_ascii_case("left") => Ok(Self::Left),
			Some(value) if value.eq_ignore_ascii_case("right") => Ok(Self::Right),
			Some(value) if value.eq_ignore_ascii_case("middle") => Ok(Self::Middle),
			Some(value) => Err(DesktopError::input_failed(format!("unknown button '{value}'"))),
		}
	}
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
	pub ctrl:  bool,
	pub alt:   bool,
	pub shift: bool,
	pub meta:  bool,
}

#[derive(Debug, Clone)]
pub enum PointerEvent {
	Click {
		x:         f64,
		y:         f64,
		button:    MouseButton,
		count:     u32,
		modifiers: Modifiers,
	},
	Move {
		x: f64,
		y: f64,
	},
	Drag {
		path:      Vec<(f64, f64)>,
		button:    MouseButton,
		modifiers: Modifiers,
	},
	Scroll {
		x:  f64,
		y:  f64,
		dx: f64,
		dy: f64,
	},
}

pub trait Backend: Send {
	fn capabilities(&mut self) -> DesktopCapabilities;
	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>>;
	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>>;
	fn capture(
		&mut self,
		target: &Target,
		caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)>;
	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()>;
	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()>;
	fn key_chord(&mut self, target: &Target, keys: &[KeyName], mode: DeliveryMode)
	-> CoreResult<()>;
	fn raise_window(&mut self, id: &str) -> CoreResult<()>;

	/// Window-control surface this backend really serves. The default covers a
	/// platform whose only native focus primitive is `raise_window`; a backend
	/// with a real control surface overrides this and advertises nothing it
	/// cannot prove.
	fn control_capabilities(&mut self) -> DesktopControlCapabilities {
		DesktopControlCapabilities {
			backend:                self.capabilities().backend,
			operations:             vec!["focusWindow".to_string()],
			coordinate_space:       None,
			focus_may_warp_pointer: false,
		}
	}

	/// Runs one validated control request. Success means the request was
	/// dispatched and accepted, not that the application obeyed it.
	fn control(&mut self, action: &ControlAction) -> CoreResult<()> {
		match action {
			// Focusing is the one control every platform backend already
			// expresses; the rest must be refused rather than faked.
			ControlAction::FocusWindow(id) => self.raise_window(id),
			_ => Err(DesktopError::control_unsupported(format!(
				"the {} backend does not support the '{}' control",
				self.control_capabilities().backend,
				action.operation()
			))),
		}
	}

	fn workspaces(&mut self) -> CoreResult<Vec<DesktopWorkspace>> {
		Err(DesktopError::control_unsupported(format!(
			"the {} backend does not report workspaces",
			self.control_capabilities().backend
		)))
	}

	/// Fresh read of one window. A backend that knows nothing beyond what
	/// [`DesktopWindow`] already carries leaves every state field absent
	/// instead of claiming a false.
	fn window_state(&mut self, id: &str) -> CoreResult<DesktopWindowState> {
		let window = self
			.windows()?
			.into_iter()
			.find(|window| window.id == id)
			.ok_or_else(|| DesktopError::window_not_found(format!("window '{id}' was not found")))?;
		Ok(DesktopWindowState {
			window,
			workspace_id: None,
			display_id: None,
			floating: None,
			urgent: None,
			maximized: None,
			minimized: None,
			fullscreen: None,
		})
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend>;
}

pub trait AxBackend {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle>;
	/// Resolves an element's owning top-level window for coordinate input.
	/// Refuses missing or ambiguous ownership instead of hit-testing unrelated
	/// windows.
	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String>;
	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps>;
	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>>;
	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>>;
	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()>;
	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()>;
	fn focus(&mut self, h: &AxHandle) -> CoreResult<()>;
	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>>;
	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>>;
	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>>;
}
