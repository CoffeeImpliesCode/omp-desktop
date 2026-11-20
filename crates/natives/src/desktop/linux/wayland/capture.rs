use std::{
	cell::Cell,
	ffi::{CStr, c_char, c_int, c_void},
	io,
	os::fd::{IntoRawFd, OwnedFd},
	ptr,
	rc::Rc,
	time::{Duration, Instant},
};

use ashpd::desktop::{
	PersistMode, Session,
	screencast::{CursorMode, Screencast, SourceType},
};
use image::RgbaImage;

use super::{
	pipewire::{self, PipeWire, PixelFormat, Plane, SpaHook, SpaPod, StreamEvents, VideoFormat},
	portal::{read_token, store_token},
};
use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
	frame::MAX_COMPOSITE_PIXELS as MAX_FRAME_PIXELS,
};

const SCREENCAST_TOKEN: &str = "screencast-token";
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const PORTAL_TIMEOUT: Duration = Duration::from_secs(30);

struct MonitorStream {
	node:     u32,
	position: Option<(i32, i32)>,
	size:     Option<(i32, i32)>,
}

struct ScreenCastSession<'a> {
	_portal: Screencast<'a>,
	session: Session<'a, Screencast<'a>>,
	streams: Vec<MonitorStream>,
	remote:  OwnedFd,
}

impl ScreenCastSession<'_> {
	fn close(self, runtime: &tokio::runtime::Runtime) {
		let _ = runtime.block_on(async {
			tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, self.session.close()).await
		});
	}
}

async fn portal_request<T>(
	request: impl std::future::Future<Output = Result<T, String>>,
) -> CoreResult<T> {
	control::cancellable(tokio::time::timeout(PORTAL_TIMEOUT, request))
		.await?
		.map_err(|_| DesktopError::capture_failed("Wayland ScreenCast portal timed out"))?
		.map_err(DesktopError::capture_failed)
}

async fn open_screencast<'a>() -> CoreResult<ScreenCastSession<'a>> {
	let portal = portal_request(async {
		Screencast::new()
			.await
			.map_err(|err| format!("ScreenCast portal: {err}"))
	})
	.await?;
	let session = portal_request(async {
		portal
			.create_session()
			.await
			.map_err(|err| format!("ScreenCast CreateSession: {err}"))
	})
	.await?;
	let opened = portal_request(async {
		let restore_token = read_token(SCREENCAST_TOKEN);
		portal
			.select_sources(
				&session,
				CursorMode::Embedded,
				SourceType::Monitor.into(),
				true,
				restore_token.as_deref(),
				PersistMode::ExplicitlyRevoked,
			)
			.await
			.map_err(|err| format!("ScreenCast SelectSources: {err}"))?;
		let response = portal
			.start(&session, None)
			.await
			.map_err(|err| format!("ScreenCast Start: {err}"))?
			.response()
			.map_err(|err| format!("ScreenCast permission: {err}"))?;
		store_token(SCREENCAST_TOKEN, response.restore_token());
		let streams = response
			.streams()
			.iter()
			.map(|stream| MonitorStream {
				node:     stream.pipe_wire_node_id(),
				position: stream.position(),
				size:     stream.size(),
			})
			.collect::<Vec<_>>();
		if streams.is_empty() {
			return Err("ScreenCast returned no monitor stream".to_string());
		}
		let remote = portal
			.open_pipe_wire_remote(&session)
			.await
			.map_err(|err| format!("ScreenCast OpenPipeWireRemote: {err}"))?;
		Ok((streams, remote))
	})
	.await;
	match opened {
		Ok((streams, remote)) => Ok(ScreenCastSession { _portal: portal, session, streams, remote }),
		Err(error) => {
			let _ = tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await;
			Err(error)
		},
	}
}

struct PixelLayout {
	size:  usize,
	red:   usize,
	green: usize,
	blue:  usize,
	alpha: Option<usize>,
}

impl PixelLayout {
	fn new(format: u32) -> Result<Self, String> {
		let format = PixelFormat::from_spa(format)
			.ok_or_else(|| format!("PipeWire negotiated unsupported pixel format {format}"))?;
		Ok(match format {
			PixelFormat::Rgb => Self { size: 3, red: 0, green: 1, blue: 2, alpha: None },
			PixelFormat::Bgr => Self { size: 3, red: 2, green: 1, blue: 0, alpha: None },
			PixelFormat::Rgba => Self { size: 4, red: 0, green: 1, blue: 2, alpha: Some(3) },
			PixelFormat::Rgbx => Self { size: 4, red: 0, green: 1, blue: 2, alpha: None },
			PixelFormat::Bgra => Self { size: 4, red: 2, green: 1, blue: 0, alpha: Some(3) },
			PixelFormat::Bgrx => Self { size: 4, red: 2, green: 1, blue: 0, alpha: None },
		})
	}
}

