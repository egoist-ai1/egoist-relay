import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { Logger } from '../extensions';
import { Api } from '../tl';
import { Connection } from './connection';

import MTProtoPlainSender from './MTProtoPlainSender';

const EXTERNAL_RESPONSE_TIMEOUT = 15000;
const LOCAL_RESPONSE_TIMEOUT = 45000;
const COLD_RESPONSE_DELAY = 20000;
const PLAIN_HEADER_LENGTH = 20;
const MESSAGE_ID_OFFSET = 8;
const BODY_LENGTH_OFFSET = 16;
const REQUEST_NONCE = 123456789n;
const SERVER_NONCE = 987654321n;
const TIMEOUT_MESSAGE = 'MTProto authentication response timeout';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { protocol: 'http:', hostname: 'tauri.localhost' },
  { protocol: 'tauri:', hostname: 'localhost' },
])('own proxy plain authentication on $protocol//$hostname', (location) => {
  beforeEach(() => {
    vi.stubGlobal('location', location);
  });

  test('keeps an unanswered connection open after 15 seconds and closes exactly at 45 seconds', async () => {
    const { sender, connection } = createSender();
    const request = startRequest(sender);

    await vi.advanceTimersByTimeAsync(EXTERNAL_RESPONSE_TIMEOUT);

    expect(connection.isConnected()).toBe(true);
    expect(connection.disconnect).not.toHaveBeenCalled();
    expect(connection.send).toHaveBeenCalledOnce();
    expect(connection.recv).toHaveBeenCalledOnce();
    expect(request.fulfilled).not.toHaveBeenCalled();
    expect(request.rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LOCAL_RESPONSE_TIMEOUT - EXTERNAL_RESPONSE_TIMEOUT - 1);

    expect(connection.isConnected()).toBe(true);
    expect(request.rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await request.complete;

    expect(connection.isConnected()).toBe(false);
    expect(connection.disconnect).toHaveBeenCalledOnce();
    expect(request.fulfilled).not.toHaveBeenCalled();
    expect(request.rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: TIMEOUT_MESSAGE }));
  });

  test('parses a valid ResPQ arriving after a 20-second cold start and cancels its timeout', async () => {
    const { sender, connection, resolveResponse } = createSender();
    const request = startRequest(sender);

    await vi.advanceTimersByTimeAsync(EXTERNAL_RESPONSE_TIMEOUT);

    expect(connection.isConnected()).toBe(true);
    expect(request.rejected).not.toHaveBeenCalled();
    expect(request.fulfilled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COLD_RESPONSE_DELAY - EXTERNAL_RESPONSE_TIMEOUT);
    resolveResponse(createPlainResponse());
    await request.complete;

    expect(request.fulfilled).toHaveBeenCalledExactlyOnceWith(expect.any(Api.ResPQ));
    expect(request.fulfilled).toHaveBeenLastCalledWith(expect.objectContaining({
      nonce: REQUEST_NONCE,
      serverNonce: SERVER_NONCE,
      pq: new Uint8Array([17, 23]),
      serverPublicKeyFingerprints: [1n],
    }));
    expect(request.rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LOCAL_RESPONSE_TIMEOUT);

    expect(connection.isConnected()).toBe(true);
    expect(connection.disconnect).not.toHaveBeenCalled();
  });
});

describe.each([
  { protocol: 'https:', hostname: 'web.telegram.org', isTestServer: undefined },
  { protocol: 'http:', hostname: 'tauri.localhost', isTestServer: true },
  { protocol: 'tauri:', hostname: 'localhost', isTestServer: true },
])('plain authentication on $protocol//$hostname, test server: $isTestServer', (options) => {
  test('preserves the 15-second authentication response timeout', async () => {
    vi.stubGlobal('location', { protocol: options.protocol, hostname: options.hostname });
    const { sender, connection } = createSender(options.isTestServer);
    const request = startRequest(sender);

    await vi.advanceTimersByTimeAsync(EXTERNAL_RESPONSE_TIMEOUT - 1);

    expect(connection.isConnected()).toBe(true);
    expect(request.rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await request.complete;

    expect(connection.isConnected()).toBe(false);
    expect(connection.disconnect).toHaveBeenCalledOnce();
    expect(request.fulfilled).not.toHaveBeenCalled();
    expect(request.rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: TIMEOUT_MESSAGE }));
  });
});

function createSender(isTestServer?: boolean) {
  const logger = new Logger('error');
  const connection = new Connection({
    ip: 'zws3.web.telegram.org',
    port: 443,
    dcId: 3,
    loggers: logger,
    isTestServer,
  });
  connection._connected = true;
  let resolveResponse!: (response: Uint8Array) => void;
  const response = new Promise<Uint8Array>((resolve) => {
    resolveResponse = resolve;
  });
  vi.spyOn(connection, 'send').mockResolvedValue(undefined);
  vi.spyOn(connection, 'recv').mockReturnValue(response);
  vi.spyOn(connection, 'disconnect').mockImplementation(() => {
    connection._connected = false;
  });
  return { sender: new MTProtoPlainSender(connection, logger), connection, resolveResponse };
}

function startRequest(sender: MTProtoPlainSender) {
  const fulfilled = vi.fn();
  const rejected = vi.fn();
  const complete = sender.send(new Api.ReqPqMulti({ nonce: REQUEST_NONCE })).then(fulfilled, rejected);
  return { complete, fulfilled, rejected };
}

function createPlainResponse() {
  const response = new Api.ResPQ({
    nonce: REQUEST_NONCE,
    serverNonce: SERVER_NONCE,
    pq: new Uint8Array([17, 23]),
    serverPublicKeyFingerprints: [1n],
  }).getBytes();
  const packet = new Uint8Array(PLAIN_HEADER_LENGTH + response.length);
  const header = new DataView(packet.buffer);
  header.setBigInt64(MESSAGE_ID_OFFSET, 1n, true);
  header.setInt32(BODY_LENGTH_OFFSET, response.length, true);
  packet.set(response, PLAIN_HEADER_LENGTH);
  return packet;
}
