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
// Cancellation and exclusive task/operation ownership of desktop mutations.
//
// Explicit control keeps the kernel lease between operations. Revocation
// stops fresh work immediately, but an in-flight operation retains ownership
// until its held input and focus have been restored.
use std::{
	cell::{Cell, RefCell},
	marker::PhantomData,
	rc::Rc,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex};


#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "macos")]
pub(crate) use macos::SYNTHETIC_EVENT_TAG;

#[derive(Default)]
struct CancellationState {
	generation: AtomicU64,
	state:      Mutex<Option<Arc<ControlLease>>>,
	wake:       Condvar,
	#[cfg(target_os = "linux")]
	async_wake: tokio::sync::Notify,
}

#[derive(Clone, Default)]
pub(crate) struct CancellationSource(Arc<CancellationState>);

impl CancellationSource {
	pub(crate) fn token(&self) -> OperationToken {
		OperationToken {
			source:     self.clone(),
			generation: self.0.generation.load(Ordering::Acquire),
		}
	}

	/// Ends a successful run without surrendering an explicitly granted task
	/// lease.
	pub(crate) fn retire(&self) {
		let _state = self.0.state.lock();
		self.0.generation.fetch_add(1, Ordering::AcqRel);
		self.0.wake.notify_all();
		#[cfg(target_os = "linux")]
		self.0.async_wake.notify_waiters();
	}

	/// Aborts current/queued work and revokes any explicit task ownership.
	pub(crate) fn cancel(&self) {
		let lease = {
			let mut state = self.0.state.lock();
			self.0.generation.fetch_add(1, Ordering::AcqRel);
			self.0.wake.notify_all();
			#[cfg(target_os = "linux")]
			self.0.async_wake.notify_waiters();
			state.take()
		};
		drop(lease);
	}

	pub(crate) fn acquire_control(&self, token: &OperationToken) -> CoreResult<()> {
		let mut state = self.0.state.lock();
		token.check()?;
		if !Arc::ptr_eq(&self.0, &token.source.0) {
			return Err(busy());
		}
		if state.is_none() {
			*state = Some(Arc::new(ControlLease::acquire(self)?));
		}
		Ok(())
	}

	pub(crate) fn release_control(&self) {
		// A release is also a generation boundary: queued work authorized by the
		// relinquished grant must never execute under a later acquisition.
		self.cancel();
	}

	pub(crate) fn control_active(&self) -> bool {
		self.0.state.lock().is_some()
	}
}

/// Weak callback ownership avoids a lease -> monitor -> source -> lease cycle.
#[derive(Clone)]
pub(super) struct EmergencyStop(Weak<CancellationState>);

impl EmergencyStop {
	fn cancel(&self) {
		if let Some(source) = self.0.upgrade() {
			CancellationSource(source).cancel();
		}
	}
}

#[derive(Clone)]
pub(crate) struct OperationToken {
	source:     CancellationSource,
	generation: u64,
}

impl OperationToken {
	pub(crate) fn control_active(&self) -> bool {
		self.source.control_active()
	}

	pub(crate) fn enter(&self) -> OperationScope {
		let previous = CURRENT.with_borrow_mut(|current| current.replace(self.clone()));
		OperationScope { previous, _thread: PhantomData }
	}

	pub(crate) fn check(&self) -> CoreResult<()> {
		if self.source.0.generation.load(Ordering::Acquire) == self.generation {
			Ok(())
		} else {
			Err(DesktopError::cancelled(
				"desktop operation cancelled; input may be partial; inspect before retrying",
			))
		}
	}

	#[cfg(target_os = "linux")]
	pub(crate) async fn cancelled(&self) -> DesktopError {
		loop {
			let notified = self.source.0.async_wake.notified();
			let mut notified = std::pin::pin!(notified);
			notified.as_mut().enable();
			if let Err(error) = self.check() {
				return error;
			}
			notified.await;
		}
	}

