mod ax;
mod backend;
mod control;
mod error;
mod frame;
mod keys;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod types;
#[cfg(any(target_os = "windows", test))]
mod win32;

use std::{
	collections::HashMap,
	panic::AssertUnwindSafe,
	sync::Arc,
	thread::{self, JoinHandle},
	time::Duration,
};

use ax::{AxRegistry, register_node};
use backend::{Backend, DeliveryMode, MouseButton, PointerEvent};
use control::ControlAction;
use error::{CoreResult, DesktopError};
use frame::{FrameGeometry, apply_capture_caps, encode_png};
use keys::{parse_keys, parse_modifiers};
use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use parking_lot::Mutex;
pub use types::*;

use crate::task;

const OPERATION_TIMEOUT: Duration = Duration::from_mins(1);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

enum Response {
	Capabilities(DesktopCapabilities),
	Displays(Vec<DesktopDisplay>),
	Windows(Vec<DesktopWindow>),
	Workspaces(Vec<DesktopWorkspace>),
	WindowState(DesktopWindowState),
	Capture(DesktopCapture),
	Unit,
	Snapshot(AxSnapshot),
	Nodes(Vec<AxNode>),
	Node(Option<AxNode>),
	Attributes(Vec<(String, String)>),
}

type Reply = flume::Sender<CoreResult<Response>>;

