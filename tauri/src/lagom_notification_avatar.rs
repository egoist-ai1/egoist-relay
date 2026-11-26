use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, Limits, RgbaImage, imageops::FilterType};
use std::{io::Cursor, sync::OnceLock, time::Duration};
use url::Url;

use super::{MAX_ICON, Service, valid_icon};

// Оставляем место для data: URI и увеличения размера при кодировании Base64.
const MAX_IMAGE_BYTES: usize = (MAX_ICON - 64) / 4 * 3;
const PORTRAIT_SIDE: u32 = 144;
static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();

pub(super) fn trusted_url(service: Service, raw: &str) -> Option<Url> {
  let url = Url::parse(raw).ok()?;
  if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
    return None;
  }
  let host = url.host_str()?;
  let is_trusted = match service {
    Service::Telegram => false,
    Service::X => host == "pbs.twimg.com" && url.path().starts_with("/profile_images/"),
    Service::Instagram => host.starts_with("scontent")
      && (host.ends_with(".cdninstagram.com") || host.ends_with(".fbcdn.net")),
  };
  is_trusted.then_some(url)
}

pub(super) fn decode(icon: &str) -> Option<RgbaImage> {
  if !valid_icon(icon) {
    return None;
  }
  let (kind, encoded) = icon.strip_prefix("data:")?.split_once(";base64,")?;
  decode_bytes(&STANDARD.decode(encoded).ok()?, image_format(kind)?)
}

pub(super) async fn fetch(url: Url) -> Option<RgbaImage> {
  let client = CLIENT.get_or_init(|| {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
      .redirect(reqwest::redirect::Policy::none())
      .timeout(Duration::from_millis(1600))
      .build()
      .ok()
  }).as_ref()?;

  let mut response = client.get(url).send().await.ok()?;
  if !response.status().is_success() || response.content_length().is_some_and(|length| length > MAX_IMAGE_BYTES as u64) {
    return None;
  }
  let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)?.to_str().ok()?.split(';').next()?.trim();
  let format = image_format(content_type)?;
  let mut bytes = Vec::new();
  while let Some(chunk) = response.chunk().await.ok()? {
    if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
      return None;
    }
    bytes.extend_from_slice(&chunk);
  }
  decode_bytes(&bytes, format)
}

fn image_format(content_type: &str) -> Option<ImageFormat> {
  Some(match content_type {
    "image/png" => ImageFormat::Png,
    "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
    "image/gif" => ImageFormat::Gif,
    "image/webp" => ImageFormat::WebP,
    _ => return None,
  })
}

fn decode_bytes(bytes: &[u8], format: ImageFormat) -> Option<RgbaImage> {
  let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
  let mut limits = Limits::default();
  limits.max_image_width = Some(1024);
  limits.max_image_height = Some(1024);
  limits.max_alloc = Some(8 * 1024 * 1024);
  reader.limits(limits);
  let photo = reader.decode().ok()?;
  if photo.width().min(photo.height()) < 40 {
    return None;
  }
  let photo = if photo.width().max(photo.height()) > PORTRAIT_SIDE {
    photo.resize(PORTRAIT_SIDE, PORTRAIT_SIDE, FilterType::Lanczos3)
  } else {
    photo
  };
  (photo.width().min(photo.height()) >= 40).then(|| photo.into_rgba8())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn allows_only_the_expected_service_avatar_origins() {
    assert!(trusted_url(Service::X, "https://pbs.twimg.com/profile_images/123/avatar.jpg").is_some());
    assert!(trusted_url(Service::Instagram, "https://scontent.test.cdninstagram.com/image.jpg").is_some());
    assert!(trusted_url(Service::Instagram, "https://scontent.test.fbcdn.net/image.jpg").is_some());
    for url in [
      "http://pbs.twimg.com/profile_images/123/avatar.jpg",
      "https://pbs.twimg.com:8443/profile_images/123/avatar.jpg",
      "https://viewer@pbs.twimg.com/profile_images/123/avatar.jpg",
      "https://pbs.twimg.com.evil.invalid/profile_images/123/avatar.jpg",
      "https://pbs.twimg.com/other/avatar.jpg",
      "https://127.0.0.1/image.jpg",
    ] {
      assert!(trusted_url(Service::X, url).is_none());
      assert!(trusted_url(Service::Instagram, url).is_none());
    }
  }
}