fn rgba_from_buffer(format: &VideoFormat, plane: &Plane<'_>) -> Result<RgbaImage, String> {
	let offset = plane.chunk.offset as usize;
	let bytes = plane.chunk.size as usize;
	let stride = plane.chunk.stride;
	if stride <= 0 {
		return Err(format!("PipeWire returned unsupported frame stride {stride}"));
	}
	let stride = stride as usize;
	let source = plane
		.memory
		.ok_or_else(|| "PipeWire frame buffer is not memory-mapped".to_string())?;
	let end = offset
		.checked_add(bytes)
		.ok_or_else(|| "PipeWire frame size overflow".to_string())?
		.min(source.len());
	let rows = source
		.get(offset..end)
		.ok_or_else(|| "PipeWire frame offset is outside the mapped buffer".to_string())?;
	rgba_from_rows(format, rows, stride)
}

/// Convert `stride`-padded raw rows into a tightly packed RGBA image.
///
/// `rows` starts at the chunk offset, and a stride larger than one row means
/// the row padding has to be skipped explicitly. A format that is not packed
/// bytes, a frame larger than [`MAX_FRAME_PIXELS`], and a buffer that cannot
/// hold the negotiated rows are all refused here rather than read out of
/// bounds.
fn rgba_from_rows(format: &VideoFormat, rows: &[u8], stride: usize) -> Result<RgbaImage, String> {
	let VideoFormat { width, height, .. } = *format;
	if width == 0 || height == 0 {
		return Err("PipeWire negotiated an empty frame".to_string());
	}
	let layout = PixelLayout::new(format.format)?;
	let pixels = u64::from(width) * u64::from(height);
	if pixels > MAX_FRAME_PIXELS {
		return Err(format!(
			"PipeWire negotiated a {width}x{height} frame above the {MAX_FRAME_PIXELS} pixel capture \
			 limit"
		));
	}
	let row_bytes = (width as usize)
		.checked_mul(layout.size)
		.ok_or_else(|| "PipeWire row size overflow".to_string())?;
	if stride < row_bytes {
		return Err(format!(
			"PipeWire frame stride {stride} cannot hold a {row_bytes} byte row of {width} pixels"
		));
	}
	let required = stride
		.checked_mul(height as usize)
		.ok_or_else(|| "PipeWire frame size overflow".to_string())?;
	if rows.len() < required {
		return Err(format!(
			"PipeWire frame buffer is short: {} bytes for {width}x{height} stride {stride}",
			rows.len()
		));
	}
	let columns = width as usize;
	let mut rgba = vec![0; columns * height as usize * 4];
	for y in 0..height as usize {
		control::check().map_err(|error| error.to_string())?;
		let row = &rows[y * stride..y * stride + row_bytes];
		for x in 0..columns {
			let pixel = &row[x * layout.size..];
			let target = &mut rgba[(y * columns + x) * 4..];
			target[0] = pixel[layout.red];
			target[1] = pixel[layout.green];
			target[2] = pixel[layout.blue];
			target[3] = layout.alpha.map_or(255, |index| pixel[index]);
		}
	}
	RgbaImage::from_raw(width, height, rgba)
		.ok_or_else(|| "failed to construct PipeWire RGBA frame".to_string())
}

struct GrabbedFrame {
	width:  u32,
	height: u32,
	image:  Option<RgbaImage>,
}

/// Validate the negotiated size and aggregate budget before touching pixels.
/// Metadata never calls `read_pixels`, including on unmapped buffers.
fn acquire_frame(
	format: &VideoFormat,
	pixels: bool,
	retained_pixels: &Cell<u64>,
	read_pixels: impl FnOnce() -> Result<RgbaImage, String>,
) -> Result<GrabbedFrame, String> {
	let VideoFormat { width, height, .. } = *format;
	if width == 0 || height == 0 {
		return Err("PipeWire negotiated an empty frame".to_string());
	}
	PixelLayout::new(format.format)?;
	let count = u64::from(width) * u64::from(height);
	let total = retained_pixels
		.get()
		.checked_add(count)
		.filter(|total| *total <= MAX_FRAME_PIXELS)
		.ok_or_else(|| "PipeWire frames exceed the desktop pixel limit".to_string())?;
	let image = if pixels { Some(read_pixels()?) } else { None };
	retained_pixels.set(total);
	Ok(GrabbedFrame { width, height, image })
}

