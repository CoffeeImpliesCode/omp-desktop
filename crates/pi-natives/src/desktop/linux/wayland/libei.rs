use std::{
	os::{fd::AsFd, unix::net::UnixStream},
	time::Duration,
};

use ashpd::desktop::{
	PersistMode, Session,
	remote_desktop::{DeviceType, RemoteDesktop},
};
use futures::StreamExt;
use reis::{
	ei,
	event::{Device, DeviceCapability, EiEvent, Keymap},
	tokio::EiConvertEventStream,
};
use xutf::graphemes_str;

use super::xkb::{KeyStroke, KeyboardLayout};
use crate::desktop::{
	backend::{Modifiers, MouseButton, PointerEvent},
	control,
	error::{CoreResult, DesktopError},
	keys::KeyName,
};

/// Budget for the devices the portal granted to appear. Every handled event
/// re-checks it, so a peer that keeps sending setup events cannot postpone it,
/// and it is elapsed time rather than a count of loop iterations or wakeups.
const DEVICE_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
/// Extra window once the granted devices are there, so the rest of the initial
/// burst still lands: other monitors and the announced modifier state.
const DEVICE_DISCOVERY_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const DRAG_STEP_DELAY: Duration = Duration::from_millis(8);

#[derive(Clone, Copy)]
struct DiscoveryTargets {
	pointer:  bool,
	keyboard: bool,
}

impl DiscoveryTargets {
	const ALL: Self = Self { pointer: true, keyboard: true };

	const fn is_complete(self, pointer: bool, keyboard: bool) -> bool {
		(!self.pointer || pointer) && (!self.keyboard || keyboard)
	}
}

struct EiDevice {
	device:  Device,
	resumed: bool,
	layout:  Option<KeyboardLayout>,
}

type RemoteDesktopSession = Session<'static, RemoteDesktop<'static>>;

struct PortalSession {
	runtime: &'static tokio::runtime::Runtime,
	session: RemoteDesktopSession,
}

pub(super) struct Libei {
	context:        ei::Context,
	devices:        Vec<EiDevice>,
	connection:     Option<reis::event::Connection>,
	sequence:       u32,
	runtime:        &'static tokio::runtime::Runtime,
	events:         Option<EiConvertEventStream>,
	disconnected:   bool,
	portal_session: Option<PortalSession>,
}

#[allow(
	clippy::non_send_fields_in_send_ty,
	reason = "EiConvertEventStream's only non-Send field is a callback map that stays empty"
)]
// SAFETY: the reis event stream is exclusively owned. Its sole non-`Send`
// field is a private callback map which remains empty because
// `EiConvertEventStream` exposes no callback-registration API.
unsafe impl Send for Libei {}

impl Drop for Libei {
	fn drop(&mut self) {
		let serial = self.serial();
		for device in &self.devices {
			if device.resumed {
				device.device.device().stop_emulating(serial);
			}
		}
		let _ = self.context.flush();
		let Some(portal) = self.portal_session.take() else {
			return;
		};
		close_session(portal.runtime, &portal.session);
	}
}

/// Closes a `RemoteDesktop` portal session, bounded by `CLOSE_TIMEOUT` so an
/// unresponsive `xdg-desktop-portal` cannot hang teardown indefinitely.
fn close_session(runtime: &tokio::runtime::Runtime, session: &RemoteDesktopSession) {
	let _ = runtime.block_on(async {
		tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await
	});
}

/// Waits for the original request or a generation-revocation wake. Cancellation
/// drops that request, never polls on a timer or starts it again.
pub(super) async fn cancellable<T>(future: impl Future<Output = T>) -> CoreResult<T> {
	control::check()?;
	let Some(token) = control::current_token() else {
		return Ok(future.await);
	};
	let future = std::pin::pin!(future);
	let cancelled = std::pin::pin!(token.cancelled());
	match futures::future::select(cancelled, future).await {
		futures::future::Either::Left((error, _)) => Err(error),
		futures::future::Either::Right((result, _)) => {
			token.check()?;
			Ok(result)
		},
	}
}

fn pace_drag(
	path: &[(f64, f64)],
	mut send_motion: impl FnMut(f64, f64) -> CoreResult<()>,
) -> CoreResult<()> {
	for &(x, y) in path.iter().skip(1) {
		control::wait(DRAG_STEP_DELAY)?;
		send_motion(x, y)?;
	}
	// Keep the final motion observable before the button release.
	control::wait(DRAG_STEP_DELAY)?;
	Ok(())
}

impl Libei {
	pub(super) const fn disconnected(&self) -> bool {
		self.disconnected
	}

	pub(super) fn new() -> CoreResult<Self> {
		control::check()?;
		let runtime = super::portal::portal_runtime()?;
		let (context, portal_session, targets) = match ei::Context::connect_to_env() {
			Ok(Some(context)) => (context, None, DiscoveryTargets::ALL),
			Ok(None) => {
				let (context, session, targets) = Self::portal_context(runtime)?;
				(context, Some(session), targets)
			},
			Err(err) => return Err(DesktopError::permission_denied(format!("LIBEI_SOCKET: {err}"))),
		};
		let mut backend = Self {
			context,
			devices: Vec::new(),
			connection: None,
			sequence: 1,
			runtime,
			events: None,
			disconnected: false,
			portal_session,
		};
		let (connection, mut events) = runtime
			.block_on(cancellable(async {
				tokio::time::timeout(
					Duration::from_secs(5),
					backend
						.context
						.handshake_tokio("omp-computer", ei::handshake::ContextType::Sender),
				)
				.await
			}))?
			.map_err(|_| DesktopError::input_failed("libei handshake timed out"))?
			.map_err(|err| DesktopError::input_failed(format!("libei handshake: {err}")))?;
		backend.connection = Some(connection);
		backend.discover_devices(runtime, &mut events, targets)?;
		backend.events = Some(events);
		if !backend.has_capability(DeviceCapability::PointerAbsolute)
			&& !backend.has_capability(DeviceCapability::Keyboard)
		{
			return Err(DesktopError::permission_denied(
				"RemoteDesktop portal granted no libei keyboard or pointer devices",
			));
		}
		Ok(backend)
	}

