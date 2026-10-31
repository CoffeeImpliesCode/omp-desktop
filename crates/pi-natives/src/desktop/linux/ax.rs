use atspi::{CoordType, ObjectRefOwned, Role, State, proxy::accessible::ObjectRefExt};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_atspi},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

mod menus;

pub struct AtSpiAx {
	rt:         Runtime,
	connection: atspi::AccessibilityConnection,
}

/// An AT-SPI top-level frame and whether its reported screen position is real.
///
/// Native Wayland clients cannot learn where the compositor placed them, so
/// their toolkits answer `CoordType::Screen` with window-relative coordinates
/// (usually `0,0`). Consumers that map `window` bounds onto a desktop capture
/// (the Wayland window crop) must refuse when `position_known` is false.
pub struct AtSpiWindow {
	pub window:         DesktopWindow,
	/// Screen and window-relative origins differ, so `window.x`/`window.y` are
	/// global compositor coordinates. False also covers a window genuinely at
	/// the global origin, which is indistinguishable over AT-SPI.
	pub position_known: bool,
}

impl AtSpiAx {
	pub(crate) fn new() -> CoreResult<Self> {
		let rt = Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI runtime: {err}")))?;
		let connection = rt
			.block_on(atspi::AccessibilityConnection::new())
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI connection: {err}")))?;
		Ok(Self { rt, connection })
	}

	const fn object(h: &AxHandle) -> &ObjectRefOwned {
		match h {
			AxHandle::AtSpi(object) => object,
			#[cfg(test)]
			_ => panic!("AT-SPI backend received a non-AT-SPI handle"),
		}
	}

