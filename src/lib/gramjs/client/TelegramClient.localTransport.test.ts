import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import MemorySession from '../sessions/Memory';
import TelegramClient from './TelegramClient';

const senderMocks = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../network/MTProtoSender', () => ({
  default: class {
    constructor(authKey: unknown, options: unknown) {
      senderMocks.create(authKey, options);
    }

    connect = senderMocks.connect;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  senderMocks.connect.mockResolvedValue(false);
  vi.stubGlobal('alert', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createClient(shouldEnableHttpTransport = false) {
  const session = new MemorySession();
  session.setDC(2, 'zws2.web.telegram.org', 443);
  const client = new TelegramClient(session, 1, 'test-only-api-hash', {
    useWSS: true,
    shouldAllowHttpTransport: shouldEnableHttpTransport,
    shouldForceHttpTransport: shouldEnableHttpTransport,
  });
  vi.spyOn(client, '_updateLoop').mockResolvedValue(undefined);
  vi.spyOn(client, 'disconnect').mockImplementation(() => {});
  return client;
}

function expectSenderTransport(shouldForceHttpTransport: boolean, shouldAllowHttpTransport: boolean) {
  expect(senderMocks.create).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
    shouldForceHttpTransport,
    shouldAllowHttpTransport,
  }));
}

describe.each([
  { protocol: 'tauri:', hostname: 'localhost' },
  { protocol: 'http:', hostname: 'tauri.localhost' },
])('Telegram local transport on $protocol//$hostname', (location) => {
  test('does not pass initially enabled HTTP transports to the sender', async () => {
    vi.stubGlobal('location', location);
    const client = createClient(true);

    await client.connect();

    expect(senderMocks.connect).toHaveBeenCalledOnce();
    expectSenderTransport(false, false);
  });

  test('runtime settings cannot enable HTTP on a newly connected sender', async () => {
    vi.stubGlobal('location', location);
    const client = createClient();

    await client.setAllowHttpTransport(true);
    expectSenderTransport(false, false);
    await client.setForceHttpTransport(true);
    expectSenderTransport(false, false);
    expect(senderMocks.connect).toHaveBeenCalledTimes(2);
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });
});

describe('Telegram browser transport', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'web.telegram.org' });
  });

  test('preserves initially enabled HTTP transports on the sender', async () => {
    const client = createClient(true);

    await client.connect();

    expectSenderTransport(true, true);
  });

  test('preserves runtime HTTP settings when reconnecting the sender', async () => {
    const client = createClient();

    await client.setAllowHttpTransport(true);
    expectSenderTransport(false, true);
    await client.setForceHttpTransport(true);
    expectSenderTransport(true, true);
    expect(senderMocks.connect).toHaveBeenCalledTimes(2);
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });
});
