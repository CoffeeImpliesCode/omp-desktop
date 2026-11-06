//! The X11 client behind a window that `xwayland-satellite` bridges into niri.
//!
//! niri reports the pid of a window's Wayland client. For an X11 application
//! that client is `xwayland-satellite`, a child of the compositor, so the pid
//! names neither the application nor anything that owns its accessibility
//! connection. The application publishes its own pid as `_NET_WM_PID` on the
//! satellite's X display; satellite maps an X top-level to a niri window with
//! its `WM_CLASS` as the app id and `_NET_WM_NAME` as the title. A niri
//! window gets the X client's pid only when exactly one viewable top-level
//! carries that class and title, so two identical windows stay unresolved
//! instead of borrowing each other's process.

use std::collections::HashMap;

use x11rb::{
	connection::Connection as _,
	protocol::xproto::{Atom, AtomEnum, ConnectionExt as _, MapState, Window},
};

use crate::desktop::types::DesktopWindow;

/// Executable name of the bridge, as `argv[0]` carries it.
const SATELLITE: &str = "xwayland-satellite";

/// Largest property value read, in 32-bit units.
const PROPERTY_LIMIT: u32 = 1024;

/// Replace each bridged window's pid with its X11 client's.
///
/// A bridged window whose X client cannot be identified uniquely loses its
/// pid: the bridge's pid would otherwise read as ownership by the compositor
/// that spawned it.
pub(super) fn resolve_client_pids(windows: &mut [DesktopWindow]) {
	let mut displays: HashMap<u32, Option<Vec<TopLevel>>> = HashMap::new();
	for window in windows.iter_mut() {
		let Some(bridge) = window.pid else {
			continue;
		};
		let Some(display) = satellite_display(bridge) else {
			continue;
		};
		let toplevels = displays
			.entry(bridge)
			.or_insert_with(|| toplevels(&display));
		window.pid = toplevels
			.as_deref()
			.and_then(|toplevels| client_pid(toplevels, &window.app, &window.title));
	}
}

/// The X display a `xwayland-satellite` process serves, or `None` when `pid`
/// is another program.
fn satellite_display(pid: u32) -> Option<String> {
	let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
	let mut args = cmdline
		.split(|byte| *byte == 0)
		.map(String::from_utf8_lossy);
	let program = args.next()?;
	if program.rsplit('/').next()? != SATELLITE {
		return None;
	}
	args
		.next()
		.filter(|display| display.starts_with(':'))
		.map(|display| display.into_owned())
}

/// An X top-level as satellite presents it to niri.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TopLevel {
	/// `WM_CLASS` instance and class names.
	class: [String; 2],
	title: String,
	pid:   Option<u32>,
}

/// The pid of the one top-level satellite would show as `app`/`title`.
fn client_pid(toplevels: &[TopLevel], app: &str, title: &str) -> Option<u32> {
	let mut matches = toplevels.iter().filter(|toplevel| {
		!app.is_empty() && toplevel.class.iter().any(|name| name == app) && toplevel.title == title
	});
	match (matches.next(), matches.next()) {
		(Some(toplevel), None) => toplevel.pid,
		_ => None,
	}
}

/// Viewable root children of `display`, or `None` when it cannot be read.
fn toplevels(display: &str) -> Option<Vec<TopLevel>> {
	let (conn, screen) = x11rb::connect(Some(display)).ok()?;
	let root = conn.setup().roots.get(screen)?.root;
	let intern = |name: &str| -> Option<Atom> {
		Some(
			conn
				.intern_atom(false, name.as_bytes())
				.ok()?
				.reply()
				.ok()?
				.atom,
		)
	};
	let (name, utf8, pid) =
		(intern("_NET_WM_NAME")?, intern("UTF8_STRING")?, intern("_NET_WM_PID")?);
	let property = |window: Window, property: Atom, kind: Atom| {
		conn
			.get_property(false, window, property, kind, 0, PROPERTY_LIMIT)
			.ok()?
			.reply()
			.ok()
			.filter(|reply| reply.value_len > 0)
	};
	let children = conn.query_tree(root).ok()?.reply().ok()?.children;
	let mut toplevels = Vec::with_capacity(children.len());
	for window in children {
		let viewable = conn
			.get_window_attributes(window)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.is_some_and(|attributes| attributes.map_state == MapState::VIEWABLE);
		if !viewable {
			continue;
		}
		let Some(class) = property(window, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into())
			.map(|reply| wm_class(&reply.value))
		else {
			continue;
		};
		// satellite titles a window from `_NET_WM_NAME`, which is UTF-8;
		// `WM_NAME` is Latin-1 and reads differently for the same title.
		let title = property(window, name, utf8)
			.map_or_default(|reply| String::from_utf8_lossy(&reply.value).into_owned());
		let pid = property(window, pid, AtomEnum::CARDINAL.into())
			.and_then(|reply| reply.value32()?.next())
			.filter(|pid| *pid > 0);
		toplevels.push(TopLevel { class, title, pid });
	}
	Some(toplevels)
}

/// `WM_CLASS` is two NUL-terminated strings: instance, then class.
fn wm_class(value: &[u8]) -> [String; 2] {
	let mut names = value
		.split(|byte| *byte == 0)
		.map(|name| String::from_utf8_lossy(name).into_owned());
	[names.next().unwrap_or_default(), names.next().unwrap_or_default()]
}

#[cfg(test)]
mod tests {
	use super::*;

	fn toplevel(class: &str, title: &str, pid: u32) -> TopLevel {
		TopLevel {
			class: [String::new(), class.to_owned()],
			title: title.to_owned(),
			pid:   Some(pid),
		}
	}

	/// Two top-levels of one class and title are two windows niri cannot tell
	/// apart, so neither process is assigned.
	#[test]
	fn client_pid_requires_a_unique_class_and_title() {
		let app = "io.github.CoffeeImpliesCode.Topocraft";
		let mut toplevels = vec![toplevel(app, "Part A", 10), toplevel(app, "Part B", 11)];
		assert_eq!(client_pid(&toplevels, app, "Part A"), Some(10));
		assert_eq!(client_pid(&toplevels, app, "Part B"), Some(11));
		assert_eq!(client_pid(&toplevels, app, "Part C"), None);
		assert_eq!(client_pid(&toplevels, "other", "Part A"), None);
		assert_eq!(client_pid(&toplevels, "", "Part A"), None);
		toplevels.push(toplevel(app, "Part A", 12));
		assert_eq!(client_pid(&toplevels, app, "Part A"), None);
	}

	#[test]
	fn wm_class_reads_instance_and_class() {
		assert_eq!(wm_class(b"\0io.github.App\0"), [String::new(), "io.github.App".to_owned()]);
		assert_eq!(wm_class(b"term\0Term\0"), ["term".to_owned(), "Term".to_owned()]);
		assert_eq!(wm_class(b""), [String::new(), String::new()]);
	}
}
