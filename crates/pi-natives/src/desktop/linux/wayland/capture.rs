use std::{
	cell::{Cell, RefCell},
	os::fd::OwnedFd,
	rc::Rc,
	time::Duration,
};

use ashpd::desktop::{
	PersistMode, Session,
	screencast::{CursorMode, Screencast, SourceType},
};
use image::RgbaImage;
use pipewire as pw;
use pw::{properties::properties, spa};

use super::portal::{read_token, store_token};
use crate::desktop::{
	error::{CoreResult, DesktopError},
	frame::MAX_COMPOSITE_PIXELS as MAX_FRAME_PIXELS,
};

const SCREENCAST_TOKEN: &str = "screencast-token";

/// `PipeWire` stream name of the capture links.
const STREAM_NAME: &str = "omp-computer-capture";

/// How long every authorized stream gets to deliver its first frame.
///
/// A stream whose node disappeared, or that the compositor never granted, stays
/// connected without data and without an error event, so without a deadline the
/// loop would wait forever and take the desktop worker down with it.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// One monitor the `ScreenCast` response authorized.
struct MonitorStream {
	/// `PipeWire` node the frame is read from.
	node:     u32,
	/// Logical position of the monitor, when the compositor reports it.
	position: Option<(i32, i32)>,
	/// Logical size of the monitor, when the compositor reports it.
	size:     Option<(i32, i32)>,
}

/// A granted `ScreenCast` session together with the `PipeWire` remote it
/// opened.
///
/// All three handles have to outlive the frame grab: the remote fd is a live
/// `PipeWire` connection only while the session that opened it exists, and the
/// session is a live grant only while its portal proxy does.
struct ScreenCastSession<'a> {
	_portal: Screencast<'a>,
	session: Session<'a, Screencast<'a>>,
	streams: Vec<MonitorStream>,
	remote:  OwnedFd,
}

impl ScreenCastSession<'_> {
	/// End the session and drop the `PipeWire` remote.
	///
	/// The close is best effort and bounded: a compositor that stops answering
	/// must not turn a finished capture into a stuck desktop worker. Every
	/// remaining handle is dropped either way.
	fn close(self, runtime: &tokio::runtime::Runtime) {
		let _ = runtime.block_on(async {
			tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, self.session.close()).await
		});
	}
}

/// Ask for consent and collect one `PipeWire` node per monitor the user picked.
///
/// The restore token round trip is unchanged: a stored token skips the dialog,
/// a fresh one is stored, and a denial surfaces as an error. Nothing here
/// widens what the user authorized.
async fn open_screencast<'a>() -> Result<ScreenCastSession<'a>, String> {
	let portal = Screencast::new()
		.await
		.map_err(|err| format!("ScreenCast portal: {err}"))?;
	let session = portal
		.create_session()
		.await
		.map_err(|err| format!("ScreenCast CreateSession: {err}"))?;
	let restore_token = read_token(SCREENCAST_TOKEN);
	let result = async {
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
	}
	.await;
	match result {
		Ok((streams, remote)) => Ok(ScreenCastSession { _portal: portal, session, streams, remote }),
		Err(err) => {
			let _ = tokio::time::timeout(crate::desktop::CLOSE_TIMEOUT, session.close()).await;
			Err(err)
		},
	}
}

/// Channel layout of a raw video format the converter supports.
struct PixelLayout {
	/// Bytes per pixel in the source buffer.
	size:  usize,
	/// Offset of the red, green and blue component within a pixel.
	red:   usize,
	green: usize,
	blue:  usize,
	/// Offset of the alpha component, or `None` when the format has none.
	alpha: Option<usize>,
}

impl PixelLayout {
	/// Map a negotiated format onto its component layout.
	fn new(format: spa::param::video::VideoFormat) -> Result<Self, String> {
		use spa::param::video::VideoFormat as F;
		Ok(match format {
			F::RGB => Self { size: 3, red: 0, green: 1, blue: 2, alpha: None },
			F::BGR => Self { size: 3, red: 2, green: 1, blue: 0, alpha: None },
			F::RGBA => Self { size: 4, red: 0, green: 1, blue: 2, alpha: Some(3) },
			F::RGBx => Self { size: 4, red: 0, green: 1, blue: 2, alpha: None },
			F::BGRA => Self { size: 4, red: 2, green: 1, blue: 0, alpha: Some(3) },
			F::BGRx => Self { size: 4, red: 2, green: 1, blue: 0, alpha: None },
			other => {
				return Err(format!("PipeWire negotiated unsupported pixel format {other:?}"));
			},
		})
	}
}

