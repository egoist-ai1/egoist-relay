import type { InlineSocialMediaSource } from './inlineSocialMedia';

import { IS_TAURI } from './browser/globalEnvironment';
import { parseInlineSocialMediaUrl } from './inlineSocialMedia';

const MAX_HEADER_SIZE = 1024;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm']);
let resolverQueue: Promise<void> = Promise.resolve();

export function parseInlineMediaPacket(packet: ArrayBuffer): Blob {
  if (!(packet instanceof ArrayBuffer) || packet.byteLength < 9) throw new Error('INLINE_MEDIA_INVALID_PACKET');
  const bytes = new Uint8Array(packet);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'ERMS') throw new Error('INLINE_MEDIA_INVALID_PACKET');
  const headerSize = new DataView(packet).getUint32(4, true);
  if (!headerSize || headerSize > MAX_HEADER_SIZE || headerSize + 8 >= packet.byteLength) {
    throw new Error('INLINE_MEDIA_INVALID_PACKET');
  }
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + headerSize)));
  const size = packet.byteLength - 8 - headerSize;
  if (!header || header.index !== 0 || header.size !== size || size > MAX_FILE_SIZE
    || !VIDEO_MIME_TYPES.has(header.mimeType)) throw new Error('INLINE_MEDIA_INVALID_PACKET');
  return new Blob([packet.slice(8 + headerSize)], { type: header.mimeType });
}

export default async function resolveInlineMedia(source: InlineSocialMediaSource, signal: AbortSignal): Promise<Blob> {
  if (!IS_TAURI || !parseInlineSocialMediaUrl(source.canonicalUrl)) throw new Error('INLINE_MEDIA_UNAVAILABLE');
  if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
  const resolution = resolverQueue.then(() => runInlineMediaResolution(source, signal));
  // The queue waits for actual IPC settlement even when its caller cancels immediately
  resolverQueue = resolution.then(() => {}, () => {});
  return waitForInlineMediaResolution(resolution, signal);
}

export async function saveInlineMedia(source: InlineSocialMediaSource, signal: AbortSignal): Promise<void> {
  if (!IS_TAURI || !parseInlineSocialMediaUrl(source.canonicalUrl)) throw new Error('INLINE_MEDIA_UNAVAILABLE');
  if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
  const download = resolverQueue.then(async () => {
    if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
    const { invoke } = await import('@tauri-apps/api/core');
    if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void invoke('relay_inline_cancel_media', { requestId }).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await invoke('relay_inline_save_media', { url: source.canonicalUrl, requestId });
      if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  });
  resolverQueue = download.then(() => {}, () => {});
  return waitForInlineMediaResolution(download, signal);
}

async function runInlineMediaResolution(source: InlineSocialMediaSource, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
  const { invoke } = await import('@tauri-apps/api/core');
  if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
  const requestId = crypto.randomUUID();
  const cancel = () => {
    void invoke('relay_inline_cancel_media', { requestId }).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const packet = await invoke<ArrayBuffer>('relay_inline_resolve_media', { url: source.canonicalUrl, requestId });
    if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
    return parseInlineMediaPacket(packet);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function waitForInlineMediaResolution<T>(resolution: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Canceled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(new DOMException('Canceled', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    resolution.then((blob) => {
      signal.removeEventListener('abort', cancel);
      resolve(blob);
    }, (err) => {
      signal.removeEventListener('abort', cancel);
      reject(err);
    });
  });
}