	pub(crate) fn wait(&self, duration: Duration) -> CoreResult<()> {
		let deadline = Instant::now() + duration;
		let mut state = self.source.0.state.lock();
		loop {
			self.check()?;
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Ok(());
			}
			self.source.0.wake.wait_for(&mut state, remaining);
		}
	}
}

thread_local! {
	static CURRENT: RefCell<Option<OperationToken>> = const { RefCell::new(None) };
	static CLEANUP: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct OperationScope {
	previous: Option<OperationToken>,
	_thread:  PhantomData<Rc<()>>,
}

impl Drop for OperationScope {
	fn drop(&mut self) {
		CURRENT.with_borrow_mut(|current| *current = self.previous.take());
	}
}

#[cfg(target_os = "linux")]
pub(crate) fn is_cleaning_up() -> bool {
	CLEANUP.get()
}

pub(crate) fn current_token() -> Option<OperationToken> {
	if CLEANUP.get() {
		None
	} else {
		CURRENT.with_borrow(Clone::clone)
	}
}

pub(crate) fn check() -> CoreResult<()> {
	if CLEANUP.get() {
		return Ok(());
	}
	CURRENT.with_borrow(|token| token.as_ref().map_or(Ok(()), OperationToken::check))
}

pub(crate) fn wait(duration: Duration) -> CoreResult<()> {
	if CLEANUP.get() {
		thread::sleep(duration);
		return Ok(());
	}
	CURRENT.with_borrow(|token| {
		if let Some(token) = token {
			token.wait(duration)
		} else {
			thread::sleep(duration);
			Ok(())
		}
	})
}

/// Cleanup must release already-held input even after cancellation. This does
/// not clear a token or authorize any later operation. Nested cleanup is safe.
pub(crate) fn cleanup<T>(action: impl FnOnce() -> T) -> T {
	struct Restore(bool);
	impl Drop for Restore {
		fn drop(&mut self) {
			CLEANUP.set(self.0);
		}
	}
	let _restore = Restore(CLEANUP.replace(true));
	action()
}

/// Owns one bounded button hold. An attempted press can be partially delivered,
/// so release is mandatory even when that press reports an error.
pub(crate) fn bounded_hold(
	duration: Duration,
	mut transition: impl FnMut(bool) -> CoreResult<()>,
) -> CoreResult<()> {
	check()?;
	let result = transition(true).and_then(|()| wait(duration));
	let released = cleanup(|| transition(false));
	match (result, released) {
		(Err(mut error), Err(release)) => {
			error.message.push_str("; input release also failed: ");
			error.message.push_str(&release.message);
			Err(error)
		},
		(Err(error), _) | (_, Err(error)) => Err(error),
		(Ok(()), Ok(())) => Ok(()),
	}
}

pub(crate) fn key_modifiers(keys: &[super::keys::KeyName]) -> super::backend::Modifiers {
	use super::keys::KeyName;
	super::backend::Modifiers {
		ctrl:  keys.contains(&KeyName::Ctrl),
		alt:   keys.contains(&KeyName::Alt),
		shift: keys.contains(&KeyName::Shift),
		meta:  keys.contains(&KeyName::Meta),
	}
}

/// Merge modifier options into the already-owned arbitrary-key gesture list.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn add_modifiers(
	keys: &mut Vec<super::keys::KeyName>,
	modifiers: super::backend::Modifiers,
) {
	use super::keys::KeyName;
	for (enabled, key) in [
		(modifiers.ctrl, KeyName::Ctrl),
		(modifiers.alt, KeyName::Alt),
		(modifiers.shift, KeyName::Shift),
		(modifiers.meta, KeyName::Meta),
	] {
		if enabled && !keys.contains(&key) {
			keys.push(key);
		}
	}
}

#[cfg(test)]
pub(crate) fn with_token_for_test<T>(token: &OperationToken, action: impl FnOnce() -> T) -> T {
	let _scope = token.enter();
	action()
}

