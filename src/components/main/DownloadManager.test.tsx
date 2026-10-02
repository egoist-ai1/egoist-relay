import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../lib/teact/teact';
import TeactDOM from '../../lib/teact/teact-dom';

import type { ActiveDownloads } from '../../types';
import { ApiMediaFormat } from '../../api/types';

import { requestMutation } from '../../lib/fasterdom/fasterdom';
import download from '../../util/download';
import * as mediaLoader from '../../util/mediaLoader';

import DownloadManager from './DownloadManager';

const { getGlobal, cancelDownloads, notify } = vi.hoisted(() => ({
  getGlobal: vi.fn(), cancelDownloads: vi.fn(), notify: vi.fn(),
}));
vi.mock('../../global', () => ({
  getGlobal, getActions: () => ({ cancelMediaHashDownloads: cancelDownloads, showNotification: notify }),
  withGlobal: () => (component: unknown) => component,
}));
vi.mock('../../global/selectors', () => ({ selectTabState: (global: unknown) => global }));
vi.mock('../../util/browser/windowEnvironment', () => ({
  IS_OPFS_SUPPORTED: false, IS_SERVICE_WORKER_SUPPORTED: false, MAX_BUFFER_SIZE: 2 ** 31,
}));
vi.mock('../../util/mediaLoader', () => ({
  getFromMemory: vi.fn(), fetch: vi.fn(), cancelProgress: vi.fn(), retainMedia: vi.fn(),
}));
vi.mock('../../util/download', () => ({ default: vi.fn() }));
vi.mock('../../hooks/useRunDebounced', () => ({ default: () => (callback: () => void) => callback() }));

const downloadFile = vi.mocked(download);
const fetchMedia = vi.mocked(mediaLoader.fetch);
const getCached = vi.mocked(mediaLoader.getFromMemory);
const releases: ReturnType<typeof vi.fn>[] = [];
let activeDownloads: ActiveDownloads;
let container: HTMLDivElement;

function renderManager() {
  return new Promise<void>((resolve) => requestMutation(() => {
    TeactDOM.render(createElement(DownloadManager, { activeDownloads }), container);
    resolve();
  }));
}

function prepareDownload(filename = 'synthetic.png', format = ApiMediaFormat.BlobUrl) {
  activeDownloads = { synthetic: { size: 15, filename, format } };
}

beforeEach(() => {
  vi.clearAllMocks();
  releases.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  prepareDownload();
  getGlobal.mockImplementation(() => ({ activeDownloads }));
  fetchMedia.mockResolvedValue('blob:synthetic');
  getCached.mockReturnValue(undefined);
  downloadFile.mockResolvedValue(true);
  vi.mocked(mediaLoader.retainMedia).mockImplementation(() => {
    const release = vi.fn();
    releases.push(release);
    return release;
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => requestMutation(() => {
    TeactDOM.render(undefined, container);
    container.remove();
    resolve();
  }));
  vi.restoreAllMocks();
});

describe('Download completion and cancellation', () => {
  test('Reports an empty media result as a failure instead of silently completing', async () => {
    fetchMedia.mockResolvedValue(undefined as unknown as string);
    await renderManager();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ message: { key: 'RelayDownloadFailed' } }));
    expect(downloadFile).not.toHaveBeenCalled();
    expect(cancelDownloads).toHaveBeenCalledWith({ mediaHashes: ['synthetic'] });
  });

  test('Reports a rejected media request and releases its lease', async () => {
    fetchMedia.mockRejectedValue(new Error('synthetic failure'));
    await renderManager();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(downloadFile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalled());
  });

  test('Drops a late result after cancellation without saving or showing an error', async () => {
    let finish: (url: string) => void = () => {};
    fetchMedia.mockReturnValue(new Promise((resolve) => {
      finish = resolve;
    }));
    await renderManager();
    await vi.waitFor(() => expect(fetchMedia).toHaveBeenCalledOnce());
    activeDownloads = {};
    await renderManager();
    finish('blob:late');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(downloadFile).not.toHaveBeenCalled();
    expect(cancelDownloads).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(mediaLoader.cancelProgress).toHaveBeenCalled();
  });

  test('Does not save a replaced request with the same media hash', async () => {
    let finish: (url: string) => void = () => {};
    fetchMedia.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve;
    }));
    fetchMedia.mockResolvedValueOnce('blob:replacement');
    await renderManager();
    await vi.waitFor(() => expect(fetchMedia).toHaveBeenCalledOnce());
    prepareDownload('replacement.png');
    await renderManager();
    await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledOnce());
    finish('blob:old');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile.mock.calls[0].slice(0, 2)).toEqual(['blob:replacement', 'replacement.png']);
  });

  test('Keeps the media lease until its save starts and exposes cancellation to the queue', async () => {
    let finish: (didStart: boolean) => void = () => {};
    downloadFile.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve;
    }));
    await renderManager();
    await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledOnce());
    expect(releases[0]).not.toHaveBeenCalled();
    const isCanceled = downloadFile.mock.calls[0][2]!;
    expect(isCanceled()).toBe(false);
    activeDownloads = {};
    await renderManager();
    await vi.waitFor(() => expect(isCanceled()).toBe(true));
    finish(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelDownloads).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('Completes a successful queued save and uses the matching HTML policy cache', async () => {
    getCached.mockReturnValue('blob:cached');
    await renderManager();
    await vi.waitFor(() => expect(cancelDownloads).toHaveBeenCalledWith({ mediaHashes: ['synthetic'] }));
    expect(getCached).toHaveBeenCalledWith('synthetic', ApiMediaFormat.BlobUrl, true);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(downloadFile.mock.calls[0].slice(0, 2)).toEqual(['blob:cached', 'synthetic.png']);
  });

  test('Does not open an empty DownloadUrl as the application base URL', async () => {
    prepareDownload('synthetic.bin', ApiMediaFormat.DownloadUrl);
    fetchMedia.mockResolvedValue(undefined as unknown as string);
    const open = vi.spyOn(window, 'open').mockImplementation(() => undefined as unknown as Window);
    await renderManager();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
  });
});
