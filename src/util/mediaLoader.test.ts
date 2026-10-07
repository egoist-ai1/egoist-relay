import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ApiMediaFormat, type ApiOnProgress } from '../api/types';

const { callApi, cancelApiProgress } = vi.hoisted(() => ({ callApi: vi.fn(), cancelApiProgress: vi.fn() }));
vi.mock('../api/gramjs', () => ({ callApi, cancelApiProgress }));
vi.mock('../config', () => ({ DEBUG: false, MEDIA_CACHE_DISABLED: true }));
vi.mock('./browser/windowEnvironment', () => ({ IS_OPUS_SUPPORTED: true, IS_PROGRESSIVE_SUPPORTED: false }));
vi.mock('./cacheApi', () => ({ Type: { Blob: 1, Text: 0 } }));
vi.mock('./multiaccount', () => ({ ACCOUNT_SLOT: 0 }));
vi.mock('./oggToWav', () => ({ oggToWav: vi.fn() }));

const createUrl = vi.fn();
const revokeUrl = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  callApi.mockReset();
  cancelApiProgress.mockReset();
  cancelApiProgress.mockImplementation((callback) => {
    callback.isCanceled = true;
  });
  createUrl.mockReset();
  revokeUrl.mockReset();
  let sequence = 0;
  createUrl.mockImplementation(() => `blob:media-test-${sequence++}`);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createUrl;

    static revokeObjectURL = revokeUrl;
  });
  callApi.mockImplementation((_, params) => Promise.resolve({
    mimeType: 'image/png',
    dataBlob: params.mediaFormat === ApiMediaFormat.Text ? 'synthetic text' : new Blob(['media']),
  }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Media cache formats and ownership', () => {
  test('Separates concurrent BlobUrl and Text requests and reads their matching cache entries', async () => {
    const loader = await import('./mediaLoader');
    const [blob, text] = await Promise.all([
      loader.fetch('document-1', ApiMediaFormat.BlobUrl), loader.fetch('document-1', ApiMediaFormat.Text),
    ]);
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(blob).toMatch(/^blob:/);
    expect(text).toBe('synthetic text');
    expect(loader.getFromMemory('document-1')).toBe(blob);
    expect(loader.getFromMemory('document-1', ApiMediaFormat.Text)).toBe(text);
    expect(await loader.fetch('document-1', ApiMediaFormat.Text)).toBe(text);
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  test('Separates allowed HTML from a sanitized viewer representation', async () => {
    const loader = await import('./mediaLoader');
    const safe = await loader.fetch('document-html', ApiMediaFormat.BlobUrl);
    const allowed = await loader.fetch('document-html', ApiMediaFormat.BlobUrl, true);
    expect(safe).not.toBe(allowed);
    expect(loader.getFromMemory('document-html', ApiMediaFormat.BlobUrl, true)).toBe(allowed);
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  test('Protects a leased URL across unload and revokes it once after the final release', async () => {
    const loader = await import('./mediaLoader');
    const firstRelease = loader.retainMedia('viewed', ApiMediaFormat.BlobUrl);
    const secondRelease = loader.retainMedia('viewed', ApiMediaFormat.BlobUrl);
    const url = await loader.fetch('viewed', ApiMediaFormat.BlobUrl);
    await loader.unload('viewed');
    expect(loader.getFromMemory('viewed')).toBeUndefined();
    expect(revokeUrl).not.toHaveBeenCalled();
    firstRelease();
    firstRelease();
    expect(revokeUrl).not.toHaveBeenCalled();
    secondRelease();
    secondRelease();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(url);
  });

  test('Revokes each unleased resource in repeated load and unload cycles', async () => {
    const loader = await import('./mediaLoader');
    for (let index = 0; index < 25; index++) {
      await loader.fetch(`resource-${index}`, ApiMediaFormat.BlobUrl);
      await loader.unload(`resource-${index}`);
    }
    expect(createUrl).toHaveBeenCalledTimes(25);
    expect(revokeUrl).toHaveBeenCalledTimes(25);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('Bounds idle entries after the grace period while protecting an active viewer', async () => {
    const loader = await import('./mediaLoader');
    const release = loader.retainMedia('active-viewer');
    const activeUrl = await loader.fetch('active-viewer', ApiMediaFormat.BlobUrl);
    for (let index = 0; index < 529; index++) await loader.fetch(`idle-${index}`, ApiMediaFormat.BlobUrl);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(revokeUrl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(revokeUrl).toHaveBeenCalledTimes(18);
    expect(revokeUrl).not.toHaveBeenCalledWith(activeUrl);
    expect(loader.getFromMemory('active-viewer')).toBe(activeUrl);
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  test('Bounds idle bytes without evicting a leased large resource', async () => {
    callApi.mockImplementation(() => {
      const blob = new Blob(['synthetic']);
      Object.defineProperty(blob, 'size', { value: 100 * 1024 * 1024 });
      return Promise.resolve({ mimeType: 'video/mp4', dataBlob: blob });
    });
    const loader = await import('./mediaLoader');
    const release = loader.retainMedia('active-large');
    const activeUrl = await loader.fetch('active-large', ApiMediaFormat.BlobUrl);
    await loader.fetch('idle-large-1', ApiMediaFormat.BlobUrl);
    await loader.fetch('idle-large-2', ApiMediaFormat.BlobUrl);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(revokeUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalledWith(activeUrl);
    expect(loader.getFromMemory('idle-large-1')).toBeUndefined();
    release();
  });

  test('Does not repopulate a resource unloaded while its fetch was pending', async () => {
    let complete: (value: unknown) => void = () => {};
    callApi.mockReturnValue(new Promise((resolve) => {
      complete = resolve;
    }));
    const loader = await import('./mediaLoader');
    const pending = loader.fetch('deleted', ApiMediaFormat.BlobUrl);
    await vi.waitFor(() => expect(callApi).toHaveBeenCalledOnce());
    await loader.unload('deleted');
    complete({ mimeType: 'image/png', dataBlob: new Blob(['media']) });
    expect(await pending).toBeUndefined();
    expect(loader.getFromMemory('deleted')).toBeUndefined();
    expect(createUrl).not.toHaveBeenCalled();
    expect(revokeUrl).not.toHaveBeenCalled();
  });

  test('Canceling one progress consumer does not abort a shared viewer fetch', async () => {
    let complete: (value: unknown) => void = () => {};
    callApi.mockReturnValue(new Promise((resolve) => {
      complete = resolve;
    }));
    const loader = await import('./mediaLoader');
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = loader.fetch('shared', ApiMediaFormat.BlobUrl, false, firstProgress, 'first');
    const second = loader.fetch('shared', ApiMediaFormat.BlobUrl, false, secondProgress, 'second');
    await vi.waitFor(() => expect(callApi).toHaveBeenCalledOnce());
    loader.cancelProgress(firstProgress);
    expect(cancelApiProgress).not.toHaveBeenCalled();
    complete({ mimeType: 'image/png', dataBlob: new Blob(['media']) });
    expect(await first).toBe(await second);
  });

  test('Canceling a download preserves a shared viewer without a progress callback', async () => {
    let complete: (value: unknown) => void = () => {};
    callApi.mockReturnValue(new Promise((resolve) => {
      complete = resolve;
    }));
    const loader = await import('./mediaLoader');
    const progress = vi.fn();
    const downloading = loader.fetch('shared-viewer', ApiMediaFormat.BlobUrl, false, progress, 'download');
    const viewing = loader.fetch('shared-viewer', ApiMediaFormat.BlobUrl);
    loader.cancelProgress(progress);
    expect(cancelApiProgress).not.toHaveBeenCalled();
    complete({ mimeType: 'image/png', dataBlob: new Blob(['media']) });
    expect(await downloading).toBe(await viewing);
  });

  test('Starts a fresh request after the previous sole consumer cancels', async () => {
    let complete: (value: unknown) => void = () => {};
    callApi.mockReturnValueOnce(new Promise((resolve) => {
      complete = resolve;
    }));
    const loader = await import('./mediaLoader');
    const firstProgress = vi.fn();
    const first = loader.fetch('retry-after-cancel', ApiMediaFormat.BlobUrl, false, firstProgress, 'first');
    loader.cancelProgress(firstProgress);
    expect(cancelApiProgress).toHaveBeenCalledOnce();
    const replacement = loader.fetch(
      'retry-after-cancel', ApiMediaFormat.BlobUrl, false, vi.fn<ApiOnProgress>(), 'replacement',
    );
    complete(undefined);
    expect(await first).toBeUndefined();
    expect(await replacement).toMatch(/^blob:/);
    expect(callApi).toHaveBeenCalledTimes(2);
  });
});