/// Convert one mapped `PipeWire` chunk into a tightly packed RGBA image.
fn rgba_from_buffer(
	format: &spa::param::video::VideoInfoRaw,
	data: &mut pw::spa::buffer::Data,
) -> Result<RgbaImage, String> {
	let chunk = data.chunk();
	let offset = chunk.offset() as usize;
	let bytes = chunk.size() as usize;
	let stride = chunk.stride();
	if stride <= 0 {
		return Err(format!("PipeWire returned unsupported frame stride {stride}"));
	}
	let stride = stride as usize;
	let source = data
		.data()
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
fn rgba_from_rows(
	format: &spa::param::video::VideoInfoRaw,
	rows: &[u8],
	stride: usize,
) -> Result<RgbaImage, String> {
	let size = format.size();
	let (width, height) = (size.width, size.height);
	if width == 0 || height == 0 {
		return Err("PipeWire negotiated an empty frame".to_string());
	}
	let layout = PixelLayout::new(format.format())?;
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

type SharedFrames = Rc<RefCell<Vec<Option<Result<RgbaImage, String>>>>>;

/// Per-stream `PipeWire` state shared with the loop callbacks.
struct StreamUserData {
	/// Index of the stream this listener belongs to.
	index:           usize,
	/// `PipeWire` node the stream reads from, for error messages.
	node:            u32,
	/// Format the compositor negotiated for this stream.
	format:          spa::param::video::VideoInfoRaw,
	/// First frame of every stream, filled in by whichever stream is ready.
	frames:          SharedFrames,
	/// Streams that have not reported a frame or an error yet.
	pending:         Rc<Cell<usize>>,
	retained_pixels: Rc<Cell<u64>>,
	/// Loop to leave once no stream is pending.
	mainloop:        pw::main_loop::MainLoopRc,
}

impl StreamUserData {
	/// Record the first outcome of this stream and leave the loop when the last
	/// one lands. Later frames and later state changes are ignored: a stream
	/// that already reported must not be counted twice.
	fn finish(&self, frame: Result<RgbaImage, String>) {
		if self.frames.borrow()[self.index].is_some() {
			return;
		}
		self.frames.borrow_mut()[self.index] = Some(frame);
		let pending = self.pending.get() - 1;
		self.pending.set(pending);
		if pending == 0 {
			self.mainloop.quit();
		}
	}

	/// Whether this stream already reported an outcome.
	fn reported(&self) -> bool {
		self.frames.borrow()[self.index].is_some()
	}
}

/// Grab one frame from every node over a single `PipeWire` connection.
///
/// `remote` picks the connection: `Some` is a `ScreenCast` `PipeWire` remote
/// whose consent the user already granted, `None` the default daemon, which a
/// native compositor screencast feeds without a portal. One connection carries
/// every node, so a multi-monitor capture needs neither a second permission
/// session nor a second remote fd.
///
/// The wait is bounded by [`CAPTURE_TIMEOUT`], and a single failing or missing
/// stream fails the whole capture rather than returning a partial desktop.
fn grab_pipewire_frames(nodes: &[u32], remote: Option<OwnedFd>) -> Result<Vec<RgbaImage>, String> {
	if nodes.is_empty() {
		return Err("PipeWire capture needs at least one node".to_string());
	}
	pw::init();
	let mainloop =
		pw::main_loop::MainLoopRc::new(None).map_err(|err| format!("PipeWire main loop: {err}"))?;
	let context = pw::context::ContextRc::new(&mainloop, None)
		.map_err(|err| format!("PipeWire context: {err}"))?;
	let core = match remote {
		Some(fd) => context.connect_fd_rc(fd, None),
		None => context.connect_rc(None),
	}
	.map_err(|err| format!("PipeWire remote: {err}"))?;
	let total = nodes.len();
	let frames = Rc::new(RefCell::new(vec![None; total]));
	let pending = Rc::new(Cell::new(total));
	let retained_pixels = Rc::new(Cell::new(0_u64));
	let timed_out = Rc::new(Cell::new(false));
	let object = spa::pod::object!(
		spa::utils::SpaTypes::ObjectParamFormat,
		spa::param::ParamType::EnumFormat,
		spa::pod::property!(
			spa::param::format::FormatProperties::MediaType,
			Id,
			spa::param::format::MediaType::Video
		),
		spa::pod::property!(
			spa::param::format::FormatProperties::MediaSubtype,
			Id,
			spa::param::format::MediaSubtype::Raw
		),
		spa::pod::property!(
			spa::param::format::FormatProperties::VideoFormat,
			Choice,
			Enum,
			Id,
			spa::param::video::VideoFormat::BGRx,
			spa::param::video::VideoFormat::BGRx,
			spa::param::video::VideoFormat::BGRA,
			spa::param::video::VideoFormat::RGBx,
			spa::param::video::VideoFormat::RGBA,
			spa::param::video::VideoFormat::RGB,
			spa::param::video::VideoFormat::BGR
		),
		spa::pod::property!(
			spa::param::format::FormatProperties::VideoSize,
			Choice,
			Range,
			Rectangle,
			spa::utils::Rectangle { width: 1920, height: 1080 },
			spa::utils::Rectangle { width: 1, height: 1 },
			spa::utils::Rectangle { width: 16384, height: 16384 }
		)
	);
	let values = spa::pod::serialize::PodSerializer::serialize(
		std::io::Cursor::new(Vec::new()),
		&spa::pod::Value::Object(object),
	)
	.map_err(|err| format!("PipeWire format serialization: {err}"))?
	.0
	.into_inner();
	let param = spa::pod::Pod::from_bytes(&values)
		.ok_or_else(|| "PipeWire rejected format parameters".to_string())?;
	let mut attached = Vec::with_capacity(total);
	for (index, &node) in nodes.iter().enumerate() {
		let stream = pw::stream::StreamBox::new(&core, STREAM_NAME, properties! {
			*pw::keys::MEDIA_TYPE => "Video",
			*pw::keys::MEDIA_CATEGORY => "Capture",
			*pw::keys::MEDIA_ROLE => "Screen",
		})
		.map_err(|err| format!("PipeWire stream {node}: {err}"))?;
		let user_data = StreamUserData {
			index,
			node,
			format: Default::default(),
			frames: Rc::clone(&frames),
			pending: Rc::clone(&pending),
			retained_pixels: Rc::clone(&retained_pixels),
			mainloop: mainloop.clone(),
		};
		let listener = stream
			.add_local_listener_with_user_data(user_data)
			.param_changed(|_, user, id, param| {
				let Some(param) = param else {
					return;
				};
				if id == spa::param::ParamType::Format.as_raw() {
					let _ = user.format.parse(param);
				}
			})
			.state_changed(|_, user, _old, new| {
				if let pw::stream::StreamState::Error(message) = new {
					user.finish(Err(format!("PipeWire stream {}: {message}", user.node)));
				}
			})
			.process(|stream, user| {
				if user.reported() {
					return;
				}
				let Some(mut buffer) = stream.dequeue_buffer() else {
					return;
				};
				let Some(data) = buffer.datas_mut().first_mut() else {
					return;
				};
				let size = user.format.size();
				let pixels = u64::from(size.width) * u64::from(size.height);
				let retained = user.retained_pixels.get();
				if retained
					.checked_add(pixels)
					.is_none_or(|total| total > MAX_FRAME_PIXELS)
				{
					user.finish(Err("PipeWire frames exceed the desktop pixel limit".to_string()));
					return;
				}
				let frame = rgba_from_buffer(&user.format, data);
				if frame.is_ok() {
					user.retained_pixels.set(retained + pixels);
				}
				user.finish(frame);
			})
			.register()
			.map_err(|err| format!("PipeWire listener {node}: {err}"))?;
		let mut params = [param];
		stream
			.connect(
				spa::utils::Direction::Input,
				Some(node),
				pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
				&mut params,
			)
			.map_err(|err| format!("PipeWire connect {node}: {err}"))?;
		attached.push((listener, stream));
	}
	let flag = Rc::clone(&timed_out);
	let timer_loop = mainloop.clone();
	let timer = mainloop.loop_().add_timer(move |_| {
		flag.set(true);
		timer_loop.quit();
	});
	timer
		.update_timer(Some(CAPTURE_TIMEOUT), None)
		.into_sync_result()
		.map_err(|err| format!("PipeWire capture deadline: {err}"))?;
	mainloop.run();
	for (_, stream) in &attached {
		let _ = stream.disconnect();
	}
	drop(attached);
	if timed_out.get() {
		return Err(format!(
			"PipeWire delivered no frame for {} of {total} stream(s) within {}s",
			pending.get(),
			CAPTURE_TIMEOUT.as_secs()
		));
	}
	std::mem::take(&mut *frames.borrow_mut())
		.into_iter()
		.map(|frame| {
			frame.unwrap_or_else(|| Err("PipeWire stream ended before producing a frame".to_string()))
		})
		.collect()
}

/// Grab one frame from a single `PipeWire` node.
///
/// `remote` picks the connection: `Some` is a `ScreenCast` `PipeWire` remote
/// whose consent the user already granted, `None` the default daemon, which a
/// native compositor screencast feeds without a portal. A native capture must
/// name the exact window node, because a second monitor would otherwise be
/// cropped into a frame that belongs to somebody else's screen.
pub(super) fn grab_pipewire_frame(node: u32, remote: Option<OwnedFd>) -> Result<RgbaImage, String> {
	let mut frames = grab_pipewire_frames(&[node], remote)?;
	frames
		.pop()
		.ok_or_else(|| "PipeWire capture produced no frame".to_string())
}

/// Capture every monitor the user authorized, closing the session afterwards.
///
/// The consent, restore token and denial paths are the portal's: the session is
/// created, granted, used, and closed exactly once per capture.
pub(super) fn capture() -> CoreResult<Vec<(RgbaImage, super::PortalGeometry)>> {
	let runtime = super::portal::portal_runtime()?;
	let session = runtime.block_on(open_screencast()).map_err(|err| {
		DesktopError::capture_failed(format!("wayland screencast unavailable: {err}"))
	})?;
	capture_streams(runtime, session)
		.map_err(|err| DesktopError::capture_failed(format!("wayland screencast failed: {err}")))
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
	runtime: &tokio::runtime::Runtime,
	session: ScreenCastSession<'_>,
) -> Result<Vec<(RgbaImage, super::PortalGeometry)>, String> {
	let outcome = placeable_monitors(&session.streams).and_then(|()| grab_granted_streams(&session));
	session.close(runtime);
	outcome
}

/// Read one frame per authorized stream and keep each monitor's logical
/// position and size next to it.
fn grab_granted_streams(
	session: &ScreenCastSession<'_>,
) -> Result<Vec<(RgbaImage, super::PortalGeometry)>, String> {
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
	grab_pipewire_frames(&nodes, Some(remote)).map(|frames| {
		frames
			.into_iter()
			.zip(&session.streams)
			.map(|(image, stream)| {
				let geometry = super::PortalGeometry::new(
					stream.position,
					stream.size,
					image.width(),
					image.height(),
				);
				(image, geometry)
			})
			.collect()
	})
}

#[cfg(test)]
mod tests {
	use pw::spa::param::video::{VideoFormat, VideoInfoRaw};

	use super::*;

	fn negotiated(format: VideoFormat, width: u32, height: u32) -> VideoInfoRaw {
		let mut info = VideoInfoRaw::new();
		info.set_format(format);
		info.set_size(spa::utils::Rectangle { width, height });
		info
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
		let frame = rgba_from_rows(&negotiated(VideoFormat::BGRx, width, height), &rows, stride)
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
		let frame = rgba_from_rows(&negotiated(VideoFormat::RGBA, 1, 1), &rows, 4)
			.expect("an RGBA frame converts");
		assert_eq!(frame.get_pixel(0, 0).0, [0x0a, 0x0b, 0x0c, 0x00]);
	}

	/// The fourth byte of RGBx is an undefined pad, so publishing it verbatim
	/// would make a fully painted monitor look transparent to the caller.
	#[test]
	fn rgbx_pad_byte_becomes_opaque() {
		let rows = [0x0a, 0x0b, 0x0c, 0x00];
		let frame = rgba_from_rows(&negotiated(VideoFormat::RGBx, 1, 1), &rows, 4)
			.expect("an RGBx frame converts");
		assert_eq!(frame.get_pixel(0, 0).0, [0x0a, 0x0b, 0x0c, 255]);
	}

	/// A planar format is not one byte per pixel per channel, so reading it as
	/// packed RGB would publish scrambled colors instead of failing.
	#[test]
	fn planar_formats_are_refused() {
		let rows = [0; 16];
		assert!(rgba_from_rows(&negotiated(VideoFormat::NV12, 2, 2), &rows, 4).is_err());
	}

	/// A chunk that cannot hold the negotiated rows would be read past its end,
	/// turning a compositor hiccup into a garbage or crashing capture.
	#[test]
	fn chunks_that_cannot_hold_their_rows_are_refused() {
		let truncated = [0; 7];
		assert!(rgba_from_rows(&negotiated(VideoFormat::RGB, 2, 2), &truncated, 8).is_err());

		let narrow = [0; 8];
		assert!(rgba_from_rows(&negotiated(VideoFormat::RGBA, 4, 1), &narrow, 8).is_err());
	}

	/// An empty negotiation is a compositor that answered without a resolution;
	/// returning a zero-sized image would report a blank monitor as a
	/// successful capture.
	#[test]
	fn zero_sized_frames_are_refused() {
		let rows = [0; 16];
		assert!(rgba_from_rows(&negotiated(VideoFormat::RGBA, 0, 4), &rows, 4).is_err());
		assert!(rgba_from_rows(&negotiated(VideoFormat::RGBA, 4, 0), &rows, 4).is_err());
	}

	#[test]
	fn oversized_frames_are_refused_before_allocating() {
		let rows = [0; 16];
		assert!(rgba_from_rows(&negotiated(VideoFormat::RGBA, 65_536, 65_536), &rows, 4).is_err());
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
}
