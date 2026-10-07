import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // The environment helpers read media queries and CSS support while the modules load
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  (globalThis as { CSS?: unknown }).CSS ??= { supports: () => false };
});

vi.mock('../util/folderManager', async (importOriginal) => ({
  ...await importOriginal<typeof import('../util/folderManager')>(),
  getOrderedIds: () => undefined,
}));

import type { ApiMessage } from '../api/types';
import type { GlobalState } from './types';
import { MAIN_THREAD_ID } from '../api/types';

import { migrateCache, serializeGlobal } from './cache';
import { INITIAL_GLOBAL_STATE } from './initialState';

const CHAT_ID = '777';
const PENDING_ID = 12.5;
const FAILED_ID = 12.25;
const SENT_ID = 12;

function buildMessage(id: number, sendingState?: ApiMessage['sendingState']) {
  return {
    id, chatId: CHAT_ID, date: 1, isOutgoing: true, content: { text: { text: 'hello' } }, sendingState,
  } as ApiMessage;
}

function buildGlobal(): GlobalState {
  return {
    ...INITIAL_GLOBAL_STATE,
    currentUserId: CHAT_ID,
    messages: {
      ...INITIAL_GLOBAL_STATE.messages,
      byChatId: {
        [CHAT_ID]: {
          byId: {
            [SENT_ID]: buildMessage(SENT_ID),
            [FAILED_ID]: buildMessage(FAILED_ID, 'messageSendingStateFailed'),
            [PENDING_ID]: buildMessage(PENDING_ID, 'messageSendingStatePending'),
          },
          ephemeralById: {},
          summaryById: {},
          threadsById: {
            [MAIN_THREAD_ID]: { localState: { lastViewportIds: [SENT_ID, FAILED_ID, PENDING_ID] } },
          },
        },
      },
    },
  } as unknown as GlobalState;
}

describe('pending messages in the cache', () => {
  it('does not keep a message pending after a restart', () => {
    const cached = JSON.parse(serializeGlobal(buildGlobal())) as GlobalState;
    const { byId } = cached.messages.byChatId[CHAT_ID];

    expect(byId[PENDING_ID].sendingState).toBe('messageSendingStateFailed');
    expect(byId[FAILED_ID].sendingState).toBe('messageSendingStateFailed');
    expect(byId[SENT_ID].sendingState).toBeUndefined();
  });

  it('heals pending messages stored by an earlier session', () => {
    const cached = buildGlobal();

    expect(migrateCache(cached, INITIAL_GLOBAL_STATE)).toBe(true);

    const { byId } = cached.messages.byChatId[CHAT_ID];
    expect(byId[PENDING_ID].sendingState).toBe('messageSendingStateFailed');
    expect(byId[SENT_ID].sendingState).toBeUndefined();
  });
});
