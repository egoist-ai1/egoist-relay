import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { routeHealth, RouteRaceError } from '../network/connectionPolicy';

import PromisedWebSockets, { setDesktopTelegramTransport } from './PromisedWebSockets';

const BRIDGE = `ws://127.0.0.1:41000/apiws?token=${'a'.repeat(64)}`;
const HOST = 'zws2.web.telegram.org';
const WSS = `wss://${HOST}:443/apiws`;
const CONNECT_TIMEOUT_MS = 5000;
const PROBE_WINDOW_MS = 60000;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  static CONNECTING = 0;

  static OPEN = 1;

  static CLOSING = 2;

  static CLOSED = 3;

  readyState = 0;

  binaryType = 'blob';

  onopen?: () => void;

  onerror?: (event?: unknown) => void;

  onclose?: (event: { code: number; reason: string; wasClean: boolean }) => void;

  onmessage?: (event: { data: ArrayBuffer }) => void;

  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  fail() {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.({ code: 1006, reason: '', wasClean: false });
  }

  disconnect() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '', wasClean: false });
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  send() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'tauri:', hostname: 'tauri.localhost' });
  vi.stubEnv('VITE_PROXY_URL', '');
  vi.stubEnv('TG_PROXY_URL', '');
  routeHealth.reset();
  setDesktopTelegramTransport(BRIDGE);
});

