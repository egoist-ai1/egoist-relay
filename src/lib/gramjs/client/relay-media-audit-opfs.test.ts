// Fixtures model immediate promises at external API boundaries
/* eslint-disable @typescript-eslint/require-await */
import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import type TelegramClient from './TelegramClient';

import { getDcBandwidthManager } from '../../../util/dcBandwithManager';
import Api from '../tl/api';
import { downloadFile } from './downloadFile';
let nextDcId = 30000;
async function runDiskScenario(options: {
  maxWrite?: number;
  sourceSize?: number;
  partSizeKb?: number;
  writeResult?: number;
  writeError?: Error;
  flushError?: Error;
} = {}) {
  const source = Uint8Array.from({
    length: options.sourceSize ?? 65537,
  }, (_, index) => index % 251);
  const stored = new Uint8Array(source.length);
  let writtenEnd = 0;
  let writeCount = 0;
  const close = vi.fn();
  const flush = vi.fn(() => {
    if (options.flushError) {
      throw options.flushError;
    }
  });
  const write = (bytes: Uint8Array, { at }: {
    at: number;
  }) => {
    writeCount++;
    if (options.writeError) {
      throw options.writeError;
    }
    const count = options.writeResult ?? Math.min(bytes.length, options.maxWrite ?? bytes.length);
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length) {
      return count;
    }
    stored.set(bytes.subarray(0, count), at);
    writtenEnd = Math.max(writtenEnd, at + count);
    return count;
  };
  const removeEntry = vi.fn(async () => {
  });
  const resultFile = {
    get size() {
      return writtenEnd;
    },
    arrayBuffer: async () => stored.slice(0, writtenEnd).buffer,
  };
  class TestFileHandle {
    async createSyncAccessHandle() {
      return {
        write, flush, close,
      };
    }

    getFile = async () => resultFile;
  }
  const downloads = {
    getFileHandle: async () => new TestFileHandle(), removeEntry,
  };
  const oldStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  const oldFileHandle = Object.getOwnPropertyDescriptor(globalThis, 'FileSystemFileHandle');
  const oldBuffer = Object.getOwnPropertyDescriptor(self, 'maxBufferSize');
  Object.defineProperty(navigator, 'storage', {
    configurable: true, value: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => downloads,
      }),
    },
  });
  Object.defineProperty(globalThis, 'FileSystemFileHandle', {
    configurable: true, value: TestFileHandle,
  });
  Object.defineProperty(self, 'maxBufferSize', {
    configurable: true, value: 1,
  });
  const dcId = nextDcId++;
  const sender = {
    send: vi.fn(async (request: Api.upload.GetFile) => ({
      bytes: source.subarray(Number(request.offset), Number(request.offset) + request.limit),
    })),
    isConnected: () => true,
  };
  const releaseExportedSender = vi.fn();
  const getSender = vi.fn(async () => sender);
  const client = {
    session: {
      dcId,
    }, isPremium: false, getSender, releaseExportedSender, _log: {
      info: vi.fn(),
    },
  } as unknown as TelegramClient;
  const location = new Api.InputDocumentFileLocation({
    id: 123n, accessHash: 0n, fileReference: new Uint8Array(), thumbSize: '',
  });
  const progress = vi.fn<(progress: number) => void>();
  let result: Uint8Array | File | undefined;
  let error: unknown;
  try {
    result = await downloadFile(client, location, {
      dcId, fileSize: source.length, partSizeKb: options.partSizeKb ?? 4, progressCallback: progress,
    });
  } catch (caught) {
    error = caught;
  } finally {
    if (oldStorage) {
      Object.defineProperty(navigator, 'storage', oldStorage);
    } else {
      Reflect.deleteProperty(navigator, 'storage');
    }
    if (oldFileHandle) {
      Object.defineProperty(globalThis, 'FileSystemFileHandle', oldFileHandle);
    } else {
      Reflect.deleteProperty(globalThis, 'FileSystemFileHandle');
    }
    if (oldBuffer) {
      Object.defineProperty(self, 'maxBufferSize', oldBuffer);
    } else {
      Reflect.deleteProperty(self, 'maxBufferSize');
    }
  }
  expect(getDcBandwidthManager(dcId, false).activeRequestSize).toBe(0);
  expect(releaseExportedSender.mock.calls.length).toBe(getSender.mock.calls.length);
  return {
    source, result, error, write, flush, close, removeEntry, progress, getWriteCount: () => writeCount,
  };
}
describe('Relay large-file OPFS integrity and disk errors', () => {
  test('Publishes complete byte-exact data and closes the handle after flushing', async () => {
    const fixture = await runDiskScenario();
    expect(fixture.error).toBeUndefined();
    const output = new Uint8Array(await (fixture.result as File).arrayBuffer());
    const expectedHash = createHash('sha256').update(fixture.source).digest('hex');
    expect(createHash('sha256').update(output).digest('hex')).toBe(expectedHash);
    expect(fixture.flush).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.removeEntry).not.toHaveBeenCalled();
  });
  test('Completes valid seven-byte partial writes without losing file contents', async () => {
    const fixture = await runDiskScenario({
      maxWrite: 7,
    });
    expect(fixture.error).toBeUndefined();
    const output = new Uint8Array(await (fixture.result as File).arrayBuffer());
    const expectedHash = createHash('sha256').update(fixture.source).digest('hex');
    expect(createHash('sha256').update(output).digest('hex')).toBe(expectedHash);
    expect(fixture.getWriteCount()).toBeGreaterThan(65537 / 7);
    expect(fixture.progress).toHaveBeenLastCalledWith(1);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.removeEntry).not.toHaveBeenCalled();
  });
  test('One-byte partial writes complete a full 1 MiB RPC part without unbounded retry loops', async () => {
    const fixture = await runDiskScenario({ maxWrite: 1, sourceSize: 1024 * 1024, partSizeKb: 1024 });
    expect(fixture.error).toBeUndefined();
    const output = new Uint8Array(await (fixture.result as File).arrayBuffer());
    const expectedHash = createHash('sha256').update(fixture.source).digest('hex');
    expect(createHash('sha256').update(output).digest('hex')).toBe(expectedHash);
    expect(fixture.getWriteCount()).toBe(1024 * 1024);
    expect(fixture.progress).toHaveBeenLastCalledWith(1);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.removeEntry).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, Infinity, 4097])('Rejects invalid disk write %s', async (writeResult) => {
    const fixture = await runDiskScenario({
      writeResult,
    });
    expect(fixture.error).toMatchObject({
      message: 'DOWNLOAD_INCOMPLETE_WRITE',
    });
    expect(fixture.result).toBeUndefined();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.removeEntry).toHaveBeenCalledOnce();
    expect(fixture.progress).not.toHaveBeenCalledWith(1);
  });
  test('Quota exhaustion closes and removes the unfinished file', async () => {
    const error = new DOMException('Storage quota exhausted', 'QuotaExceededError');
    const fixture = await runDiskScenario({
      writeError: error,
    });
    expect(fixture.error === error || (fixture.error instanceof Error && fixture.error.cause === error)).toBe(true);
    expect(fixture.result).toBeUndefined();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.removeEntry).toHaveBeenCalledOnce();
    expect(fixture.flush).not.toHaveBeenCalled();
  });
  test('Flush failure closes and removes the unfinished file', async () => {
    const error = new Error('DISK_FLUSH_FAILED');
    const fixture = await runDiskScenario({
      flushError: error,
    });
    expect(fixture.error === error || (fixture.error instanceof Error && fixture.error.cause === error)).toBe(true);
    expect(fixture.result).toBeUndefined();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.removeEntry).toHaveBeenCalledOnce();
  });
});