/// Pixel layouts a capture stream accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Formats {
	/// Any packed RGB layout; a monitor stream is opaque.
	Any,
	/// Only layouts that carry alpha. A niri window cast offers `BGRx` before
	/// `BGRA`, so accepting `BGRx` loses the translucent shadow boundary.
	Alpha,
}

impl Formats {
	fn offered(self) -> &'static [PixelFormat] {
		match self {
			Self::Any => &PixelFormat::OFFERED,
			Self::Alpha => &[PixelFormat::Bgra, PixelFormat::Rgba],
		}
	}
}

/// A stable allocation for each stream's callbacks, used only by its loop.
struct Listener {
	pw:              &'static PipeWire,
	stream:          *mut pipewire::Stream,
	node:            u32,
	pixels:          bool,
	format:          Option<VideoFormat>,
	frame:           Option<Result<GrabbedFrame, String>>,
	pending:         Rc<Cell<usize>>,
	retained_pixels: Rc<Cell<u64>>,
}

impl Listener {
	fn finish(&mut self, frame: Result<GrabbedFrame, String>) {
		if self.frame.is_none() {
			self.frame = Some(frame);
			self.pending.set(self.pending.get() - 1);
		}
	}
}

static STREAM_EVENTS: StreamEvents =
	StreamEvents::new(on_state_changed, on_param_changed, on_process);

unsafe extern "C" fn on_state_changed(
	data: *mut c_void,
	_old: c_int,
	state: c_int,
	error: *const c_char,
) {
	if state != -1 {
		return;
	}
	// SAFETY: `data` is the live listener and callbacks run only while its
	// owning thread is inside `pipewire::iterate`.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	let message = if error.is_null() {
		"unknown error".into()
	} else {
		// SAFETY: PipeWire supplies a NUL-terminated error for this callback.
		unsafe { CStr::from_ptr(error) }.to_string_lossy()
	};
	listener.finish(Err(format!("PipeWire stream {}: {message}", listener.node)));
}

unsafe extern "C" fn on_param_changed(data: *mut c_void, id: u32, param: *const SpaPod) {
	if id != pipewire::SPA_PARAM_FORMAT || param.is_null() {
		return;
	}
	// SAFETY: `data` is the stream's live listener; nothing else borrows it
	// while the loop dispatches callbacks.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	// SAFETY: PipeWire passes a valid POD for the duration of the call.
	listener.format = pipewire::parse_video_format(unsafe { pipewire::pod_bytes(param) });
}

unsafe extern "C" fn on_process(data: *mut c_void) {
	// SAFETY: as in `on_param_changed`.
	let listener = unsafe { &mut *data.cast::<Listener>() };
	if listener.frame.is_some() {
		return;
	}
	let pw = listener.pw;
	// SAFETY: the stream is live while its listener is registered.
	let buffer = unsafe { (pw.pw_stream_dequeue_buffer)(listener.stream) };
	if buffer.is_null() {
		return;
	}
	let format = listener
		.format
		.unwrap_or(VideoFormat { format: 0, width: 0, height: 0 });
	let frame = acquire_frame(&format, listener.pixels, &listener.retained_pixels, || {
		// SAFETY: `buffer` stays dequeued until it is queued back below. This
		// closure is never called for metadata, so it does not map/read pixels.
		let plane = unsafe { pipewire::first_plane(buffer) }
			.ok_or_else(|| "PipeWire frame has no data".to_string())?;
		rgba_from_buffer(&format, &plane)
	});
	listener.finish(frame);
	// SAFETY: `buffer` was dequeued from this stream and is no longer read.
	unsafe { (pw.pw_stream_queue_buffer)(listener.stream, buffer) };
}

/// The stream is destroyed before its hook and listener allocations are freed.
struct CaptureStream {
	stream:   *mut pipewire::Stream,
	hook:     Box<SpaHook>,
	listener: Box<Listener>,
}

impl Drop for CaptureStream {
	fn drop(&mut self) {
		// SAFETY: this stream is live and uniquely owned. Destruction unlinks
		// the hook, after which no callback can reach the listener.
		unsafe { (self.listener.pw.pw_stream_destroy)(self.stream) };
	}
}

/// One connection carries every authorized stream, and outlives them all.
struct Connection {
	pw:        &'static PipeWire,
	main_loop: *mut pipewire::MainLoop,
	context:   *mut pipewire::Context,
	core:      *mut pipewire::Core,
	streams:   Vec<CaptureStream>,
}