	fn portal_context(
		runtime: &'static tokio::runtime::Runtime,
	) -> CoreResult<(ei::Context, PortalSession, DiscoveryTargets)> {
		let (fd, session, targets) = runtime.block_on(async {
			let portal = cancellable(RemoteDesktop::new()).await?.map_err(|err| {
				DesktopError::permission_denied(format!("RemoteDesktop portal unavailable: {err}"))
			})?;
			let session = cancellable(portal.create_session()).await?.map_err(|err| {
				DesktopError::permission_denied(format!("RemoteDesktop CreateSession: {err}"))
			})?;
			let fd = cancellable(async {
				portal
					.select_devices(
						&session,
						DeviceType::Keyboard | DeviceType::Pointer,
						None,
						PersistMode::DoNot,
					)
					.await
					.map_err(|err| format!("RemoteDesktop SelectDevices: {err}"))?;
				let response = portal
					.start(&session, None)
					.await
					.map_err(|err| format!("RemoteDesktop Start: {err}"))?
					.response()
					.map_err(|err| format!("RemoteDesktop permission: {err}"))?;
				let devices = response.devices();
				let targets = DiscoveryTargets {
					pointer:  devices.contains(DeviceType::Pointer),
					keyboard: devices.contains(DeviceType::Keyboard),
				};
				portal
					.connect_to_eis(&session)
					.await
					.map(|fd| (fd, targets))
					.map_err(|err| format!("RemoteDesktop ConnectToEIS: {err}"))
			})
			.await
			.and_then(|result| result.map_err(DesktopError::permission_denied));
			match fd {
				Ok((fd, targets)) => Ok((fd, session, targets)),
				Err(err) => {
					// Already inside `runtime.block_on`, so the `close_session`
					// helper (itself a `block_on`) would abort with a
					// nested-runtime panic; bound this consent-denied close
					// inline instead.
					let _ = tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await;
					Err(err)
				},
			}
		})?;
		let context = match ei::Context::new(UnixStream::from(fd)) {
			Ok(context) => context,
			Err(err) => {
				close_session(runtime, &session);
				return Err(DesktopError::input_failed(format!("libei portal socket: {err}")));
			},
		};
		Ok((context, PortalSession { runtime, session }, targets))
	}

	fn discover_devices(
		&mut self,
		runtime: &tokio::runtime::Runtime,
		events: &mut EiConvertEventStream,
		targets: DiscoveryTargets,
	) -> CoreResult<()> {
		if targets.is_complete(false, false) {
			return Ok(());
		}
		runtime.block_on(async {
			let deadline = tokio::time::Instant::now() + DEVICE_DISCOVERY_TIMEOUT;
			let mut drain_deadline = None;
			loop {
				control::check()?;
				let now = tokio::time::Instant::now();
				let until = drain_deadline.unwrap_or(deadline);
				if now >= until {
					if targets.is_complete(
						self.has_capability(DeviceCapability::PointerAbsolute),
						self.has_capability(DeviceCapability::Keyboard),
					) {
						break;
					}
					return Err(DesktopError::input_failed(if drain_deadline.is_some() {
						"libei device discovery ended before every granted device resumed"
					} else {
						"libei device discovery timed out"
					}));
				}
				let until = until.min(deadline);
				let tick = (tokio::time::Instant::now() + Duration::from_millis(10)).min(until);
				let event = match tokio::time::timeout_at(tick, events.next()).await {
					Ok(Some(event)) => event.map_err(|err| {
						DesktopError::input_failed(format!("libei device discovery: {err}"))
					})?,
					Ok(None) => {
						return Err(DesktopError::input_failed("libei disconnected during discovery"));
					},
					Err(_) if tokio::time::Instant::now() < until => continue,
					Err(_) => break,
				};
				self.handle_event(event)?;
				// Drain the initial burst even after the first matching devices:
				// other monitors and initial modifier state can follow.
				if drain_deadline.is_none()
					&& targets.is_complete(
						self.has_capability(DeviceCapability::PointerAbsolute),
						self.has_capability(DeviceCapability::Keyboard),
					) {
					drain_deadline = Some(tokio::time::Instant::now() + DEVICE_DISCOVERY_DRAIN_TIMEOUT);
				}
			}
			self.flush()
		})
	}

	fn serial(&self) -> u32 {
		self
			.connection
			.as_ref()
			.map_or(0, reis::event::Connection::serial)
	}

	fn has_capability(&self, capability: DeviceCapability) -> bool {
		self
			.devices
			.iter()
			.any(|device| device.resumed && device.device.has_capability(capability))
	}

	fn handle_event(&mut self, event: EiEvent) -> CoreResult<()> {
		match event {
			EiEvent::SeatAdded(event) => {
				event.seat.bind_capabilities(&[
					DeviceCapability::PointerAbsolute,
					DeviceCapability::Pointer,
					DeviceCapability::Button,
					DeviceCapability::Scroll,
					DeviceCapability::Keyboard,
				]);
			},
			EiEvent::DeviceAdded(event) => {
				let layout = event.device.keymap().and_then(read_keymap);
				self
					.devices
					.push(EiDevice { device: event.device, resumed: false, layout });
			},
			EiEvent::DeviceResumed(event) => {
				let serial = self.serial();
				if let Some(device) = self
					.devices
					.iter_mut()
					.find(|device| device.device == event.device)
				{
					device.resumed = true;
					// An emulation transaction lasts until pause/disconnect, not
					// one command. Mutter can discard frames stopped in the same
					// batch; modifiers also need their own keyboard emulating.
					device
						.device
						.device()
						.start_emulating(serial, self.sequence);
					self.sequence = self.sequence.wrapping_add(1);
				}
			},
			EiEvent::DevicePaused(event) => {
				if let Some(device) = self
					.devices
					.iter_mut()
					.find(|device| device.device == event.device)
				{
					device.resumed = false;
				}
			},
			EiEvent::DeviceRemoved(event) => {
				self.devices.retain(|device| device.device != event.device);
			},
			EiEvent::SeatRemoved(event) => self
				.devices
				.retain(|device| device.device.seat() != &event.seat),
			EiEvent::KeyboardModifiers(event) => {
				if let Some(device) = self
					.devices
					.iter_mut()
					.find(|device| device.device == event.device)
					&& let Some(layout) = device.layout.as_mut()
				{
					layout.update_modifiers(event.depressed, event.latched, event.locked, event.group);
				}
			},
			EiEvent::Disconnected(event) => {
				self.devices.clear();
				self.disconnected = true;
				return Err(DesktopError::input_failed(format!(
					"libei disconnected: {}",
					event.explanation
				)));
			},
			_ => {},
		}
		self.flush()
	}

