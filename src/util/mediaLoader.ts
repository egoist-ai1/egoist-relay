import type {
  ApiOnProgress,
  ApiParsedMedia,
  ApiPreparedMedia,
} from '../api/types';
import {
  ApiMediaFormat,
} from '../api/types';

import {
  DEBUG, MEDIA_CACHE_DISABLED, MEDIA_CACHE_NAME,
  MEDIA_CACHE_NAME_AVATARS,
} from '../config';
import { callApi, cancelApiProgress } from '../api/gramjs';
import {
  IS_OPUS_SUPPORTED, IS_PROGRESSIVE_SUPPORTED,
} from './browser/windowEnvironment';
import * as cacheApi from './cacheApi';
import { ACCOUNT_SLOT } from './multiaccount';
import { oggToWav } from './oggToWav';

const asCacheApiType = {
  [ApiMediaFormat.BlobUrl]: cacheApi.Type.Blob,
  [ApiMediaFormat.Text]: cacheApi.Type.Text,
  [ApiMediaFormat.DownloadUrl]: undefined,
  [ApiMediaFormat.Progressive]: undefined,
};

const PROGRESSIVE_URL_PREFIX = './progressive/';
const DOWNLOAD_URL_PREFIX = './download/';
const MAX_MEDIA_RETRIES = 5;
const MAX_MEMORY_ENTRIES = 512;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const MEMORY_GRACE_PERIOD = 5 * 60 * 1000;
const MEMORY_CLEANUP_INTERVAL = 60 * 1000;

type MediaCacheEntry = {
  url: string;
  value: ApiPreparedMedia;
  size: number;
  ownedBlobUrl?: string;
  accessedAt: number;
};

const memoryCache = new Map<string, MediaCacheEntry>();
const retiredEntries = new Map<string, MediaCacheEntry[]>();
const retainedMedia = new Map<string, number>();
const fetchPromises = new Map<string, Promise<ApiPreparedMedia | undefined>>();
const progressCallbacks = new Map<string, Map<string, ApiOnProgress>>();
const cancellableCallbacks = new Map<string, ApiOnProgress>();
const untrackedConsumers = new Map<string, number>();
const invalidatedRequests = new WeakSet<Promise<ApiPreparedMedia | undefined>>();
let memoryBytes = 0;
let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;

export function fetch<T extends ApiMediaFormat>(
  url: string,
  mediaFormat: T,
  isHtmlAllowed = false,
  onProgress?: ApiOnProgress,
  callbackUniqueId?: string,
): Promise<ApiPreparedMedia> {
  if (mediaFormat === ApiMediaFormat.Progressive) {
    return (
      IS_PROGRESSIVE_SUPPORTED
        ? Promise.resolve(getProgressiveUrl(url))
        : fetch(url, ApiMediaFormat.BlobUrl, isHtmlAllowed, onProgress, callbackUniqueId)
    );
  }

  if (mediaFormat === ApiMediaFormat.DownloadUrl) {
    return (
      IS_PROGRESSIVE_SUPPORTED
        ? Promise.resolve(getDownloadUrl(url))
        : fetch(url, ApiMediaFormat.BlobUrl, isHtmlAllowed, onProgress, callbackUniqueId)
    );
  }

  const cacheKey = buildCacheKey(url, mediaFormat, isHtmlAllowed);
  const cached = getFromMemory(url, mediaFormat, isHtmlAllowed);
  if (cached) {
    onProgress?.(1);
    return Promise.resolve(cached);
  }
  const previous = fetchPromises.get(cacheKey);
  if (previous && (cancellableCallbacks.get(cacheKey)?.isCanceled || invalidatedRequests.has(previous))) {
    return previous.then(() => fetch(url, mediaFormat, isHtmlAllowed, onProgress, callbackUniqueId));
  }
  if (!fetchPromises.has(cacheKey)) {
    const promise = fetchFromCacheOrRemote(url, mediaFormat, isHtmlAllowed, cacheKey)
      .then((entry) => {
        if (invalidatedRequests.has(promise)) {
          releaseEntry(entry);
          return undefined;
        }
        memoryCache.set(cacheKey, entry);
        memoryBytes += entry.size;
        scheduleMemoryCleanup();
        return entry.value;
      })
      .catch((err) => {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.warn(err);
        }

        return undefined;
      })
      .finally(() => {
        fetchPromises.delete(cacheKey);
        progressCallbacks.delete(cacheKey);
        cancellableCallbacks.delete(cacheKey);
      });

    fetchPromises.set(cacheKey, promise);
  }

  if (onProgress && callbackUniqueId) {
    let activeCallbacks = progressCallbacks.get(cacheKey);
    if (!activeCallbacks) {
      activeCallbacks = new Map<string, ApiOnProgress>();
      progressCallbacks.set(cacheKey, activeCallbacks);
    }
    activeCallbacks.set(callbackUniqueId, onProgress);
  }

  const pending = fetchPromises.get(cacheKey)!;
  if (onProgress && callbackUniqueId) return pending as Promise<ApiPreparedMedia>;
  untrackedConsumers.set(cacheKey, (untrackedConsumers.get(cacheKey) || 0) + 1);
  return pending.finally(() => {
    const remaining = (untrackedConsumers.get(cacheKey) || 1) - 1;
    if (remaining) untrackedConsumers.set(cacheKey, remaining);
    else untrackedConsumers.delete(cacheKey);
  }) as Promise<ApiPreparedMedia>;
}