enum Request {
	Capabilities {
		reply: Reply,
	},
	ListDisplays {
		reply: Reply,
	},
	ListWindows {
		reply: Reply,
	},
	Capture {
		target: Target,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	Click {
		target:  Target,
		x:       f64,
		y:       f64,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	MoveMouse {
		target: Target,
		x:      f64,
		y:      f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	Drag {
		target:  Target,
		path:    Vec<(f64, f64)>,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	Scroll {
		target: Target,
		x:      f64,
		y:      f64,
		dx:     f64,
		dy:     f64,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	TypeText {
		target: Target,
		text:   String,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	KeyChord {
		target: Target,
		keys:   Vec<keys::KeyName>,
		mode:   DeliveryMode,
		reply:  Reply,
	},
	Control {
		action: ControlAction,
		reply:  Reply,
	},
	ListWorkspaces {
		reply: Reply,
	},
	WindowState {
		id:    String,
		reply: Reply,
	},
	AxSnapshot {
		target:  Target,
		options: AxSnapshotOptions,
		reply:   Reply,
	},
	AxQuery {
		target: Target,
		query:  AxQuery,
		reply:  Reply,
	},
	AxElementAt {
		target: Target,
		x:      f64,
		y:      f64,
		reply:  Reply,
	},
	AxFocused {
		reply: Reply,
	},
	AxNode {
		reference: String,
		reply:     Reply,
	},
	AxAttributes {
		reference: String,
		reply:     Reply,
	},
	AxChildren {
		reference: String,
		reply:     Reply,
	},
	AxParent {
		reference: String,
		reply:     Reply,
	},
	AxPerform {
		reference: String,
		action:    String,
		reply:     Reply,
	},
	AxSetValue {
		reference: String,
		value:     String,
		reply:     Reply,
	},
	AxFocus {
		reference: String,
		reply:     Reply,
	},
	AxClick {
		reference: String,
		options:   ParsedPointerOptions,
		reply:     Reply,
	},
	Close {
		reply: Reply,
	},
}

impl Request {
	fn reply(self, result: CoreResult<Response>) {
		let reply = match self {
			Self::Capabilities { reply }
			| Self::ListDisplays { reply }
			| Self::ListWindows { reply }
			| Self::Capture { reply, .. }
			| Self::Click { reply, .. }
			| Self::MoveMouse { reply, .. }
			| Self::Drag { reply, .. }
			| Self::Scroll { reply, .. }
			| Self::TypeText { reply, .. }
			| Self::KeyChord { reply, .. }
			| Self::Control { reply, .. }
			| Self::ListWorkspaces { reply }
			| Self::WindowState { reply, .. }
			| Self::AxSnapshot { reply, .. }
			| Self::AxQuery { reply, .. }
			| Self::AxElementAt { reply, .. }
			| Self::AxFocused { reply }
			| Self::AxNode { reply, .. }
			| Self::AxAttributes { reply, .. }
			| Self::AxChildren { reply, .. }
			| Self::AxParent { reply, .. }
			| Self::AxPerform { reply, .. }
			| Self::AxSetValue { reply, .. }
			| Self::AxFocus { reply, .. }
			| Self::AxClick { reply, .. }
			| Self::Close { reply } => reply,
		};
		let _ = reply.send(result);
	}

	const fn is_close(&self) -> bool {
		matches!(self, Self::Close { .. })
	}
}

#[derive(Clone, Copy)]
struct ParsedPointerOptions {
	button:    MouseButton,
	count:     u32,
	modifiers: backend::Modifiers,
	mode:      DeliveryMode,
}
impl ParsedPointerOptions {
	fn parse(options: Option<PointerOptions>) -> CoreResult<Self> {
		let options = options.unwrap_or_default();
		Ok(Self {
			button:    MouseButton::parse(options.button.as_deref())?,
			count:     options.count.unwrap_or(1).max(1),
			modifiers: parse_modifiers(options.modifiers.as_deref().unwrap_or_default())?,
			mode:      DeliveryMode::from_takeover(options.takeover),
		})
	}
}

struct Worker {
	backend:      CoreResult<Box<dyn Backend>>,
	registry:     AxRegistry,
	frames:       HashMap<String, FrameGeometry>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
}

impl Worker {
	fn new(selector: DisplaySelector, capabilities: Arc<Mutex<DesktopCapabilities>>) -> Self {
		let backend = create_backend(selector);
		Self { backend, registry: AxRegistry::default(), frames: HashMap::new(), capabilities }
	}

	fn backend(&mut self) -> CoreResult<&mut Box<dyn Backend>> {
		self.backend.as_mut().map_err(|error| error.clone())
	}

	fn window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
		match target {
			Target::Window(id) => self.window_by_id(id),
			Target::Desktop => self
				.backend()?
				.windows()?
				.into_iter()
				.find(|window| window.focused)
				.ok_or_else(|| DesktopError::window_not_found("no focused window was found")),
		}
	}

	/// Fresh lookup of one exact window id. The id arrives by reference, so a
	/// control action re-resolves its own borrowed id instead of copying it
	/// into a throwaway target.
	fn window_by_id(&mut self, id: &str) -> CoreResult<DesktopWindow> {
		let windows = self.backend()?.windows()?;
		windows
			.into_iter()
			.find(|window| window.id == id)
			.ok_or_else(|| DesktopError::window_not_found(format!("window '{id}' was not found")))
	}

	fn frame(&self, target: &Target) -> CoreResult<FrameGeometry> {
		self.frames.get(target.key()).cloned().ok_or_else(|| {
			DesktopError::invalid_coordinate_frame(format!(
				"no capture of '{}' yet — take a screenshot of this target first; coordinate input is \
				 in pixels of that screenshot",
				target.key()
			))
		})
	}

	fn map_point(
		&mut self,
		target: &Target,
		x: f64,
		y: f64,
	) -> CoreResult<(f64, f64, FrameGeometry)> {
		let frame = self.frame(target)?;
		let current = if matches!(target, Target::Window(_)) {
			Some(self.window(target)?)
		} else {
			None
		};
		let (x, y) = frame.map_point(x, y, current.as_ref())?;
		Ok((x, y, frame))
	}

	fn ax(&mut self) -> CoreResult<&mut dyn backend::AxBackend> {
		self
			.backend()?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)
	}

	/// Capability record for the live backend. Platform capability literals
	/// describe their own surface only, so the control surface is attached here
	/// from the same backend that would serve the request.
	fn live_capabilities(&mut self) -> CoreResult<DesktopCapabilities> {
		let backend = self.backend()?;
		let mut capabilities = backend.capabilities();
		capabilities.window_control = Some(backend.control_capabilities());
		Ok(capabilities)
	}

	/// Accepts a control request or refuses it with nothing dispatched: the
	/// backend must advertise the operation, and the window must still exist.
	///
	/// Every cached screenshot frame is then dropped, because an accepted
	/// mutation may move the window, its workspace or the whole layout, and a
	/// surviving frame would map later coordinates onto stale pixels. Frames
	/// survive only a refusal that provably changed nothing.
	fn prepare_control(&mut self, action: &ControlAction) -> CoreResult<()> {
		let operation = action.operation();
		let supported = self.backend()?.control_capabilities().operations;
		if !supported.iter().any(|name| name.as_str() == operation) {
			return Err(DesktopError::control_unsupported(format!(
				"the live backend does not support '{}'; supported: {}",
				operation,
				if supported.is_empty() {
					"none".to_string()
				} else {
					supported.join(", ")
				}
			)));
		}
		if let Some(id) = action.window_id() {
			self.window_by_id(id)?;
		}
		self.frames.clear();
		Ok(())
	}

	fn process(&mut self, request: &Request) -> CoreResult<Response> {
		match request {
			Request::Capabilities { .. } => {
				let caps = match self.live_capabilities() {
					Ok(caps) => caps,
					Err(_) => DesktopCapabilities::unavailable(),
				};
				*self.capabilities.lock() = caps.clone();
				Ok(Response::Capabilities(caps))
			},
			Request::ListDisplays { .. } => Ok(Response::Displays(self.backend()?.displays()?)),
			Request::ListWindows { .. } => Ok(Response::Windows(self.backend()?.windows()?)),
			Request::ListWorkspaces { .. } => Ok(Response::Workspaces(self.backend()?.workspaces()?)),
			Request::WindowState { id, .. } => {
				Ok(Response::WindowState(self.backend()?.window_state(id)?))
			},
			Request::Capture { target, caps, .. } => {
				let (image, mut geometry) = self.backend()?.capture(target, caps)?;
				let source_width = image.width();
				let source_height = image.height();
				let image = apply_capture_caps(image, &mut geometry, caps)?;
				let width = image.width();
				let height = image.height();
				let source = match target {
					Target::Desktop => self.backend()?.displays()?,
					Target::Window(_) => {
						let w = self.window(target)?;
						vec![DesktopDisplay {
							id:           w.id,
							name:         format!("{} — {}", w.app, w.title),
							x:            w.x,
							y:            w.y,
							width:        w.width,
							height:       w.height,
							scale:        f64::from(width) / f64::from(w.width.max(1)),
							pixel_x:      0,
							pixel_y:      0,
							pixel_width:  width,
							pixel_height: height,
							is_primary:   false,
						}]
					},
				};
				let displays = geometry.display_metadata(&source);
				let png = encode_png(image)?;
				self.frames.insert(target.key().to_string(), geometry);
				let capabilities = self.live_capabilities()?;
				*self.capabilities.lock() = capabilities.clone();
				Ok(Response::Capture(DesktopCapture {
					data: Uint8Array::from(png),
					width,
					height,
					source_width,
					source_height,
					target: target.key().to_string(),
					displays,
					backend: capabilities.backend,
					display_server: capabilities.display_server,
				}))
			},
			Request::Click { target, x, y, options, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::MoveMouse { target, x, y, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self
					.backend()?
					.pointer(target, PointerEvent::Move { x, y }, &frame, *mode)?;
				Ok(Response::Unit)
			},
			Request::Drag { target, path, options, .. } => {
				let frame = self.frame(target)?;
				let current = if matches!(target, Target::Window(_)) {
					Some(self.window(target)?)
				} else {
					None
				};
				let mapped = path
					.iter()
					.map(|(x, y)| frame.map_point(*x, *y, current.as_ref()))
					.collect::<CoreResult<Vec<_>>>()?;
				self.backend()?.pointer(
					target,
					PointerEvent::Drag {
						path:      mapped,
						button:    options.button,
						modifiers: options.modifiers,
					},
					&frame,
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Scroll { target, x, y, dx, dy, mode, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Scroll { x, y, dx: *dx, dy: *dy },
					&frame,
					*mode,
				)?;
				Ok(Response::Unit)
			},
			Request::TypeText { target, text, mode, .. } => {
				self.backend()?.type_text(target, text, *mode)?;
				Ok(Response::Unit)
			},
			Request::KeyChord { target, keys, mode, .. } => {
				self.backend()?.key_chord(target, keys, *mode)?;
				Ok(Response::Unit)
			},
			Request::Control { action, .. } => {
				// Validation happens first so a refused request leaves no trace:
				// no native call, no dropped frame.
				self.prepare_control(action)?;
				self.backend()?.control(action)?;
				Ok(Response::Unit)
			},
			Request::AxSnapshot { target, options, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Snapshot(ax::snapshot(ax, registry, &window, options)?))
			},
			Request::AxQuery { target, query, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Nodes(ax::query(ax, registry, &window, query)?))
			},
			Request::AxElementAt { target, x, y, .. } => {
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let backend = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Node(ax::element_at_node(backend, registry, target.key(), *x, *y)?))
			},
			Request::AxFocused { .. } => {
				let handle = self.ax()?.focused_element()?;
				let node = match handle {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, "desktop", h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxNode { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let props = self.ax()?.props(&h)?;
				Ok(Response::Node(Some(axnode(reference.clone(), props))))
			},
			Request::AxAttributes { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let mut attributes = self.ax()?.attributes(&h)?;
				for (_, value) in &mut attributes {
					if value.chars().count() > 200 {
						*value = value
							.chars()
							.take(199)
							.chain(std::iter::once('…'))
							.collect();
					}
				}
				Ok(Response::Attributes(attributes))
			},
			Request::AxChildren { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let handles = self.ax()?.children(&h)?;
				let mut nodes = Vec::with_capacity(handles.len());
				for h in handles {
					let (backend, registry) = (&mut self.backend, &mut self.registry);
					let ax = backend
						.as_mut()
						.map_err(|error| error.clone())?
						.ax()
						.ok_or_else(DesktopError::ax_unsupported)?;
					nodes.push(register_node(ax, registry, &target, h)?);
				}
				Ok(Response::Nodes(nodes))
			},
			Request::AxParent { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let parent = self.ax()?.parent(&h)?;
				let node = match parent {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, &target, h)?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxPerform { reference, action, .. } => {
				let h = self.registry.resolve(reference)?;
				if action.eq_ignore_ascii_case("press") {
					ax::ax_press(self.ax()?, &h)?;
				} else {
					self.ax()?.perform(&h, action)?;
				}
				Ok(Response::Unit)
			},
			Request::AxSetValue { reference, value, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.set_value(&h, value)?;
				Ok(Response::Unit)
			},
			Request::AxFocus { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.focus(&h)?;
				Ok(Response::Unit)
			},
			Request::AxClick { reference, options, .. } => {
				let h = self.registry.resolve(reference)?;
				let bounds = self.ax()?.props(&h)?.bounds.ok_or_else(|| {
					DesktopError::ax_failed(format!("{reference} has no clickable bounds"))
				})?;
				let x = bounds.x + bounds.width / 2.0;
				let y = bounds.y + bounds.height / 2.0;
				let windows = self.backend()?.windows()?;
				// Desktop refs and parent traversal can leave the snapshot's
				// original window; only the live element can establish ownership.
				let window_id = self.ax()?.window_id(&h, &windows)?;
				let target = Target::Window(window_id);
				self.backend()?.pointer(
					&target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&FrameGeometry::identity_global(),
					options.mode,
				)?;
				Ok(Response::Unit)
			},
			Request::Close { .. } => Ok(Response::Unit),
		}
	}
}

fn axnode(reference: String, props: ax::AxProps) -> AxNode {
	let (x, y, width, height) = props
		.bounds
		.map_or((None, None, None, None), |b| (Some(b.x), Some(b.y), Some(b.width), Some(b.height)));
	AxNode {
		ref_: reference,
		role: props.role,
		native_role: props.native_role,
		title: props.title,
		value: props.value,
		description: props.description,
		enabled: props.enabled,
		focused: props.focused,
		x,
		y,
		width,
		height,
		actions: (!props.actions.is_empty()).then_some(props.actions),
		child_count: props.child_count,
	}
}

#[cfg(target_os = "macos")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(macos::MacosBackend::new(selector)?))
}
#[cfg(target_os = "windows")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(win32::Win32Backend::new(selector)?))
}
#[cfg(target_os = "linux")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	linux::new_backend(selector)
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn create_backend(_: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Err(DesktopError::capture_failed("desktop backend unavailable on this platform"))
}

struct Lifecycle {
	tx:     Option<flume::Sender<Request>>,
	done:   Option<flume::Receiver<()>>,
	join:   Option<JoinHandle<()>>,
	closed: bool,
}
struct SessionCore {
	selector:     DisplaySelector,
	lifecycle:    Mutex<Lifecycle>,
	capabilities: Arc<Mutex<DesktopCapabilities>>,
}
impl SessionCore {
	fn new(selector: DisplaySelector) -> Arc<Self> {
		Arc::new(Self {
			selector,
			lifecycle: Mutex::new(Lifecycle {
				tx:     None,
				done:   None,
				join:   None,
				closed: false,
			}),
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
		})
	}

	fn ensure_started(&self) -> CoreResult<flume::Sender<Request>> {
		let mut lifecycle = self.lifecycle.lock();
		if lifecycle.closed {
			return Err(DesktopError::closed());
		}
		if let Some(tx) = &lifecycle.tx {
			return Ok(tx.clone());
		}
		let (tx, rx) = flume::unbounded::<Request>();
		let (done_tx, done_rx) = flume::bounded(1);
		let selector = self.selector.clone();
		let caps = Arc::clone(&self.capabilities);
		let join = thread::Builder::new()
			.name("omp-desktop-session".into())
			.spawn(move || {
				let mut worker = Worker::new(selector, caps);
				while let Ok(request) = rx.recv() {
					let close = request.is_close();
					let result = std::panic::catch_unwind(AssertUnwindSafe(|| worker.process(&request)))
						.unwrap_or_else(|_| {
							Err(DesktopError::internal("native desktop worker panicked"))
						});
					request.reply(result);
					if close {
						break;
					}
				}
				let _ = done_tx.send(());
			})
			.map_err(|e| {
				DesktopError::internal(format!("failed to start native desktop worker: {e}"))
			})?;
		lifecycle.tx = Some(tx.clone());
		lifecycle.done = Some(done_rx);
		lifecycle.join = Some(join);
		Ok(tx)
	}

	fn call(&self, make: impl FnOnce(Reply) -> Request) -> CoreResult<Response> {
		let (txr, rxr) = flume::bounded(1);
		self
			.ensure_started()?
			.send(make(txr))
			.map_err(|_| DesktopError::internal("native desktop worker stopped unexpectedly"))?;
		rxr.recv_timeout(OPERATION_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("native desktop operation did not complete: {e}"))
		})?
	}

	fn close(&self) -> CoreResult<()> {
		let mut lifecycle = self.lifecycle.lock();
		lifecycle.closed = true;
		let Some(tx) = lifecycle.tx.take() else {
			return Ok(());
		};
		let (rtx, rrx) = flume::bounded(1);
		tx.send(Request::Close { reply: rtx })
			.map_err(|_| DesktopError::closed())?;
		let _ = rrx.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("timed out closing native desktop worker: {e}"))
		})?;
		if let Some(done) = lifecycle.done.take() {
			done.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
				DesktopError::timeout(format!("native desktop worker did not exit: {e}"))
			})?;
		}
		if let Some(join) = lifecycle.join.take() {
			join
				.join()
				.map_err(|_| DesktopError::internal("native desktop worker panicked during close"))?;
		}
		Ok(())
	}
}
impl Drop for SessionCore {
	fn drop(&mut self) {
		let lifecycle = self.lifecycle.get_mut();
		if let Some(tx) = lifecycle.tx.take() {
			let (reply, _) = flume::bounded(1);
			let _ = tx.send(Request::Close { reply });
		}
		let _ = lifecycle.join.take();
	}
}

