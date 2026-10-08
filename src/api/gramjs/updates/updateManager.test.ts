import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api as GramJs } from '../../../lib/gramjs';
import { UpdateSessionGap } from '../../../lib/gramjs/network';

import localDb from '../localDb';
import { sendApiUpdate } from './apiUpdateEmitter';
import { init, processUpdate, reset } from './updateManager';

vi.mock('./apiUpdateEmitter', () => ({ sendApiUpdate: vi.fn() }));
vi.mock('./mtpUpdateHandler', () => ({ updater: vi.fn() }));
vi.mock('./entityProcessor', () => ({ processAndUpdateEntities: vi.fn() }));

const UPDATE_WAIT_TIMEOUT = 500;
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

function triggerGap() {
  processUpdate(new UpdateSessionGap(BigInt(1), BigInt(2)));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockedSendApiUpdate.mockReset();
  reset();
  localDb.commonBoxState = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe('difference recovery', () => {
  it('keeps recovering gaps after a failed difference request', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(new GramJs.updates.State(REMOTE_STATE as never))
      .mockRejectedValueOnce(new Error('Difference failed'))
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(1);
    expect(getFetchingFlags().at(-1)).toBe(false);

    triggerGap();
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);

    expect(countDifferenceRequests(invoke)).toBe(2);
  });

  it('keeps recovering gaps when a following difference slice fails', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(new GramJs.updates.State(REMOTE_STATE as never))
      .mockResolvedValueOnce(buildSlice())
      .mockRejectedValueOnce(new Error('Slice failed'))
      .mockResolvedValue(new GramJs.updates.DifferenceEmpty({ date: 102, seq: 3 }));
    await init(invoke);

    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);
    expect(countDifferenceRequests(invoke)).toBe(2);
    expect(getFetchingFlags().at(-1)).toBe(false);

    triggerGap();
    await vi.advanceTimersByTimeAsync(UPDATE_WAIT_TIMEOUT);

    expect(countDifferenceRequests(invoke)).toBe(3);
  });
});