	fn refresh_devices(&mut self) -> CoreResult<()> {
		let mut events = self
			.events
			.take()
			.ok_or_else(|| DesktopError::input_failed("libei event stream is unavailable"))?;
		let runtime = self.runtime;
		let result = runtime.block_on(async {
			for _ in 0..256 {
				control::check()?;
				match tokio::time::timeout(Duration::from_millis(1), events.next()).await {
					Ok(Some(Ok(event))) => self.handle_event(event)?,
					Ok(Some(Err(err))) => {
						self.disconnected = true;
						return Err(DesktopError::input_failed(format!("libei device state: {err}")));
					},
					Ok(None) => {
						self.disconnected = true;
						return Err(DesktopError::input_failed("libei disconnected"));
					},
					Err(_) => return Ok(()),
				}
			}
			Err(DesktopError::input_failed("libei device state did not settle; no input was sent"))
		});
		self.events = Some(events);
		result
	}

	fn flush(&self) -> CoreResult<()> {
		flush_context(&self.context)
	}

	fn timestamp() -> CoreResult<u64> {
		let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
		// SAFETY: `time` is writable timespec storage; CLOCK_MONOTONIC is a
		// supported Linux clock and clock_gettime retains no pointer.
		if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut time) } != 0 {
			return Err(DesktopError::input_failed(format!(
				"libei monotonic clock: {}",
				std::io::Error::last_os_error()
			)));
		}
		Ok((time.tv_sec as u64)
			.saturating_mul(1_000_000)
			.saturating_add(time.tv_nsec as u64 / 1_000))
	}

	fn send_key(
		device: &EiDevice,
		keyboard: &ei::Keyboard,
		keycode: u32,
		pressed: bool,
		serial: u32,
		time: &mut u64,
	) -> CoreResult<()> {
		control::check()?;
		keyboard.key(
			keycode,
			if pressed {
				ei::keyboard::KeyState::Press
			} else {
				ei::keyboard::KeyState::Released
			},
		);
		device.device.device().frame(serial, *time);
		*time = time.saturating_add(1);
		Ok(())
	}

	pub(super) fn pointer(&mut self, event: PointerEvent) -> CoreResult<()> {
		self.refresh_devices()?;
		// Preflight the complete gesture, before moving or holding anything.
		// In particular, an invalid later drag point must not leave a button
		// or modifier held after returning an error.
		let (modifiers, button) = match &event {
			PointerEvent::Click { modifiers, button, .. }
			| PointerEvent::Drag { modifiers, button, .. } => (
				*modifiers,
				Some(match button {
					MouseButton::Left => 0x110,
					MouseButton::Right => 0x111,
					MouseButton::Middle => 0x112,
				}),
			),
			PointerEvent::Hold { button, .. } => (
				Modifiers::default(),
				Some(match button {
					MouseButton::Left => 0x110,
					MouseButton::Right => 0x111,
					MouseButton::Middle => 0x112,
				}),
			),
			_ => (Modifiers::default(), None),
		};
		let scroll_units = match &event {
			PointerEvent::Scroll { dx, dy, .. } => {
				Some((discrete_detents(*dx)?, discrete_detents(*dy)?))
			},
			_ => None,
		};
		if matches!(&event, PointerEvent::Drag { path, .. } if path.is_empty()) {
			return Err(DesktopError::input_failed("libei drag path is empty"));
		}
		let device_index = self
			.devices
			.iter()
			.position(|device| {
				device.resumed
					&& device
						.device
						.has_capability(DeviceCapability::PointerAbsolute)
					&& (button.is_none() || device.device.has_capability(DeviceCapability::Button))
					&& (scroll_units.is_none() || device.device.has_capability(DeviceCapability::Scroll))
					&& match &event {
						PointerEvent::Click { x, y, .. }
						| PointerEvent::Hold { x, y, .. }
						| PointerEvent::Move { x, y }
						| PointerEvent::Scroll { x, y, .. } => device_contains(&device.device, *x, *y),
						PointerEvent::Drag { path, .. } => path
							.iter()
							.all(|&(x, y)| device_contains(&device.device, x, y)),
					}
			})
			.ok_or_else(|| {
				DesktopError::input_failed(
					"no resumed libei pointer provides the required capabilities and covers every \
					 gesture point; no input was sent",
				)
			})?;
		let extra_keys = match &event {
			PointerEvent::Hold { keys, .. } | PointerEvent::Drag { keys, .. } => keys.as_slice(),
			_ => &[],
		};
		let mut key_codes: Vec<u32> = modifier_keys(modifiers)
			.into_iter()
			.filter_map(|(enabled, code)| enabled.then_some(code))
			.collect();
		if !extra_keys.is_empty() {
			let keyboard_index = self
				.devices
				.iter()
				.position(|keyboard| {
					keyboard.resumed
						&& keyboard.device.seat() == self.devices[device_index].device.seat()
						&& keyboard.device.has_capability(DeviceCapability::Keyboard)
				})
				.ok_or_else(|| {
					DesktopError::permission_denied(
						"no resumed libei keyboard on the pointer's seat can hold the gesture's keys",
					)
				})?;
			for code in plan_keys(&mut self.devices[keyboard_index], extra_keys)? {
				if !key_codes.contains(&code) {
					key_codes.push(code);
				}
			}
		}
		let device = &self.devices[device_index];
		let pointer = device
			.device
			.interface::<ei::PointerAbsolute>()
			.ok_or_else(|| {
				DesktopError::input_failed("libei absolute pointer interface is unavailable")
			})?;
		let button_interface =
			if button.is_some() {
				Some(device.device.interface::<ei::Button>().ok_or_else(|| {
					DesktopError::input_failed("libei button interface is unavailable")
				})?)
			} else {
				None
			};
		let scroll_interface =
			if scroll_units.is_some() {
				Some(device.device.interface::<ei::Scroll>().ok_or_else(|| {
					DesktopError::input_failed("libei scroll interface is unavailable")
				})?)
			} else {
				None
			};
		let keyboard = if key_codes.is_empty() {
			None
		} else {
			let keyboard = self
				.devices
				.iter()
				.find(|keyboard| {
					keyboard.resumed
						&& keyboard.device.seat() == device.device.seat()
						&& keyboard.device.has_capability(DeviceCapability::Keyboard)
				})
				.ok_or_else(|| {
					DesktopError::permission_denied(
						"no resumed libei keyboard on the pointer's seat can hold the gesture's \
						 modifiers",
					)
				})?;
			Some((
				keyboard,
				keyboard.device.interface::<ei::Keyboard>().ok_or_else(|| {
					DesktopError::input_failed("libei keyboard interface is unavailable")
				})?,
			))
		};
		let serial = self.serial();
		let mut time = Self::timestamp()?;
		let mut held_modifiers = 0usize;
		let mut button_held = false;
		let move_to = |x: f64, y: f64, time: &mut u64| -> CoreResult<()> {
			control::check()?;
			pointer.motion_absolute(x as f32, y as f32);
			device.device.device().frame(serial, *time);
			*time = time.saturating_add(1);
			self.flush()
		};
		let gesture_result = (|| {
			if let Some((keyboard, interface)) = &keyboard {
				for (index, &code) in key_codes.iter().enumerate() {
					control::check()?;
					held_modifiers = index + 1;
					Self::send_key(keyboard, interface, code, true, serial, &mut time)?;
				}
				self.flush()?;
			}
			match event {
				PointerEvent::Move { x, y } | PointerEvent::Scroll { x, y, .. } => {
					move_to(x, y, &mut time)?;
				},
				PointerEvent::Click { x, y, count, .. } => {
					move_to(x, y, &mut time)?;
					if let (Some(code), Some(interface)) = (button, &button_interface) {
						for _ in 0..count.max(1) {
							control::check()?;
							button_held = true;
							interface.button(code, ei::button::ButtonState::Press);
							device.device.device().frame(serial, time);
							time = time.saturating_add(1);
							self.flush()?;
							control::check()?;
							interface.button(code, ei::button::ButtonState::Released);
							device.device.device().frame(serial, time);
							time = time.saturating_add(1);
							self.flush()?;
							button_held = false;
						}
					}
				},
				PointerEvent::Hold { x, y, duration, .. } => {
					move_to(x, y, &mut time)?;
					if let (Some(code), Some(interface)) = (button, &button_interface) {
						control::check()?;
						button_held = true;
						interface.button(code, ei::button::ButtonState::Press);
						device.device.device().frame(serial, time);
						time = time.saturating_add(1);
						self.flush()?;
						control::wait(duration)?;
						time = Self::timestamp()?.max(time);
					}
				},
				PointerEvent::Drag { path, .. } => {
					move_to(path[0].0, path[0].1, &mut time)?;
					if let (Some(code), Some(interface)) = (button, &button_interface) {
						control::check()?;
						button_held = true;
						interface.button(code, ei::button::ButtonState::Press);
						device.device.device().frame(serial, time);
						time = time.saturating_add(1);
						self.flush()?;
						pace_drag(&path, |x, y| {
							time = Self::timestamp()?.max(time);
							move_to(x, y, &mut time)
						})?;
					}
				},
			}
			if let (Some((dx, dy)), Some(interface)) = (scroll_units, scroll_interface) {
				control::check()?;
				interface.scroll_discrete(dx, dy);
				device.device.device().frame(serial, time);
				time = time.saturating_add(1);
			}
			Ok(())
		})();
		let released = control::cleanup(|| {
			if button_held && let (Some(code), Some(interface)) = (button, &button_interface) {
				interface.button(code, ei::button::ButtonState::Released);
				device.device.device().frame(serial, time);
				time = time.saturating_add(1);
			}
			if let Some((keyboard, interface)) = &keyboard {
				for &code in key_codes[..held_modifiers].iter().rev() {
					let _ = Self::send_key(keyboard, interface, code, false, serial, &mut time);
				}
			}
			self.flush()
		});
		gesture_result.and(released)
	}

	pub(super) fn key_chord(&mut self, keys: &[KeyName]) -> CoreResult<()> {
		self.hold_keys(keys, Duration::ZERO)
	}

	pub(super) fn hold_keys(&mut self, keys: &[KeyName], duration: Duration) -> CoreResult<()> {
		self.refresh_devices()?;
		let device = self
			.devices
			.iter_mut()
			.find(|device| device.resumed && device.device.has_capability(DeviceCapability::Keyboard))
			.ok_or_else(|| {
				DesktopError::permission_denied("no resumed libei keyboard is available")
			})?;
		let codes = plan_keys(device, keys)?;
		let interface = device
			.device
			.interface::<ei::Keyboard>()
			.ok_or_else(|| DesktopError::input_failed("libei keyboard interface is unavailable"))?;
		let serial = self
			.connection
			.as_ref()
			.map_or(0, reis::event::Connection::serial);
		let mut time = Self::timestamp()?;
		let mut held = 0;
		let result = (|| {
			for &code in &codes {
				control::check()?;
				held += 1;
				Self::send_key(device, &interface, code, true, serial, &mut time)?;
			}
			flush_context(&self.context)?;
			control::wait(duration)?;
			time = Self::timestamp()?.max(time);
			Ok(())
		})();
		control::cleanup(|| {
			for &code in codes[..held].iter().rev() {
				let _ = Self::send_key(device, &interface, code, false, serial, &mut time);
			}
		});
		let flushed = self.flush();
		result.and(flushed)
	}

	pub(super) fn type_text(&mut self, text: &str) -> CoreResult<()> {
		self.refresh_devices()?;
		let device = self
			.devices
			.iter_mut()
			.find(|device| device.resumed && device.device.has_capability(DeviceCapability::Keyboard))
			.ok_or_else(|| {
				DesktopError::permission_denied("no resumed libei keyboard is available")
			})?;
		let strokes = graphemes_str(text)
			.flat_map(str::chars)
			.map(|character| {
				control::check()?;
				char_stroke(device.layout.as_mut(), character)
			})
			.collect::<CoreResult<Vec<_>>>()?;
		let interface = device
			.device
			.interface::<ei::Keyboard>()
			.ok_or_else(|| DesktopError::input_failed("libei keyboard interface is unavailable"))?;
		let serial = self
			.connection
			.as_ref()
			.map_or(0, reis::event::Connection::serial);
		let mut time = Self::timestamp()?;
		for stroke in strokes {
			let mut held = 0;
			let mut key_held = false;
			let result = (|| {
				for &modifier in &stroke.modifiers {
					control::check()?;
					held += 1;
					Self::send_key(device, &interface, modifier, true, serial, &mut time)?;
				}
				control::check()?;
				key_held = true;
				Self::send_key(device, &interface, stroke.keycode, true, serial, &mut time)
			})();
			control::cleanup(|| {
				if key_held {
					let _ = Self::send_key(device, &interface, stroke.keycode, false, serial, &mut time);
				}
				for &modifier in stroke.modifiers[..held].iter().rev() {
					let _ = Self::send_key(device, &interface, modifier, false, serial, &mut time);
				}
			});
			let flushed = self.context.flush().map_err(|err| {
				DesktopError::input_failed(format!(
					"libei transport failed: {err}; delivery may be partial, do not retry blindly"
				))
			});
			result.and(flushed)?;
		}
		Ok(())
	}
}

