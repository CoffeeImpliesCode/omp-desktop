use smallvec::SmallVec;

use super::{
	error::{CoreResult, DesktopError},
	types::DesktopControlAction,
};

/// One validated window-control request.
///
/// The parser owns every argument check, so a request reaches a compositor or
/// window manager only with the exact fields its operation declares: no
/// guessed identity, no second mutation smuggled in, no truncated size.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum ControlAction {
	FocusWindow(String),
	CloseWindow(String),
	MoveWindow { id: String, x: f64, y: f64 },
	MoveWindowBy { id: String, dx: f64, dy: f64 },
	ResizeWindow { id: String, width: Option<u32>, height: Option<u32> },
	MaximizeWindow(String),
	MinimizeWindow(String),
	RestoreWindow(String),
	ToggleMaximized(String),
	ToggleFullscreen(String),
	ToggleWindowedFullscreen(String),
	SetFullscreen { id: String, enabled: bool },
	SetFloating { id: String, enabled: bool },
	CenterWindow(String),
	MoveWindowToWorkspace { id: String, workspace: String, focus: bool },
	MoveWindowToDisplay { id: String, display: String },
	FocusWorkspace(String),
	FocusDisplay(String),
	MoveWorkspaceToDisplay { workspace: String, display: String },
}

impl ControlAction {
	/// CamelCase operation name, identical to the capability strings a backend
	/// advertises.
	pub(super) const fn operation(&self) -> &'static str {
		match self {
			Self::FocusWindow(_) => "focusWindow",
			Self::CloseWindow(_) => "closeWindow",
			Self::MoveWindow { .. } => "moveWindow",
			Self::MoveWindowBy { .. } => "moveWindowBy",
			Self::ResizeWindow { .. } => "resizeWindow",
			Self::MaximizeWindow(_) => "maximizeWindow",
			Self::MinimizeWindow(_) => "minimizeWindow",
			Self::RestoreWindow(_) => "restoreWindow",
			Self::ToggleMaximized(_) => "toggleMaximized",
			Self::ToggleFullscreen(_) => "toggleFullscreen",
			Self::ToggleWindowedFullscreen(_) => "toggleWindowedFullscreen",
			Self::SetFullscreen { .. } => "setFullscreen",
			Self::SetFloating { .. } => "setFloating",
			Self::CenterWindow(_) => "centerWindow",
			Self::MoveWindowToWorkspace { .. } => "moveWindowToWorkspace",
			Self::MoveWindowToDisplay { .. } => "moveWindowToDisplay",
			Self::FocusWorkspace(_) => "focusWorkspace",
			Self::FocusDisplay(_) => "focusDisplay",
			Self::MoveWorkspaceToDisplay { .. } => "moveWorkspaceToDisplay",
		}
	}

	/// Exact window id this action mutates, if it targets a window at all.
	pub(super) fn window_id(&self) -> Option<&str> {
		match self {
			Self::FocusWindow(id)
			| Self::CloseWindow(id)
			| Self::MaximizeWindow(id)
			| Self::MinimizeWindow(id)
			| Self::RestoreWindow(id)
			| Self::ToggleMaximized(id)
			| Self::ToggleFullscreen(id)
			| Self::ToggleWindowedFullscreen(id)
			| Self::CenterWindow(id) => Some(id),
			Self::MoveWindow { id, .. }
			| Self::MoveWindowBy { id, .. }
			| Self::ResizeWindow { id, .. }
			| Self::SetFullscreen { id, .. }
			| Self::SetFloating { id, .. }
			| Self::MoveWindowToWorkspace { id, .. }
			| Self::MoveWindowToDisplay { id, .. } => Some(id),
			Self::FocusWorkspace(_) | Self::FocusDisplay(_) | Self::MoveWorkspaceToDisplay { .. } => {
				None
			},
		}
	}
}

