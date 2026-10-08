import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { routeHealth } from '../network/connectionPolicy';

import PromisedWebSockets, { setDesktopTelegramTransport } from './PromisedWebSockets';

const BRIDGE = `ws://127.0.0.1:41000/apiws?token=${'a'.repeat(64)}`;

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
  routeHealth.reset();
  setDesktopTelegramTransport(BRIDGE);
});

afterEach(() => {
  setDesktopTelegramTransport(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function create() {
  return new PromisedWebSockets(() => undefined);
}

describe('PromisedWebSockets routes', () => {
  test('uses the Lagom bridge when it opens and never touches the direct route', async () => {
    const socket = create();
    const connected = socket.connect(443, 'zws2.web.telegram.org', false, false, 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain('127.0.0.1:41000');
    expect(FakeWebSocket.instances[0].url).toContain('dc=2');
    FakeWebSocket.instances[0].open();
    await connected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(routeHealth.getStatus()?.kind).toBe('lagom');
  });

  test('fails over to the direct route immediately when the bridge refuses', async () => {
    const socket = create();
    const connected = socket.connect(443, 'zws2.web.telegram.org', false, false, 2);
    FakeWebSocket.instances[0].fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe('wss://zws2.web.telegram.org:443/apiws');
    FakeWebSocket.instances[1].open();
    await connected;
    expect(routeHealth.getStatus()?.kind).toBe('direct');
    // Следующее подключение сразу начинает с прямого маршрута, а Lagom проверяется в фоне
    const next = create();
    void next.connect(443, 'zws2.web.telegram.org', false, false, 2).catch(() => undefined);
    expect(FakeWebSocket.instances[2].url).toBe('wss://zws2.web.telegram.org:443/apiws');
  });

  test('races the direct route when the bridge is silent and closes the loser', async () => {
    const socket = create();
    const connected = socket.connect(443, 'zws2.web.telegram.org', false, false, 2);
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    await connected;
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(FakeWebSocket.instances[1].closed).toBe(false);
  });

  test('rejects when both routes fail and demotes both', async () => {
    const socket = create();
    const connected = socket.connect(443, 'zws2.web.telegram.org', false, false, 2);
    const assertion = expect(connected).rejects.toBeInstanceOf(Error);
    FakeWebSocket.instances[0].fail();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[1].fail();
    await assertion;
  });

  test('a bridge socket closed before any byte demotes the Lagom route for the next connection', async () => {
    const socket = create();
    const connected = socket.connect(443, 'zws2.web.telegram.org', false, false, 2);
    FakeWebSocket.instances[0].open();
    await connected;
    FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: '', wasClean: false });
    const next = create();
    void next.connect(443, 'zws2.web.telegram.org', false, false, 2).catch(() => undefined);
    expect(FakeWebSocket.instances[1].url).toBe('wss://zws2.web.telegram.org:443/apiws');
  });

  test('test servers and a missing bridge use only the official route', () => {
    const socket = create();
    expect(socket.getRouteCandidates('zws2.web.telegram.org', 443, true).map(({ kind }) => kind)).toEqual(['direct']);
    setDesktopTelegramTransport(undefined);
    expect(socket.getRouteCandidates('zws2.web.telegram.org', 443).map(({ kind }) => kind)).toEqual(['direct']);
  });

  test('closing during the race aborts both attempts without errors', async () => {
    const socket = create();
    const connected = socket.connect(443, 'zws2.web.telegram.org', false, false, 2);
    const assertion = expect(connected).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(300);
    socket.close();
    await assertion;
    expect(FakeWebSocket.instances.every((instance) => instance.closed)).toBe(true);
  });
});