afterEach(() => {
  setDesktopTelegramTransport(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function create() {
  return new PromisedWebSockets(() => undefined);
}

describe('PromisedWebSockets routes', () => {
  test('connects only to the local proxy without scheduling a wss probe', async () => {
    routeHealth.recordFailure('wss');
    const socket = create();
    const connected = socket.connect(443, HOST, false, false, 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe(`${BRIDGE}&dc=2`);
    FakeWebSocket.instances[0].open();
    await connected;
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closed).toBe(false);
    expect(routeHealth.getStatus()?.kind).toBe('mtproxy');
    socket.close();
  });

  test.each([
    { ip: HOST, dcId: 2, isPremium: false, dc: '2', isMedia: false },
    { ip: 'zws4-1.web.telegram.org', dcId: undefined, isPremium: true, dc: '4', isMedia: true },
    { ip: 'zws4-1.web.telegram.org', dcId: 5, isPremium: false, dc: '5', isMedia: true },
    { ip: '149.154.167.51', dcId: undefined, isPremium: false, dc: '2', isMedia: false },
  ])('preserves local routing arguments for $ip with dcId $dcId', ({ ip, dcId, isPremium, dc, isMedia }) => {
    const candidates = create().getRouteCandidates(ip, 443, false, isPremium, dcId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('mtproxy');
    const url = new URL(candidates[0].url);
    expect(url.origin).toBe('ws://127.0.0.1:41000');
    expect(url.pathname).toBe('/apiws');
    expect(url.searchParams.get('token')).toBe('a'.repeat(64));
    expect(url.searchParams.get('dc')).toBe(dc);
    expect(url.searchParams.has('media')).toBe(isMedia);
    expect(url.searchParams.get('media') ?? undefined).toBe(isMedia ? '1' : undefined);
    expect(url.searchParams.has('premium')).toBe(isPremium);
    expect(url.searchParams.get('premium') ?? undefined).toBe(isPremium ? '1' : undefined);
  });

  test.each(['error', 'close'])('rejects a local proxy %s without opening wss', async (failure) => {
    const socket = create();
    const connected = socket.connect(443, HOST, false, false, 2);
    const assertion = expect(connected).rejects.toBeInstanceOf(RouteRaceError);
    if (failure === 'error') FakeWebSocket.instances[0].fail();
    else FakeWebSocket.instances[0].disconnect();
    await assertion;
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(routeHealth.probeDue('mtproxy', 0)).toBe(true);
    expect(routeHealth.probeDue('wss', 0)).toBe(false);
    const next = create();
    const reconnected = next.connect(443, HOST, false, false, 2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe(`${BRIDGE}&dc=2`);
    FakeWebSocket.instances[1].open();
    await reconnected;
    next.close();
  });

  test('times out the local proxy after five seconds without opening wss', async () => {
    const socket = create();
    const connected = socket.connect(443, HOST, false, false, 2);
    const assertion = expect(connected).rejects.toThrow('WebSocket connection timeout');
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(routeHealth.probeDue('mtproxy', 0)).toBe(true);
    expect(routeHealth.probeDue('wss', 0)).toBe(false);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test.each([
    { bytes: [], hasReceived: false },
    { bytes: [1], hasReceived: true },
  ])('tracks first-byte health when the local proxy closes after $bytes', async ({ bytes, hasReceived }) => {
    const disconnected = vi.fn();
    const socket = new PromisedWebSockets(disconnected);
    const connected = socket.connect(443, HOST, false, false, 2);
    FakeWebSocket.instances[0].open();
    await connected;
    FakeWebSocket.instances[0].onmessage?.({ data: new Uint8Array(bytes).buffer });
    FakeWebSocket.instances[0].disconnect();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(routeHealth.probeDue('mtproxy', 0)).toBe(!hasReceived);
    expect(routeHealth.getStatus()?.kind).toBe(hasReceived ? 'mtproxy' : undefined);
    const next = create();
    const reconnected = next.connect(443, HOST, false, false, 2);
    expect(FakeWebSocket.instances[1].url).toBe(`${BRIDGE}&dc=2`);
    FakeWebSocket.instances[1].open();
    await reconnected;
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
    next.close();
  });

  test('demotes the local proxy when it closes before receiving any message', async () => {
    const socket = create();
    const connected = socket.connect(443, HOST, false, false, 2);
    FakeWebSocket.instances[0].open();
    await connected;
    FakeWebSocket.instances[0].disconnect();
    expect(routeHealth.getStatus()).toBeUndefined();
    expect(routeHealth.probeDue('mtproxy', 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('keeps only the local candidate even when wss was previously healthy', () => {
    routeHealth.recordSuccess('wss');
    const socket = create();
    expect(routeHealth.order(socket.getRouteCandidates(HOST, 443, false, false, 2)))
      .toEqual([{ kind: 'mtproxy', url: `${BRIDGE}&dc=2` }]);
  });

  test('test servers still use wss when the local proxy is available', async () => {
    const socket = create();
    expect(socket.getRouteCandidates(HOST, 443, true, true, 2))
      .toEqual([{ kind: 'wss', url: `${WSS}_test_premium` }]);
    const connected = socket.connect(443, HOST, true, true, 2);
    expect(FakeWebSocket.instances[0].url).toBe(`${WSS}_test_premium`);
    FakeWebSocket.instances[0].open();
    await connected;
    expect(routeHealth.getStatus()?.kind).toBe('wss');
    socket.close();
  });

  test('rejects an unavailable desktop proxy without constructing a WebSocket', async () => {
    setDesktopTelegramTransport(undefined);
    const socket = create();
    expect(socket.getRouteCandidates(HOST, 443)).toEqual([]);
    await expect(socket.connect(443, HOST)).rejects.toBeInstanceOf(RouteRaceError);
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test('browser connections use wss when no desktop proxy is set', async () => {
    setDesktopTelegramTransport(undefined);
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'web.telegram.org' });
    const socket = create();
    expect(socket.getRouteCandidates(HOST, 443)).toEqual([{ kind: 'wss', url: WSS }]);
    const connected = socket.connect(443, HOST);
    expect(FakeWebSocket.instances[0].url).toBe(WSS);
    FakeWebSocket.instances[0].open();
    await connected;
    socket.close();
  });

  test('closing while connecting aborts the local attempt without wss or route failure', async () => {
    const socket = create();
    const connected = socket.connect(443, HOST, false, false, 2);
    const assertion = expect(connected).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(300);
    socket.close();
    await assertion;
    await vi.advanceTimersByTimeAsync(PROBE_WINDOW_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(routeHealth.probeDue('mtproxy', 0)).toBe(false);
    expect(routeHealth.probeDue('wss', 0)).toBe(false);
  });
});
