import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type TelegramClient from './TelegramClient';

import { downloadFile, getPartTimeout, tryAcquireSenderRecreate } from './downloadFile';

describe('getPartTimeout', () => {
  test('small parts use 15s, large ones 60s', () => {
    expect(getPartTimeout(4096)).toBe(15000);
    expect(getPartTimeout(128 * 1024)).toBe(15000);
    expect(getPartTimeout(256 * 1024)).toBe(60000);
    expect(getPartTimeout(1024 * 1024)).toBe(60000);
  });
});

describe('tryAcquireSenderRecreate', () => {
  test('allows 2 recreations per dc in 30s, third is refused, then window slides', () => {
    const owner = {};
    expect(tryAcquireSenderRecreate(owner, 2, 0)).toBe(true);
    expect(tryAcquireSenderRecreate(owner, 2, 1000)).toBe(true);
    expect(tryAcquireSenderRecreate(owner, 2, 2000)).toBe(false);
    expect(tryAcquireSenderRecreate(owner, 4, 2000)).toBe(true);
    expect(tryAcquireSenderRecreate(owner, 2, 31000)).toBe(true);
  });
});

describe('downloadFile retry through a new sender', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('hung send is retried via recreated sender', async () => {
    const hung = { isConnected: () => true, send: vi.fn(() => new Promise(() => undefined)) };
    const fresh = {
      isConnected: () => true,
      send: vi.fn(() => Promise.resolve({ bytes: new Uint8Array(4096) })),
    };
    let current: { isConnected: () => boolean; send: () => Promise<unknown> } = hung;
    const client = {
      isPremium: false,
      _log: { info: vi.fn() },
      getSender: vi.fn(() => Promise.resolve(current)),
      releaseExportedSender: vi.fn(),
      _cleanupExportedSender: vi.fn(() => {
        current = fresh;
        return Promise.resolve();
      }),
    } as unknown as TelegramClient;

    const promise = downloadFile(client, { id: 1n } as never, {
      dcId: 777, fileSize: 4096, partSizeKb: 4,
    });
    await vi.advanceTimersByTimeAsync(15000 + 1500);
    const data = await promise;
    expect(data).toHaveLength(4096);
    expect(client._cleanupExportedSender).toHaveBeenCalledWith(777, expect.any(Number));
    expect(fresh.send).toHaveBeenCalledTimes(1);
  });
});