fn flush_context(context: &ei::Context) -> CoreResult<()> {
	context.flush().map_err(|err| {
		DesktopError::input_failed(format!(
			"libei transport failed: {err}; delivery may be partial, do not retry blindly"
		))
	})
}

fn plan_keys(device: &mut EiDevice, keys: &[KeyName]) -> CoreResult<Vec<u32>> {
	let mut codes = Vec::with_capacity(keys.len());
	for &key in keys {
		control::check()?;
		let stroke = match key {
			KeyName::Char(character) => char_stroke(device.layout.as_mut(), character)?,
			_ => KeyStroke { keycode: evdev_keycode(key)?, modifiers: Vec::new() },
		};
		for code in stroke
			.modifiers
			.into_iter()
			.chain(std::iter::once(stroke.keycode))
		{
			if !codes.contains(&code) {
				codes.push(code);
			}
		}
	}
	Ok(codes)
}

const fn modifier_keys(modifiers: Modifiers) -> [(bool, u32); 4] {
	[(modifiers.ctrl, 29), (modifiers.alt, 56), (modifiers.shift, 42), (modifiers.meta, 125)]
}

fn device_contains(device: &Device, x: f64, y: f64) -> bool {
	device.regions().iter().any(|region| {
		x.is_finite()
			&& y.is_finite()
			&& x >= f64::from(region.x)
			&& y >= f64::from(region.y)
			&& x < f64::from(region.x) + f64::from(region.width)
			&& y < f64::from(region.y) + f64::from(region.height)
	})
}

