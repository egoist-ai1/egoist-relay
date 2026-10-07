// Fixtures model immediate promises at external API boundaries
/* eslint-disable @typescript-eslint/require-await */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type TelegramClient from './TelegramClient';

import { getDcBandwidthManager } from '../../../util/dcBandwithManager';
import { FloodPremiumWaitError } from '../errors';
import Api from '../tl/api';
import { downloadFile } from './downloadFile';
import { uploadFile } from './uploadFile';
const KIB = 1024;
const MIB = KIB * KIB;
const UPLOAD_TIMEOUT = 60000;
let nextDcId = 10000;
type MediaRequest = Api.upload.SaveFilePart | Api.upload.SaveBigFilePart | Api.upload.GetFile;
type TestSender = ReturnType<typeof createTestSender>;
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise, resolve, reject,
  };
}
function createProgress() {
  return Object.assign(vi.fn<(progress: number) => void>(), {
    isCanceled: false,
  });
}
function createFixture(size: number) {
  const bytes = Uint8Array.from({
    length: size,
  }, (_, index) => (index * 31 + Math.floor(index / 251)) % 256);
  let reads = 0;
  const file = {
    name: 'fixture.bin', size,
    slice(start: number, end: number) {
      return {
        arrayBuffer: async () => {
          reads++;
          return bytes.slice(start, end).buffer;
        },
      };
    },
  } as unknown as File;
  return {
    bytes, file, getReads: () => reads,
  };
}
function createTestSender(send: (request: MediaRequest, signal: AbortSignal) => Promise<unknown>) {
  return {
    send: vi.fn(send), isConnected: vi.fn(() => true), _updateCallback: vi.fn(),
  };
}
function createClient(send: (request: MediaRequest, signal: AbortSignal) => Promise<unknown>, isPremium = false) {
  const dcId = nextDcId++;
  const acquired: TestSender[] = [];
  const released: TestSender[] = [];
  const getSender = vi.fn(async () => {
    const sender = createTestSender(send);
    acquired.push(sender);
    return sender;
  });
  const releaseExportedSender = vi.fn((sender: TestSender) => released.push(sender));
  const client = {
    isPremium, session: {
      dcId,
    }, getSender, releaseExportedSender,
    _cleanupExportedSenders: vi.fn(async () => {
    }), _log: {
      info: vi.fn(),
    },
  } as unknown as TelegramClient;
  const manager = getDcBandwidthManager(dcId, isPremium);
  return {
    client, manager, acquired, released, getSender, releaseExportedSender,
  };
}
function expectReleased(fixture: ReturnType<typeof createClient>) {
  expect(fixture.released).toHaveLength(fixture.acquired.length);
  expect(new Set(fixture.released).size).toBe(fixture.acquired.length);
  expect(fixture.manager.activeRequestSize).toBe(0);
  expect(fixture.manager.queueLength).toBe(0);
  for (let index = 0; index < 6; index++) {
    expect(fixture.manager.getForeman(index).activeRequestHeapSize).toBe(0);
    expect(fixture.manager.getForeman(index).queueLength).toBe(0);
  }
}
function createLocation() {
  return new Api.InputDocumentFileLocation({
    id: 123n, accessHash: 0n, fileReference: new Uint8Array(), thumbSize: '',
  });
}
function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
function createAbortableWait(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    const abort = () => reject(new Error('Request aborted'));
    signal.addEventListener('abort', abort, {
      once: true,
    });
    if (signal.aborted) {
      abort();
    }
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('Relay media upload stress and recovery', () => {
  test.each([false, true])('Transfers 40 MiB byte-exactly with bounded workers (premium=%s)', async (isPremium) => {
    const source = createFixture(40 * MIB + 17);
    const parts = new Map<number, Uint8Array>();
    const progress = createProgress();
    let active = 0;
    let peakActive = 0;
    let peakActiveBytes = 0;
    const fixture = createClient(async (request) => {
      expect(request).toBeInstanceOf(Api.upload.SaveBigFilePart);
      const part = request as Api.upload.SaveBigFilePart;
      active++;
      peakActive = Math.max(peakActive, active);
      peakActiveBytes = Math.max(peakActiveBytes, fixture.manager.activeRequestSize);
      await new Promise((resolve) => {
        setTimeout(resolve, (part.filePart % 7) + 1);
      });
      parts.set(part.filePart, part.bytes);
      active--;
      return true;
    }, isPremium);
    const result = await uploadFile(fixture.client, {
      file: source.file, workers: 1000, onProgress: progress,
    });
    expect(result).toBeInstanceOf(Api.InputFileBig);
    expect(result.parts).toBe(81);
    expect(parts.size).toBe(result.parts);
    const reconstructed = new Uint8Array(source.bytes.length);
    for (const [index, bytes] of parts) {
      reconstructed.set(bytes, index * 512 * KIB);
    }
    expect(hash(reconstructed)).toBe(hash(source.bytes));
    expect(source.getReads()).toBe(result.parts);
    expect(peakActive).toBeGreaterThan(1);
    expect(peakActiveBytes).toBeLessThanOrEqual((isPremium ? 20 : 9) * MIB);
    const values = progress.mock.calls.map(([value]) => value);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
    expect(values.every((value, index) => index === 0 || value > values[index - 1])).toBe(true);
    expectReleased(fixture);
  });
  test('Rejects an empty file before allocating a worker or sender', async () => {
    const fixture = createClient(async () => true);
    await expect(uploadFile(fixture.client, {
      file: createFixture(0).file, workers: 1,
    })).rejects.toThrow('UPLOAD_EMPTY_FILE');
    expect(fixture.getSender).not.toHaveBeenCalled();
    expectReleased(fixture);
  });
  test('Pre-cancellation sends no RPC and never reports completion', async () => {
    const fixture = createClient(async () => true);
    const progress = createProgress();
    progress.isCanceled = true;
    await expect(uploadFile(fixture.client, {
      file: createFixture(17).file, workers: 1, onProgress: progress,
    }))
      .rejects.toThrow('USER_CANCELED');
    expect(fixture.getSender).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalledWith(1);
    expectReleased(fixture);
  });
  test('Reuses the part bytes through disconnect retries and releases every acquired sender', async () => {
    vi.useFakeTimers();
    const source = createFixture(257);
    let attempts = 0;
    const sentBytes: Uint8Array[] = [];
    const fixture = createClient(async (request) => {
      attempts++;
      sentBytes.push((request as Api.upload.SaveFilePart).bytes);
      fixture.acquired.at(-1)!.isConnected.mockReturnValue(false);
      if (attempts < 3) {
        throw new Error('CONNECTION_LOST');
      }
      return true;
    });
    const result = uploadFile(fixture.client, {
      file: source.file, workers: 1,
    });
    await vi.runAllTimersAsync();
    expect((await result).parts).toBe(1);
    expect(attempts).toBe(3);
    expect(source.getReads()).toBe(1);
    expect(sentBytes[0]).toBe(sentBytes[1]);
    expect(sentBytes[1]).toBe(sentBytes[2]);
    expectReleased(fixture);
  });
  test('Stops an 81-part queue after the first rejected part and settles sibling workers', async () => {
    let attempts = 0;
    const fixture = createClient(async (request) => {
      attempts++;
      if ((request as Api.upload.SaveBigFilePart).filePart === 0) {
        return false;
      }
      return true;
    });
    const progress = createProgress();
    await expect(uploadFile(fixture.client, {
      file: createFixture(40 * MIB).file, workers: 1000, onProgress: progress,
    }))
      .rejects.toThrow('UPLOAD_PART_REJECTED');
    expect(attempts).toBeLessThan(80);
    expect(progress).not.toHaveBeenCalledWith(1);
    expectReleased(fixture);
  });
  test('Mid-flight cancellation aborts only the active upload and releases its bandwidth', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fixture = createClient(async (_, signal) => {
      signals.push(signal);
      return createAbortableWait(signal);
    });
    const progress = createProgress();
    const result = uploadFile(fixture.client, {
      file: createFixture(3 * MIB).file, workers: 6, onProgress: progress,
    });
    const rejection = expect(result).rejects.toThrow('USER_CANCELED');
    await vi.advanceTimersByTimeAsync(1);
    expect(signals.length).toBeGreaterThan(0);
    progress.isCanceled = true;
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(progress).not.toHaveBeenCalledWith(1);
    expectReleased(fixture);
  });
  test('Cancellation releases a sender that arrives after the caller has settled', async () => {
    vi.useFakeTimers();
    const late = createDeferred<TestSender>();
    const fixture = createClient(async () => true);
    const sender = {
      send: vi.fn(async () => true), isConnected: vi.fn(() => true), _updateCallback: vi.fn(),
    };
    fixture.getSender.mockImplementation(async () => late.promise);
    const progress = createProgress();
    const result = uploadFile(fixture.client, {
      file: createFixture(31).file, workers: 1, onProgress: progress,
    });
    const rejection = expect(result).rejects.toThrow('USER_CANCELED');
    await vi.advanceTimersByTimeAsync(1);
    progress.isCanceled = true;
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(fixture.manager.activeRequestSize).toBe(0);
    late.resolve(sender);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.releaseExportedSender).toHaveBeenCalledExactlyOnceWith(sender);
    expect(sender.send).not.toHaveBeenCalled();
  });
  test('A hanging RPC has a finite retry budget and aborts every abandoned attempt', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fixture = createClient(async (_, signal) => {
      signals.push(signal);
      return createAbortableWait(signal);
    });
    const result = uploadFile(fixture.client, {
      file: createFixture(31).file, workers: 1,
    });
    const rejection = expect(result).rejects.toThrow('UPLOAD_TIMEOUT');
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT * 5 + 4001);
    await rejection;
    expect(signals).toHaveLength(5);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expectReleased(fixture);
  });
  test('A successful RPC arriving after cancellation never advances progress to completion', async () => {
    vi.useFakeTimers();
    const response = createDeferred<boolean>();
    const fixture = createClient(async () => response.promise);
    const progress = createProgress();
    const result = uploadFile(fixture.client, {
      file: createFixture(31).file, workers: 1, onProgress: progress,
    });
    const rejection = expect(result).rejects.toThrow('USER_CANCELED');
    await vi.advanceTimersByTimeAsync(1);
    progress.isCanceled = true;
    response.resolve(true);
    await rejection;
    expect(progress).not.toHaveBeenCalledWith(1);
    expectReleased(fixture);
  });
  test('Premium flood wait publishes one update while retaining bytes through retries', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fixture = createClient(async () => {
      if (++attempts < 3) {
        throw new FloodPremiumWaitError({
          capture: 1, errorMessage: 'FLOOD_PREMIUM_WAIT', code: 420,
        });
      }
      return true;
    }, true);
    const source = createFixture(31);
    const result = uploadFile(fixture.client, {
      file: source.file, workers: 1,
    });
    await vi.runAllTimersAsync();
    await result;
    expect(fixture.acquired.reduce((total, sender) => total + sender._updateCallback.mock.calls.length, 0)).toBe(1);
    expect(source.getReads()).toBe(1);
    expectReleased(fixture);
  });
});
describe('Relay media download ranges and recovery', () => {
  test('128 seeded byte ranges across 1 MiB boundaries are reconstructed exactly', async () => {
    const source = createFixture(2 * MIB + 257).bytes;
    let seed = 183;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const boundaryRanges = [
      [0, 0], [4095, 4097], [MIB - 1, MIB + 1], [MIB + 17, MIB + 8193],
      [source.length - 1, source.length - 1],
    ];
    for (let index = 0; index < 128; index++) {
      const start = index < boundaryRanges.length ? boundaryRanges[index][0] : next() % source.length;
      const end = index < boundaryRanges.length ? boundaryRanges[index][1]
        : Math.min(source.length - 1, start + next() % (64 * KIB));
      const fixture = createClient(async (request) => {
        expect(request).toBeInstanceOf(Api.upload.GetFile);
        const part = request as Api.upload.GetFile;
        const offset = Number(part.offset);
        expect(offset % 4096).toBe(0);
        expect(offset % MIB + part.limit).toBeLessThanOrEqual(MIB);
        return {
          bytes: source.subarray(offset, offset + part.limit),
        };
      });
      const result = await downloadFile(fixture.client, createLocation(), {
        dcId: fixture.client.session.dcId, fileSize: source.length, start, end,
        partSizeKb: [4, 64, 256, 1024][index % 4],
      });
      expect(hash(result as Uint8Array)).toBe(hash(source.subarray(start, end + 1)));
      expectReleased(fixture);
    }
  });
  test('Out-of-order whole-file responses retain byte integrity and monotonic progress', async () => {
    const source = createFixture(6 * MIB + 19).bytes;
    const fixture = createClient(async (request) => {
      const part = request as Api.upload.GetFile;
      const offset = Number(part.offset);
      await new Promise((resolve) => {
        setTimeout(resolve, 7 - Math.floor(offset / MIB));
      });
      return {
        bytes: source.subarray(offset, offset + part.limit),
      };
    }, true);
    const progress = createProgress();
    const result = await downloadFile(fixture.client, createLocation(), {
      dcId: fixture.client.session.dcId, fileSize: source.length, progressCallback: progress,
    });
    expect(hash(result as Uint8Array)).toBe(hash(source));
    const values = progress.mock.calls.map(([value]) => value);
    expect(values.at(-1)).toBe(1);
    expect(values.every((value, index) => index === 0 || value > values[index - 1])).toBe(true);
    expectReleased(fixture);
  });
  test('Unknown-size streaming ends on the short final response without zero-padding', async () => {
    const source = createFixture(MIB + 257).bytes;
    const offsets: number[] = [];
    const fixture = createClient(async (request) => {
      const part = request as Api.upload.GetFile;
      offsets.push(Number(part.offset));
      return {
        bytes: source.subarray(Number(part.offset), Number(part.offset) + part.limit),
      };
    });
    const result = await downloadFile(fixture.client, createLocation(), {
      dcId: fixture.client.session.dcId,
    });
    expect(hash(result as Uint8Array)).toBe(hash(source));
    expect(offsets).toEqual([0, MIB]);
    expectReleased(fixture);
  });
  test('A truncated response rejects the file instead of returning silent zero bytes', async () => {
    const fixture = createClient(async () => ({
      bytes: new Uint8Array(17),
    }));
    await expect(downloadFile(fixture.client, createLocation(), {
      dcId: fixture.client.session.dcId, fileSize: 4096,
    }))
      .rejects.toThrow('DOWNLOAD_INCOMPLETE');
    expectReleased(fixture);
  });
  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('Rejects invalid range %s before an RPC', async (start) => {
    const fixture = createClient(async () => ({
      bytes: new Uint8Array(),
    }));
    await expect(downloadFile(fixture.client, createLocation(), {
      dcId: fixture.client.session.dcId, fileSize: 17, start,
    }))
      .rejects.toThrow('Invalid download range');
    expect(fixture.getSender).not.toHaveBeenCalled();
    expectReleased(fixture);
  });
  test('A research request preserves the first RPC error and does not retry account-bound work', async () => {
    const fixture = createClient(async () => {
      throw new Error('SELECTED_RPC_DENIED');
    });
    fixture.getSender.mockImplementation(async () => {
      const sender = {
        send: vi.fn(async () => {
          throw new Error('SELECTED_RPC_DENIED');
        }), isConnected: vi.fn(() => false), _updateCallback: vi.fn(),
      };
      fixture.acquired.push(sender);
      return sender;
    });
    await expect(downloadFile(fixture.client, createLocation(), {
      dcId: fixture.client.session.dcId, fileSize: 17, isResearchRequest: true,
    }))
      .rejects.toThrow('SELECTED_RPC_DENIED');
    expect(fixture.acquired).toHaveLength(1);
    expectReleased(fixture);
  });
  test('Mid-flight cancellation aborts download RPCs and frees the shared manager', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fixture = createClient(async (_, signal) => {
      signals.push(signal);
      return createAbortableWait(signal);
    });
    const progress = createProgress();
    const result = downloadFile(fixture.client, createLocation(), {
      dcId: fixture.client.session.dcId, fileSize: 3 * MIB, progressCallback: progress,
    });
    const rejection = expect(result).rejects.toThrow('USER_CANCELED');
    await vi.advanceTimersByTimeAsync(1);
    progress.isCanceled = true;
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(progress).not.toHaveBeenCalledWith(1);
    expectReleased(fixture);
  });
});
