import 'fake-indexeddb/auto';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiChat, ApiMessage, ApiUpdate } from '../../../api/types';
import type { GlobalState } from '../../types';

import { deletedMessagesStorage } from '../../../util/deletedMessages';
import { INITIAL_GLOBAL_STATE, INITIAL_TAB_STATE } from '../../initialState';
import { addMessages } from '../../reducers/messages';

type ApiUpdateHandler = (global: GlobalState, actions: Record<string, unknown>, update: ApiUpdate) => void;

const { handlers, state } = vi.hoisted(() => {
  // The environment helpers read media queries while the modules load
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  (globalThis as { CSS?: unknown }).CSS ??= { supports: () => false };

  const handlerMap: Record<string, unknown> = {};
  const stateHolder: { global: unknown } = { global: undefined };

  return { handlers: handlerMap, state: stateHolder };
});

vi.mock('../../index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../index')>(),
  addActionHandler: (name: string, handler: unknown) => { handlers[name] = handler; },
  getActions: () => ({}),
  getGlobal: () => state.global,
  setGlobal: (global: unknown) => { state.global = global; },
}));

const CHAT_ID = '-1000000000100';
const USER_ID = '1';
const LIMITS = { retentionDays: 90, maxMegabytes: 200 };
const REMOVAL_DELAY_MS = 5000;

const actions = {
  requestChatUpdate: vi.fn(),
  restoreDeletedMessages: vi.fn(),
};

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

function buildGlobal(messages: ApiMessage[], shouldKeepDeletedMessages = true) {
  let global = {
    ...INITIAL_GLOBAL_STATE,
    currentUserId: USER_ID,
    byTabId: { 1: { ...INITIAL_TAB_STATE, id: 1 } },
    sharedState: {
      ...INITIAL_GLOBAL_STATE.sharedState,
      settings: { ...INITIAL_GLOBAL_STATE.sharedState.settings, shouldKeepDeletedMessages },
    },
    chats: {
      ...INITIAL_GLOBAL_STATE.chats,
      byId: { [CHAT_ID]: { id: CHAT_ID, type: 'chatTypeChannel' } as ApiChat },
    },
  } as unknown as GlobalState;

  global = addMessages(global, messages);
  return global;
}

function getMessage(id: number) {
  return (state.global as GlobalState).messages.byChatId[CHAT_ID].byId[id] as ApiMessage | undefined;
}

function handleDelete(update: Record<string, unknown>) {
  (handlers.apiUpdate as ApiUpdateHandler)(
    state.global as GlobalState, actions, { '@type': 'deleteMessages', chatId: CHAT_ID, ...update } as ApiUpdate,
  );
}

async function loadRecords() {
  // The storage queue runs after pending writes
  return deletedMessagesStorage.loadChat(USER_ID, CHAT_ID, LIMITS, Math.floor(Date.now() / 1000));
}

beforeAll(async () => {
  await import('./messages');
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  actions.requestChatUpdate.mockReset();
  actions.restoreDeletedMessages.mockReset();
  await deletedMessagesStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deleted message updates', () => {
  it('keeps a message deleted by the peer in the list and saves a copy', async () => {
    state.global = buildGlobal([buildMessage(10)]);

    handleDelete({ ids: [10] });
    vi.advanceTimersByTime(REMOVAL_DELAY_MS);

    expect(getMessage(10)).toMatchObject({ id: 10, deletedAt: expect.any(Number) });
    expect(getMessage(10)!.isDeleting).toBeUndefined();

    const records = await loadRecords();
    expect(records).toHaveLength(1);
    expect(records[0].message?.content.text?.text).toBe('message 10');
    expect(records[0].isDeletedByMe).toBeUndefined();
  });

  it('keeps own deletions the same way and marks them as made by me', async () => {
    state.global = buildGlobal([buildMessage(11, { isOutgoing: true })]);

    handleDelete({ ids: [11], isDeletedByMe: true });
    vi.advanceTimersByTime(REMOVAL_DELAY_MS);

    expect(getMessage(11)?.deletedAt).toBeDefined();
    expect((await loadRecords())[0].isDeletedByMe).toBe(true);
  });

  it('removes the message and saves nothing when keeping is turned off', async () => {
    state.global = buildGlobal([buildMessage(10)], false);

    handleDelete({ ids: [10] });
    vi.advanceTimersByTime(REMOVAL_DELAY_MS);

    expect(getMessage(10)).toBeUndefined();
    expect(await loadRecords()).toEqual([]);
  });

  it('removes messages with an auto-delete timer and saves nothing', async () => {
    state.global = buildGlobal([buildMessage(10, { ttlPeriod: 60 }), buildMessage(12, { content: { ttlSeconds: 5 } })]);

    handleDelete({ ids: [10, 12] });
    vi.advanceTimersByTime(REMOVAL_DELAY_MS);

    expect(getMessage(10)).toBeUndefined();
    expect(getMessage(12)).toBeUndefined();
    expect(await loadRecords()).toEqual([]);
  });

  it('saves a placeholder for a message that was never loaded and asks to restore it', async () => {
    state.global = buildGlobal([buildMessage(10)]);

    handleDelete({ ids: [15] });
    vi.advanceTimersByTime(REMOVAL_DELAY_MS);
    const records = await loadRecords();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 15 });
    expect(records[0].message).toBeUndefined();
    await vi.waitFor(() => expect(actions.restoreDeletedMessages).toHaveBeenCalledWith({ chatId: CHAT_ID, tabId: 1 }));
    expect(getMessage(15)).toBeUndefined();
  });
});