#[cfg(target_os = "macos")]
static USER_ACTIVITY: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
pub(crate) fn user_activity() -> u64 {
	USER_ACTIVITY.load(Ordering::Acquire)
}

static OWNED: AtomicBool = AtomicBool::new(false);

struct ProcessLease;
impl ProcessLease {
	fn acquire() -> CoreResult<Self> {
		OWNED
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map_err(|_| busy())?;
		Ok(Self)
	}
}
impl Drop for ProcessLease {
	fn drop(&mut self) {
		OWNED.store(false, Ordering::Release);
	}
}

fn busy() -> DesktopError {
	DesktopError::input_busy("another desktop operation owns input/focus control; no input was sent")
}

/// The kernel owner lives on its own thread: Windows mutex release must happen
/// on the same thread that acquired it, even when the session is disposed from
/// another host thread. Closing/crashing the process releases the OS resource.
struct ControlLease {
	#[cfg(target_os = "macos")]
	_escape: Option<macos::EscapeMonitor>,
	#[cfg(windows)]
	_escape: Option<windows::EscapeMonitor>,
	#[cfg(target_os = "linux")]
	_escape: Option<linux::EscapeMonitor>,
	_kernel: KernelOwner,
	running: AtomicBool,
}

impl ControlLease {
	fn acquire(source: &CancellationSource) -> CoreResult<Self> {
		let kernel = KernelOwner::acquire()?;
		#[cfg(target_os = "macos")]
		let escape = macos::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		#[cfg(windows)]
		let escape = windows::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		#[cfg(target_os = "linux")]
		let escape = linux::EscapeMonitor::start(EmergencyStop(Arc::downgrade(&source.0)))?;
		Ok(Self {
			#[cfg(any(target_os = "macos", windows))]
			_escape: Some(escape),
			#[cfg(target_os = "linux")]
			_escape: escape,
			_kernel: kernel,
			running: AtomicBool::new(false),
		})
	}
}

struct KernelOwner {
	stop:   Option<flume::Sender<()>>,
	thread: Option<thread::JoinHandle<()>>,
}

impl KernelOwner {
	fn acquire() -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let (stop, stopped) = flume::bounded(1);
		let thread = thread::Builder::new()
			.name("desktop-owner".into())
			.spawn(move || {
				let leases = ProcessLease::acquire()
					.and_then(|process| KernelLease::acquire().map(|kernel| (kernel, process)));
				match leases {
					Ok(_leases) => {
						let _ = ready.send(Ok(()));
						let _ = stopped.recv();
					},
					Err(error) => {
						let _ = ready.send(Err(error));
					},
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start desktop owner: {error}"))
			})?;
		let owner = Self { stop: Some(stop), thread: Some(thread) };
		receive.recv().map_err(|_| {
			DesktopError::input_failed("desktop owner stopped before acquiring input")
		})??;
		Ok(owner)
	}
}

