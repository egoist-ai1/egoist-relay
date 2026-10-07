import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdate } from '../../../api/types';
import type { GlobalState } from '../../types';

import { INITIAL_GLOBAL_STATE } from '../../initialState';

type ApiUpdateHandler = (global: GlobalState, actions: Record<string, unknown>, update: ApiUpdate) => void;

const { handlers, state, showAllowedMessageTypesNotification } = vi.hoisted(() => {
  // The environment helpers read media queries while the modules load
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  (globalThis as { CSS?: unknown }).CSS ??= { supports: () => false };

  const handlerMap: Record<string, unknown> = {};
  const stateHolder: { global: unknown } = { global: undefined };

  return {
    handlers: handlerMap,
    state: stateHolder,
    showAllowedMessageTypesNotification: vi.fn(),
  };
});

vi.mock('../../index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../index')>(),
  addActionHandler: (name: string, handler: unknown) => { handlers[name] = handler; },
  getActions: () => ({ showAllowedMessageTypesNotification }),
  getGlobal: () => state.global,
  setGlobal: (global: unknown) => { state.global = global; },
}));

const CHAT_ID = '100';
const LOCAL_ID = 5;

function buildGlobal() {
  return {
    ...INITIAL_GLOBAL_STATE,
    messages: {
      ...INITIAL_GLOBAL_STATE.messages,
      byChatId: {
        [CHAT_ID]: {
          byId: {
            [LOCAL_ID]: {
              id: LOCAL_ID, chatId: CHAT_ID, content: {}, sendingState: 'messageSendingStatePending',
            },
          },
          threadsById: {},
        },
      },
    },
  } as unknown as GlobalState;
}

function getSendingState() {
  const global = state.global as GlobalState;
  return global.messages.byChatId[CHAT_ID].byId[LOCAL_ID].sendingState;
}

function handleApiUpdate(update: Record<string, unknown>) {
  (handlers.apiUpdate as ApiUpdateHandler)(
    state.global as GlobalState, { showAllowedMessageTypesNotification }, update as unknown as ApiUpdate,
  );
}

beforeAll(async () => {
  await import('./messages');
});

beforeEach(() => {
  state.global = buildGlobal();
  showAllowedMessageTypesNotification.mockReset();
});

describe('message send failure updates', () => {
  it('marks the message failed when the error has no text', () => {
    expect(() => handleApiUpdate({ '@type': 'updateMessageSendFailed', chatId: CHAT_ID, localId: LOCAL_ID }))
      .not.toThrow();

    expect(getSendingState()).toBe('messageSendingStateFailed');
    expect(showAllowedMessageTypesNotification).not.toHaveBeenCalled();
  });

  it('still reports forbidden chat errors', () => {
    state.global = { ...(state.global as GlobalState), byTabId: { 1: { id: 1 } } };

    handleApiUpdate({
      '@type': 'updateMessageSendFailed', chatId: CHAT_ID, localId: LOCAL_ID, error: 'CHAT_SEND_PLAIN_FORBIDDEN',
    });

    expect(getSendingState()).toBe('messageSendingStateFailed');
    expect(showAllowedMessageTypesNotification).toHaveBeenCalledWith({ chatId: CHAT_ID, tabId: 1 });
  });
});