impl Drop for Connection {
	fn drop(&mut self) {
		self.streams.clear();
		// SAFETY: each pointer is null or an object this connection created
		// and still owns. Streams and listeners were destroyed above.
		unsafe {
			if !self.core.is_null() {
				(self.pw.pw_core_disconnect)(self.core);
			}
			if !self.context.is_null() {
				(self.pw.pw_context_destroy)(self.context);
			}
			(self.pw.pw_main_loop_destroy)(self.main_loop);
		}
	}
}

/// Grab every node over one remote, or the default daemon for native casts.
/// Missing/error streams fail the whole capture; cancellation and the deadline
/// are checked at most one loop iteration (10 ms) apart.
fn grab_pipewire_frames(
	pw: &'static PipeWire,
	nodes: &[u32],
	remote: Option<OwnedFd>,
	formats: Formats,
	pixels: bool,
) -> Result<Vec<GrabbedFrame>, String> {
	if nodes.is_empty() {
		return Err("PipeWire capture needs at least one node".to_string());
	}
	control::check().map_err(|error| error.to_string())?;
	let failed = |object: &str| format!("PipeWire {object}: creation failed");
	// SAFETY: pw_main_loop_new accepts null properties.
	let main_loop = unsafe { (pw.pw_main_loop_new)(ptr::null()) };
	if main_loop.is_null() {
		return Err(failed("main loop"));
	}
	let mut connection = Connection {
		pw,
		main_loop,
		context: ptr::null_mut(),
		core: ptr::null_mut(),
		streams: Vec::with_capacity(nodes.len()),
	};
	// SAFETY: `main_loop` is live.
	let pw_loop = unsafe { (pw.pw_main_loop_get_loop)(main_loop) };
	// SAFETY: `pw_loop` is live; null properties are accepted.
	connection.context = unsafe { (pw.pw_context_new)(pw_loop, ptr::null_mut(), 0) };
	if connection.context.is_null() {
		return Err(failed("context"));
	}
	// SAFETY: the context is live. connect_fd takes ownership of the fd,
	// closing it on disconnect or failure; connect uses the default daemon.
	connection.core = unsafe {
		match remote {
			Some(fd) => {
				(pw.pw_context_connect_fd)(connection.context, fd.into_raw_fd(), ptr::null_mut(), 0)
			},
			None => (pw.pw_context_connect)(connection.context, ptr::null_mut(), 0),
		}
	};
	if connection.core.is_null() {
		return Err(failed("remote"));
	}
	let format = pipewire::enum_format(formats.offered());
	let pending = Rc::new(Cell::new(nodes.len()));
	let retained_pixels = Rc::new(Cell::new(0));
	for &node in nodes {
		let items = [
			pipewire::SpaDictItem { key: c"media.type".as_ptr(), value: c"Video".as_ptr() },
			pipewire::SpaDictItem { key: c"media.category".as_ptr(), value: c"Capture".as_ptr() },
			pipewire::SpaDictItem { key: c"media.role".as_ptr(), value: c"Screen".as_ptr() },
		];
		let dict =
			pipewire::SpaDict { flags: 0, n_items: items.len() as u32, items: items.as_ptr() };
		// SAFETY: the dict and strings outlive the call, which copies them;
		// the stream takes ownership of the new properties.
		let stream = unsafe {
			let properties = (pw.pw_properties_new_dict)(&raw const dict);
			(pw.pw_stream_new)(connection.core, c"omp-computer-capture".as_ptr(), properties)
		};
		if stream.is_null() {
			return Err(failed("stream"));
		}
		connection.streams.push(CaptureStream {
			stream,
			hook: Box::new(SpaHook::new()),
			listener: Box::new(Listener {
				pw,
				stream,
				node,
				pixels,
				format: None,
				frame: None,
				pending: Rc::clone(&pending),
				retained_pixels: Rc::clone(&retained_pixels),
			}),
		});
		let attached = connection
			.streams
			.last_mut()
			.expect("the stream was just inserted");
		let mut params = [format.as_ptr().cast::<SpaPod>()];
		// SAFETY: the stream, stable hook and listener allocations outlive
		// registration; the event table is static; connect copies the POD.
		let connected = unsafe {
			(pw.pw_stream_add_listener)(
				stream,
				&raw mut *attached.hook,
				&raw const STREAM_EVENTS,
				(&raw mut *attached.listener).cast(),
			);
			(pw.pw_stream_connect)(
				stream,
				pipewire::SPA_DIRECTION_INPUT,
				node,
				pipewire::PW_STREAM_FLAG_AUTOCONNECT
					| if pixels {
						pipewire::PW_STREAM_FLAG_MAP_BUFFERS
					} else {
						0
					},
				params.as_mut_ptr(),
				params.len() as u32,
			)
		};
		if connected < 0 {
			return Err(format!(
				"PipeWire connect {node}: {}",
				io::Error::from_raw_os_error(-connected)
			));
		}
	}
	let deadline = Instant::now() + CAPTURE_TIMEOUT;
	loop {
		control::check().map_err(|error| error.to_string())?;
		if pending.get() == 0 {
			break;
		}
		if Instant::now() >= deadline {
			return Err(format!(
				"PipeWire delivered no frame for {} of {} stream(s) within {}s",
				pending.get(),
				nodes.len(),
				CAPTURE_TIMEOUT.as_secs()
			));
		}
		// SAFETY: the loop belongs to this thread's live connection.
		if unsafe { pipewire::iterate(pw_loop, Duration::from_millis(10)) } < 0 {
			return Err("PipeWire loop failed before producing every frame".to_string());
		}
	}
	collect_frames(
		connection
			.streams
			.iter_mut()
			.map(|stream| stream.listener.frame.take())
			.collect(),
	)
}

