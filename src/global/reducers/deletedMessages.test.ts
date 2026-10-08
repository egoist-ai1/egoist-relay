import { describe, expect, it, vi } from 'vitest';

import type { ApiChat, ApiMessage } from '../../api/types';
import type { Thread } from '../../types';
import type { GlobalState } from '../types';
import { MAIN_THREAD_ID } from '../../api/types';

import { buildDeletedRecord } from '../../util/deletedMessages';
import { INITIAL_GLOBAL_STATE, INITIAL_TAB_STATE } from '../initialState';
import { selectChatMessage, selectListedIds, selectViewportIds } from '../selectors';
import { keepDeletedMessages, removeKeptDeletedMessages, restoreDeletedMessages } from './deletedMessages';
import { addMessages, updateMessageStore } from './messages';
import { replaceTabThreadParam, replaceThreadLocalStateParam } from './threads';

vi.hoisted(() => {
  // The environment helpers read media queries while the modules load
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  (globalThis as { CSS?: unknown }).CSS ??= { supports: () => false };
});

const TAB_ID = 1;
const CHAT_ID = '100';
const USER_ID = '1';
const NOW = 1_800_000_000;

function buildMessage(id: number, patch: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id,
    chatId: CHAT_ID,
    date: 1000 + id,
    isOutgoing: false,
    content: { text: { text: `message ${id}` } },
    ...patch,
  };
}

function buildGlobal(options: { chat?: Partial<ApiChat>; lastMessageId?: number; messages?: ApiMessage[] } = {}) {
  const { chat, lastMessageId = 20, messages = [buildMessage(10), buildMessage(20)] } = options;
  const ids = messages.map((message) => message.id);

  let global = {
    ...INITIAL_GLOBAL_STATE,
    currentUserId: USER_ID,
    byTabId: { [TAB_ID]: { ...INITIAL_TAB_STATE, id: TAB_ID } },
    chats: {
      ...INITIAL_GLOBAL_STATE.chats,
      byId: { [CHAT_ID]: { id: CHAT_ID, type: 'chatTypePrivate', ...chat } as ApiChat },
      lastMessageIds: { all: { [CHAT_ID]: lastMessageId } },
    },
  } as unknown as GlobalState;

  global = addMessages(global, messages);
  global = updateMessageStore(global, CHAT_ID, {
    threadsById: {
      [MAIN_THREAD_ID]: { localState: {}, threadInfo: { chatId: CHAT_ID }, readState: {} } as unknown as Thread,
    },
  });
  global = replaceThreadLocalStateParam(global, CHAT_ID, MAIN_THREAD_ID, 'listedIds', ids);
  global = replaceTabThreadParam(global, CHAT_ID, MAIN_THREAD_ID, 'viewportIds', ids, TAB_ID);
  return global;
}

function buildRecord(id: number, message?: ApiMessage) {
  return buildDeletedRecord({
    userId: USER_ID, chatId: CHAT_ID, id, deletedAt: NOW, message,
  });
}

describe('keepDeletedMessages', () => {
  it('marks a loaded message as kept and builds its record', () => {
    const global = buildGlobal({ messages: [buildMessage(10, { groupedId: 'g1', isInAlbum: true })] });

    const result = keepDeletedMessages(global, CHAT_ID, [10], { deletedAt: NOW, isDeletedByMe: true });
    const message = selectChatMessage(result.global, CHAT_ID, 10)!;

    expect(result.keptIds).toEqual(new Set([10]));
    expect(message.deletedAt).toBe(NOW);
    expect(message.groupedId).toBeUndefined();
    expect(message.isInAlbum).toBeUndefined();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      key: `${USER_ID}|${CHAT_ID}|10`, deletedAt: NOW, isDeletedByMe: true,
    });
    expect(result.records[0].message?.content.text?.text).toBe('message 10');
  });

  it('resolves the chat of a common box message without a chat id', () => {
    const global = buildGlobal();

    const result = keepDeletedMessages(global, undefined, [20], { deletedAt: NOW });

    expect(result.keptIds).toEqual(new Set([20]));
    expect(result.records[0].chatId).toBe(CHAT_ID);
  });

  it('does not keep messages with a timer or self-destructing media', () => {
    const global = buildGlobal({
      messages: [buildMessage(10, { ttlPeriod: 60 }), buildMessage(20, { content: { ttlSeconds: 5 } })],
    });

    const result = keepDeletedMessages(global, CHAT_ID, [10, 20], { deletedAt: NOW });

    expect(result.keptIds.size).toBe(0);
    expect(result.records).toEqual([]);
    expect(selectChatMessage(result.global, CHAT_ID, 10)!.deletedAt).toBeUndefined();
  });

  it('does not keep messages of secret chats', () => {
    const global = buildGlobal({ chat: { type: 'chatTypeSecret' } });

    const result = keepDeletedMessages(global, CHAT_ID, [10, 99], { deletedAt: NOW });

    expect(result.keptIds.size).toBe(0);
    expect(result.records).toEqual([]);
  });

  it('records only the fact of deletion for a message that was never loaded', () => {
    const global = buildGlobal();

    const result = keepDeletedMessages(global, CHAT_ID, [15], { deletedAt: NOW });

    expect(result.keptIds.size).toBe(0);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].message).toBeUndefined();
  });

  it('records nothing for an unknown message without a chat', () => {
    const global = buildGlobal();

    expect(keepDeletedMessages(global, undefined, [15], { deletedAt: NOW }).records).toEqual([]);
    expect(keepDeletedMessages(global, '999', [15], { deletedAt: NOW }).records).toEqual([]);
  });

  it('keeps an already kept message as it is', () => {
    const global = buildGlobal({ messages: [buildMessage(10, { deletedAt: NOW - 5 })] });

    const result = keepDeletedMessages(global, CHAT_ID, [10], { deletedAt: NOW });

    expect(result.keptIds).toEqual(new Set([10]));
    expect(result.records).toEqual([]);
    expect(selectChatMessage(result.global, CHAT_ID, 10)!.deletedAt).toBe(NOW - 5);
  });
});

