import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api as GramJs } from '../../../lib/gramjs';
import { UpdateConnectionState } from '../../../lib/gramjs/network';

import localDb from '../localDb';
import { sendApiUpdate } from './apiUpdateEmitter';
import {
  init, processUpdate, reset, stop,
} from './updateManager';

vi.mock('./apiUpdateEmitter', () => ({ sendApiUpdate: vi.fn() }));
vi.mock('./mtpUpdateHandler', () => ({ updater: vi.fn() }));
vi.mock('./entityProcessor', () => ({ processAndUpdateEntities: vi.fn() }));

const UPDATE_WAIT_TIMEOUT = 500;
const RETRY_TIMEOUT = 5000;
const DIFFERENCE_TIMEOUT = 30000;
const REMOTE_STATE = { seq: 1, date: 100, pts: 10, qts: 0 };

const mockedSendApiUpdate = vi.mocked(sendApiUpdate);

function buildSlice() {
  return new GramJs.updates.DifferenceSlice({
    newMessages: [],
    newEncryptedMessages: [],
    otherUpdates: [],
    chats: [],
    users: [],
    intermediateState: new GramJs.updates.State({ pts: 11, qts: 0, date: 101, seq: 2, unreadCount: 0 }),
  });
}

function getFetchingFlags() {
  return mockedSendApiUpdate.mock.calls
    .map(([update]) => update as unknown as { '@type': string; isFetching?: boolean })
    .filter((update) => update['@type'] === 'updateFetchingDifference')
    .map((update) => update.isFetching);
}

function countDifferenceRequests(invoke: ReturnType<typeof vi.fn>) {
  return invoke.mock.calls.filter(([request]) => request instanceof GramJs.updates.GetDifference).length;
}

function countStateRequests(invoke: ReturnType<typeof vi.fn>) {
  return invoke.mock.calls.filter(([request]) => request instanceof GramJs.updates.GetState).length;
}

function buildState() {
  return new GramJs.updates.State({ ...REMOTE_STATE, unreadCount: 0 });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedSendApiUpdate.mockReset();
  reset();
  // Связь и invoke — состояние модуля вне reset(): возвращаем к исходному без запуска загрузки
  stop();
  processUpdate(new UpdateConnectionState(UpdateConnectionState.connected));
  localDb.commonBoxState = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe('difference recovery', () => {
  it('retries after 5s when GetDifference is rejected, state stays inited', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(buildState())
      .mockRejectedValueOnce(new Error('Difference failed'))
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(1);
    expect(getFetchingFlags()).toEqual([true, false]);
    expect(countStateRequests(invoke)).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_TIMEOUT - 1);
    expect(countDifferenceRequests(invoke)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(countDifferenceRequests(invoke)).toBe(2);
    expect(getFetchingFlags()).toEqual([true, false, true, false]);
    expect(localDb.commonBoxState.pts).toBe(REMOTE_STATE.pts);
  });

  it('keeps recovering gaps when a following difference slice fails', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(buildState())
      .mockResolvedValueOnce(buildSlice())
      .mockRejectedValueOnce(new Error('Slice failed'))
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(2);
    expect(getFetchingFlags().at(-1)).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(3);
  });

  it('retries GetState with backoff until it succeeds', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(buildState())
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);
    expect(countStateRequests(invoke)).toBe(1);
    expect(localDb.commonBoxState.seq).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5000);
    expect(countStateRequests(invoke)).toBe(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(countStateRequests(invoke)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(countStateRequests(invoke)).toBe(3);
    expect(localDb.commonBoxState.pts).toBe(REMOTE_STATE.pts);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(1);
  });

  it('times out a hung GetDifference and ignores its late response', async () => {
    let resolveHung: (value: unknown) => void = () => undefined;
    const invoke = vi.fn()
      .mockResolvedValueOnce(buildState())
      .mockImplementationOnce(() => new Promise((resolve) => { resolveHung = resolve; }))
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(getFetchingFlags()).toEqual([true]);

    await vi.advanceTimersByTimeAsync(DIFFERENCE_TIMEOUT);
    expect(getFetchingFlags()).toEqual([true, false]);

    // Поздний ответ старого поколения не должен откатить pts
    resolveHung(new GramJs.updates.Difference({
      newMessages: [],
      newEncryptedMessages: [],
      otherUpdates: [],
      chats: [],
      users: [],
      state: new GramJs.updates.State({ pts: 5, qts: 0, date: 50, seq: 1, unreadCount: 0 }),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(localDb.commonBoxState.pts).toBe(REMOTE_STATE.pts);

    await vi.advanceTimersByTimeAsync(RETRY_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(2);
  });

  it('DifferenceTooLong requests sync and releases the flag after reinit', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(buildState())
      .mockResolvedValueOnce(new GramJs.updates.DifferenceTooLong({ pts: 99 }))
      .mockResolvedValueOnce(new GramJs.updates.State({ ...REMOTE_STATE, pts: 99, unreadCount: 0 }))
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    const types = mockedSendApiUpdate.mock.calls.map(([update]) => update['@type']);
    expect(types).toContain('requestSync');
    expect(getFetchingFlags()).toEqual([true]);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(localDb.commonBoxState.pts).toBe(99);
    expect(getFetchingFlags()).toEqual([true, true, false]);
  });

  it('starts loading state on connected update after reset', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(buildState())
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);

    reset();
    invoke.mockResolvedValueOnce(buildState());
    processUpdate(new UpdateConnectionState(UpdateConnectionState.connected));
    await vi.advanceTimersByTimeAsync(0);

    expect(countStateRequests(invoke)).toBe(2);
    expect(localDb.commonBoxState.pts).toBe(REMOTE_STATE.pts);
  });

  it('stop() halts state loading and init() after relogin loads state at once', async () => {
    const oldInvoke = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValue(new Error('AUTH_KEY_UNREGISTERED'));
    void init(oldInvoke);
    await vi.advanceTimersByTimeAsync(0);
    expect(countStateRequests(oldInvoke)).toBe(1);

    // Клиент закрыт: новый клиент на экране входа подключается, но GetState не шлём
    stop();
    processUpdate(new UpdateConnectionState(UpdateConnectionState.connected));
    await vi.advanceTimersByTimeAsync(60000);
    expect(countStateRequests(oldInvoke)).toBe(1);

    // После входа загрузка идёт сразу, а не после таймаута зависшего запроса
    const invoke = vi.fn()
      .mockResolvedValueOnce(buildState())
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);
    expect(localDb.commonBoxState.pts).toBe(REMOTE_STATE.pts);
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(1);
  });

  it('does not pile up retries while disconnected and resumes on connected', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(buildState())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);

    processUpdate(new UpdateConnectionState(UpdateConnectionState.disconnected));
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(countDifferenceRequests(invoke)).toBe(1);
    expect(getFetchingFlags().at(-1)).toBe(false);

    processUpdate(new UpdateConnectionState(UpdateConnectionState.connected));
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(2);
  });

  it('does not retry GetState while disconnected and loads it on reconnect', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(buildState())
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    processUpdate(new UpdateConnectionState(UpdateConnectionState.disconnected));
    await init(invoke);
    await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(countStateRequests(invoke)).toBe(1);

    processUpdate(new UpdateConnectionState(UpdateConnectionState.connected));
    await vi.advanceTimersByTimeAsync(0);
    expect(countStateRequests(invoke)).toBe(2);
    expect(localDb.commonBoxState.pts).toBe(REMOTE_STATE.pts);
  });
});