/// Preserve all-authorized-stream semantics, including missing/error outcomes.
fn collect_frames(
	frames: Vec<Option<Result<GrabbedFrame, String>>>,
) -> Result<Vec<GrabbedFrame>, String> {
	frames
		.into_iter()
		.map(|frame| {
			frame.unwrap_or_else(|| Err("PipeWire stream ended before producing a frame".to_string()))
		})
		.collect()
}

/// Native casts name one exact window node on the default daemon.
pub(super) fn grab_pipewire_frame(
	pw: &'static PipeWire,
	node: u32,
	remote: Option<OwnedFd>,
	formats: Formats,
) -> Result<RgbaImage, String> {
	let mut frames = grab_pipewire_frames(pw, &[node], remote, formats, true)?;
	frames
		.pop()
		.and_then(|frame| frame.image)
		.ok_or_else(|| "PipeWire capture produced no pixel frame".to_string())
}

/// Capture every monitor the user authorized, closing the session afterwards.
pub(super) fn capture(pw: pipewire::Loaded) -> CoreResult<Vec<(RgbaImage, super::PortalGeometry)>> {
	acquire_portal_streams(pw, true).and_then(|frames| {
		frames
			.into_iter()
			.map(|(frame, geometry)| {
				let image = frame.image.ok_or_else(|| {
					DesktopError::capture_failed("PipeWire capture produced no pixel frame")
				})?;
				Ok((image, geometry))
			})
			.collect()
	})
}

/// Refuse a missing runtime library before starting any consent/session work.
pub(super) fn require_pipewire(pw: pipewire::Loaded) -> CoreResult<&'static PipeWire> {
	control::check()?;
	pw.map_err(|reason| {
		DesktopError::capture_failed(format!(
			"Wayland capture needs PipeWire's client library: {reason}"
		))
	})
}

fn acquire_portal_streams(
	pw: pipewire::Loaded,
	pixels: bool,
) -> CoreResult<Vec<(GrabbedFrame, super::PortalGeometry)>> {
	let pw = require_pipewire(pw)?;
	let runtime = super::portal::portal_runtime()?;
	let session = runtime.block_on(open_screencast())?;
	let outcome = capture_streams(pw, runtime, session, pixels);
	control::check()?;
	outcome.map_err(|err| DesktopError::capture_failed(format!("wayland screencast failed: {err}")))
}

/// Refuse a multi-monitor capture whose streams cannot be placed.
///
/// Every authorized stream has to carry its own logical position: a stream
/// without one falls back to the compositor origin, so two monitors would land
/// on the same spot and the caller would composite one monitor's pixels over
/// the other. A single stream keeps the scale-one fallback instead, because
/// there is nothing to confuse it with.
fn placeable_monitors(streams: &[MonitorStream]) -> Result<(), String> {
	if streams.len() < 2 {
		return Ok(());
	}
	if let Some(stream) = streams.iter().find(|stream| stream.position.is_none()) {
		return Err(format!(
			"ScreenCast authorized {} monitors but stream {} has no logical position, so they cannot \
			 be placed on the desktop",
			streams.len(),
			stream.node
		));
	}
	if streams.iter().any(|stream| {
		stream
			.size
			.is_none_or(|(width, height)| width <= 0 || height <= 0)
	}) {
		return Err("ScreenCast monitor streams lack valid logical sizes".to_string());
	}
	Ok(())
}