/// Wheel detents → libei discrete scroll units (120 per detent).
fn discrete_detents(value: f64) -> CoreResult<i32> {
	let units = (value * 120.0).round();
	if !units.is_finite() || units < f64::from(i32::MIN) || units > f64::from(i32::MAX) {
		return Err(DesktopError::input_failed(format!("scroll delta {value} is out of range")));
	}
	Ok(units as i32)
}

fn read_keymap(keymap: &Keymap) -> Option<KeyboardLayout> {
	if keymap.type_ != ei::keyboard::KeymapType::Xkb
		|| keymap.size == 0
		|| keymap.size > 16 * 1024 * 1024
	{
		return None;
	}
	let fd = keymap.fd.as_fd().try_clone_to_owned().ok()?;
	KeyboardLayout::from_fd(fd, keymap.size as usize)
}

/// Resolves only through the active XKB group. Falling back to a key from a
/// different group would emit the wrong glyph because libei cannot request a
/// portable compositor group switch, so printable misses are reported.
/// Control characters and ASCII on a US group resolve to fixed evdev keys
/// first. A keymap may bind `'\n'` to `<LNFD>` instead of Enter.
fn char_stroke(layout: Option<&mut KeyboardLayout>, character: char) -> CoreResult<KeyStroke> {
	let us_ascii = layout
		.as_deref()
		.is_some_and(KeyboardLayout::can_use_us_ascii_fast_path);
	let fixed_key = character.is_control() || (character.is_ascii() && us_ascii);
	if fixed_key && let Some((keycode, shift)) = evdev_char(character) {
		return Ok(KeyStroke { keycode, modifiers: if shift { vec![42] } else { Vec::new() } });
	}
	let Some(layout) = layout else {
		return Err(DesktopError::input_failed(format!(
			"libei cannot type character {character:?}: no usable XKB keymap was announced"
		)));
	};
	layout.resolve_char(character).ok_or_else(|| {
		DesktopError::input_failed(format!(
			"libei cannot type character {character:?} in active XKB group {}",
			layout.active_group()
		))
	})
}

fn evdev_keycode(key: KeyName) -> CoreResult<u32> {
	let code = match key {
		KeyName::Ctrl => 29,
		KeyName::Alt => 56,
		KeyName::Shift => 42,
		KeyName::Meta => 125,
		KeyName::Enter => 28,
		KeyName::Escape => 1,
		KeyName::Tab => 15,
		KeyName::Space => 57,
		KeyName::Backspace => 14,
		KeyName::Delete => 111,
		KeyName::Insert => 110,
		KeyName::Home => 102,
		KeyName::End => 107,
		KeyName::PageUp => 104,
		KeyName::PageDown => 109,
		KeyName::Up => 103,
		KeyName::Down => 108,
		KeyName::Left => 105,
		KeyName::Right => 106,
		KeyName::CapsLock => 58,
		KeyName::NumLock => 69,
		KeyName::PrintScreen => 99,
		KeyName::F1 => 59,
		KeyName::F2 => 60,
		KeyName::F3 => 61,
		KeyName::F4 => 62,
		KeyName::F5 => 63,
		KeyName::F6 => 64,
		KeyName::F7 => 65,
		KeyName::F8 => 66,
		KeyName::F9 => 67,
		KeyName::F10 => 68,
		KeyName::F11 => 87,
		KeyName::F12 => 88,
		KeyName::F13 => 183,
		KeyName::F14 => 184,
		KeyName::F15 => 185,
		KeyName::F16 => 186,
		KeyName::F17 => 187,
		KeyName::F18 => 188,
		KeyName::F19 => 189,
		KeyName::F20 => 190,
		KeyName::F21 => 191,
		KeyName::F22 => 192,
		KeyName::F23 => 193,
		KeyName::F24 => 194,
		KeyName::Char(character) => evdev_char(character).map(|(code, _)| code).ok_or_else(|| {
			DesktopError::input_failed(format!("no evdev keycode for {character:?}"))
		})?,
	};
	Ok(code)
}