/// Parses the loose native request into exactly one validated action.
pub(super) fn parse(action: DesktopControlAction) -> CoreResult<ControlAction> {
	let DesktopControlAction {
		operation,
		window_id,
		workspace_id,
		display_id,
		x,
		y,
		dx,
		dy,
		width,
		height,
		enabled,
		focus,
	} = action;
	let mut fields =
		Fields { window_id, workspace_id, display_id, x, y, dx, dy, width, height, enabled, focus };

	match operation.as_str() {
		"focusWindow" => {
			let id = fields.window(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::FocusWindow(id))
		},
		"closeWindow" => {
			let id = fields.window(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::CloseWindow(id))
		},
		"moveWindow" => {
			let id = fields.window(&operation)?;
			let (x, y) = fields.point(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::MoveWindow { id, x, y })
		},
		"moveWindowBy" => {
			let id = fields.window(&operation)?;
			let (dx, dy) = fields.delta(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::MoveWindowBy { id, dx, dy })
		},
		"resizeWindow" => {
			let id = fields.window(&operation)?;
			let width = fields.size(&operation, "width")?;
			let height = fields.size(&operation, "height")?;
			if width.is_none() && height.is_none() {
				return Err(DesktopError::control_failed(
					"resizeWindow needs at least one of width or height",
				));
			}
			fields.done(&operation)?;
			Ok(ControlAction::ResizeWindow { id, width, height })
		},
		"maximizeWindow" => {
			ControlAction::window_only(&mut fields, &operation, ControlAction::MaximizeWindow)
		},
		"minimizeWindow" => {
			ControlAction::window_only(&mut fields, &operation, ControlAction::MinimizeWindow)
		},
		"restoreWindow" => {
			ControlAction::window_only(&mut fields, &operation, ControlAction::RestoreWindow)
		},
		"toggleMaximized" => {
			ControlAction::window_only(&mut fields, &operation, ControlAction::ToggleMaximized)
		},
		"toggleFullscreen" => {
			ControlAction::window_only(&mut fields, &operation, ControlAction::ToggleFullscreen)
		},
		"toggleWindowedFullscreen" => ControlAction::window_only(
			&mut fields,
			&operation,
			ControlAction::ToggleWindowedFullscreen,
		),
		"setFullscreen" => {
			let id = fields.window(&operation)?;
			let enabled = fields.enabled(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::SetFullscreen { id, enabled })
		},
		"setFloating" => {
			let id = fields.window(&operation)?;
			let enabled = fields.enabled(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::SetFloating { id, enabled })
		},
		"centerWindow" => {
			ControlAction::window_only(&mut fields, &operation, ControlAction::CenterWindow)
		},
		"moveWindowToWorkspace" => {
			let id = fields.window(&operation)?;
			let workspace = fields.workspace(&operation)?;
			// Only this operation may also move focus; niri has no such
			// primitive for a display move, so no other call may pass it.
			let focus = fields.focus();
			fields.done(&operation)?;
			Ok(ControlAction::MoveWindowToWorkspace { id, workspace, focus })
		},
		"moveWindowToDisplay" => {
			let id = fields.window(&operation)?;
			let display = fields.display(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::MoveWindowToDisplay { id, display })
		},
		"focusWorkspace" => {
			let workspace = fields.workspace(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::FocusWorkspace(workspace))
		},
		"focusDisplay" => {
			let display = fields.display(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::FocusDisplay(display))
		},
		"moveWorkspaceToDisplay" => {
			let workspace = fields.workspace(&operation)?;
			let display = fields.display(&operation)?;
			fields.done(&operation)?;
			Ok(ControlAction::MoveWorkspaceToDisplay { workspace, display })
		},
		_ => {
			Err(DesktopError::control_unsupported(format!("unknown control operation '{operation}'")))
		},
	}
}

impl ControlAction {
	fn window_only(
		fields: &mut Fields,
		operation: &str,
		wrap: fn(String) -> Self,
	) -> CoreResult<Self> {
		let id = fields.window(operation)?;
		fields.done(operation)?;
		Ok(wrap(id))
	}
}

/// Request fields, each consumed by the operation that owns it. Whatever is
/// left over when the action is built is a field that operation never reads,
/// and is refused instead of silently ignored.
struct Fields {
	window_id:    Option<String>,
	workspace_id: Option<String>,
	display_id:   Option<String>,
	x:            Option<f64>,
	y:            Option<f64>,
	dx:           Option<f64>,
	dy:           Option<f64>,
	width:        Option<f64>,
	height:       Option<f64>,
	enabled:      Option<bool>,
	focus:        Option<bool>,
}

impl Fields {
	fn window(&mut self, operation: &str) -> CoreResult<String> {
		let id = identity(operation, "windowId", self.window_id.take())?;
		// "desktop" addresses the whole screen for capture and input, so it can
		// never name the single window a control operation must move.
		if id.eq_ignore_ascii_case("desktop") {
			return Err(DesktopError::invalid_target(format!(
				"{operation} needs one window from discovery, not the whole desktop"
			)));
		}
		Ok(id)
	}