describe('restoreDeletedMessages', () => {
  it('puts a saved message back between loaded messages', () => {
    const global = buildGlobal();

    const result = restoreDeletedMessages(global, CHAT_ID, [buildRecord(15, buildMessage(15))], TAB_ID);

    expect(selectChatMessage(result, CHAT_ID, 15)).toMatchObject({
      deletedAt: NOW, content: { text: { text: 'message 15' } },
    });
    expect(selectListedIds(result, CHAT_ID, MAIN_THREAD_ID)).toEqual([10, 15, 20]);
    expect(selectViewportIds(result, CHAT_ID, MAIN_THREAD_ID, TAB_ID)).toEqual([10, 15, 20]);
  });

  it('builds a placeholder with the date of the previous message', () => {
    const global = buildGlobal();

    const result = restoreDeletedMessages(global, CHAT_ID, [buildRecord(15)], TAB_ID);

    expect(selectChatMessage(result, CHAT_ID, 15)).toMatchObject({
      hasNoDeletedCopy: true, deletedAt: NOW, date: 1010, content: {},
    });
  });

  it('skips messages outside the loaded history', () => {
    const global = buildGlobal({ lastMessageId: 30 });

    const result = restoreDeletedMessages(global, CHAT_ID, [buildRecord(5, buildMessage(5)), buildRecord(25)], TAB_ID);

    expect(result).toBe(global);
  });

  it('restores messages deleted after the last loaded one when the history end is loaded', () => {
    const global = buildGlobal();

    const result = restoreDeletedMessages(global, CHAT_ID, [buildRecord(25, buildMessage(25))], TAB_ID);

    expect(selectListedIds(result, CHAT_ID, MAIN_THREAD_ID)).toEqual([10, 20, 25]);
    expect(selectViewportIds(result, CHAT_ID, MAIN_THREAD_ID, TAB_ID)).toEqual([10, 20, 25]);
  });

  it('does not replace a message that is already in the list', () => {
    const global = buildGlobal();

    const result = restoreDeletedMessages(global, CHAT_ID, [buildRecord(10, buildMessage(10))], TAB_ID);

    expect(result).toBe(global);
    expect(selectChatMessage(result, CHAT_ID, 10)!.deletedAt).toBeUndefined();
  });

  it('does nothing for forums', () => {
    const global = buildGlobal({ chat: { isForum: true } });

    expect(restoreDeletedMessages(global, CHAT_ID, [buildRecord(15, buildMessage(15))], TAB_ID)).toBe(global);
  });
});

describe('removeKeptDeletedMessages', () => {
  it('removes kept messages and leaves the others', () => {
    const global = buildGlobal({ messages: [buildMessage(10), buildMessage(20, { deletedAt: NOW })] });

    const result = removeKeptDeletedMessages(global);

    expect(selectChatMessage(result, CHAT_ID, 20)).toBeUndefined();
    expect(selectChatMessage(result, CHAT_ID, 10)).toBeDefined();
    expect(selectListedIds(result, CHAT_ID, MAIN_THREAD_ID)).toEqual([10]);
  });
});