fn evdev_char(character: char) -> Option<(u32, bool)> {
	let lower = character.to_ascii_lowercase();
	let code = match lower {
		'a'..='z' => [
			30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47,
			17, 45, 21, 44,
		][(lower as u8 - b'a') as usize],
		'1'..='9' => 2 + u32::from(lower as u8 - b'1'),
		'0' => 11,
		' ' => 57,
		'\n' | '\r' => 28,
		'\t' => 15,
		'-' | '_' => 12,
		'=' | '+' => 13,
		'[' | '{' => 26,
		']' | '}' => 27,
		'\\' | '|' => 43,
		';' | ':' => 39,
		'\'' | '"' => 40,
		'`' | '~' => 41,
		',' | '<' => 51,
		'.' | '>' => 52,
		'/' | '?' => 53,
		'!' => 2,
		'@' => 3,
		'#' => 4,
		'$' => 5,
		'%' => 6,
		'^' => 7,
		'&' => 8,
		'*' => 9,
		'(' => 10,
		')' => 11,
		_ => return None,
	};
	let shift = character.is_ascii_uppercase()
		|| matches!(
			character,
			'_' | '+'
				| '{'
				| '}'
				| '|'
				| ':'
				| '"'
				| '~'
				| '<'
				| '>'
				| '?'
				| '!'
				| '@'
				| '#'
				| '$'
				| '%'
				| '^'
				| '&'
				| '*'
				| '('
				| ')'
		);
	Some((code, shift))
}

