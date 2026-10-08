import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import type { ApiChat, ApiMessage } from '../api/types';

import { IdbStore } from './browser/idb';
import {
  applyDeletedRecordToMessage,
  buildDeletedRecord,
  canKeepDeletedMessage,
  createDeletedMessagesStorage,
  findKeysToEvict,
} from './deletedMessages';

const DAY = 24 * 60 * 60;
const MEGABYTE = 1024 * 1024;
const NOW = 1_800_000_000;
const LIMITS = { retentionDays: 90, maxMegabytes: 200 };

let storeCounter = 0;

function createStorage() {
  storeCounter += 1;
  return createDeletedMessagesStorage(new IdbStore(`test-deleted-${storeCounter}`));
}

function buildMessage(id: number, patch: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id,
    chatId: '100',
    date: NOW - 1000,
    isOutgoing: false,
    content: { text: { text: `message ${id}` } },
    ...patch,
  };
}

function buildRecord(id: number, deletedAt = NOW, message: ApiMessage | undefined = buildMessage(id)) {
  return buildDeletedRecord({
    userId: '1', chatId: '100', id, deletedAt, message,
  });
}

function buildPlaceholderRecord(id: number, deletedAt = NOW) {
  return buildDeletedRecord({
    userId: '1', chatId: '100', id, deletedAt,
  });
}

describe('canKeepDeletedMessage', () => {
  it('keeps an ordinary message', () => {
    expect(canKeepDeletedMessage(buildMessage(5))).toBe(true);
  });

  it('does not keep messages from secret chats', () => {
    expect(canKeepDeletedMessage(buildMessage(5), { type: 'chatTypeSecret' } as ApiChat)).toBe(false);
  });

  it('does not keep messages with an auto-delete timer', () => {
    expect(canKeepDeletedMessage(buildMessage(5, { ttlPeriod: 86400 }))).toBe(false);
  });

  it('does not keep self-destructing media', () => {
    expect(canKeepDeletedMessage(buildMessage(5, { content: { ttlSeconds: 10 } }))).toBe(false);
  });

  it('does not keep local, ephemeral and service messages', () => {
    expect(canKeepDeletedMessage(buildMessage(5, { sendingState: 'messageSendingStatePending' }))).toBe(false);
    expect(canKeepDeletedMessage(buildMessage(5, { isEphemeral: true }))).toBe(false);
    expect(canKeepDeletedMessage(buildMessage(5.1))).toBe(false);
    const serviceMessage = buildMessage(5, { content: { action: { type: 'chatCreate' } as never } });
    expect(canKeepDeletedMessage(serviceMessage)).toBe(false);
  });
});

describe('findKeysToEvict', () => {
  it('evicts records older than the retention period', () => {
    const index = { old: [NOW - 91 * DAY, 10], fresh: [NOW - 89 * DAY, 10] } as Record<string, [number, number]>;

    expect(findKeysToEvict(index, NOW, LIMITS)).toEqual(['old']);
  });

  it('evicts the oldest records first when the size limit is exceeded', () => {
    const index = {
      a: [NOW - 3 * DAY, 60 * MEGABYTE],
      b: [NOW - DAY, 60 * MEGABYTE],
      c: [NOW - 2 * DAY, 60 * MEGABYTE],
    } as Record<string, [number, number]>;

    expect(findKeysToEvict(index, NOW, { retentionDays: 90, maxMegabytes: 130 })).toEqual(['a']);
    expect(findKeysToEvict(index, NOW, { retentionDays: 90, maxMegabytes: 70 })).toEqual(['a', 'c']);
  });

  it('keeps everything within the limits', () => {
    const index = { a: [NOW, MEGABYTE] } as Record<string, [number, number]>;

    expect(findKeysToEvict(index, NOW, LIMITS)).toEqual([]);
  });
});

describe('deleted messages storage', () => {
  it('saves a copy and returns it for the chat', async () => {
    const storage = createStorage();

    await storage.save([buildRecord(7), buildRecord(5)], LIMITS, NOW);
    const records = await storage.loadChat('1', '100', LIMITS, NOW);

    expect(records.map((record) => record.id)).toEqual([5, 7]);
    expect(records[0].message?.content.text?.text).toBe('message 5');
  });

  it('returns nothing for a chat or user without copies', async () => {
    const storage = createStorage();
    await storage.save([buildRecord(7)], LIMITS, NOW);

    expect(await storage.loadChat('1', '200', LIMITS, NOW)).toEqual([]);
    expect(await storage.loadChat('2', '100', LIMITS, NOW)).toEqual([]);
  });

  it('stores a placeholder without a message and does not overwrite a copy with it', async () => {
    const storage = createStorage();
    await storage.save([buildRecord(7), buildPlaceholderRecord(8)], LIMITS, NOW);
    await storage.save([buildPlaceholderRecord(7, NOW + 5)], LIMITS, NOW);

    const [first, second] = await storage.loadChat('1', '100', LIMITS, NOW);

    expect(first.message).toBeDefined();
    expect(second.message).toBeUndefined();
    expect(applyDeletedRecordToMessage(second, 123)).toMatchObject({
      id: 8, date: 123, hasNoDeletedCopy: true, deletedAt: NOW,
    });
  });

  it('evicts expired records on save and on load', async () => {
    const storage = createStorage();
    await storage.save([buildRecord(1, NOW - 100 * DAY), buildRecord(2, NOW)], LIMITS, NOW);

    expect((await storage.loadChat('1', '100', LIMITS, NOW)).map((record) => record.id)).toEqual([2]);

    const laterLimits = { retentionDays: 1, maxMegabytes: 200 };
    expect(await storage.loadChat('1', '100', laterLimits, NOW + 2 * DAY)).toEqual([]);
  });

  it('evicts the oldest records when the size limit is exceeded', async () => {
    const storage = createStorage();
    const bigText = 'x'.repeat(0.7 * MEGABYTE);
    const big = (id: number, deletedAt: number) => buildRecord(id, deletedAt, buildMessage(id, {
      content: { text: { text: bigText } },
    }));
    const limits = { retentionDays: 90, maxMegabytes: 1.5 };

    await storage.save([big(1, NOW - 3), big(2, NOW - 2)], limits, NOW);
    const result = await storage.save([big(3, NOW - 1)], limits, NOW);

    expect(result.evictedKeys).toEqual(['1|100|1']);
    expect((await storage.loadChat('1', '100', limits, NOW)).map((record) => record.id)).toEqual([2, 3]);
    expect(await storage.getTotalBytes()).toBeLessThanOrEqual(1.5 * MEGABYTE);
  });

  it('clears copies of one user or everything', async () => {
    const storage = createStorage();
    const otherUserRecord = buildDeletedRecord({
      userId: '2', chatId: '100', id: 9, deletedAt: NOW, message: buildMessage(9),
    });
    await storage.save([buildRecord(1), otherUserRecord], LIMITS, NOW);

    await storage.clear('1');
    expect(await storage.loadChat('1', '100', LIMITS, NOW)).toEqual([]);
    expect(await storage.loadChat('2', '100', LIMITS, NOW)).toHaveLength(1);

    await storage.clear();
    expect(await storage.loadChat('2', '100', LIMITS, NOW)).toEqual([]);
    expect(await storage.getTotalBytes()).toBe(0);
  });
});