/// Pair each authorized stream with its frame, then close the session on every
/// outcome. The session outlives the grab because dropping it first would take
/// the `PipeWire` remote with it.
fn capture_streams(
	pw: &'static PipeWire,
	runtime: &tokio::runtime::Runtime,
	session: ScreenCastSession<'_>,
	pixels: bool,
) -> Result<Vec<(GrabbedFrame, super::PortalGeometry)>, String> {
	let outcome = placeable_monitors(&session.streams)
		.and_then(|()| grab_granted_streams(pw, &session, pixels));
	session.close(runtime);
	outcome
}

/// Read one frame per authorized stream and keep each monitor's logical
/// position and size next to it.
fn grab_granted_streams(
	pw: &'static PipeWire,
	session: &ScreenCastSession<'_>,
	pixels: bool,
) -> Result<Vec<(GrabbedFrame, super::PortalGeometry)>, String> {
	// A duplicate keeps the session's own handle alive, so the session can
	// still be closed after PipeWire took its descriptor.
	let remote = session
		.remote
		.try_clone()
		.map_err(|err| format!("ScreenCast PipeWire remote: {err}"))?;
	let nodes = session
		.streams
		.iter()
		.map(|stream| stream.node)
		.collect::<Vec<_>>();
	let frames = grab_pipewire_frames(pw, &nodes, Some(remote), Formats::Any, pixels)?;
	pair_granted_streams(&session.streams, frames)
}

fn pair_granted_streams(
	streams: &[MonitorStream],
	frames: Vec<GrabbedFrame>,
) -> Result<Vec<(GrabbedFrame, super::PortalGeometry)>, String> {
	placeable_monitors(streams)?;
	if frames.len() != streams.len() {
		return Err("PipeWire did not return every authorized monitor".to_string());
	}
	Ok(frames
		.into_iter()
		.zip(streams)
		.map(|(frame, stream)| {
			let geometry =
				super::PortalGeometry::new(stream.position, stream.size, frame.width, frame.height);
			(frame, geometry)
		})
		.collect())
}