fn response_unit(response: Response) -> CoreResult<()> {
	if matches!(response, Response::Unit) {
		Ok(())
	} else {
		Err(DesktopError::internal("unexpected desktop worker response"))
	}
}

/// Persistent, serialized native desktop capture/input/accessibility session.
#[napi]
pub struct DesktopSession {
	core: Arc<SessionCore>,
}
#[napi]
impl DesktopSession {
	#[napi(constructor)]
	pub fn new(options: Option<DesktopSessionOptions>) -> Result<Self> {
		Ok(Self { core: SessionCore::new(DisplaySelector::parse(options.and_then(|o| o.display))) })
	}

	#[napi(getter)]
	pub fn capabilities(&self) -> DesktopCapabilities {
		match self.core.call(|reply| Request::Capabilities { reply }) {
			Ok(Response::Capabilities(c)) => c,
			_ => self.core.capabilities.lock().clone(),
		}
	}

	#[napi]
	pub fn list_displays(&self) -> Result<task::Promise<Vec<DesktopDisplay>>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.listDisplays", (), move |_| {
			match c.call(|reply| Request::ListDisplays { reply })? {
				Response::Displays(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_windows(&self) -> Result<task::Promise<Vec<DesktopWindow>>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.listWindows", (), move |_| {
			match c.call(|reply| Request::ListWindows { reply })? {
				Response::Windows(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn capture(
		&self,
		target: String,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.capture", (), move |_| {
			match c.call(|reply| Request::Capture { target, caps: caps.unwrap_or_default(), reply })? {
				Response::Capture(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn click(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.click", move |reply| Request::Click {
			target: Target::parse(&target),
			x,
			y,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn move_mouse(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.moveMouse", move |reply| Request::MoveMouse {
			target: Target::parse(&target),
			x,
			y,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn drag(
		&self,
		target: String,
		path: Vec<DesktopPoint>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		let path = path.into_iter().map(|p| (p.x, p.y)).collect();
		Ok(self.unit("desktop.drag", move |reply| Request::Drag {
			target: Target::parse(&target),
			path,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn scroll(
		&self,
		target: String,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.scroll", move |reply| Request::Scroll {
			target: Target::parse(&target),
			x,
			y,
			dx,
			dy,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn type_text(
		&self,
		target: String,
		text: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.typeText", move |reply| Request::TypeText {
			target: Target::parse(&target),
			text,
			mode,
			reply,
		}))
	}

	#[napi]
	pub fn key_chord(
		&self,
		target: String,
		keys: Vec<String>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		let mode = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.mode;
		Ok(self.unit("desktop.keyChord", move |reply| Request::KeyChord {
			target: Target::parse(&target),
			keys,
			mode,
			reply,
		}))
	}

	/// Runs one window-control request. Success means the compositor or window
	/// manager accepted it, not that the application obeyed it.
	#[napi]
	pub fn control(&self, action: DesktopControlAction) -> Result<task::Promise<()>> {
		let action = control::parse(action).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.control", move |reply| Request::Control { action, reply }))
	}

	#[napi]
	pub fn list_workspaces(&self) -> Result<task::Promise<Vec<DesktopWorkspace>>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.listWorkspaces", (), move |_| {
			match c.call(|reply| Request::ListWorkspaces { reply })? {
				Response::Workspaces(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn window_state(&self, window_id: String) -> Result<task::Promise<DesktopWindowState>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.windowState", (), move |_| {
			match c.call(|reply| Request::WindowState { id: window_id, reply })? {
				Response::WindowState(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_snapshot(
		&self,
		target: String,
		opts: Option<AxSnapshotOptions>,
	) -> Result<task::Promise<AxSnapshot>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.axSnapshot", (), move |_| {
			match c.call(|reply| Request::AxSnapshot {
				target: Target::parse(&target),
				options: opts.unwrap_or_default(),
				reply,
			})? {
				Response::Snapshot(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_query(&self, target: String, query: AxQuery) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axQuery", move |reply| Request::AxQuery {
			target: Target::parse(&target),
			query,
			reply,
		}))
	}

	/// Accessibility hit-test at global logical desktop coordinates; needs no
	/// prior capture.
	#[napi]
	pub fn ax_element_at(
		&self,
		target: String,
		x: f64,
		y: f64,
	) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axElementAt", move |reply| Request::AxElementAt {
			target: Target::parse(&target),
			x,
			y,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focused(&self) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axFocused", move |reply| Request::AxFocused { reply }))
	}

	#[napi]
	pub fn ax_node(&self, reference: String) -> Result<task::Promise<AxNode>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.axNode", (), move |_| {
			match c.call(|reply| Request::AxNode { reference, reply })? {
				Response::Node(Some(v)) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_attributes(&self, reference: String) -> Result<task::Promise<Vec<(String, String)>>> {
		let c = Arc::clone(&self.core);
		Ok(task::blocking("desktop.axAttributes", (), move |_| {
			match c.call(|reply| Request::AxAttributes { reference, reply })? {
				Response::Attributes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_children(&self, reference: String) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axChildren", move |reply| Request::AxChildren { reference, reply }))
	}

	#[napi]
	pub fn ax_parent(&self, reference: String) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axParent", move |reply| Request::AxParent { reference, reply }))
	}

	#[napi]
	pub fn ax_perform(&self, reference: String, action: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axPerform", move |reply| Request::AxPerform {
			reference,
			action,
			reply,
		}))
	}

	#[napi]
	pub fn ax_set_value(&self, reference: String, value: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axSetValue", move |reply| Request::AxSetValue {
			reference,
			value,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focus(&self, reference: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axFocus", move |reply| Request::AxFocus { reference, reply }))
	}

	#[napi]
	pub fn ax_click(
		&self,
		reference: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<()>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.unit("desktop.axClick", move |reply| Request::AxClick {
			reference,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn close(&self) -> task::Promise<()> {
		let c = Arc::clone(&self.core);
		task::blocking("desktop.close", (), move |_| c.close().map_err(Into::into))
	}
}
impl DesktopSession {
	fn unit(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<()> {
		let c = Arc::clone(&self.core);
		task::blocking(label, (), move |_| c.call(make).and_then(response_unit).map_err(Into::into))
	}

	fn nodes(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Vec<AxNode>> {
		let c = Arc::clone(&self.core);
		task::blocking(label, (), move |_| {
			match c.call(make)? {
				Response::Nodes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}

	fn node(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Option<AxNode>> {
		let c = Arc::clone(&self.core);
		task::blocking(label, (), move |_| {
			match c.call(make)? {
				Response::Node(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}
}

#[cfg(test)]
mod capture_tests {
	use image::RgbaImage;

	use super::*;
	use crate::desktop::{
		ax::{AxBounds, AxHandle, AxProps},
		backend::{AxBackend, Backend},
		error::ErrorCode,
		keys::KeyName,
	};

	pub(super) const WAYLAND_ID: &str = "atspi::1.31:/org/a11y/atspi/accessible/1";

	/// Backend that mints a composite AT-SPI window id, mirroring the Wayland
	/// `AtSpiAx` path. Exists to exercise `Worker::process` without a display.
	pub(super) struct FakeWaylandBackend {
		window:         DesktopWindow,
		overlap:        Option<DesktopWindow>,
		window_present: bool,
		clicks:         Arc<Mutex<Vec<String>>>,
		raised:         Arc<Mutex<Vec<String>>>,
	}

	impl FakeWaylandBackend {
		pub(super) fn new() -> Self {
			Self {
				window:         DesktopWindow {
					id:             WAYLAND_ID.to_string(),
					title:          "Obsidian".to_string(),
					app:            "obsidian".to_string(),
					pid:            Some(1234),
					position_known: Some(true),
					x:              0,
					y:              0,
					width:          64,
					height:         48,
					focused:        true,
				},
				overlap:        None,
				window_present: true,
				clicks:         Arc::new(Mutex::new(Vec::new())),
				raised:         Arc::new(Mutex::new(Vec::new())),
			}
		}

		/// Focus requests the backend actually received, for control tests.
		pub(super) fn raises(&self) -> Arc<Mutex<Vec<String>>> {
			Arc::clone(&self.raised)
		}
	}

	impl AxBackend for FakeWaylandBackend {
		fn window_root(&mut self, _: &DesktopWindow) -> CoreResult<AxHandle> {
			Ok(AxHandle::Test(1))
		}

		fn window_id(&mut self, _: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
			windows
				.iter()
				.find(|window| window.id == self.window.id)
				.map(|window| window.id.clone())
				.ok_or_else(|| DesktopError::window_not_found("the element's window closed"))
		}

		fn props(&mut self, _: &AxHandle) -> CoreResult<AxProps> {
			Ok(AxProps {
				role:        "button".to_string(),
				native_role: "button".to_string(),
				title:       None,
				value:       None,
				description: None,
				enabled:     true,
				focused:     false,
				bounds:      Some(AxBounds { x: 10.0, y: 10.0, width: 20.0, height: 20.0 }),
				actions:     Vec::new(),
				child_count: 0,
			})
		}

		fn children(&mut self, _: &AxHandle) -> CoreResult<Vec<AxHandle>> {
			unreachable!("tree traversal not exercised")
		}

		fn parent(&mut self, _: &AxHandle) -> CoreResult<Option<AxHandle>> {
			unreachable!("tree traversal not exercised")
		}

		fn perform(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			unreachable!("semantic actions not exercised")
		}

		fn set_value(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			unreachable!("text input not exercised")
		}

		fn focus(&mut self, _: &AxHandle) -> CoreResult<()> {
			unreachable!("focus not exercised")
		}

		fn element_at(&mut self, _: f64, _: f64) -> CoreResult<Option<AxHandle>> {
			unreachable!("hit testing not exercised")
		}

		fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
			unreachable!("focus not exercised")
		}

		fn attributes(&mut self, _: &AxHandle) -> CoreResult<Vec<(String, String)>> {
			unreachable!("attributes not exercised")
		}
	}

	impl Backend for FakeWaylandBackend {
		fn capabilities(&mut self) -> DesktopCapabilities {
			DesktopCapabilities {
				backend: "wayland".to_string(),
				display_server: Some("wayland".to_string()),
				capture: true,
				..DesktopCapabilities::unavailable()
			}
		}

		fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
			Ok(Vec::new())
		}

		fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
			Ok(self
				.overlap
				.iter()
				.chain(self.window_present.then_some(&self.window))
				.cloned()
				.collect())
		}

		fn capture(
			&mut self,
			target: &Target,
			_caps: &CaptureCaps,
		) -> CoreResult<(RgbaImage, FrameGeometry)> {
			match target {
				Target::Window(id) if id == &self.window.id => {
					let image = RgbaImage::new(self.window.width, self.window.height);
					let geometry =
						FrameGeometry::for_window(&self.window, image.width(), image.height());
					Ok((image, geometry))
				},
				Target::Window(id) => {
					Err(DesktopError::window_not_found(format!("Wayland window {id} not found")))
				},
				Target::Desktop => Err(DesktopError::capture_failed("desktop capture not exercised")),
			}
		}

		fn pointer(
			&mut self,
			target: &Target,
			_: PointerEvent,
			_: &FrameGeometry,
			_: DeliveryMode,
		) -> CoreResult<()> {
			self.clicks.lock().push(target.key().to_string());
			Ok(())
		}

		fn type_text(&mut self, _: &Target, _: &str, _: DeliveryMode) -> CoreResult<()> {
			unreachable!("type_text not exercised")
		}

		fn key_chord(&mut self, _: &Target, _: &[KeyName], _: DeliveryMode) -> CoreResult<()> {
			unreachable!("key_chord not exercised")
		}

		fn raise_window(&mut self, id: &str) -> CoreResult<()> {
			self.raised.lock().push(id.to_string());
			Ok(())
		}

		fn ax(&mut self) -> Option<&mut dyn AxBackend> {
			Some(self)
		}
	}

	pub(super) fn worker_with(backend: impl Backend + 'static) -> Worker {
		Worker {
			backend:      Ok(Box::new(backend)),
			registry:     AxRegistry::default(),
			frames:       HashMap::new(),
			capabilities: Arc::new(Mutex::new(DesktopCapabilities::unavailable())),
		}
	}

	fn overlapping_backend() -> FakeWaylandBackend {
		let mut backend = FakeWaylandBackend::new();
		backend.overlap =
			Some(DesktopWindow { id: "unrelated-overlay".to_string(), ..backend.window.clone() });
		backend
	}

	fn click_reference(worker: &mut Worker, origin: &str) -> CoreResult<Response> {
		let generation = worker.registry.current_generation(origin);
		let reference = worker
			.registry
			.register(origin, generation, AxHandle::Test(1));
		let (reply, _rx) = flume::bounded(1);
		worker.process(&Request::AxClick {
			reference,
			options: ParsedPointerOptions::parse(None)?,
			reply,
		})
	}

	#[test]
	fn ax_click_targets_element_owner_despite_overlapping_or_snapshot_windows() {
		let backend = overlapping_backend();
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		// A desktop ref has no snapshot owner; a traversed ref can retain a
		// snapshot origin different from its live native window.
		click_reference(&mut worker, "desktop").expect("desktop element click");
		click_reference(&mut worker, "unrelated-overlay").expect("traversed element click");
		assert_eq!(*clicks.lock(), [WAYLAND_ID, WAYLAND_ID]);
	}

	#[test]
	fn ax_click_never_retargets_a_closed_owner_to_an_overlapping_window() {
		let mut backend = overlapping_backend();
		backend.window_present = false;
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let Err(error) = click_reference(&mut worker, WAYLAND_ID) else {
			panic!("closed element window must refuse input");
		};
		assert_eq!(error.code, ErrorCode::WindowNotFound);
		assert!(clicks.lock().is_empty(), "no input may reach the overlapping window");
	}

	pub(super) fn capture_request(target: Target) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Capture { target, caps: CaptureCaps::default(), reply }
	}

	/// Regression for #7701: a composite AT-SPI window id minted by the Wayland
	/// backend's own `windows()` must reach the backend, not be rejected by a
	/// `u64` pre-parse in the shared request path.
	#[test]
	fn capture_accepts_non_numeric_wayland_window_id() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let response = worker
			.process(&capture_request(Target::Window(WAYLAND_ID.to_string())))
			.expect("wayland window id should be accepted by capture");
		let Response::Capture(capture) = response else {
			panic!("expected a capture response");
		};
		assert_eq!(capture.target, WAYLAND_ID);
		assert_eq!(capture.width, 64);
		assert_eq!(capture.height, 48);
		assert_eq!(capture.backend, "wayland");
	}

	/// Unknown ids still fail — but as `WindowNotFound` from the backend lookup,
	/// never as an `InvalidTarget` pre-parse rejection of a non-`u64` id.
	#[test]
	fn capture_rejects_unknown_window_id_via_backend_lookup() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let Err(err) = worker.process(&capture_request(Target::Window("does-not-exist".to_string())))
		else {
			panic!("unknown window id should fail");
		};
		assert_eq!(err.code, ErrorCode::WindowNotFound);
	}
}

#[cfg(test)]
mod control_tests {
	use image::RgbaImage;

	use super::{
		capture_tests::{FakeWaylandBackend, WAYLAND_ID, capture_request, worker_with},
		*,
	};
	use crate::desktop::{
		backend::{AxBackend, Backend},
		error::ErrorCode,
		keys::KeyName,
	};

	const WINDOW_ID: &str = "w1";
	const SIBLING_ID: &str = "w2";

	/// One point the platform really received, in global coordinates. Whether a
	/// refused request moved a window is visible right here: a stale frame
	/// would re-map the same screenshot pixel onto the window's new position.
	#[derive(Debug, PartialEq)]
	struct PointerHit {
		target: String,
		x:      f64,
		y:      f64,
	}

	fn hit(target: &str, x: f64, y: f64) -> PointerHit {
		PointerHit { target: target.to_string(), x, y }
	}

	/// Global origin of a window that is still live in the compositor model.
	fn origin(state: &Mutex<Vec<DesktopWindow>>, id: &str) -> (i32, i32) {
		let windows = state.lock();
		let window = windows
			.iter()
			.find(|window| window.id == id)
			.expect("the window is still live");
		(window.x, window.y)
	}

	/// Two windows on one display, with control operations that really move the
	/// window they name. A refused request has to leave every geometry alone,
	/// and a dispatched one has to show up in where the next click lands.
	struct ControlBackend {
		windows:     Arc<Mutex<Vec<DesktopWindow>>>,
		display:     DesktopDisplay,
		operations:  Vec<&'static str>,
		dispatched:  Arc<Mutex<Vec<String>>>,
		hits:        Arc<Mutex<Vec<PointerHit>>>,
		/// Set when the request was sent and may already have applied,
		/// mirroring a transport timeout or a partly applied request.
		unconfirmed: bool,
	}

	impl ControlBackend {
		fn new(operations: &[&'static str]) -> Self {
			Self {
				windows:     Arc::new(Mutex::new(vec![
					DesktopWindow {
						id:             WINDOW_ID.to_string(),
						title:          "Editor".to_string(),
						app:            "editor".to_string(),
						pid:            Some(77),
						position_known: Some(true),
						x:              0,
						y:              0,
						width:          64,
						height:         48,
						focused:        true,
					},
					DesktopWindow {
						id:             SIBLING_ID.to_string(),
						title:          "Browser".to_string(),
						app:            "browser".to_string(),
						pid:            Some(78),
						position_known: Some(true),
						x:              100,
						y:              0,
						width:          32,
						height:         32,
						focused:        false,
					},
				])),
				display:     DesktopDisplay {
					id:           "eDP-1".to_string(),
					name:         "eDP-1".to_string(),
					x:            0,
					y:            0,
					width:        192,
					height:       108,
					scale:        1.0,
					pixel_x:      0,
					pixel_y:      0,
					pixel_width:  192,
					pixel_height: 108,
					is_primary:   true,
				},
				operations:  operations.to_vec(),
				dispatched:  Arc::new(Mutex::new(Vec::new())),
				hits:        Arc::new(Mutex::new(Vec::new())),
				unconfirmed: false,
			}
		}

		/// The application exited between discovery and the request.
		fn closed(self) -> Self {
			self.windows.lock().retain(|window| window.id != WINDOW_ID);
			self
		}

		/// The window manager never confirmed a request that was already sent.
		fn unconfirmed(mut self) -> Self {
			self.unconfirmed = true;
			self
		}

		/// Live window state, shared with the worker so a test can read what a
		/// dispatched control really did.
		fn state(&self) -> Arc<Mutex<Vec<DesktopWindow>>> {
			Arc::clone(&self.windows)
		}
	}

	impl Backend for ControlBackend {
		fn capabilities(&mut self) -> DesktopCapabilities {
			// A platform capability literal says nothing about control; the core
			// worker attaches that surface from the same live backend.
			DesktopCapabilities {
				backend: "control-test".to_string(),
				capture: true,
				..DesktopCapabilities::unavailable()
			}
		}

		fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
			Ok(vec![self.display.clone()])
		}

		fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
			Ok(self.windows.lock().clone())
		}

		fn capture(
			&mut self,
			target: &Target,
			_caps: &CaptureCaps,
		) -> CoreResult<(RgbaImage, FrameGeometry)> {
			match target {
				Target::Window(id) => {
					let window = self
						.windows
						.lock()
						.iter()
						.find(|window| window.id == *id)
						.cloned()
						.ok_or_else(|| DesktopError::window_not_found(format!("window {id} is gone")))?;
					let image = RgbaImage::new(window.width, window.height);
					let geometry = FrameGeometry::for_window(&window, image.width(), image.height());
					Ok((image, geometry))
				},
				Target::Desktop => {
					let image = RgbaImage::new(self.display.pixel_width, self.display.pixel_height);
					Ok((image, FrameGeometry::for_displays(&[self.display.clone()])))
				},
			}
		}

		fn pointer(
			&mut self,
			target: &Target,
			ev: PointerEvent,
			_: &FrameGeometry,
			_: DeliveryMode,
		) -> CoreResult<()> {
			let (x, y) = match ev {
				PointerEvent::Click { x, y, .. } => (x, y),
				_ => unreachable!("coordinate input is only exercised through clicks"),
			};
			let record = PointerHit { target: target.key().to_string(), x, y };
			self.hits.lock().push(record);
			Ok(())
		}

		fn type_text(&mut self, _: &Target, _: &str, _: DeliveryMode) -> CoreResult<()> {
			unreachable!("type_text not exercised")
		}

		fn key_chord(&mut self, _: &Target, _: &[KeyName], _: DeliveryMode) -> CoreResult<()> {
			unreachable!("key_chord not exercised")
		}

		fn raise_window(&mut self, _: &str) -> CoreResult<()> {
			unreachable!("raise_window not exercised")
		}

		fn ax(&mut self) -> Option<&mut dyn AxBackend> {
			None
		}

		fn control_capabilities(&mut self) -> DesktopControlCapabilities {
			DesktopControlCapabilities {
				backend:                "control-test".to_string(),
				operations:             self
					.operations
					.iter()
					.map(|name| (*name).to_string())
					.collect(),
				coordinate_space:       Some("desktop".to_string()),
				focus_may_warp_pointer: false,
			}
		}

		fn control(&mut self, action: &ControlAction) -> CoreResult<()> {
			self.dispatched.lock().push(action.operation().to_string());
			// The request reached the compositor, so the model applies it even
			// when the reply is lost: an unconfirmed call may already have moved
			// the window.
			if let ControlAction::MoveWindow { id, x, y } = action {
				let mut windows = self.windows.lock();
				if let Some(window) = windows.iter_mut().find(|window| window.id == *id) {
					window.x = *x as i32;
					window.y = *y as i32;
				}
			}
			if self.unconfirmed {
				return Err(DesktopError::control_failed(
					"the window manager never confirmed the request; its effects may already have \
					 happened",
				));
			}
			Ok(())
		}
	}

	fn control_request(action: ControlAction) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Control { action, reply }
	}

	fn click_request(target: Target, x: f64, y: f64) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Click {
			target,
			x,
			y,
			options: ParsedPointerOptions::parse(None).expect("pointer defaults parse"),
			reply,
		}
	}

	fn workspaces_request() -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::ListWorkspaces { reply }
	}

	fn window_state_request(id: &str) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::WindowState { id: id.to_string(), reply }
	}

	/// A screenshot frame is a pixel map of a layout, so an accepted control
	/// has to retire every cached frame. A click on the window the mutation
	/// never touched, and one on the whole desktop, would otherwise land on the
	/// pixels the compositor no longer paints there.
	#[test]
	fn an_accepted_control_retires_the_frame_of_every_target() {
		let backend = ControlBackend::new(&["moveWindow"]);
		let state = backend.state();
		let hits = Arc::clone(&backend.hits);
		let mut worker = worker_with(backend);
		let edited = Target::Window(WINDOW_ID.to_string());
		let untouched = Target::Window(SIBLING_ID.to_string());
		let desktop = Target::Desktop;
		let fresh = [(&edited, 10.0, 10.0), (&untouched, 5.0, 5.0), (&desktop, 60.0, 20.0)];

		worker
			.process(&capture_request(edited.clone()))
			.expect("edited window capture");
		worker
			.process(&capture_request(untouched.clone()))
			.expect("sibling window capture");
		worker
			.process(&capture_request(desktop.clone()))
			.expect("desktop capture");
		for (target, x, y) in fresh {
			worker
				.process(&click_request(target.clone(), x, y))
				.expect("fresh frame accepts pixels");
		}
		assert_eq!(
			*hits.lock(),
			[hit(WINDOW_ID, 10.0, 10.0), hit(SIBLING_ID, 105.0, 5.0), hit("desktop", 60.0, 20.0)],
			"a fresh frame maps into the window's current global position"
		);

		let move_to = ControlAction::MoveWindow { id: WINDOW_ID.to_string(), x: 4.0, y: 8.0 };
		worker
			.process(&control_request(move_to))
			.expect("the advertised move is dispatched");
		assert_eq!(origin(&state, WINDOW_ID), (4, 8), "the window really moved");

		for (target, x, y) in fresh {
			let Err(error) = worker.process(&click_request(target.clone(), x, y)) else {
				panic!("{} must refuse pixels from a retired frame", target.key());
			};
			assert_eq!(error.code, ErrorCode::InvalidCoordinateFrame);
		}
		assert_eq!(hits.lock().len(), 3, "no click may reach the platform on a retired frame");
	}

	/// A request the live backend never claimed must be refused with the
	/// window it named exactly where it was: the next click on that same frame
	/// has to arrive at the same global point, or the refused request moved
	/// something after all.
	#[test]
	fn an_unadvertised_operation_refuses_without_moving_anything() {
		let backend = ControlBackend::new(&["closeWindow"]);
		let state = backend.state();
		let dispatched = Arc::clone(&backend.dispatched);
		let hits = Arc::clone(&backend.hits);
		let mut worker = worker_with(backend);
		let target = Target::Window(WINDOW_ID.to_string());

		worker
			.process(&capture_request(target.clone()))
			.expect("window capture");
		worker
			.process(&click_request(target.clone(), 10.0, 10.0))
			.expect("click on the fresh frame");

		let move_to = ControlAction::MoveWindow { id: WINDOW_ID.to_string(), x: 40.0, y: 40.0 };
		let Err(error) = worker.process(&control_request(move_to)) else {
			panic!("an operation the backend does not advertise must be refused");
		};
		assert_eq!(error.code, ErrorCode::ControlUnsupported);
		assert!(dispatched.lock().is_empty(), "the request must never reach the platform");
		assert_eq!(origin(&state, WINDOW_ID), (0, 0), "a refused move leaves the window alone");

		worker
			.process(&click_request(target.clone(), 10.0, 10.0))
			.expect("a refusal that moved nothing keeps the frame");
		assert_eq!(
			*hits.lock(),
			[hit(WINDOW_ID, 10.0, 10.0), hit(WINDOW_ID, 10.0, 10.0)],
			"the same screenshot pixel must still reach the same global point"
		);
	}

	/// A window id taken from discovery can die before the mutation is
	/// dispatched: the stale id must be refused with nothing sent, and the
	/// frames of the windows that are still alive must keep answering clicks.
	#[test]
	fn a_window_that_closed_since_discovery_never_reaches_the_platform() {
		let backend = ControlBackend::new(&["closeWindow"]).closed();
		let dispatched = Arc::clone(&backend.dispatched);
		let hits = Arc::clone(&backend.hits);
		let mut worker = worker_with(backend);
		let alive = Target::Window(SIBLING_ID.to_string());

		worker
			.process(&capture_request(alive.clone()))
			.expect("live window capture");
		worker
			.process(&click_request(alive.clone(), 5.0, 5.0))
			.expect("click on the fresh frame");

		let close = ControlAction::CloseWindow(WINDOW_ID.to_string());
		let Err(error) = worker.process(&control_request(close)) else {
			panic!("a window that no longer exists must be refused");
		};
		assert_eq!(error.code, ErrorCode::WindowNotFound);
		assert!(dispatched.lock().is_empty(), "no close request may be sent for a stale id");

		worker
			.process(&click_request(alive.clone(), 5.0, 5.0))
			.expect("a refusal that closed nothing keeps the live frame");
		assert_eq!(*hits.lock(), [hit(SIBLING_ID, 105.0, 5.0), hit(SIBLING_ID, 105.0, 5.0)]);
	}

	/// A move the window manager never confirmed may already have happened, so
	/// the frame is retired even though the call failed: otherwise the next
	/// click on the old pixels would land on the window's new position instead
	/// of refusing.
	#[test]
	fn a_request_the_window_manager_never_confirmed_still_retires_the_frame() {
		let backend = ControlBackend::new(&["moveWindow"]).unconfirmed();
		let state = backend.state();
		let hits = Arc::clone(&backend.hits);
		let mut worker = worker_with(backend);
		let target = Target::Window(WINDOW_ID.to_string());

		worker
			.process(&capture_request(target.clone()))
			.expect("window capture");
		worker
			.process(&click_request(target.clone(), 10.0, 10.0))
			.expect("click on the fresh frame");

		let move_to = ControlAction::MoveWindow { id: WINDOW_ID.to_string(), x: 4.0, y: 8.0 };
		let Err(error) = worker.process(&control_request(move_to)) else {
			panic!("an unconfirmed native request must not report success");
		};
		assert_eq!(error.code, ErrorCode::ControlFailed);
		assert_eq!(origin(&state, WINDOW_ID), (4, 8), "the request reached the compositor anyway");

		let Err(error) = worker.process(&click_request(target.clone(), 10.0, 10.0)) else {
			panic!("a move that may have applied must not keep its pre-move frame");
		};
		assert_eq!(error.code, ErrorCode::InvalidCoordinateFrame);
		assert_eq!(hits.lock().len(), 1, "no click may reach the platform on a retired frame");
	}

	/// The default backend refuses unsupported mutations and discovery without
	/// touching the platform.
	#[test]
	fn the_default_control_surface_refuses_unsupported_operations() {
		let mut backend = FakeWaylandBackend::new();
		let raised = backend.raises();

		let close = ControlAction::CloseWindow(WAYLAND_ID.to_string());
		let error = backend
			.control(&close)
			.expect_err("closing is not part of the default surface");
		assert_eq!(error.code, ErrorCode::ControlUnsupported);
		assert!(raised.lock().is_empty(), "a refused control must not touch the platform");

		let mut worker = worker_with(FakeWaylandBackend::new());
		let Err(error) = worker.process(&workspaces_request()) else {
			panic!("a backend that cannot enumerate workspaces must refuse");
		};
		assert_eq!(error.code, ErrorCode::ControlUnsupported);
	}

	/// A backend that sees no window-manager state reports the descriptor and
	/// leaves state unknown, never `false`.
	#[test]
	fn default_window_state_reports_the_descriptor_and_leaves_state_unknown() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let Ok(Response::WindowState(state)) = worker.process(&window_state_request(WAYLAND_ID))
		else {
			panic!("a live window must resolve");
		};
		assert_eq!(
			(
				state.workspace_id,
				state.display_id,
				state.floating,
				state.urgent,
				state.maximized,
				state.minimized,
				state.fullscreen,
			),
			(None, None, None, None, None, None, None),
			"unreadable state must stay absent instead of becoming false",
		);

		let Err(error) = worker.process(&window_state_request("closed-window")) else {
			panic!("an unknown window must be refused");
		};
		assert_eq!(error.code, ErrorCode::WindowNotFound);
	}
}