impl Drop for KernelOwner {
	fn drop(&mut self) {
		self.stop.take();
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

pub(crate) struct InputLease {
	_scope:  OperationScope,
	owner:   Arc<ControlLease>,
	_thread: PhantomData<Rc<()>>,
}

impl InputLease {
	pub(crate) fn acquire(token: &OperationToken) -> CoreResult<Self> {
		token.check()?;
		let owner = {
			let state = token.source.0.state.lock();
			token.check()?;
			match state.as_ref() {
				Some(owner) => owner.clone(),
				None => Arc::new(ControlLease::acquire(&token.source)?),
			}
		};
		owner
			.running
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map_err(|_| busy())?;
		let lease = Self { _scope: token.enter(), owner, _thread: PhantomData };
		token.check()?;
		Ok(lease)
	}
}

impl Drop for InputLease {
	fn drop(&mut self) {
		self.owner.running.store(false, Ordering::Release);
	}
}

#[cfg(unix)]
struct KernelLease(std::fs::File);

#[cfg(unix)]
impl KernelLease {
	fn acquire() -> CoreResult<Self> {
		Self::at(&Self::path())
	}

	/// A fixed per-login-user inode coordinates independently launched hosts.
	/// Never unlink it: unlinking a locked inode would create two lock domains.
	#[cfg(not(test))]
	fn path() -> std::path::PathBuf {
		// SAFETY: geteuid has no preconditions.
		let uid = unsafe { libc::geteuid() };
		std::path::PathBuf::from(format!("/tmp/pi-desktop-input-{uid}.lock"))
	}

	/// nextest runs every test in its own process; a per-process inode keeps
	/// concurrent test processes and a live host from contending for input.
	#[cfg(test)]
	fn path() -> std::path::PathBuf {
		std::env::temp_dir().join(format!("pi-desktop-input-test-{}.lock", std::process::id()))
	}

	fn at(path: &std::path::Path) -> CoreResult<Self> {
		use std::os::unix::{
			fs::{MetadataExt, OpenOptionsExt},
			io::AsRawFd,
		};
		let file = std::fs::OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.mode(0o600)
			.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
			.open(path)
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot acquire desktop ownership: {error}"))
			})?;
		let metadata = file.metadata().map_err(|error| {
			DesktopError::input_failed(format!("cannot inspect desktop ownership: {error}"))
		})?;
		// SAFETY: geteuid has no preconditions.
		let uid = unsafe { libc::geteuid() };
		if !metadata.is_file()
			|| metadata.uid() != uid
			|| metadata.nlink() != 1
			|| metadata.mode() & 0o077 != 0
		{
			return Err(DesktopError::input_failed(
				"desktop ownership file is not a private regular file",
			));
		}
		// SAFETY: the descriptor remains owned by `file`; flock is nonblocking.
		if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
			let error = std::io::Error::last_os_error();
			if error.kind() == std::io::ErrorKind::WouldBlock {
				return Err(busy());
			}
			return Err(DesktopError::input_failed(format!("cannot lock desktop ownership: {error}")));
		}
		Ok(Self(file))
	}
}

#[cfg(unix)]
impl Drop for KernelLease {
	fn drop(&mut self) {
		use std::os::fd::AsRawFd;
		// SAFETY: this guard owns the live locked descriptor.
		unsafe {
			libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
		}
	}
}