pub(super) fn geometry(pw: pipewire::Loaded) -> CoreResult<Vec<super::PortalGeometry>> {
	acquire_portal_streams(pw, false)
		.map(|frames| frames.into_iter().map(|(_, geometry)| geometry).collect())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn negotiated(format: PixelFormat, width: u32, height: u32) -> VideoFormat {
		VideoFormat { format: format as u32, width, height }
	}

	// `SPA_VIDEO_FORMAT_NV12`: planar data is not a packed RGB layout.
	const NV12: VideoFormat = VideoFormat { format: 23, width: 2, height: 2 };
	#[test]
	fn metadata_never_reads_pixels_and_uses_the_same_limits() {
		let retained = Cell::new(0);
		let frame = acquire_frame(&negotiated(PixelFormat::Bgra, 8, 6), false, &retained, || {
			panic!("metadata must not access buffer data")
		})
		.unwrap();
		assert_eq!((frame.width, frame.height), (8, 6));
		assert!(frame.image.is_none());
		assert_eq!(retained.get(), 48);
		for (width, height) in [(0, 3), (3, 0), (65_536, 65_536)] {
			assert!(
				acquire_frame(
					&negotiated(PixelFormat::Bgra, width, height),
					false,
					&retained,
					|| panic!("invalid geometry must not read pixels"),
				)
				.is_err()
			);
		}
		assert!(
			acquire_frame(&NV12, false, &retained, || {
				panic!("an unsupported format must not read pixels")
			})
			.is_err()
		);
		retained.set(MAX_FRAME_PIXELS - 1);
		assert!(
			acquire_frame(&negotiated(PixelFormat::Bgra, 1, 1), false, &retained, || {
				panic!("metadata at the limit must not read pixels")
			})
			.is_ok()
		);
		assert_eq!(retained.get(), MAX_FRAME_PIXELS);
		retained.set(MAX_FRAME_PIXELS);
		assert!(
			acquire_frame(&negotiated(PixelFormat::Bgra, 1, 1), false, &retained, || {
				panic!("an over-budget stream must not read pixels")
			})
			.is_err()
		);
	}

	#[test]
	fn pixel_acquisition_keeps_alpha_and_does_not_charge_failed_frames() {
		let retained = Cell::new(0);
		let format = negotiated(PixelFormat::Rgba, 1, 1);
		assert!(acquire_frame(&format, true, &retained, || Err("unmapped".into())).is_err());
		assert_eq!(retained.get(), 0);
		let frame =
			acquire_frame(&format, true, &retained, || rgba_from_rows(&format, &[1, 2, 3, 4], 4))
				.unwrap();
		assert_eq!(frame.image.unwrap().get_pixel(0, 0).0, [1, 2, 3, 4]);
		assert_eq!(retained.get(), 1);
	}

	#[test]
	fn granted_metadata_keeps_order_logical_bounds_and_all_streams() {
		let streams =
			[MonitorStream { node: 8, position: Some((-4, -2)), size: Some((4, 3)) }, MonitorStream {
				node:     9,
				position: Some((0, 1)),
				size:     Some((4, 3)),
			}];
		let metadata = || {
			let retained = Cell::new(0);
			[(4, 3), (8, 6)]
				.into_iter()
				.map(|(width, height)| {
					acquire_frame(
						&negotiated(PixelFormat::Bgra, width, height),
						false,
						&retained,
						|| panic!("granted metadata must not read pixels"),
					)
				})
				.collect::<Vec<_>>()
		};
		let frames = pair_granted_streams(
			&streams,
			collect_frames(metadata().into_iter().map(Some).collect()).unwrap(),
		)
		.unwrap();
		let geometries = frames
			.into_iter()
			.map(|(_, geometry)| geometry)
			.collect::<Vec<_>>();
		let displays = super::super::geometry::fresh_layout(&geometries, &[]).unwrap();
		assert_eq!(
			(displays[0].x, displays[0].y, displays[0].pixel_x, displays[0].pixel_y),
			(-4, -2, 0, 0)
		);
		assert_eq!(
			(displays[1].x, displays[1].y, displays[1].pixel_x, displays[1].pixel_y),
			(0, 1, 8, 6)
		);
		assert_eq!((displays[0].scale, displays[1].scale), (1.0, 2.0));
		assert!(pair_granted_streams(&streams, vec![]).is_err());
		assert!(collect_frames(vec![Some(metadata().remove(0)), None]).is_err());
		assert!(
			collect_frames(vec![Some(metadata().remove(0)), Some(Err("denied".into()))]).is_err()
		);
		let invalid =
			[MonitorStream { node: 8, position: Some((0, 0)), size: Some((4, 3)) }, MonitorStream {
				node:     9,
				position: None,
				size:     Some((4, 3)),
			}];
		assert!(
			pair_granted_streams(
				&invalid,
				metadata()
					.into_iter()
					.collect::<Result<Vec<_>, _>>()
					.unwrap()
			)
			.is_err()
		);
	}

	/// `PipeWire` hands out rows aligned to its own stride, so a converter that
	/// reads `width * pixel_size` bytes per row shifts every row but the first
	/// and paints the row padding into the output.
	#[test]
	fn padded_rows_keep_their_pixels_in_place() {
		let (width, height, stride) = (3u32, 2u32, 16usize);
		let mut rows = vec![0xee; stride * height as usize];
		rows[0..4].copy_from_slice(&[0x01, 0x02, 0x03, 0x04]);
		rows[4..8].copy_from_slice(&[0x0a, 0x0b, 0x0c, 0x0d]);
		rows[8..12].copy_from_slice(&[0x14, 0x15, 0x16, 0x17]);
		rows[stride..stride + 4].copy_from_slice(&[0x21, 0x22, 0x23, 0x24]);
		rows[stride + 4..stride + 8].copy_from_slice(&[0x2a, 0x2b, 0x2c, 0x2d]);
		rows[stride + 8..stride + 12].copy_from_slice(&[0x34, 0x35, 0x36, 0x37]);
		let frame = rgba_from_rows(&negotiated(PixelFormat::Bgrx, width, height), &rows, stride)
			.expect("a padded BGRx frame converts");
		assert_eq!(frame.dimensions(), (width, height));
		// BGRx stores blue first, so the components come out reversed, and the
		// four padding bytes at the end of a row reach no output pixel.
		assert_eq!(frame.get_pixel(0, 0).0, [0x03, 0x02, 0x01, 255]);
		assert_eq!(frame.get_pixel(2, 0).0, [0x16, 0x15, 0x14, 255]);
		assert_eq!(frame.get_pixel(0, 1).0, [0x23, 0x22, 0x21, 255]);
		assert_eq!(frame.get_pixel(2, 1).0, [0x36, 0x35, 0x34, 255]);
	}

	/// A compositor that composites a window into the capture relies on the
	/// alpha channel, so RGBA has to keep it instead of forcing every pixel
	/// opaque.
	#[test]
	fn rgba_keeps_its_alpha_channel() {
		let rows = [0x0a, 0x0b, 0x0c, 0x00];
		let frame = rgba_from_rows(&negotiated(PixelFormat::Rgba, 1, 1), &rows, 4)
			.expect("an RGBA frame converts");
		assert_eq!(frame.get_pixel(0, 0).0, [0x0a, 0x0b, 0x0c, 0x00]);
	}

	/// The fourth byte of RGBx is an undefined pad, so publishing it verbatim
	/// would make a fully painted monitor look transparent to the caller.
	#[test]
	fn rgbx_pad_byte_becomes_opaque() {
		let rows = [0x0a, 0x0b, 0x0c, 0x00];
		let frame = rgba_from_rows(&negotiated(PixelFormat::Rgbx, 1, 1), &rows, 4)
			.expect("an RGBx frame converts");
		assert_eq!(frame.get_pixel(0, 0).0, [0x0a, 0x0b, 0x0c, 255]);
	}

	/// A planar format is not one byte per pixel per channel, so reading it as
	/// packed RGB would publish scrambled colors instead of failing.
	#[test]
	fn planar_formats_are_refused() {
		let rows = [0; 16];
		assert!(rgba_from_rows(&NV12, &rows, 4).is_err());
	}

	/// A chunk that cannot hold the negotiated rows would be read past its end,
	/// turning a compositor hiccup into a garbage or crashing capture.
	#[test]
	fn chunks_that_cannot_hold_their_rows_are_refused() {
		let truncated = [0; 7];
		assert!(rgba_from_rows(&negotiated(PixelFormat::Rgb, 2, 2), &truncated, 8).is_err());

		let narrow = [0; 8];
		assert!(rgba_from_rows(&negotiated(PixelFormat::Rgba, 4, 1), &narrow, 8).is_err());
	}

	/// An empty negotiation is a compositor that answered without a resolution;
	/// returning a zero-sized image would report a blank monitor as a
	/// successful capture.
	#[test]
	fn zero_sized_frames_are_refused() {
		let rows = [0; 16];
		assert!(rgba_from_rows(&negotiated(PixelFormat::Rgba, 0, 4), &rows, 4).is_err());
		assert!(rgba_from_rows(&negotiated(PixelFormat::Rgba, 4, 0), &rows, 4).is_err());
	}

	#[test]
	fn oversized_frames_are_refused_before_allocating() {
		let rows = [0; 16];
		assert!(rgba_from_rows(&negotiated(PixelFormat::Rgba, 65_536, 65_536), &rows, 4).is_err());
	}

	/// Two monitors that both fall back to the compositor origin would be
	/// composited on top of each other, so an unplaced stream may only pass
	/// when it is the only one.
	#[test]
	fn multiple_monitors_need_their_own_position() {
		let monitor =
			|node: u32, position| MonitorStream { node, position, size: Some((1920, 1080)) };
		let placed = [monitor(41, Some((0, 0))), monitor(42, Some((1920, 0)))];
		assert!(placeable_monitors(&placed).is_ok());
		assert!(
			placeable_monitors(&[monitor(43, None)]).is_ok(),
			"a lone monitor has nothing to be confused with"
		);
		assert!(
			placeable_monitors(&[monitor(44, Some((0, 0))), monitor(45, None)]).is_err(),
			"an unplaced second monitor would be composited at the first monitor's origin"
		);
		let missing_size = MonitorStream { node: 46, position: Some((1920, 0)), size: None };
		assert!(placeable_monitors(&[monitor(44, Some((0, 0))), missing_size]).is_err());
	}

	#[test]
	fn cancelled_geometry_refresh_never_opens_a_portal_session() {
		let source = control::CancellationSource::default();
		let token = source.token();
		source.cancel();
		let result = control::with_token_for_test(&token, || geometry(Err("not loaded")));
		assert_eq!(result.unwrap_err().code, token.check().unwrap_err().code);
	}

	/// A window cast that negotiated `BGRx` loses the alpha that tells the
	/// window body from its shadow, so the alpha request offers nothing else.
	#[test]
	fn alpha_request_offers_only_formats_with_alpha() {
		assert_eq!(Formats::Alpha.offered(), &[PixelFormat::Bgra, PixelFormat::Rgba]);
		for &format in Formats::Alpha.offered() {
			let layout = PixelLayout::new(format as u32).expect("an offered format converts");
			assert!(layout.alpha.is_some(), "{format:?} carries no alpha");
		}
	}
}
