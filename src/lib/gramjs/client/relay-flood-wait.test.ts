import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type RequestState from '../network/RequestState';

import { FloodWaitError } from '../errors';
import Api from '../tl/api';

import TelegramClient from './TelegramClient';

const REQUEST_RETRIES = 5;
const FLOOD_SECONDS = 2;

type FakeClient = {
  _sender: { addStateToQueue: (state: RequestState) => void };
  _connectedDeferred: { promise: Promise<void> };
  _requestRetries: number;
  floodSleepLimit: number;
  _log: { info: () => void; warn: () => void };
  _lastRequest: number;
  releaseExportedSender: () => void;
};

function createFakeClient(buildError: () => unknown) {
  const addStateToQueue = vi.fn((state: RequestState) => {
    state.reject?.(buildError() as Error);
  });
  const client: FakeClient = {
    _sender: { addStateToQueue },
    _connectedDeferred: { promise: Promise.resolve() },
    _requestRetries: REQUEST_RETRIES,
    floodSleepLimit: 60,
    _log: { info: () => {}, warn: () => {} },
    _lastRequest: 0,
    releaseExportedSender: () => {},
  };
  return { client, addStateToQueue };
}

function invoke(client: FakeClient) {
  return TelegramClient.prototype.invoke.call(
    client as unknown as TelegramClient, new Api.updates.GetState(),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Relay flood wait handling', () => {
  test('Exhausted retries keep the flood wait error and its wait time', async () => {
    const { client, addStateToQueue } = createFakeClient(() => new FloodWaitError({
      errorMessage: `FLOOD_WAIT_${FLOOD_SECONDS}`,
      capture: FLOOD_SECONDS,
      request: new Api.updates.GetState(),
      code: 420,
    }));

    const result = invoke(client);
    const assertion = expect(result).rejects.toMatchObject({
      errorMessage: `FLOOD_WAIT_${FLOOD_SECONDS}`, seconds: FLOOD_SECONDS,
    });
    await vi.advanceTimersByTimeAsync(REQUEST_RETRIES * FLOOD_SECONDS * 1000);

    await assertion;
    expect(addStateToQueue).toHaveBeenCalledTimes(REQUEST_RETRIES);
  });
});