	fn workspace(&mut self, operation: &str) -> CoreResult<String> {
		identity(operation, "workspaceId", self.workspace_id.take())
	}

	fn display(&mut self, operation: &str) -> CoreResult<String> {
		identity(operation, "displayId", self.display_id.take())
	}

	fn point(&mut self, operation: &str) -> CoreResult<(f64, f64)> {
		Ok((coordinate(operation, "x", self.x.take())?, coordinate(operation, "y", self.y.take())?))
	}

	fn delta(&mut self, operation: &str) -> CoreResult<(f64, f64)> {
		Ok((
			coordinate(operation, "dx", self.dx.take())?,
			coordinate(operation, "dy", self.dy.take())?,
		))
	}

	/// Sizes arrive as doubles; a fractional or oversized pixel count is a
	/// caller bug, not something to round into a silent different request.
	fn size(&mut self, operation: &str, field: &'static str) -> CoreResult<Option<u32>> {
		let Some(value) = (if field == "width" {
			self.width.take()
		} else {
			self.height.take()
		}) else {
			return Ok(None);
		};
		let integral = value.is_finite() && value >= 1.0 && value.fract() == 0.0;
		if !integral || value > f64::from(i32::MAX) {
			return Err(DesktopError::control_failed(format!(
				"{operation} {field} must be a whole pixel count of 1..={}, got {value}",
				i32::MAX
			)));
		}
		Ok(Some(value as u32))
	}

	fn enabled(&mut self, operation: &str) -> CoreResult<bool> {
		self
			.enabled
			.take()
			.ok_or_else(|| DesktopError::control_failed(format!("{operation} needs enabled")))
	}

	fn focus(&mut self) -> bool {
		// Workspace moves leave focus where the user put it unless the caller
		// explicitly asks for the move to steal it.
		self.focus.take().unwrap_or(false)
	}

	fn done(&self, operation: &str) -> CoreResult<()> {
		let mut extra = SmallVec::<[&str; 11]>::new();
		for (name, present) in [
			("windowId", self.window_id.is_some()),
			("workspaceId", self.workspace_id.is_some()),
			("displayId", self.display_id.is_some()),
			("x", self.x.is_some()),
			("y", self.y.is_some()),
			("dx", self.dx.is_some()),
			("dy", self.dy.is_some()),
			("width", self.width.is_some()),
			("height", self.height.is_some()),
			("enabled", self.enabled.is_some()),
			("focus", self.focus.is_some()),
		] {
			if present {
				extra.push(name);
			}
		}
		if extra.is_empty() {
			return Ok(());
		}
		Err(DesktopError::control_failed(format!(
			"{operation} does not take {}; it would be ignored",
			extra.join(", ")
		)))
	}
}

fn identity(operation: &str, field: &'static str, value: Option<String>) -> CoreResult<String> {
	match value {
		// Ids are opaque: keep the exact bytes, only reject an absent or blank
		// one so a fallback can never be guessed from an empty string.
		Some(id) if !id.trim().is_empty() => Ok(id),
		_ => Err(DesktopError::invalid_target(format!(
			"{operation} needs an exact {field} from discovery"
		))),
	}
}

