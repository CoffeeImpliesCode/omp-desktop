#[cfg(any(feature = "wayland-pipewire", test))]
use image::{RgbaImage, imageops};

use crate::desktop::{
	error::{CoreResult, DesktopError},
	frame::MAX_COMPOSITE_PIXELS,
	types::DesktopDisplay,
};
#[cfg(any(feature = "wayland-pipewire", test))]
use crate::desktop::{linux::ax::AtSpiWindow, types::DisplaySelector};

#[cfg(test)]
mod tests {
	use image::Rgba;

	use super::*;
	use crate::desktop::frame::FrameGeometry;

	fn monitor(
		x: i32,
		y: i32,
		width: u32,
		height: u32,
		scale: u32,
		color: u8,
	) -> (RgbaImage, PortalGeometry) {
		let image = RgbaImage::from_pixel(width * scale, height * scale, Rgba([color, 0, 0, 255]));
		let geometry = PortalGeometry::new(
			Some((x, y)),
			Some((width as i32, height as i32)),
			image.width(),
			image.height(),
		);
		(image, geometry)
	}

	#[test]
	fn both_monitors_survive_composition_and_coordinate_mapping() {
		let frames = vec![monitor(4, 0, 4, 3, 1, 22), monitor(0, 0, 4, 3, 1, 11)];
		let (image, displays) = compose(frames, &DisplaySelector::All, &[]).unwrap();
		assert_eq!(image.dimensions(), (8, 3));
		assert_eq!(image.get_pixel(1, 1).0, [11, 0, 0, 255]);
		assert_eq!(image.get_pixel(6, 1).0, [22, 0, 0, 255]);
		assert_ne!(displays[0].id, displays[1].id);
		let frame = FrameGeometry::for_displays(&displays);
		assert_eq!(frame.map_point(6.0, 1.0, None).unwrap(), (6.0, 1.0));
	}

	#[test]
	fn selecting_second_portal_monitor_keeps_its_pixels_and_origin() {
		let frames = vec![monitor(-4, 0, 4, 3, 1, 11), monitor(0, 0, 4, 3, 2, 22)];
		let (image, displays) =
			compose(frames, &DisplaySelector::Id("wayland-portal-1".into()), &[]).unwrap();
		assert_eq!(image.dimensions(), (8, 6));
		assert_eq!(image.get_pixel(7, 5).0, [22, 0, 0, 255]);
		let frame = FrameGeometry::for_displays(&displays);
		assert_eq!(frame.map_point(6.0, 4.0, None).unwrap(), (3.0, 2.0));
	}

	#[test]
	fn negative_origins_and_mixed_scale_do_not_overlap_native_buffers() {
		let frames = vec![monitor(-4, -2, 4, 3, 1, 11), monitor(0, -2, 4, 3, 2, 22)];
		let (image, displays) = compose(frames, &DisplaySelector::All, &[]).unwrap();
		assert_eq!(image.dimensions(), (16, 6));
		assert_eq!(image.get_pixel(1, 1).0, [11, 0, 0, 255]);
		assert_eq!(image.get_pixel(9, 1).0, [22, 0, 0, 255]);
		let frame = FrameGeometry::for_displays(&displays);
		assert_eq!(frame.map_point(10.0, 4.0, None).unwrap(), (1.0, 0.0));
		assert!(frame.map_point(5.0, 1.0, None).is_err(), "padding is not an input surface");
	}

	#[test]
	fn missing_display_selector_and_oversized_layout_fail_closed() {
		let err =
			compose(vec![monitor(0, 0, 4, 3, 1, 11)], &DisplaySelector::Id("missing".into()), &[])
				.unwrap_err();
		assert_eq!(err.code.as_str(), "InvalidTarget");
		let mut displays = vec![
			PortalGeometry::new(Some((i32::MIN, 0)), Some((4, 3)), 4, 3).display(0),
			PortalGeometry::new(Some((i32::MAX - 4, 0)), Some((4, 3)), 4, 3).display(1),
		];
		assert!(layout(&mut displays).is_err());
	}
}

#[cfg(any(feature = "wayland-pipewire", test))]
/// Portal logical bounds paired with the native `PipeWire` buffer dimensions.
#[derive(Debug, Clone, Copy)]
pub(super) struct PortalGeometry {
	logical_x:      i32,
	logical_y:      i32,
	logical_width:  u32,
	logical_height: u32,
	pixel_width:    u32,
	pixel_height:   u32,
}

#[cfg(any(feature = "wayland-pipewire", test))]
impl PortalGeometry {
	pub(super) fn new(
		position: Option<(i32, i32)>,
		size: Option<(i32, i32)>,
		pixel_width: u32,
		pixel_height: u32,
	) -> Self {
		let (logical_x, logical_y) = position.unwrap_or((0, 0));
		let (logical_width, logical_height) = match size {
			Some((w, h)) if w > 0 && h > 0 => (w as u32, h as u32),
			_ => (pixel_width, pixel_height),
		};
		Self { logical_x, logical_y, logical_width, logical_height, pixel_width, pixel_height }
	}

	pub(super) fn display(&self, index: usize) -> DesktopDisplay {
		DesktopDisplay {
			id:           format!("wayland-portal-{index}"),
			name:         format!("Wayland portal monitor {}", index + 1),
			x:            self.logical_x,
			y:            self.logical_y,
			width:        self.logical_width,
			height:       self.logical_height,
			scale:        f64::from(self.pixel_width) / f64::from(self.logical_width.max(1)),
			pixel_x:      0,
			pixel_y:      0,
			pixel_width:  self.pixel_width,
			pixel_height: self.pixel_height,
			is_primary:   index == 0,
		}
	}

