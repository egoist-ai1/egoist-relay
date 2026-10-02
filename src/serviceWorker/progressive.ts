import {
  DEBUG,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_PROGRESSIVE_CACHE_DISABLED,
  MEDIA_PROGRESSIVE_CACHE_NAME,
} from '../config';
import generateUniqueId from '../util/generateUniqueId';
import { getAccountSlot } from '../util/multiaccount';

declare const self: ServiceWorkerGlobalScope;

type PartInfo = {
  type: 'PartInfo';
  arrayBuffer: ArrayBuffer;
  mimeType: string;
  fullSize: number;
};

type RequestStates = {
  resolve: (response: PartInfo) => void;
  reject: (error: Error) => void;
  clientId: string;
};

const MB = 1024 * 1024;
const DEFAULT_PART_SIZE = 0.5 * MB;
const MAX_END_TO_CACHE = 16 * MB - 1; // Cache up to 16 MB of each progressive media stream
const PART_TIMEOUT = 60000;

const requestStates = new Map<string, RequestStates>();

export async function respondForProgressive(e: FetchEvent) {
  const { url } = e.request;
  const accountSlot = getAccountSlot(url);
  const parsedUrl = new URL(url);
  const fileSizeParam = parsedUrl.searchParams.get('fileSize');
  const fileSize = fileSizeParam ? Number(fileSizeParam) : undefined;
  const hasFileSize = fileSize !== undefined && Number.isSafeInteger(fileSize) && fileSize >= 0;
  const range = e.request.headers.get('range');
  const bytes = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (!bytes || (!bytes[1] && !bytes[2]) || (!bytes[1] && !hasFileSize)) {
    return respondForInvalidRange(hasFileSize ? fileSize : undefined);
  }
  const suffixSize = bytes[1] ? undefined : Number(bytes[2]);
  const start = suffixSize !== undefined ? Math.max(fileSize! - suffixSize, 0) : Number(bytes[1]);
  const originalEnd = suffixSize !== undefined ? fileSize! - 1 : (bytes[2] ? Number(bytes[2]) : undefined);
  if (!Number.isSafeInteger(start) || start < 0
    || (originalEnd !== undefined && (!Number.isSafeInteger(originalEnd) || originalEnd < start))
    || (suffixSize !== undefined && (!Number.isSafeInteger(suffixSize) || suffixSize <= 0))
    || (hasFileSize && start >= fileSize)) {
    return respondForInvalidRange(hasFileSize ? fileSize : undefined);
  }

  let end = Math.min(originalEnd ?? Infinity, start + DEFAULT_PART_SIZE - 1);
  if (hasFileSize) end = Math.min(end, fileSize - 1);

  // Optimization for Safari
  if (start === 0 && end === 1) {
    const mimeType = parsedUrl.searchParams.get('mimeType');

    if (hasFileSize && fileSize >= 2 && mimeType) {
      return new Response(new Uint8Array(2).buffer, {
        status: 206,
        statusText: 'Partial Content',
        headers: [
          ['Content-Range', `bytes 0-1/${fileSize}`],
          ['Accept-Ranges', 'bytes'],
          ['Content-Length', '2'],
          ['Content-Type', mimeType],
        ],
      });
    }
  }

  parsedUrl.searchParams.set('start', String(start));
  parsedUrl.searchParams.set('end', String(end));
  const cacheKey = parsedUrl.href;
  const [cachedArrayBuffer, cachedHeaders] = !MEDIA_PROGRESSIVE_CACHE_DISABLED
    ? await fetchFromCache(accountSlot, cacheKey).catch(() => []) : [];

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log(
      `FETCH PROGRESSIVE ${cacheKey} (request: ${start}-${originalEnd}) CACHED: ${Boolean(cachedArrayBuffer)}`,
    );
  }

  if (cachedArrayBuffer && cachedHeaders) {
    return new Response(cachedArrayBuffer, {
      status: 206,
      statusText: 'Partial Content',
      headers: cachedHeaders,
    });
  }

  let partInfo;
  try {
    partInfo = await requestPart(e, { url, start, end });
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('FETCH PROGRESSIVE', err);
    }
  }

  if (!partInfo) {
    return new Response('', {
      status: 500,
      statusText: 'Failed to fetch progressive part',
    });
  }

  const { arrayBuffer, fullSize, mimeType } = partInfo;
  if (!Number.isSafeInteger(fullSize) || fullSize <= start || !arrayBuffer.byteLength) {
    return respondForInvalidRange(fullSize);
  }

  const partSize = Math.min(end - start + 1, arrayBuffer.byteLength, fullSize - start);
  end = start + partSize - 1;
  const arrayBufferPart = arrayBuffer.slice(0, partSize);
  const headers: [string, string][] = [
    ['Content-Range', `bytes ${start}-${end}/${fullSize}`],
    ['Accept-Ranges', 'bytes'],
    ['Content-Length', String(partSize)],
    ['Content-Type', mimeType],
  ];

  if (!MEDIA_PROGRESSIVE_CACHE_DISABLED && partSize <= MEDIA_CACHE_MAX_BYTES && end <= MAX_END_TO_CACHE) {
    e.waitUntil(saveToCache(accountSlot, cacheKey, arrayBufferPart, headers).catch(() => undefined));
  }

  return new Response(arrayBufferPart, {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}

function respondForInvalidRange(fullSize?: number) {
  return new Response('', {
    status: 416,
    statusText: 'Range Not Satisfiable',
    headers: fullSize !== undefined && Number.isSafeInteger(fullSize) && fullSize >= 0
      ? { 'Content-Range': `bytes */${fullSize}` } : undefined,
  });
}

// We can not cache 206 responses: https://github.com/GoogleChrome/workbox/issues/1644#issuecomment-638741359
async function fetchFromCache(accountSlot: number | undefined, cacheKey: string) {
  const cacheName = !accountSlot ? MEDIA_PROGRESSIVE_CACHE_NAME : `${MEDIA_PROGRESSIVE_CACHE_NAME}_${accountSlot}`;
  const cache = await self.caches.open(cacheName);

  return Promise.all([
    cache.match(`${cacheKey}&type=arrayBuffer`).then((r) => (r ? r.arrayBuffer() : undefined)),
    cache.match(`${cacheKey}&type=headers`).then((r) => (r ? r.json() : undefined)),
  ]);
}

async function saveToCache(
  accountSlot: number | undefined, cacheKey: string, arrayBuffer: ArrayBuffer, headers: HeadersInit,
) {
  const cacheName = !accountSlot ? MEDIA_PROGRESSIVE_CACHE_NAME : `${MEDIA_PROGRESSIVE_CACHE_NAME}_${accountSlot}`;
  const cache = await self.caches.open(cacheName);

  return Promise.all([
    cache.put(new Request(`${cacheKey}&type=arrayBuffer`), new Response(arrayBuffer)),
    cache.put(new Request(`${cacheKey}&type=headers`), new Response(JSON.stringify(headers))),
  ]);
}

export async function requestPart(
  e: FetchEvent,
  params: { url: string; start: number; end: number },
): Promise<PartInfo | undefined> {
  const isDownload = params.url.includes('/download/');
  const client = await (isDownload ? getClientForRequest(params.url) : self.clients.get(e.clientId));
  if (!client) {
    return undefined;
  }

  const messageId = generateUniqueId();
  const { signal } = e.request;
  if (signal.aborted) throw new Error('ERROR_PART_ABORTED');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const handleAbort = () => requestStates.get(messageId)?.reject(new Error('ERROR_PART_ABORTED'));
  try {
    return await new Promise<PartInfo>((resolve, reject) => {
      requestStates.set(messageId, { resolve, reject, clientId: client.id });
      timeout = setTimeout(() => reject(new Error('ERROR_PART_TIMEOUT')), PART_TIMEOUT);
      signal.addEventListener('abort', handleAbort, { once: true });
      client.postMessage({ type: 'requestPart', messageId, params });
    });
  } finally {
    requestStates.delete(messageId);
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener('abort', handleAbort);
  }
}

async function getClientForRequest(url: string) {
  const urlAccountSlot = getAccountSlot(url);
  const clients = await self.clients.matchAll();
  return clients.find((c) => (
    c.type === 'window' && c.frameType === 'top-level' && getAccountSlot(c.url) === urlAccountSlot
  ));
}

self.addEventListener('message', (e) => {
  const { type, messageId, result } = e.data as {
    type: string;
    messageId: string;
    result: PartInfo;
  };

  if (type === 'partResponse') {
    const requestState = requestStates.get(messageId);
    if (requestState && e.source && 'id' in e.source && e.source.id === requestState.clientId) {
      requestState.resolve(result);
    }
  }
});
