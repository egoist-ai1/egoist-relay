import type { ApiChat, ApiMessage } from '../api/types';

import { IdbStore } from './browser/idb';
import { isLocalMessageId } from './keys/messageKey';

export const DELETED_MESSAGES_RETENTION_DAYS_OPTIONS = [7, 30, 90, 365];
export const DELETED_MESSAGES_MAX_MEGABYTES_OPTIONS = [50, 200, 500, 1000];

const INDEX_KEY = '__index__';
const KEY_SEPARATOR = '|';
const SECONDS_PER_DAY = 24 * 60 * 60;
const BYTES_PER_MEGABYTE = 1024 * 1024;

export type DeletedMessagesLimits = {
  retentionDays: number;
  maxMegabytes: number;
};

export type DeletedMessageRecord = {
  key: string;
  userId: string;
  chatId: string;
  id: number;
  // Unix seconds
  deletedAt: number;
  isDeletedByMe?: boolean;
  // Absent when the message was never loaded and only the fact of deletion is known
  message?: ApiMessage;
};

// Deletion time (unix seconds) and approximate size in bytes by record key
type StorageIndex = Record<string, [number, number]>;

export function buildDeletedRecordKey(userId: string, chatId: string, id: number) {
  return [userId, chatId, id].join(KEY_SEPARATOR);
}

export function canKeepDeletedMessage(message: ApiMessage, chat?: ApiChat) {
  if (chat?.type === 'chatTypeSecret') return false;
  if (message.isEphemeral || message.sendingState || isLocalMessageId(message.id)) return false;
  if (message.ttlPeriod !== undefined || message.content.ttlSeconds !== undefined) return false;

  return !message.content.action;
}

export function buildDeletedRecord(params: {
  userId: string;
  chatId: string;
  id: number;
  deletedAt: number;
  message?: ApiMessage;
  isDeletedByMe?: boolean;
}): DeletedMessageRecord {
  const {
    userId, chatId, id, deletedAt, message, isDeletedByMe,
  } = params;

  return {
    key: buildDeletedRecordKey(userId, chatId, id),
    userId,
    chatId,
    id,
    deletedAt,
    isDeletedByMe,
    message: message && sanitizeMessageCopy(message),
  };
}

export function applyDeletedRecordToMessage(record: DeletedMessageRecord, neighborDate: number): ApiMessage {
  if (record.message) {
    return { ...record.message, deletedAt: record.deletedAt };
  }

  return {
    id: record.id,
    chatId: record.chatId,
    date: neighborDate,
    isOutgoing: false,
    content: {},
    deletedAt: record.deletedAt,
    hasNoDeletedCopy: true,
  };
}

export function findKeysToEvict(index: StorageIndex, now: number, limits: DeletedMessagesLimits) {
  const expiresBefore = now - limits.retentionDays * SECONDS_PER_DAY;
  const maxBytes = limits.maxMegabytes * BYTES_PER_MEGABYTE;

  const keysToEvict: string[] = [];
  const alive: [string, number, number][] = [];
  let totalBytes = 0;

  Object.entries(index).forEach(([key, [deletedAt, size]]) => {
    if (deletedAt < expiresBefore) {
      keysToEvict.push(key);
      return;
    }
    alive.push([key, deletedAt, size]);
    totalBytes += size;
  });

  if (totalBytes <= maxBytes) return keysToEvict;

  alive.sort((a, b) => a[1] - b[1]);
  for (const [key, , size] of alive) {
    if (totalBytes <= maxBytes) break;
    keysToEvict.push(key);
    totalBytes -= size;
  }

  return keysToEvict;
}

export function createDeletedMessagesStorage(store: IdbStore) {
  let queue: Promise<unknown> = Promise.resolve();
  let cachedIndex: StorageIndex | undefined;

  // Operations run one after another so the index is never written from stale state
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  async function readIndex(shouldRefresh?: boolean) {
    if (!cachedIndex || shouldRefresh) {
      cachedIndex = (await store.get<StorageIndex>(INDEX_KEY)) || {};
    }
    return cachedIndex;
  }

  async function applyEviction(index: StorageIndex, now: number, limits: DeletedMessagesLimits) {
    const keysToEvict = findKeysToEvict(index, now, limits);
    if (!keysToEvict.length) return keysToEvict;

    await store.delMany(keysToEvict);
    keysToEvict.forEach((key) => delete index[key]);
    return keysToEvict;
  }

  function save(records: DeletedMessageRecord[], limits: DeletedMessagesLimits, now: number) {
    return enqueue(async () => {
      const index = { ...await readIndex(true) };

      const entries: [string, DeletedMessageRecord][] = [];
      records.forEach((record) => {
        const shouldKeepExisting = record.key in index && !record.message;
        if (shouldKeepExisting) return;

        index[record.key] = [record.deletedAt, JSON.stringify(record).length];
        entries.push([record.key, record]);
      });

      if (entries.length) await store.setMany(entries);
      const evictedKeys = await applyEviction(index, now, limits);
      cachedIndex = index;
      await store.set(INDEX_KEY, index);

      return { savedCount: entries.length, evictedKeys };
    });
  }

  function loadChat(userId: string, chatId: string, limits: DeletedMessagesLimits, now: number) {
    return enqueue(async () => {
      const index = await readIndex();
      const evictedKeys = await applyEviction(index, now, limits);
      if (evictedKeys.length) await store.set(INDEX_KEY, index);

      const prefix = [userId, chatId, ''].join(KEY_SEPARATOR);
      const keys = Object.keys(index).filter((key) => key.startsWith(prefix));
      if (!keys.length) return [];

      const records = await store.getMany<DeletedMessageRecord>(keys);
      return records.filter(Boolean).sort((a, b) => a.id - b.id);
    });
  }

  function clear(userId?: string) {
    return enqueue(async () => {
      if (!userId) {
        await store.clear();
        cachedIndex = {};
        return;
      }

      const index = { ...await readIndex(true) };
      const prefix = [userId, ''].join(KEY_SEPARATOR);
      const keys = Object.keys(index).filter((key) => key.startsWith(prefix));
      if (keys.length) await store.delMany(keys);
      keys.forEach((key) => delete index[key]);
      cachedIndex = index;
      await store.set(INDEX_KEY, index);
    });
  }

  function getTotalBytes() {
    return enqueue(async () => {
      const index = await readIndex(true);
      return Object.values(index).reduce((total, [, size]) => total + size, 0);
    });
  }

  return {
    save, loadChat, clear, getTotalBytes,
  };
}

export const deletedMessagesStorage = createDeletedMessagesStorage(new IdbStore('tt-deleted-messages', true));

// Fields that describe the message position in the live list rather than its content
function sanitizeMessageCopy(message: ApiMessage): ApiMessage {
  return {
    ...message,
    isDeleting: undefined,
    deletedAt: undefined,
    hasNoDeletedCopy: undefined,
    groupedId: undefined,
    isInAlbum: undefined,
    inlineButtons: undefined,
    keyboardButtons: undefined,
  };
}

export function getDeletedMessagesLimits(settings: {
  deletedMessagesRetentionDays: number;
  deletedMessagesMaxMegabytes: number;
}): DeletedMessagesLimits {
  return {
    retentionDays: settings.deletedMessagesRetentionDays,
    maxMegabytes: settings.deletedMessagesMaxMegabytes,
  };
}