	pub(crate) fn windows(&self) -> CoreResult<Vec<AtSpiWindow>> {
		self.rt.block_on(async {
			let mut windows = Vec::new();
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				let app_proxy = app
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI application: {err}")))?;
				let app_name = app_proxy.name().await.unwrap_or_default();
				let pid = if let Some(bus_name) = app.name() {
					let dbus = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
						.await
						.ok();
					if let Some(dbus) = dbus {
						dbus
							.get_connection_unix_process_id(bus_name.clone().into())
							.await
							.ok()
					} else {
						None
					}
				} else {
					None
				};
				for frame in Self::frames(&self.connection, &app)
					.await
					.unwrap_or_default()
				{
					let frame_proxy = frame
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame: {err}")))?;
					let title = frame_proxy.name().await.unwrap_or_default();
					let state = frame_proxy.get_state().await.ok();
					let Ok(component) = Self::component(&self.connection, &frame).await else {
						continue;
					};
					let Ok((x, y, width, height)) = component.get_extents(CoordType::Screen).await
					else {
						continue;
					};
					if width < 16 || height < 16 {
						continue;
					}
					let position_known = component
						.get_extents(CoordType::Window)
						.await
						.is_ok_and(|(window_x, window_y, ..)| (window_x, window_y) != (x, y));
					let id = atspi_window_id(&frame);
					windows.push(AtSpiWindow {
						window: DesktopWindow {
							id,
							title,
							app: app_name.clone(),
							pid,
							position_known: Some(position_known),
							x,
							y,
							width: width as u32,
							height: height as u32,
							focused: state.as_ref().is_some_and(|states| {
								states.contains(State::Focused) || states.contains(State::Active)
							}),
						},
						position_known,
					});
					if windows.len() == 48 {
						return Ok(windows);
					}
				}
			}
			Ok(windows)
		})
	}

	async fn apps(
		connection: &atspi::AccessibilityConnection,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let root = connection
			.root_accessible_on_registry()
			.await
			.map_err(|err| err.to_string())?;
		root.get_children().await.map_err(|err| err.to_string())
	}

	/// The AT-SPI application serving `win`, with the process that owns its
	/// accessibility connection when ownership, not the application name,
	/// established the match.
	async fn app_for_window(
		connection: &atspi::AccessibilityConnection,
		win: &DesktopWindow,
		compositor: Option<u32>,
	) -> Result<(ObjectRefOwned, Option<u32>), String> {
		let apps = Self::apps(connection).await?;
		let mut matches = Vec::new();
		for app in apps {
			if win.id.starts_with("atspi:") {
				if app
					.name()
					.is_some_and(|name| win.id.starts_with(&format!("atspi:{name}:")))
				{
					matches.push((0, app, None));
				}
				continue;
			}
			// A niri window without a pid is one whose client could not be
			// identified; an application name alone does not prove which of
			// its windows this is.
			if win.pid.is_none() && !win.id.starts_with("niri:") {
				let proxy = app
					.as_accessible_proxy(connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				if proxy
					.name()
					.await
					.unwrap_or_default()
					.eq_ignore_ascii_case(&win.app)
				{
					matches.push((0, app, None));
				}
				continue;
			}
			let Some(bus_name) = app.name() else {
				continue;
			};
			let dbus = atspi::zbus::fdo::DBusProxy::new(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			if let Ok(owner) = dbus
				.get_connection_unix_process_id(bus_name.clone().into())
				.await
				&& let Some(rank) = ownership_rank(owner, win, compositor)
			{
				matches.push((rank, app, Some(owner)));
			}
		}
		// The closest owner wins: a terminal or launcher that started the app is
		// an ancestor too and has its own accessibility tree.
		let best = matches.iter().map(|(rank, ..)| *rank).min();
		matches.retain(|(rank, ..)| Some(*rank) == best);
		if matches.len() == 1 {
			let (_, app, owner) = matches.remove(0);
			Ok((app, owner))
		} else {
			Err(format!(
				"application '{}' (pid {:?}) has {} AT-SPI matches; refusing ambiguous ownership",
				win.app,
				win.pid,
				matches.len()
			))
		}
	}

	async fn frames(
		connection: &atspi::AccessibilityConnection,
		app: &ObjectRefOwned,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let proxy = app
			.as_accessible_proxy(connection.connection())
			.await
			.map_err(|err| err.to_string())?;
		let children = proxy.get_children().await.map_err(|err| err.to_string())?;
		let mut frames = Vec::new();
		for child in children {
			let child_proxy = child
				.as_accessible_proxy(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			if matches!(child_proxy.get_role().await, Ok(Role::Frame | Role::Dialog | Role::Window)) {
				frames.push(child);
			}
		}
		Ok(frames)
	}

	/// Whether `frame` is the only top-level frame of its application.
	async fn sole_frame(
		connection: &atspi::AccessibilityConnection,
		frame: &atspi::proxy::accessible::AccessibleProxy<'_>,
	) -> Result<bool, String> {
		let app = frame.parent().await.map_err(|err| err.to_string())?;
		if app.is_null() {
			return Ok(false);
		}
		Ok(Self::frames(connection, &app).await?.len() == 1)
	}

	async fn component<'a>(
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::component::ComponentProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::component::ComponentProxy::builder(connection.connection())
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	async fn action<'a>(
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::action::ActionProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::action::ActionProxy::builder(connection.connection())
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	async fn find_focused(
		connection: &atspi::zbus::Connection,
		root: ObjectRefOwned,
		depth: u8,
	) -> Result<Option<ObjectRefOwned>, String> {
		// Chromium/Electron frames report children that are the AT-SPI null
		// object.
		if depth > 40 || root.is_null() {
			return Ok(None);
		}
		let proxy = root
			.as_accessible_proxy(connection)
			.await
			.map_err(|err| err.to_string())?;
		if proxy
			.get_state()
			.await
			.is_ok_and(|state| state.contains(State::Focused))
		{
			return Ok(Some(root));
		}
		for child in proxy.get_children().await.unwrap_or_default() {
			if let Some(found) = Box::pin(Self::find_focused(connection, child, depth + 1)).await? {
				return Ok(Some(found));
			}
		}
		Ok(None)
	}
}

fn atspi_window_id(frame: &ObjectRefOwned) -> String {
	let name = frame.name().map_or_default(ToString::to_string);
	format!("atspi:{name}:{}", frame.path())
}

/// Generations from `client` up to its ancestor `owner`, if `owner` is one.
fn ancestor_distance(owner: u32, mut client: u32) -> Option<u32> {
	// Browser Wayland connections can belong to a child process while AT-SPI
	// belongs to its parent. Only ancestry, never shared titles/apps, proves it.
	for distance in 0..32 {
		if owner == client {
			return Some(distance);
		}
		let stat = std::fs::read_to_string(format!("/proc/{client}/stat")).ok()?;
		let parent = stat
			.rsplit_once(')')?
			.1
			.split_whitespace()
			.nth(1)?
			.parse::<u32>()
			.ok()?;
		if parent == client || parent <= 1 {
			return None;
		}
		client = parent;
	}
	None
}

/// How closely the accessibility connection owned by process `owner` is tied
/// to the native `window`, lower being closer, or `None` when it is not.
///
/// The owner is the window's own client (rank 0) or, for a niri window, whose
/// pid the compositor reads from the Wayland socket, a process of the same
/// Flatpak instance (rank 1) or an ancestor of that client (2 plus the
/// generations between them; browsers draw from a child process). A sandboxed
/// app reaches the accessibility bus through `xdg-dbus-proxy`, which runs
/// beside the app's process tree, not above it. The `compositor` is an
/// ancestor of everything it spawned, so ancestry from it proves nothing and
/// is accepted only when the compositor is known.
fn ownership_rank(owner: u32, window: &DesktopWindow, compositor: Option<u32>) -> Option<u32> {
	if window.id.starts_with("atspi:") {
		return None;
	}
	let client = window.pid?;
	if client == owner {
		return Some(0);
	}
	if !window.id.starts_with("niri:") {
		return None;
	}
	if same_flatpak_instance(owner, client) {
		return Some(1);
	}
	compositor
		.filter(|compositor| *compositor != owner)
		.and_then(|_| ancestor_distance(owner, client))
		.map(|distance| distance + 2)
}

/// Whether the accessibility connection owned by `owner` serves `window`.
fn owner_serves_window(owner: u32, window: &DesktopWindow, compositor: Option<u32>) -> bool {
	ownership_rank(owner, window, compositor).is_some()
}

/// Whether both processes run in one Flatpak instance.
///
/// Flatpak bind-mounts the instance's `.flatpak-info` at the root of every
/// process it sandboxes, its D-Bus proxies included; xdg-desktop-portal
/// identifies a proxied D-Bus peer the same way.
fn same_flatpak_instance(owner: u32, client: u32) -> bool {
	let instance = |pid: u32| {
		std::fs::read_to_string(format!("/proc/{pid}/root/.flatpak-info"))
			.ok()
			.and_then(|info| flatpak_instance_id(&info).map(str::to_owned))
	};
	instance(owner).is_some_and(|owner| instance(client).is_some_and(|client| owner == client))
}

/// `instance-id` of the `[Instance]` group of a `.flatpak-info` key file.
fn flatpak_instance_id(info: &str) -> Option<&str> {
	let mut in_instance = false;
	for line in info.lines().map(str::trim) {
		if line.starts_with('[') {
			in_instance = line == "[Instance]";
		} else if in_instance && let Some(id) = line.strip_prefix("instance-id=") {
			return Some(id.trim()).filter(|id| !id.is_empty());
		}
	}
	None
}

/// Top-level frames of the application serving a window, with their names.
struct FrameCandidates<T = ObjectRefOwned> {
	/// Process owning the application's accessibility connection, when
	/// ownership rather than the application name matched it.
	owner:  Option<u32>,
	frames: Vec<(T, String)>,
}

/// The frame of native window `win`.
///
/// The one frame titled like the window is it. A toolkit may also publish a
/// frame without the window's title: unnamed, or with a title it never
/// updated. Such a frame stands for the window only when it is the
/// application's only frame, the window is a niri window, the application was
/// matched by process ownership, and the compositor shows no other window that
/// owner serves (`sole_window`). Anything else is refused as ambiguous.
fn select_frame<T>(
	candidates: FrameCandidates<T>,
	win: &DesktopWindow,
	sole_window: impl FnOnce(u32) -> bool,
) -> Result<T, String> {
	let FrameCandidates { owner, mut frames } = candidates;
	let total = frames.len();
	let mut titled = frames
		.iter()
		.enumerate()
		.filter(|(_, (_, name))| name == &win.title)
		.map(|(index, _)| index);
	match (titled.next(), titled.next()) {
		(Some(index), None) => return Ok(frames.swap_remove(index).0),
		(Some(_), Some(_)) => {
			return Err(format!(
				"window '{}' has several AT-SPI frames with its title; refusing ambiguous ownership",
				win.title
			));
		},
		(None, _) => {},
	}
	if total == 1 && win.id.starts_with("niri:") && owner.is_some_and(sole_window) {
		return Ok(frames.swap_remove(0).0);
	}
	Err(format!(
		"window '{}' matches none of its application's {total} AT-SPI frames by title, and no frame \
		 is provably its own",
		win.title
	))
}

/// The native window an AT-SPI frame belongs to.
///
/// `serves` says whether the frame's accessibility owner serves a native
/// window. The one served window titled like the frame is it. A frame without
/// such a title that is its application's only frame (`sole_frame`) stands
/// for the owner's window only when the owner serves exactly one niri window.
fn native_window_for_frame(
	windows: &[DesktopWindow],
	serves: impl Fn(&DesktopWindow) -> bool,
	title: &str,
	sole_frame: bool,
) -> CoreResult<String> {
	let served = windows
		.iter()
		.filter(|window| serves(window))
		.collect::<Vec<_>>();
	let mut titled = served.iter().filter(|window| window.title == title);
	match (titled.next(), titled.next()) {
		(Some(window), None) => return Ok(window.id.clone()),
		(Some(_), Some(_)) => {
			return Err(DesktopError::ax_failed(
				"AT-SPI frame matches multiple native windows; refusing ambiguous input ownership",
			));
		},
		(None, _) => {},
	}
	if let [window] = served.as_slice()
		&& sole_frame
		&& window.id.starts_with("niri:")
	{
		return Ok(window.id.clone());
	}
	Err(DesktopError::window_not_found("AT-SPI frame has no matching native window"))
}

/// Generic press means activation, not action zero (GTK4 text views put
/// `buffer.delete-line` there). Explicit advertised actions remain available.
fn action_index<'a>(
	mut actions: impl Iterator<Item = &'a str> + Clone,
	requested: &str,
) -> Option<usize> {
	actions
		.clone()
		.position(|name| name.eq_ignore_ascii_case(requested))
		.or_else(|| {
			requested
				.eq_ignore_ascii_case("press")
				.then(|| {
					actions.position(|name| {
						[
							"click",
							"clickAncestor",
							"activate",
							"invoke",
							"toggle",
							"open",
							"jump",
							"do default",
							"do-default",
						]
						.iter()
						.any(|safe| name.eq_ignore_ascii_case(safe))
					})
				})
				.flatten()
		})
}

impl AxBackend for AtSpiAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		// niri IPC drives its own runtime, which cannot start inside this one,
		// so compositor state is read before and after the AT-SPI work.
		let compositor = win
			.id
			.starts_with("niri:")
			.then(super::wayland::compositor_pid)
			.flatten();
		let result = self.rt.block_on(async {
			let (app, owner) = Self::app_for_window(&self.connection, win, compositor).await?;
			let frames = Self::frames(&self.connection, &app).await?;
			let mut named = Vec::new();
			for frame in frames {
				let id = atspi_window_id(&frame);
				if win.id.starts_with("atspi:") {
					if id == win.id {
						return Ok(FrameCandidates { owner, frames: vec![(frame, win.title.clone())] });
					}
					continue;
				}
				let proxy = frame
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				let name = proxy.name().await.map_err(|err| err.to_string())?;
				named.push((frame, name));
			}
			Ok(FrameCandidates { owner, frames: named })
		});
		result
			.and_then(|candidates| {
				let sole_window = |owner: u32| {
					super::wayland::compositor_windows().is_some_and(|windows| {
						windows
							.iter()
							.filter(|window| owner_serves_window(owner, window, compositor))
							.count()
							== 1
					})
				};
				select_frame(candidates, win, sole_window)
			})
			.map(AxHandle::AtSpi)
			.map_err(|err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}")))
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let mut object = Self::object(h).clone();
		let compositor = windows
			.iter()
			.any(|window| window.id.starts_with("niri:"))
			.then(super::wayland::compositor_pid)
			.flatten();
		self.rt.block_on(async {
			// Follow ownership, never screen containment: overlapping windows and
			// same-process dialogs are distinct input destinations.
			for _ in 0..64 {
				let proxy = object
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window owner: {err}")))?;
				let role = proxy
					.get_role()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window role: {err}")))?;
				if matches!(role, Role::Frame | Role::Dialog | Role::Window) {
					let id = atspi_window_id(&object);
					if windows.iter().any(|window| window.id == id) {
						return Ok(id);
					}
					let name = object
						.name()
						.ok_or_else(|| DesktopError::ax_failed("AT-SPI window has no bus owner"))?;
					let dbus = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
						.await
						.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
					let pid = dbus
						.get_connection_unix_process_id(name.clone().into())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window pid: {err}")))?;
					let title = proxy
						.name()
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window title: {err}")))?;
					let sole_frame = Self::sole_frame(&self.connection, &proxy)
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frames: {err}")))?;
					let id = native_window_for_frame(
						windows,
						|window| owner_serves_window(pid, window, compositor),
						&title,
						sole_frame,
					)?;
					if id.starts_with("niri:") {
						let window = windows
							.iter()
							.find(|window| window.id == id)
							.ok_or_else(|| DesktopError::window_not_found("AT-SPI owner is gone"))?;
						if window.position_known == Some(false) {
							return Err(DesktopError::invalid_coordinate_frame(
								"window has no known global origin; use an accessibility action or \
								 desktop screenshot coordinates",
							));
						}
						let component =
							Self::component(&self.connection, &object)
								.await
								.map_err(|err| {
									DesktopError::ax_failed(format!("AT-SPI window component: {err}"))
								})?;
						let (x, y, ..) =
							component
								.get_extents(CoordType::Screen)
								.await
								.map_err(|err| {
									DesktopError::ax_failed(format!("AT-SPI window origin: {err}"))
								})?;
						if (x, y) != (window.x, window.y) {
							return Err(DesktopError::invalid_coordinate_frame(
								"AT-SPI coordinates do not match the compositor's window origin; use an \
								 accessibility action or window screenshot coordinates",
							));
						}
					}
					return Ok(id);
				}
				let parent = proxy
					.parent()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window parent: {err}")))?;
				if parent.is_null() || parent == object {
					break;
				}
				drop(proxy);
				object = parent;
			}
			Err(DesktopError::ax_failed("AT-SPI element has no identifiable top-level window"))
		})
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI accessible: {err}")))?;
			let title = proxy.name().await.ok().filter(|s| !s.is_empty());
			let description = proxy.description().await.ok().filter(|s| !s.is_empty());
			let native_role = match proxy.get_role_name().await {
				Ok(role) => role,
				Err(_) => proxy
					.get_localized_role_name()
					.await
					.unwrap_or_else(|_| "unknown".to_string()),
			};
			let state = proxy.get_state().await.ok();
			let multiline = state
				.as_ref()
				.is_some_and(|states| states.contains(State::MultiLine));
			let value = if let Some(name) = object.name().cloned() {
				let builder = atspi::proxy::text::TextProxy::builder(self.connection.connection())
					.destination(name)
					.and_then(|builder| builder.path(object.path().clone()));
				if let Ok(builder) = builder
					&& let Ok(text) = builder.build().await
				{
					let count = text.character_count().await.unwrap_or(0).min(16_384);
					text.get_text(0, count).await.ok().filter(|s| !s.is_empty())
				} else {
					None
				}
			} else {
				None
			};
			let bounds = if let Ok(component) = Self::component(&self.connection, &object).await {
				component
					.get_extents(CoordType::Screen)
					.await
					.ok()
					.and_then(|(x, y, width, height)| {
						(width >= 0 && height >= 0).then_some(AxBounds {
							x:      f64::from(x),
							y:      f64::from(y),
							width:  f64::from(width),
							height: f64::from(height),
						})
					})
			} else {
				None
			};
			let actions = match Self::action(&self.connection, &object).await {
				Ok(action) => action
					.get_actions()
					.await
					.unwrap_or_default()
					.into_iter()
					.map(|a| a.name)
					.collect(),
				Err(_) => Vec::new(),
			};
			let child_count = proxy.child_count().await.unwrap_or(0).max(0) as u32;
			Ok(AxProps {
				role: normalize_role_atspi(&native_role, multiline),
				native_role,
				title,
				value,
				description,
				enabled: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Enabled)),
				focused: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Focused)),
				bounds,
				actions,
				child_count,
				identity: None,
				partial: false,
			})
		})
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))?;
			proxy
				.get_children()
				.await
				.map(|items| {
					items
						.into_iter()
						.filter(|item| !item.is_null())
						.map(AxHandle::AtSpi)
						.collect()
				})
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))
		})
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			let parent = proxy
				.parent()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			Ok((!parent.is_null()).then_some(AxHandle::AtSpi(parent)))
		})
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = Self::action(&self.connection, &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			let actions = proxy
				.get_actions()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI actions: {err}")))?;
			let mut names = actions.iter().map(|item| item.name.as_str());
			let mut index = action_index(names.clone(), action);
			if index.is_none() && action.eq_ignore_ascii_case("press") {
				let accessible = object
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				if matches!(accessible.get_role().await, Ok(Role::CheckBox | Role::CheckMenuItem)) {
					index = names.position(|name| {
						name.eq_ignore_ascii_case("check") || name.eq_ignore_ascii_case("uncheck")
					});
				}
			}
			let index = index.ok_or_else(|| {
				DesktopError::ax_failed(format!("AT-SPI action '{action}' is unavailable"))
			})? as i32;
			proxy
				.do_action(index)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?
				.ok_or_else(|| DesktopError::ax_failed(format!("AT-SPI action '{action}' failed")))
		})
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let name = object
				.name()
				.ok_or_else(|| DesktopError::ax_failed("AT-SPI object has no bus name"))?
				.clone();
			let accessible = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
			let interfaces = accessible
				.get_interfaces()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI interfaces: {err}")))?;
			if interfaces.contains(atspi::Interface::EditableText) {
				let editable = atspi::proxy::editable_text::EditableTextProxy::builder(
					self.connection.connection(),
				)
				.destination(name.clone())
				.and_then(|b| b.path(object.path().clone()))
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?
				.build()
				.await;
				let editable = editable
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI editable text: {err}")))?;
				return editable
					.set_text_contents(value)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text value: {err}")))?
					.ok_or_else(|| DesktopError::ax_failed("AT-SPI text value was rejected"));
			}
			if !interfaces.contains(atspi::Interface::Value) {
				return Err(DesktopError::ax_failed("AT-SPI element has no writable value interface"));
			}
			let numeric = value.parse::<f64>().map_err(|_| {
				DesktopError::ax_failed("AT-SPI value is not editable text or a number")
			})?;
			if !numeric.is_finite() {
				return Err(DesktopError::ax_failed("AT-SPI numeric value must be finite"));
			}
			let proxy = atspi::proxy::value::ValueProxy::builder(self.connection.connection())
				.destination(name)
				.and_then(|b| b.path(object.path().clone()))
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?
				.build()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))?;
			proxy
				.set_current_value(numeric)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))
		})
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let component = Self::component(&self.connection, &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			component
				.grab_focus()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI focus: {err}")))?
				.ok_or_else(|| DesktopError::ax_failed("AT-SPI focus request was rejected"))
		})
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let x = x.round() as i32;
		let y = y.round() as i32;
		self.rt.block_on(async {
			let mut root = None;
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				for frame in Self::frames(&self.connection, &app)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					let contains = {
						let component = Self::component(&self.connection, &frame)
							.await
							.map_err(DesktopError::ax_failed)?;
						component
							.contains(x, y, CoordType::Screen)
							.await
							.map_err(|err| {
								DesktopError::ax_failed(format!("AT-SPI frame hit test: {err}"))
							})?
					};
					if !contains {
						continue;
					}
					// AT-SPI enumeration is not stacking order. Never choose an
					// arbitrary frame when two top-levels contain the point.
					if let Some(previous) = &root {
						if previous != &frame {
							return Err(DesktopError::ax_failed(
								"multiple AT-SPI windows contain this point; topmost ownership is \
								 ambiguous",
							));
						}
					} else {
						root = Some(frame);
					}
				}
			}
			let Some(mut current) = root else {
				return Ok(None);
			};
			let mut ancestors = Vec::new();
			for _ in 0..64 {
				let has_component = {
					let accessible = current
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI hit-test element: {err}"))
						})?;
					accessible
						.get_interfaces()
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI hit-test interfaces: {err}"))
						})?
						.contains(atspi::Interface::Component)
				};
				if !has_component {
					return Ok(Some(AxHandle::AtSpi(current)));
				}
				// GetAccessibleAtPoint returns an immediate child, not
				// necessarily the leaf that owns the requested pixel.
				let child = {
					let component = Self::component(&self.connection, &current)
						.await
						.map_err(DesktopError::ax_failed)?;
					component
						.get_accessible_at_point(x, y, CoordType::Screen)
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI element at point: {err}"))
						})?
				};
				if child.is_null() || child == current {
					return Ok(Some(AxHandle::AtSpi(current)));
				}
				if ancestors.contains(&child) {
					return Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy contains a cycle"));
				}
				ancestors.push(current);
				current = child;
			}
			Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy exceeds the depth limit"))
		})
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.rt.block_on(async {
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				if let Some(found) = Self::find_focused(self.connection.connection(), app, 0)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					return Ok(Some(AxHandle::AtSpi(found)));
				}
			}
			Ok(None)
		})
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?;
			let mut attrs: Vec<_> = proxy
				.get_attributes()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?
				.into_iter()
				.map(|(key, mut value)| {
					value.truncate(200);
					(key, value)
				})
				.collect();
			attrs.sort_by(|a, b| a.0.cmp(&b.0));
			Ok(attrs)
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn generic_press_never_selects_an_unrelated_editing_action() {
		let actions = ["buffer.delete-line", "clipboard.cut", "activate"];
		assert_eq!(action_index(actions.into_iter(), "press"), Some(2));
		assert_eq!(action_index(actions[..2].iter().copied(), "press"), None);
		assert_eq!(action_index(actions.into_iter(), "buffer.delete-line"), Some(0));
		assert_eq!(action_index(std::iter::empty(), "press"), None);
	}

	fn window(id: &str, pid: u32, title: &str) -> DesktopWindow {
		DesktopWindow {
			id:             id.to_owned(),
			pid:            Some(pid),
			position_known: Some(true),
			title:          title.into(),
			app:            "Editor".into(),
			x:              0,
			y:              0,
			width:          100,
			height:         100,
			focused:        false,
		}
	}

	#[test]
	fn frame_ownership_requires_unique_process_and_title() {
		let owned_by = |owner: u32| move |window: &DesktopWindow| window.pid == Some(owner);
		let mut windows = vec![window("1", 10, "Document"), window("2", 20, "Document")];
		assert_eq!(native_window_for_frame(&windows, owned_by(20), "Document", false).unwrap(), "2");
		assert!(native_window_for_frame(&windows, owned_by(30), "Document", false).is_err());
		windows.push(window("3", 20, "Document"));
		assert!(native_window_for_frame(&windows, owned_by(20), "Document", false).is_err());
	}

	/// A frame without the window's title maps to the owner's window only when
	/// the owner serves exactly one; with two windows of one application either
	/// could be meant.
	#[test]
	fn untitled_frame_needs_a_sole_served_window() {
		let owned_by = |owner: u32| move |window: &DesktopWindow| window.pid == Some(owner);
		let mut windows = vec![window("niri:1", 10, "Part A"), window("niri:2", 20, "Other")];
		// AccessKit frames may be unnamed or keep a title the app never updated.
		for frame_title in ["", "Untitled"] {
			assert_eq!(
				native_window_for_frame(&windows, owned_by(10), frame_title, true).unwrap(),
				"niri:1"
			);
		}
		assert!(
			native_window_for_frame(&windows, owned_by(10), "", false).is_err(),
			"another frame of the application could be this window"
		);
		windows.push(window("niri:3", 10, "Part B"));
		assert!(native_window_for_frame(&windows, owned_by(10), "", true).is_err());
		let x11 = [window("0x1", 10, "Part A")];
		assert!(
			native_window_for_frame(&x11, owned_by(10), "", true).is_err(),
			"only the compositor's complete window list proves a sole window"
		);
	}

	#[test]
	fn titled_frame_wins_and_untitled_frame_needs_proven_ownership() {
		let candidates = |frames: &[(u8, &str)]| FrameCandidates {
			owner:  Some(10),
			frames: frames
				.iter()
				.map(|&(id, name)| (id, name.to_owned()))
				.collect(),
		};
		let win = window("niri:1", 10, "Part A");
		assert_eq!(select_frame(candidates(&[(1, ""), (2, "Part A")]), &win, |_| false), Ok(2));
		assert_eq!(select_frame(candidates(&[(1, "")]), &win, |_| true), Ok(1));
		assert_eq!(select_frame(candidates(&[(1, "Untitled")]), &win, |_| true), Ok(1));
		// Two windows of one application: the compositor reports another
		// window the same owner serves, so the frame may be either's.
		assert!(select_frame(candidates(&[(1, "")]), &win, |_| false).is_err());
		assert!(select_frame(candidates(&[(1, ""), (2, "Settings")]), &win, |_| true).is_err());
		assert!(select_frame(candidates(&[(1, "Part A"), (2, "Part A")]), &win, |_| true).is_err());
		let named_only = FrameCandidates { owner: None, frames: vec![(1_u8, String::new())] };
		assert!(
			select_frame(named_only, &win, |_| true).is_err(),
			"a name-matched application proves no ownership"
		);
		let x11 = window("0x1", 10, "Part A");
		assert!(select_frame(candidates(&[(1, "")]), &x11, |_| true).is_err());
	}

	/// The compositor spawns Xwayland bridges and launched apps, so its own
	/// accessibility tree must never be taken for one of their windows.
	#[test]
	fn compositor_ancestry_proves_no_ownership() {
		let parent_of = |pid: u32| {
			let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("stat");
			stat
				.rsplit_once(')')
				.and_then(|(_, fields)| fields.split_whitespace().nth(1))
				.and_then(|pid| pid.parse::<u32>().ok())
				.expect("parent pid")
		};
		let client = std::process::id();
		let parent = parent_of(client);
		let win = window("niri:1", client, "Part A");
		assert!(owner_serves_window(parent, &win, Some(1)), "an ancestor owns a child's window");
		assert!(!owner_serves_window(parent, &win, Some(parent)), "the compositor owns nothing");
		assert!(!owner_serves_window(parent, &win, None), "ancestry needs a known compositor");
		assert!(owner_serves_window(client, &win, Some(client)), "the client owns its window");
		// A terminal that launched the app is a farther ancestor than the app's
		// own process, so the app's accessibility tree ranks first.
		let grandparent = parent_of(parent);
		let rank = |owner| ownership_rank(owner, &win, Some(1));
		assert!(rank(client) < rank(parent));
		if grandparent > 1 {
			assert!(rank(parent) < rank(grandparent));
		}
	}

	#[test]
	fn flatpak_instance_id_comes_from_the_instance_group() {
		let info = concat!(
			"[Application]\nname=ai.storyteller.pdfcraft\ninstance-id=decoy\n\n",
			"[Instance]\ninstance-id=1280135730\napp-path=/app\n",
		);
		assert_eq!(flatpak_instance_id(info), Some("1280135730"));
		assert_eq!(flatpak_instance_id("[Instance]\ninstance-id=\n"), None);
		assert_eq!(flatpak_instance_id("[Application]\nname=x\n"), None);
	}

	#[test]
	fn focused_search_skips_null_child_refs() {
		use atspi::zbus::{
			connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		/// Minimal `org.a11y.atspi.Accessible` node: a state set plus `(name,
		/// path)` children.
		struct Node {
			state:    Vec<u32>,
			children: Vec<(String, OwnedObjectPath)>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Node {
			fn get_state(&self) -> Vec<u32> {
				self.state.clone()
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self.children.clone()
			}
		}

		const PEER: &str = ":1.7";
		let path = |p: &str| OwnedObjectPath::try_from(p).unwrap();
		let focused = State::Focused as u64;
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let found = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let root = Node {
				state:    vec![0, 0],
				// Chromium frames report children that are all the AT-SPI null object.
				children: vec![
					(PEER.to_owned(), path("/org/a11y/atspi/null")),
					(PEER.to_owned(), path("/focus")),
				],
			};
			let leaf =
				Node { state: vec![focused as u32, (focused >> 32) as u32], children: Vec::new() };
			let guid = atspi::zbus::Guid::generate();
			let server = ConnectionBuilder::unix_stream(server)
				.server(guid)
				.unwrap()
				.p2p()
				.serve_at("/root", root)
				.unwrap()
				.serve_at("/focus", leaf)
				.unwrap()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let root = ObjectRefOwned::from_static_str_unchecked(PEER, "/root");
			let found = AtSpiAx::find_focused(&client, root, 0).await;
			drop(server);
			found
		});
		let found = found.expect("null child refs must not fail the focused search");
		assert_eq!(
			found
				.map(|object| object.path_as_str().to_owned())
				.as_deref(),
			Some("/focus")
		);
	}
}
