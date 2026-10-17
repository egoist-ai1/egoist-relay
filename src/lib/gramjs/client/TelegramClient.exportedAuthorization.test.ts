import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import MTProtoSender from '../network/MTProtoSender';
import Api from '../tl/api';

import { AuthKey } from '../crypto/AuthKey';
import Logger from '../extensions/Logger';
import { Connection } from '../network/connection/Connection';
import MemorySession from '../sessions/Memory';
import TelegramClient from './TelegramClient';

const authenticate = vi.hoisted(() => vi.fn());

vi.mock('../network/Authenticator', () => ({ doAuthentication: authenticate }));

const AUTH_KEY = new Uint8Array(256).fill(1);
const AUTH_KEY_HASH = new Uint8Array(20).fill(1);
const RETRY_DELAY_MS = 1000;

class StubConnection extends Connection {
  isConnected() {
    return true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('alert', undefined);
  vi.stubGlobal('location', { protocol: 'tauri:', hostname: 'tauri.localhost' });
  vi.stubGlobal('navigator', {
    locks: { request: async (_name: string, callback: () => Promise<void>) => callback() },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  authenticate.mockResolvedValue({
    authKey: new AuthKey(AUTH_KEY, AUTH_KEY_HASH), timeOffset: 0, serverSalt: 1n,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createFixture(dcId: number, hasCachedKey = false) {
  const session = new MemorySession();
  session.setDC(2, 'zws2.web.telegram.org', 443);
  const client = new TelegramClient(session, 1, 'test-only-api-hash', {
    connection: StubConnection,
    fallbackConnection: StubConnection,
  });
  const logger = new Logger('error');
  const authKey = hasCachedKey ? new AuthKey(AUTH_KEY, AUTH_KEY_HASH) : new AuthKey();
  const sender = new MTProtoSender(authKey, {
    logger, dcId, isExported: true,
  } as ConstructorParameters<typeof MTProtoSender>[1]);
  vi.spyOn(sender, '_sendLoop').mockResolvedValue(undefined);
  vi.spyOn(sender, '_recvLoop').mockResolvedValue(undefined);
  const connect = vi.spyOn(sender, 'connect');
  const send = vi.spyOn(sender, 'send').mockResolvedValue(undefined);
  const invoke = vi.spyOn(client, 'invoke').mockResolvedValue(new Api.auth.ExportedAuthorization({
    id: 1n, bytes: new Uint8Array(0),
  }));
  return { client, sender, connect, send, invoke };
}

describe('exported sender authorization', () => {
  test('retries a failed import before resolving a sender with a newly generated key', async () => {
    const fixture = createFixture(4);
    let completeImport: () => void;
    const imported = new Promise<undefined>((resolve) => {
      completeImport = () => resolve(undefined);
    });
    fixture.send.mockRejectedValueOnce(new Error('Transport disconnected during ImportAuthorization'))
      .mockReturnValueOnce(imported);
    const onConnected = vi.fn();
    const connected = fixture.client._connectSender(fixture.sender, 4, 0, true);
    void connected.then(onConnected);

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);

    expect(authenticate).toHaveBeenCalledOnce();
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(onConnected).not.toHaveBeenCalled();
    expect(fixture.connect.mock.calls.map(([connection]) => connection._ip))
      .toEqual(['zws4.web.telegram.org', 'zws4.web.telegram.org']);
    expect(fixture.connect.mock.calls.every(([connection]) => !connection._isPremium)).toBe(true);
    completeImport!();
    await expect(connected).resolves.toBe(fixture.sender);
    expect(fixture.sender._authenticated).toBe(true);
  });

  test('imports authorization for a new exported sender with a cached key', async () => {
    const fixture = createFixture(4, true);

    await expect(fixture.client._connectSender(fixture.sender, 4, 0, true)).resolves.toBe(fixture.sender);

    expect(authenticate).not.toHaveBeenCalled();
    expect(fixture.invoke).toHaveBeenCalledOnce();
    expect(fixture.send).toHaveBeenCalledOnce();
    expect(fixture.connect.mock.calls[0][0]._ip).toBe('zws4-1.web.telegram.org');
    expect(fixture.connect.mock.calls[0][0]._isPremium).toBe(true);
    expect(fixture.sender._authenticated).toBe(true);
  });

  test('does not export authorization when the media sender uses the main DC', async () => {
    const fixture = createFixture(2, true);

    await expect(fixture.client._connectSender(fixture.sender, 2, 0)).resolves.toBe(fixture.sender);

    expect(authenticate).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.connect.mock.calls[0][0]._ip).toBe('zws2-1.web.telegram.org');
  });
});