#[cfg(test)]
mod tests {
	use std::{
		fs::File,
		io::{ErrorKind, Write},
		os::fd::{FromRawFd, OwnedFd},
		sync::{
			Arc, LazyLock, Mutex, MutexGuard,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::Instant,
	};

	use reis::{PendingRequestResult, eis, handshake};

	use super::*;
	use crate::desktop::error::ErrorCode;

	#[test]
	fn drag_motions_and_release_are_spaced_for_event_consumers() {
		let started = Instant::now();
		let mut previous = started;
		let mut received = Vec::new();
		pace_drag(&[(450.0, 400.0), (600.0, 411.0), (750.0, 422.0)], |x, y| {
			let now = Instant::now();
			assert!(now.duration_since(previous) >= DRAG_STEP_DELAY);
			previous = now;
			received.push((x, y));
			Ok(())
		})
		.unwrap();
		assert_eq!(received, [(600.0, 411.0), (750.0, 422.0)]);
		assert!(previous.elapsed() >= DRAG_STEP_DELAY, "release must not overtake the final motion");
	}

	#[test]
	fn cancellation_drops_an_in_flight_request_without_restarting_it() {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_time()
			.build()
			.unwrap();
		let source = control::CancellationSource::default();
		let token = source.token();
		let mut starts = 0;
		let result = control::with_token_for_test(&token, || {
			runtime.block_on(cancellable(async {
				starts += 1;
				source.cancel();
				std::future::pending::<()>().await;
			}))
		});
		assert!(result.is_err());
		assert_eq!(starts, 1);
	}

	#[test]
	fn cancellation_stops_drag_before_the_next_motion() {
		let source = control::CancellationSource::default();
		let token = source.token();
		let mut received = Vec::new();
		let result = control::with_token_for_test(&token, || {
			pace_drag(&[(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)], |x, y| {
				received.push((x, y));
				source.cancel();
				Ok(())
			})
		});
		assert!(result.is_err());
		assert_eq!(received, [(1.0, 1.0)]);
		let later = control::CancellationSource::default().token();
		control::with_token_for_test(&later, || {
			pace_drag(&[(0.0, 0.0), (3.0, 3.0)], |x, y| {
				received.push((x, y));
				Ok(())
			})
		})
		.unwrap();
		assert_eq!(received, [(1.0, 1.0), (3.0, 3.0)]);
	}

	#[test]
	fn printable_text_without_a_keymap_never_assumes_us_layout() {
		assert!(char_stroke(None, 'a').is_err());
		assert!(char_stroke(None, '@').is_err());
		assert_eq!(char_stroke(None, '\n').unwrap().keycode, 28);
	}

	#[test]
	fn newline_presses_enter_even_when_the_keymap_has_a_linefeed_key() {
		let mut layout = KeyboardLayout::compile(include_str!("testdata/fr.xkb"))
			.expect("French fixture must compile");
		assert_eq!(char_stroke(Some(&mut layout), '\n').unwrap().keycode, 28);
	}

	#[test]
	fn scroll_detents_preserve_direction_and_reject_overflow() {
		assert_eq!(discrete_detents(2.0).unwrap(), 240);
		assert_eq!(discrete_detents(-0.5).unwrap(), -60);
		assert!(discrete_detents(f64::INFINITY).is_err());
		assert!(discrete_detents(f64::from(i32::MAX)).is_err());
	}

	const FR: &str = include_str!("testdata/fr.xkb");
	/// How often the scripted EIS peer polls its socket.
	const PEER_POLL: Duration = Duration::from_millis(1);
	/// Long enough for the fixture thread to record what the client sent, short
	/// enough that a lost write fails the test instead of stalling the suite.
	const PEER_RECORD_TIMEOUT: Duration = Duration::from_secs(5);
	/// A peer that announces this many deviceless seats keeps the connection
	/// busy without ever resuming anything.
	const SEAT_FLOOD: usize = 512;

	/// What the scripted peer announces once the handshake is answered.
	type Announce = Box<dyn FnOnce(&eis::Connection) + Send>;

	/// The fixture runtime plus the lock that keeps two fixture tests from
	/// driving it at once. `Libei` borrows its runtime for `'static`, so the
	/// runtime is process-wide exactly like the shared portal runtime; nextest
	/// already isolates each test in its own process, and the lock keeps
	/// `cargo test`'s single binary honest. Time is real, so the discovery
	/// tests that must reach the production deadline cost that much wall
	/// clock; nextest runs them in parallel.
	fn fixture_runtime() -> (&'static tokio::runtime::Runtime, MutexGuard<'static, ()>) {
		static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
			tokio::runtime::Builder::new_current_thread()
				.enable_io()
				.enable_time()
				.build()
				.expect("build the fixture runtime")
		});
		static DRIVER: Mutex<()> = Mutex::new(());
		let locked = DRIVER.lock();
		let guard = locked.unwrap_or_else(std::sync::PoisonError::into_inner);
		(&RUNTIME, guard)
	}

	/// The scripted EIS peer. Dropping it stops the fixture thread, so a failing
	/// assertion cannot leave a thread reading a closed socket.
	struct Peer {
		stop:     Arc<AtomicBool>,
		keys:     Arc<Mutex<Vec<u32>>>,
		thread:   Option<thread::JoinHandle<()>>,
		/// Holds the fixture runtime for as long as this peer exists.
		_runtime: MutexGuard<'static, ()>,
	}

	impl Peer {
		fn spawn(announce: Announce, runtime: MutexGuard<'static, ()>) -> (UnixStream, Self) {
			let (client, server) = UnixStream::pair().expect("pair the EIS fixture sockets");
			let stop = Arc::new(AtomicBool::new(false));
			let keys = Arc::new(Mutex::new(Vec::new()));
			let thread_keys = Arc::clone(&keys);
			let thread_stop = Arc::clone(&stop);
			let serve = move || serve_eis(server, announce, thread_keys, thread_stop);
			let handle = thread::spawn(serve);
			(client, Self { stop, keys, thread: Some(handle), _runtime: runtime })
		}

		/// Key codes the client pressed, waiting for `count` of them so the
		/// assertion does not race the fixture thread.
		fn key_presses(&self, count: usize) -> Vec<u32> {
			let deadline = Instant::now() + PEER_RECORD_TIMEOUT;
			loop {
				let keys = self.keys.lock().expect("lock the recorded key presses");
				if keys.len() >= count || Instant::now() >= deadline {
					return keys.clone();
				}
				drop(keys);
				thread::sleep(PEER_POLL);
			}
		}
	}

	impl Drop for Peer {
		fn drop(&mut self) {
			self.stop.store(true, Ordering::Relaxed);
			if let Some(handle) = self.thread.take() {
				let _ = handle.join();
			}
		}
	}

	/// Answers the handshake, hands the announced burst to the client, then
	/// records the key requests the client emulates until the test stops the
	/// peer.
	fn serve_eis(
		socket: UnixStream,
		announce: Announce,
		keys: Arc<Mutex<Vec<u32>>>,
		stop: Arc<AtomicBool>,
	) {
		let opened = eis::Context::new(socket);
		let context = opened.expect("open the EIS fixture context");
		let mut handshaker = handshake::EisHandshaker::new(&context, 1);
		let connection = loop {
			if let Some(result) = context.pending_request() {
				let PendingRequestResult::Request(request) = result else {
					panic!("EIS fixture received an unparsable request");
				};
				let answered = handshaker.handle_request(request);
				if let Some(response) = answered.expect("answer the handshake") {
					break response.connection;
				}
				continue;
			}
			match context.read() {
				Ok(_) => {},
				// The fixture socket is non-blocking, so an empty queue is the
				// normal case rather than a closed connection.
				Err(err) if err.kind() == ErrorKind::WouldBlock => {
					if stop.load(Ordering::Relaxed) {
						return;
					}
					thread::sleep(PEER_POLL);
				},
				// The client went away: nothing left to announce or record.
				Err(_) => return,
			}
		};

		context.flush().expect("flush the handshake response");
		// A real EIS announces its seats and devices immediately after the
		// connection event, so they are already queued when the client looks.
		announce(&connection);
		context.flush().expect("flush the announced devices");

		while !stop.load(Ordering::Relaxed) {
			match context.read() {
				Ok(_) => {},
				Err(err) if err.kind() == ErrorKind::WouldBlock => {},
				Err(_) => return,
			}
			while let Some(result) = context.pending_request() {
				let PendingRequestResult::Request(request) = result else {
					continue;
				};
				record_press(&keys, &request);
			}
			thread::sleep(PEER_POLL);
		}
	}

	/// Remembers the key code of every key press the client emulated, which is
	/// exactly what the compositor would have typed.
	fn record_press(keys: &Mutex<Vec<u32>>, request: &eis::Request) {
		let eis::Request::Keyboard(_, eis::keyboard::Request::Key { key, state }) = request else {
			return;
		};
		if *state == eis::keyboard::KeyState::Press {
			keys.lock().expect("record a key press").push(*key);
		}
	}

	/// A `Libei` that has completed its handshake against the scripted peer,
	/// before any device has been discovered.
	fn handshaken_backend(announce: Announce) -> (Libei, EiConvertEventStream, Peer) {
		let (runtime, driver) = fixture_runtime();
		let (socket, peer) = Peer::spawn(announce, driver);
		let context = ei::Context::new(socket).expect("open the client context");
		let sender = ei::handshake::ContextType::Sender;
		let reply = context.handshake_tokio("omp-test", sender);
		let completed =
			runtime.block_on(async { tokio::time::timeout(Duration::from_secs(5), reply).await });
		let answered = completed.expect("the fixture peer answered the handshake");
		let negotiated = answered.expect("handshake with the fixture peer");
		let (connection, events) = negotiated;
		let backend = Libei {
			context,
			devices: Vec::new(),
			connection: Some(connection),
			sequence: 1,
			runtime,
			events: None,
			disconnected: false,
			portal_session: None,
		};
		(backend, events, peer)
	}

	/// Runs the same discovery `Libei::new` runs, so the fixtures below cover
	/// the production entry point rather than a test-only variant.
	fn discover(backend: &mut Libei, events: &mut EiConvertEventStream) -> CoreResult<()> {
		let runtime = backend.runtime;
		let targets = DiscoveryTargets::ALL;
		backend.discover_devices(runtime, events, targets)
	}

	/// A fresh memfd holding `text`, with its shared offset left at EOF exactly
	/// where a compositor that just serialized the keymap leaves it.
	fn memfd(text: &str) -> File {
		// SAFETY: `memfd_create` returns a fresh descriptor or -1, which the
		// assertion rejects; ownership moves into `File` exactly once.
		let mut file = unsafe {
			let fd = libc::memfd_create(c"keymap".as_ptr(), 0);
			assert!(fd >= 0, "memfd_create failed");
			File::from_raw_fd(fd)
		};
		let written = file.write_all(text.as_bytes());
		written.expect("write the keymap");
		file
	}

	/// Builds a layout the way `read_keymap` does: a memfd holding the
	/// serialized keymap, duplicated so the shared offset stays at EOF.
	fn announced_layout(keymap: &str) -> Option<KeyboardLayout> {
		let composer = memfd(keymap);
		let reader = OwnedFd::from(composer.try_clone().expect("duplicate the keymap fd"));
		KeyboardLayout::from_fd(reader, keymap.len())
	}

	/// Announces the burst a compositor sends once `ei_connection.connection`
	/// is out: one seat carrying an absolute pointer and a keyboard, both
	/// resumed. `keymap` is handed over as a keymap fd left at EOF, which is
	/// what every real EIS does.
	fn announce_pointer_and_keyboard(keymap: Option<&'static str>) -> Announce {
		Box::new(move |connection: &eis::Connection| {
			let seat = connection.seat(1);
			seat.name("omp-fixture");
			seat.capability(0b11, "ei_pointer_absolute");
			seat.capability(0b11, "ei_keyboard");
			seat.done();

			let pointer = seat.device(1);
			pointer.name("fixture pointer");
			pointer.device_type(eis::device::DeviceType::Virtual);
			pointer.region(0, 0, 1920, 1080, 1.0);
			pointer.interface::<eis::PointerAbsolute>(1);
			pointer.done();
			pointer.resumed(2);

			let keyboard = seat.device(1);
			keyboard.name("fixture keyboard");
			keyboard.device_type(eis::device::DeviceType::Virtual);
			let interface = keyboard.interface::<eis::Keyboard>(1);
			if let Some(keymap) = keymap {
				let composer = memfd(keymap);
				let bytes = keymap.len() as u32;
				let fd = composer.as_fd();
				interface.keymap(eis::keyboard::KeymapType::Xkb, bytes, fd);
			}
			keyboard.done();
			keyboard.resumed(3);
		})
	}

	/// Announces the same seat but never resumes a keyboard: the portal granted
	/// one the EIS implementation then fails to hand over.
	fn announce_pointer_without_keyboard() -> Announce {
		Box::new(|connection: &eis::Connection| {
			let seat = connection.seat(1);
			seat.name("omp-fixture");
			seat.capability(0b11, "ei_pointer_absolute");
			seat.done();

			let pointer = seat.device(1);
			pointer.name("fixture pointer");
			pointer.device_type(eis::device::DeviceType::Virtual);
			pointer.region(0, 0, 1920, 1080, 1.0);
			pointer.interface::<eis::PointerAbsolute>(1);
			pointer.done();
			pointer.resumed(2);
		})
	}

	/// Seats that carry no device at all: a peer that keeps the connection busy
	/// with events but never resumes anything.
	fn announce_idle_seats(count: usize) -> Announce {
		Box::new(move |connection: &eis::Connection| {
			for _ in 0..count {
				let seat = connection.seat(1);
				seat.name("omp-fixture-idle");
				seat.capability(0b11, "ei_pointer_absolute");
				seat.capability(0b11, "ei_keyboard");
				seat.done();
			}
		})
	}

	#[test]
	fn newline_presses_enter_even_when_the_keymap_binds_linefeed() {
		let compiled = announced_layout(FR);
		let mut layout = compiled.expect("French fixture must compile");
		// The keymap really does bind `\n` to `<LNFD>` (evdev keycode 101).
		let linefeed = KeyStroke { keycode: 101, modifiers: Vec::new() };
		assert_eq!(layout.resolve_char('\n'), Some(linefeed));

		let resolved = char_stroke(Some(&mut layout), '\n');
		let newline = resolved.expect("newline must resolve");
		assert_eq!(newline.keycode, 28);
	}

	#[test]
	fn types_the_announced_layout_through_a_keymap_fd_left_at_end_of_file() {
		let announce = announce_pointer_and_keyboard(Some(FR));
		let (mut backend, mut events, peer) = handshaken_backend(announce);
		let result = discover(&mut backend, &mut events);
		result.expect("the announced keyboard must be discovered");
		backend.events = Some(events);

		let typed = backend.type_text("a");
		typed.expect("type through the announced keymap");

		// `<AD01>` is `a` at evdev keycode 16 on this French keymap; 30 is the
		// US `a` a layout-less type would send.
		assert_eq!(peer.key_presses(1), vec![16]);
	}

	/// Keyboard state is re-read from the event stream before every chord, so
	/// without one there is nothing to type against. Refusing here is what
	/// keeps a stale device table from typing the wrong glyph later.
	#[test]
	fn typing_without_a_live_event_stream_sends_no_input() {
		let announce = announce_pointer_and_keyboard(None);
		let (mut backend, mut events, peer) = handshaken_backend(announce);
		let result = discover(&mut backend, &mut events);
		result.expect("the announced keyboard must be discovered");

		let typed = backend.type_text("a");
		let error = typed.expect_err("typing without an event stream must be refused");

		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(peer.key_presses(0).is_empty(), "no key may reach the compositor");
	}

	#[test]
	fn discovery_uses_events_the_peer_queued_right_after_the_handshake() {
		let announce = announce_pointer_and_keyboard(None);
		let (mut backend, mut events, _peer) = handshaken_backend(announce);

		let result = discover(&mut backend, &mut events);
		result.expect("queued devices must still be discovered");

		assert!(backend.has_capability(DeviceCapability::PointerAbsolute));
		assert!(backend.has_capability(DeviceCapability::Keyboard));
	}

	#[test]
	fn discovery_refuses_a_peer_that_never_resumes_a_device() {
		let (mut backend, mut events, _peer) = handshaken_backend(announce_idle_seats(0));
		let result = discover(&mut backend, &mut events);
		let error = result.expect_err("a silent peer is not a discovery");

		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(!backend.has_capability(DeviceCapability::PointerAbsolute));
		assert!(!backend.has_capability(DeviceCapability::Keyboard));
	}

	/// A keyboard the portal granted but the EIS implementation never resumes
	/// leaves the active group and modifier state unverifiable, so nothing may
	/// be typed on it. The half-arrived pointer proves discovery really ran.
	#[test]
	fn an_unresumed_granted_keyboard_blocks_all_input() {
		let announce = announce_pointer_without_keyboard();
		let (mut backend, mut events, peer) = handshaken_backend(announce);
		let result = discover(&mut backend, &mut events);
		let error = result.expect_err("half a granted session is not a discovery");

		// The pointer did arrive, so discovery made progress and still has to
		// refuse rather than hand back a backend that rejects every keystroke
		// later with nothing the caller can act on.
		assert!(backend.has_capability(DeviceCapability::PointerAbsolute));
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(!backend.has_capability(DeviceCapability::Keyboard));
		assert!(peer.key_presses(0).is_empty(), "no key may reach the compositor");
	}

	/// A peer that answers with endless setup events and never resumes
	/// anything must not be able to postpone the deadline: each handled event
	/// has to re-check it, or the session waits for the compositor to go away.
	#[test]
	fn an_event_storm_cannot_postpone_the_discovery_deadline() {
		let announce = announce_idle_seats(SEAT_FLOOD);
		let (mut backend, mut events, _peer) = handshaken_backend(announce);
		let result = discover(&mut backend, &mut events);
		let error = result.expect_err("a peer that only keeps talking must not stall discovery");

		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(!backend.has_capability(DeviceCapability::Keyboard));
	}
}