export function getFromMemory(url: string, mediaFormat = ApiMediaFormat.BlobUrl, isHtmlAllowed = false) {
  const cacheKey = buildCacheKey(url, mediaFormat, isHtmlAllowed);
  const entry = memoryCache.get(cacheKey);
  if (!entry) return undefined;
  entry.accessedAt = Date.now();
  memoryCache.delete(cacheKey);
  memoryCache.set(cacheKey, entry);
  return entry.value;
}

export function retainMedia(
  url: string, mediaFormat = ApiMediaFormat.BlobUrl, isHtmlAllowed = false,
): NoneToVoidFunction {
  const cacheKey = buildCacheKey(url, mediaFormat, isHtmlAllowed);
  retainedMedia.set(cacheKey, (retainedMedia.get(cacheKey) || 0) + 1);
  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    const remaining = (retainedMedia.get(cacheKey) || 1) - 1;
    if (remaining) {
      retainedMedia.set(cacheKey, remaining);
      return;
    }
    retainedMedia.delete(cacheKey);
    retiredEntries.get(cacheKey)?.forEach(releaseEntry);
    retiredEntries.delete(cacheKey);
    scheduleMemoryCleanup();
  };
}

export function cancelProgress(progressCallback: ApiOnProgress) {
  progressCallbacks.forEach((map, cacheKey) => {
    map.forEach((callback, callbackId) => {
      if (callback === progressCallback) {
        map.delete(callbackId);
        if (map.size || untrackedConsumers.has(cacheKey)) return;
        const parentCallback = cancellableCallbacks.get(cacheKey);
        if (!parentCallback) return;

        cancelApiProgress(parentCallback);
        progressCallbacks.delete(cacheKey);
        return;
      }
    });
  });
}

export function removeCallback(
  url: string, callbackUniqueId: string, mediaFormat = ApiMediaFormat.BlobUrl, isHtmlAllowed = false,
) {
  const callbacks = progressCallbacks.get(buildCacheKey(url, mediaFormat, isHtmlAllowed));
  if (!callbacks) return;
  callbacks.delete(callbackUniqueId);
}

export function getProgressiveUrl(url: string) {
  const base = new URL(`${PROGRESSIVE_URL_PREFIX}${url}`, window.location.href);
  if (ACCOUNT_SLOT) base.searchParams.set('account', ACCOUNT_SLOT.toString());
  return base.href;
}

function getDownloadUrl(url: string) {
  const base = new URL(`${DOWNLOAD_URL_PREFIX}${url}`, window.location.href);
  if (ACCOUNT_SLOT) base.searchParams.set('account', ACCOUNT_SLOT.toString());
  return base.href;
}