#[cfg(windows)]
struct KernelLease(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl KernelLease {
	fn acquire() -> CoreResult<Self> {
		use windows_sys::Win32::{
			Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
			System::Threading::{CreateMutexW, WaitForSingleObject},
		};
		let name = Self::name();
		// SAFETY: nul-terminated name and default security descriptor are valid.
		let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
		if handle.is_null() {
			return Err(DesktopError::input_failed("cannot open desktop ownership mutex"));
		}
		// SAFETY: handle is live; zero timeout never queues or retries input.
		let status = unsafe { WaitForSingleObject(handle, 0) };
		if status == WAIT_OBJECT_0 || status == WAIT_ABANDONED {
			return Ok(Self(handle));
		}
		// SAFETY: the failed acquisition still owns its opened handle.
		unsafe {
			CloseHandle(handle);
		}
		if status == WAIT_TIMEOUT {
			return Err(busy());
		}
		Err(DesktopError::input_failed("cannot acquire desktop ownership mutex"))
	}

	/// Nul-terminated mutex name shared by every host in the login session.
	#[cfg(not(test))]
	fn name() -> Vec<u16> {
		"Local\\PiDesktopInput-v1\0".encode_utf16().collect()
	}

	/// nextest runs every test in its own process; a per-process mutex keeps
	/// concurrent test processes and a live host from contending for input.
	#[cfg(test)]
	fn name() -> Vec<u16> {
		format!("Local\\PiDesktopInput-test-{}\0", std::process::id())
			.encode_utf16()
			.collect()
	}
}

#[cfg(windows)]
impl Drop for KernelLease {
	fn drop(&mut self) {
		// SAFETY: this thread owns both the mutex and its handle.
		unsafe {
			windows_sys::Win32::System::Threading::ReleaseMutex(self.0);
			windows_sys::Win32::Foundation::CloseHandle(self.0);
		}
	}
}

#[cfg(test)]
mod ownership_tests {
	use super::*;

	static OWNERSHIP_TEST: Mutex<()> = Mutex::new(());

	/// Real ownership without OS event monitoring: lifecycle regressions must
	/// not depend on an interactive desktop or Accessibility permissions.
	fn grant_for_test(source: &CancellationSource) {
		let owner = ControlLease {
			_escape: None,
			_kernel: KernelOwner::acquire().expect("test kernel owner"),
			running: AtomicBool::new(false),
		};
		*source.0.state.lock() = Some(Arc::new(owner));
	}

	/// Removes this process's private kernel lock (see `KernelLease::path`).
	fn remove_test_lock() {
		#[cfg(unix)]
		let _ = std::fs::remove_file(KernelLease::path());
	}

	#[test]
	fn task_lease_survives_retirement_but_abort_and_release_revoke_it() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		grant_for_test(&source);
		source
			.acquire_control(&source.token())
			.expect("idempotent acquisition");
		let old = source.token();
		{
			let _operation = InputLease::acquire(&old).expect("reuse task ownership");
			assert!(InputLease::acquire(&source.token()).is_err());
			assert!(InputLease::acquire(&CancellationSource::default().token()).is_err());
		}
		source.retire();
		assert!(source.control_active());
		assert!(old.check().is_err());
		let fresh = source.token();
		let running = InputLease::acquire(&fresh).expect("fresh run reuses ownership");
		source.cancel();
		assert!(!source.control_active());
		assert!(fresh.check().is_err());
		assert!(KernelOwner::acquire().is_err(), "cleanup still owns the kernel");
		drop(running);
		drop(KernelOwner::acquire().expect("cleanup releases ownership"));
		grant_for_test(&source);
		let queued = source.token();
		source.release_control();
		assert!(!source.control_active());
		assert!(queued.check().is_err());
		assert!(source.acquire_control(&queued).is_err(), "stale acquisition cannot grant ownership");
		assert!(!source.control_active());
		grant_for_test(&source);
		assert!(queued.check().is_err(), "reacquiring cannot revive queued input");
		drop((old, fresh, queued));
		drop(source);
		drop(KernelOwner::acquire().expect("session destruction releases ownership"));
		remove_test_lock();
	}

	#[test]
	fn emergency_stop_revokes_idle_task_control_after_retirement() {
		let _serial = OWNERSHIP_TEST.lock();
		let source = CancellationSource::default();
		grant_for_test(&source);
		let emergency = EmergencyStop(Arc::downgrade(&source.0));
		source.retire();
		let fresh = source.token();
		emergency.cancel();
		assert!(!source.control_active());
		assert!(fresh.check().is_err());
		drop(KernelOwner::acquire().expect("idle Escape releases kernel ownership"));
		remove_test_lock();
	}

	#[test]
	fn bounded_button_hold_releases_on_success_cancel_and_partial_press() {
		let mut events = Vec::new();
		bounded_hold(Duration::ZERO, |down| {
			events.push(down);
			Ok(())
		})
		.unwrap();
		assert_eq!(events, [true, false]);

		events.clear();
		let source = CancellationSource::default();
		let token = source.token();
		let result = with_token_for_test(&token, || {
			bounded_hold(Duration::from_secs(100), |down| {
				events.push(down);
				if down {
					source.cancel();
				}
				Ok(())
			})
		});
		assert!(result.is_err());
		assert_eq!(events, [true, false]);
		assert!(token.check().is_err());

		events.clear();
		let result = bounded_hold(Duration::from_secs(100), |down| {
			events.push(down);
			Err(DesktopError::input_failed(if down {
				"partial press"
			} else {
				"release failed"
			}))
		});
		let message = result.unwrap_err().message;
		assert!(message.contains("partial press") && message.contains("release failed"));
		assert_eq!(events, [true, false]);
	}

	#[test]
	fn cancellation_wakes_a_bounded_hold_without_polling() {
		let source = CancellationSource::default();
		let token = source.token();
		let (ready, waiting) = flume::bounded(1);
		let worker = thread::spawn(move || {
			ready.send(()).unwrap();
			token.wait(Duration::from_secs(100))
		});
		waiting.recv().unwrap();
		source.cancel();
		assert!(worker.join().unwrap().is_err());
	}

	#[test]
	fn cancellation_never_revives_queued_generations() {
		let source = CancellationSource::default();
		let running = source.token();
		let queued = source.token();
		source.cancel();
		let later = source.token();
		assert!(running.check().is_err());
		assert!(queued.check().is_err());
		assert!(later.check().is_ok());
		source.cancel();
		assert!(later.check().is_err());
		assert!(source.token().check().is_ok());
		assert!(running.check().is_err());
	}

	#[test]
	fn newer_scope_cannot_revive_an_older_operation() {
		let source = CancellationSource::default();
		let old = source.token();
		let _scope = old.enter();
		source.cancel();
		{
			let _later = source.token().enter();
			assert!(check().is_ok());
		}
		assert!(check().is_err());
	}

	#[test]
	fn cleanup_does_not_clear_cancellation() {
		let source = CancellationSource::default();
		CURRENT.with_borrow_mut(|current| *current = Some(source.token()));
		source.cancel();
		cleanup(|| {
			assert!(check().is_ok());
			cleanup(|| assert!(check().is_ok()));
		});
		assert!(check().is_err());
		CURRENT.with_borrow_mut(|current| *current = None);
	}

	#[test]
	fn process_ownership_fails_closed_and_releases() {
		let _serial = OWNERSHIP_TEST.lock();
		let first = ProcessLease::acquire().expect("first lease");
		assert!(ProcessLease::acquire().is_err());
		drop(first);
		assert!(ProcessLease::acquire().is_ok());
	}

	#[cfg(unix)]
	#[test]
	fn kernel_child_probe() {
		let Some(path) = std::env::var_os("PI_CONTROL_TEST_LOCK") else {
			return;
		};
		let acquired = KernelLease::at(std::path::Path::new(&path));
		assert_eq!(acquired.is_ok(), std::env::var_os("PI_CONTROL_TEST_FREE").is_some());
		if acquired.is_ok() {
			// Deliberately skip Rust destructors, as on a crashed host.
			std::process::exit(0);
		}
	}

	#[cfg(unix)]
	#[test]
	fn independent_processes_contend_and_release() {
		let path =
			std::env::temp_dir().join(format!("pi-control-process-test-{}.lock", std::process::id()));
		let first = KernelLease::at(&path).expect("parent lease");
		let child = |free: bool| {
			let mut command =
				std::process::Command::new(std::env::current_exe().expect("test binary"));
			command
				.args(["--exact", "desktop::control::tests::kernel_child_probe"])
				.env("PI_CONTROL_TEST_LOCK", &path)
				.env_remove("PI_CONTROL_TEST_FREE");
			if free {
				command.env("PI_CONTROL_TEST_FREE", "1");
			}
			assert!(command.status().expect("child probe").success());
		};
		child(false);
		drop(first);
		child(true);
		let recovered =
			KernelLease::at(&path).expect("kernel releases ownership after abrupt child exit");
		drop(recovered);
		std::fs::remove_file(path).expect("remove process test lock");
	}

	#[cfg(unix)]
	#[test]
	fn independent_kernel_handles_contend_and_release() {
		let path = std::env::temp_dir().join(format!("pi-control-test-{}.lock", std::process::id()));
		let first = KernelLease::at(&path).expect("first kernel lease");
		assert!(KernelLease::at(&path).is_err());
		drop(first);
		let second = KernelLease::at(&path).expect("lease after release");
		drop(second);
		std::fs::remove_file(path).expect("remove test lock");
	}
}