fn coordinate(operation: &str, field: &'static str, value: Option<f64>) -> CoreResult<f64> {
	match value {
		Some(value) if value.is_finite() => Ok(value),
		Some(value) => Err(DesktopError::control_failed(format!(
			"{operation} {field} must be a finite coordinate, got {value}"
		))),
		None => Err(DesktopError::control_failed(format!("{operation} needs {field}"))),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	fn action(operation: &str) -> DesktopControlAction {
		DesktopControlAction { operation: operation.to_string(), ..DesktopControlAction::default() }
	}

	fn window_action(operation: &str, id: &str) -> DesktopControlAction {
		DesktopControlAction {
			operation: operation.to_string(),
			window_id: Some(id.to_string()),
			..DesktopControlAction::default()
		}
	}

	fn error(operation: &str, action: DesktopControlAction) -> DesktopError {
		parse(action).expect_err(&format!("{operation} must refuse this request"))
	}

	#[test]
	fn window_operations_refuse_the_desktop_target_and_a_missing_id() {
		let desktop = error("focusWindow", window_action("focusWindow", "desktop"));
		assert_eq!(desktop.code, ErrorCode::InvalidTarget);
		let blank = error("closeWindow", window_action("closeWindow", "   "));
		assert_eq!(blank.code, ErrorCode::InvalidTarget);
		let missing = error("maximizeWindow", action("maximizeWindow"));
		assert_eq!(missing.code, ErrorCode::InvalidTarget);
	}

	#[test]
	fn fields_the_operation_never_reads_are_refused() {
		let mut smuggled = window_action("focusWindow", "w1");
		smuggled.x = Some(10.0);
		assert_eq!(error("focusWindow", smuggled).code, ErrorCode::ControlFailed);

		let mut workspace_focus = action("focusWorkspace");
		workspace_focus.workspace_id = Some("niri-workspace:1".to_string());
		workspace_focus.focus = Some(true);
		// Only moveWindowToWorkspace may carry focus; a display move has no
		// focus option to honor.
		assert_eq!(error("focusWorkspace", workspace_focus).code, ErrorCode::ControlFailed);

		let mut display_focus = window_action("moveWindowToDisplay", "w1");
		display_focus.display_id = Some("HDMI-1".to_string());
		display_focus.focus = Some(true);
		assert_eq!(error("moveWindowToDisplay", display_focus).code, ErrorCode::ControlFailed);

		let mut workspace_id_on_window = window_action("closeWindow", "w1");
		workspace_id_on_window.workspace_id = Some("niri-workspace:1".to_string());
		assert_eq!(error("closeWindow", workspace_id_on_window).code, ErrorCode::ControlFailed);
	}

	#[test]
	fn non_finite_coordinates_never_reach_the_backend() {
		for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
			let mut move_to = window_action("moveWindow", "w1");
			move_to.x = Some(value);
			move_to.y = Some(0.0);
			assert_eq!(error("moveWindow", move_to).code, ErrorCode::ControlFailed);

			let mut move_by = window_action("moveWindowBy", "w1");
			move_by.dx = Some(0.0);
			move_by.dy = Some(value);
			assert_eq!(error("moveWindowBy", move_by).code, ErrorCode::ControlFailed);
		}

		let mut missing_axis = window_action("moveWindow", "w1");
		missing_axis.x = Some(12.0);
		assert_eq!(error("moveWindow", missing_axis).code, ErrorCode::ControlFailed);
	}

	#[test]
	fn fractional_or_out_of_range_sizes_are_refused_instead_of_truncated() {
		for width in [640.5, 0.0, -10.0, f64::from(i32::MAX) + 1.0] {
			let mut resize = window_action("resizeWindow", "w1");
			resize.width = Some(width);
			assert_eq!(error("resizeWindow", resize).code, ErrorCode::ControlFailed);
		}
		let mut empty = window_action("resizeWindow", "w1");
		empty.enabled = Some(true);
		assert_eq!(error("resizeWindow", empty).code, ErrorCode::ControlFailed);
	}

	#[test]
	fn accepted_requests_carry_the_exact_size_and_default_focus() {
		let mut resize = window_action("resizeWindow", "w1");
		resize.width = Some(640.0);
		resize.height = Some(480.0);
		assert_eq!(
			parse(resize).expect("whole pixel sizes are valid"),
			ControlAction::ResizeWindow {
				id:     "w1".to_string(),
				width:  Some(640),
				height: Some(480),
			}
		);

		let mut to_workspace = window_action("moveWindowToWorkspace", "w1");
		to_workspace.workspace_id = Some("niri-workspace:3".to_string());
		assert_eq!(
			parse(to_workspace).expect("workspace move without focus is valid"),
			ControlAction::MoveWindowToWorkspace {
				id:        "w1".to_string(),
				workspace: "niri-workspace:3".to_string(),
				focus:     false,
			}
		);

		let mut set_fullscreen = window_action("setFullscreen", "w1");
		set_fullscreen.enabled = Some(false);
		assert_eq!(
			parse(set_fullscreen).expect("explicit false is valid"),
			ControlAction::SetFullscreen { id: "w1".to_string(), enabled: false }
		);
	}

	#[test]
	fn unknown_operation_is_unsupported_rather_than_a_backend_error() {
		assert_eq!(
			error("teleportWindow", action("teleportWindow")).code,
			ErrorCode::ControlUnsupported,
		);
	}
}