async function fetchFromCacheOrRemote(
  url: string, mediaFormat: ApiMediaFormat, isHtmlAllowed: boolean, cacheKey: string, retryNumber = 0,
): Promise<MediaCacheEntry> {
  if (!MEDIA_CACHE_DISABLED) {
    const cacheName = url.startsWith('avatar') ? MEDIA_CACHE_NAME_AVATARS : MEDIA_CACHE_NAME;
    const cached = await cacheApi.fetch(cacheName, url, asCacheApiType[mediaFormat]!, isHtmlAllowed);

    if (cached) {
      let media = cached;

      if (cached.type === 'audio/ogg' && !IS_OPUS_SUPPORTED) {
        media = await oggToWav(media);
      }

      return prepareMedia(url, media);
    }
  }

  const onProgress = makeOnProgress(cacheKey);
  cancellableCallbacks.set(cacheKey, onProgress);

  const remote = await callApi('downloadMedia', { url, mediaFormat, isHtmlAllowed }, onProgress);
  if (onProgress.isCanceled) throw new Error('MEDIA_CANCELED');
  if (!remote) {
    if (retryNumber >= MAX_MEDIA_RETRIES) {
      throw new Error(`Failed to fetch media ${url}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, getRetryTimeout(retryNumber));
    });
    if (onProgress.isCanceled) throw new Error('MEDIA_CANCELED');
    // eslint-disable-next-line no-console
    if (DEBUG) console.debug(`Retrying to fetch media ${url}`);
    return fetchFromCacheOrRemote(url, mediaFormat, isHtmlAllowed, cacheKey, retryNumber + 1);
  }

  const { mimeType } = remote;
  let media = remote.dataBlob;

  if (mimeType === 'audio/ogg' && !IS_OPUS_SUPPORTED && media instanceof Blob) {
    media = await oggToWav(media);
  }

  return prepareMedia(url, media);
}

export async function unload(url: string) {
  for (const [cacheKey, entry] of memoryCache) {
    if (entry.url !== url) continue;
    memoryCache.delete(cacheKey);
    memoryBytes -= entry.size;
    if (retainedMedia.has(cacheKey)) {
      const entries = retiredEntries.get(cacheKey) || [];
      entries.push(entry);
      retiredEntries.set(cacheKey, entries);
    } else releaseEntry(entry);
  }
  for (const [cacheKey, promise] of fetchPromises) {
    if (JSON.parse(cacheKey)[0] !== url) continue;
    invalidatedRequests.add(promise);
    const progress = cancellableCallbacks.get(cacheKey);
    if (progress) cancelApiProgress(progress);
  }
  if (!MEDIA_CACHE_DISABLED) {
    const cacheName = url.startsWith('avatar') ? MEDIA_CACHE_NAME_AVATARS : MEDIA_CACHE_NAME;
    await cacheApi.remove(cacheName, url);
  }
}

function makeOnProgress(cacheKey: string) {
  const onProgress: ApiOnProgress = (progress: number) => {
    const callbacks = progressCallbacks.get(cacheKey);
    callbacks?.forEach((callback, callbackId) => {
      callback(progress);
      if (callback.isCanceled) {
        callbacks.delete(callbackId);
      }
    });
    if (callbacks && !callbacks.size && !untrackedConsumers.has(cacheKey)) onProgress.isCanceled = true;
  };

  return onProgress;
}

function prepareMedia(url: string, mediaData: Exclude<ApiParsedMedia, ArrayBuffer>): MediaCacheEntry {
  if (mediaData instanceof Blob) {
    const ownedBlobUrl = URL.createObjectURL(mediaData);
    return { url, value: ownedBlobUrl, ownedBlobUrl, size: mediaData.size, accessedAt: Date.now() };
  }

  return { url, value: mediaData, size: mediaData.length * 2, accessedAt: Date.now() };
}

function buildCacheKey(url: string, mediaFormat: ApiMediaFormat, isHtmlAllowed: boolean) {
  const format = !IS_PROGRESSIVE_SUPPORTED && (
    mediaFormat === ApiMediaFormat.Progressive || mediaFormat === ApiMediaFormat.DownloadUrl
  ) ? ApiMediaFormat.BlobUrl : mediaFormat;
  return JSON.stringify([url, format, isHtmlAllowed]);
}

function releaseEntry(entry: MediaCacheEntry) {
  if (entry.ownedBlobUrl) URL.revokeObjectURL(entry.ownedBlobUrl);
}

function scheduleMemoryCleanup() {
  if (cleanupTimeout || (memoryCache.size <= MAX_MEMORY_ENTRIES && memoryBytes <= MAX_MEMORY_BYTES)) return;
  cleanupTimeout = setTimeout(cleanupMemory, MEMORY_CLEANUP_INTERVAL);
}

function cleanupMemory() {
  cleanupTimeout = undefined;
  const now = Date.now();
  for (const [cacheKey, entry] of memoryCache) {
    if (memoryCache.size <= MAX_MEMORY_ENTRIES && memoryBytes <= MAX_MEMORY_BYTES) break;
    // Leases protect viewers; the grace period lets short one-shot readers finish
    if (retainedMedia.has(cacheKey) || now - entry.accessedAt < MEMORY_GRACE_PERIOD) continue;
    memoryCache.delete(cacheKey);
    memoryBytes -= entry.size;
    releaseEntry(entry);
  }
  scheduleMemoryCleanup();
}

if (IS_PROGRESSIVE_SUPPORTED) {
  navigator.serviceWorker.addEventListener('message', async (e) => {
    const { type, messageId, params } = e.data as {
      type: string;
      messageId: string;
      params: { url: string; start: number; end: number };
    };

    if (type !== 'requestPart') {
      return;
    }

    async function downloadWithRetry(retryNumber = 0) {
      const result = await callApi('downloadMedia', { mediaFormat: ApiMediaFormat.Progressive, ...params });
      if (!result) {
        if (retryNumber >= MAX_MEDIA_RETRIES) {
          if (DEBUG) {
            // eslint-disable-next-line no-console
            console.warn(`Failed to download media part after ${MAX_MEDIA_RETRIES} retries:`, params.url);
          }
          return undefined;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, getRetryTimeout(retryNumber));
        });
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.debug(`Retrying to download media part ${params.url}, attempt ${retryNumber + 1}`);
        }
        return downloadWithRetry(retryNumber + 1);
      }
      return result;
    }

    const result = await downloadWithRetry();
    if (!result) {
      return;
    }

    const { arrayBuffer, mimeType, fullSize } = result;

    navigator.serviceWorker.controller!.postMessage({
      type: 'partResponse',
      messageId,
      result: {
        arrayBuffer,
        mimeType,
        fullSize,
      },
    }, [arrayBuffer!]);
  });
}

function getRetryTimeout(retryNumber: number) {
  // 250ms, 500ms, 1s, 2s, 4s
  return 250 * 2 ** retryNumber;
}