	pub(super) fn window_crop(&self, entry: &AtSpiWindow) -> CoreResult<(u32, u32, u32, u32)> {
		let window = &entry.window;
		if !entry.position_known {
			return Err(DesktopError::capture_failed(format!(
				"Wayland window {} has no known screen position; use native compositor window capture \
				 or capture the desktop",
				window.id
			)));
		}
		let outside = || {
			DesktopError::capture_failed(format!(
				"Wayland window {} is outside the selected portal monitor",
				window.id
			))
		};
		let rel_x = i64::from(window.x) - i64::from(self.logical_x);
		let rel_y = i64::from(window.y) - i64::from(self.logical_y);
		if rel_x < 0
			|| rel_y < 0
			|| rel_x + i64::from(window.width) > i64::from(self.logical_width)
			|| rel_y + i64::from(window.height) > i64::from(self.logical_height)
		{
			return Err(outside());
		}
		let scale_x = f64::from(self.pixel_width) / f64::from(self.logical_width.max(1));
		let scale_y = f64::from(self.pixel_height) / f64::from(self.logical_height.max(1));
		let x = (rel_x as f64 * scale_x).round() as u32;
		let y = (rel_y as f64 * scale_y).round() as u32;
		let right = ((rel_x as f64 + f64::from(window.width)) * scale_x).round() as u32;
		let bottom = ((rel_y as f64 + f64::from(window.height)) * scale_y).round() as u32;
		if right <= x || bottom <= y || right > self.pixel_width || bottom > self.pixel_height {
			return Err(outside());
		}
		Ok((x, y, right - x, bottom - y))
	}
}

/// Put native buffers on a common maximum-scale grid. Smaller-scale buffers
/// stay native-sized; gaps are deliberately excluded from coordinate mapping.
pub(super) fn layout(displays: &mut [DesktopDisplay]) -> CoreResult<(u32, u32)> {
	let left = displays
		.iter()
		.map(|d| d.x)
		.min()
		.ok_or_else(|| DesktopError::capture_failed("no authorized monitor streams"))?;
	let top = displays.iter().map(|d| d.y).min().unwrap_or(0);
	let scale = displays.iter().map(|d| d.scale).fold(1.0_f64, f64::max);
	let mut width = 0_u64;
	let mut height = 0_u64;
	for d in displays {
		if d.width == 0
			|| d.height == 0
			|| d.pixel_width == 0
			|| d.pixel_height == 0
			|| !d.scale.is_finite()
			|| d.scale <= 0.0
		{
			return Err(DesktopError::capture_failed("invalid monitor geometry"));
		}
		let x = ((i64::from(d.x) - i64::from(left)) as f64 * scale).round();
		let y = ((i64::from(d.y) - i64::from(top)) as f64 * scale).round();
		if x > f64::from(u32::MAX) || y > f64::from(u32::MAX) {
			return Err(DesktopError::capture_failed(
				"monitor layout exceeds composite coordinate space",
			));
		}
		d.pixel_x = x as u32;
		d.pixel_y = y as u32;
		width = width.max(u64::from(d.pixel_x) + u64::from(d.pixel_width));
		height = height.max(u64::from(d.pixel_y) + u64::from(d.pixel_height));
	}
	if width > u64::from(u32::MAX)
		|| height > u64::from(u32::MAX)
		|| width
			.checked_mul(height)
			.is_none_or(|pixels| pixels > MAX_COMPOSITE_PIXELS)
	{
		return Err(DesktopError::capture_failed("monitor composite exceeds native safety limit"));
	}
	Ok((width as u32, height as u32))
}

#[cfg(any(feature = "wayland-pipewire", test))]
pub(super) fn metadata(
	frames: &[(RgbaImage, PortalGeometry)],
	known: &[DesktopDisplay],
) -> Vec<DesktopDisplay> {
	frames
		.iter()
		.enumerate()
		.map(|(index, (_, geometry))| {
			let mut display = geometry.display(index);
			let mut matches = known.iter().filter(|d| {
				d.x == display.x
					&& d.y == display.y
					&& d.width == display.width
					&& d.height == display.height
			});
			if let Some(native) = matches.next()
				&& matches.next().is_none()
			{
				display.id.clone_from(&native.id);
				display.name.clone_from(&native.name);
				display.is_primary = native.is_primary;
			}
			display
		})
		.collect()
}

#[cfg(any(feature = "wayland-pipewire", test))]
pub(super) fn compose(
	mut frames: Vec<(RgbaImage, PortalGeometry)>,
	selector: &DisplaySelector,
	known: &[DesktopDisplay],
) -> CoreResult<(RgbaImage, Vec<DesktopDisplay>)> {
	let mut displays = metadata(&frames, known);
	if let DisplaySelector::Id(id) = selector {
		let index = displays
			.iter()
			.position(|d| &d.id == id || &d.name == id)
			.ok_or_else(|| {
				DesktopError::invalid_target(format!(
					"selected Wayland display '{id}' is not in the authorized capture"
				))
			})?;
		let frame = frames.swap_remove(index);
		let display = displays.swap_remove(index);
		frames = vec![frame];
		displays = vec![display];
	}
	let (width, height) = layout(&mut displays)?;
	if frames.len() == 1 {
		return Ok((frames.remove(0).0, displays));
	}
	let mut image = RgbaImage::new(width, height);
	for ((frame, _), display) in frames.into_iter().zip(&displays) {
		imageops::replace(&mut image, &frame, i64::from(display.pixel_x), i64::from(display.pixel_y));
	}
	Ok((image, displays))
}
