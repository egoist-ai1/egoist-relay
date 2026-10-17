import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PromisedWebSockets, { setDesktopTelegramTransport } from './PromisedWebSockets';

const BRIDGE = `ws://127.0.0.1:41000/apiws?token=${'a'.repeat(64)}`;

beforeEach(() => {
  vi.stubEnv('VITE_PROXY_URL', '');
  vi.stubEnv('TG_PROXY_URL', '');
});

afterEach(() => {
  setDesktopTelegramTransport(undefined);
  window.localStorage.removeItem('egoist_relay_proxy');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('desktop Telegram network isolation', () => {
  it.each([
    { protocol: 'tauri:', hostname: 'localhost' },
    { protocol: 'http:', hostname: 'tauri.localhost' },
  ])('requires the native local proxy despite a retired saved bridge on $hostname', (location) => {
    window.localStorage.setItem('egoist_relay_proxy', 'ws://127.0.0.1:17884');
    vi.stubGlobal('location', location);
    vi.stubGlobal('name', 'relayProxyPort=19544');
    const socket = new PromisedWebSockets(vi.fn());

    expect(socket.getRouteCandidates('zws2.web.telegram.org', 443, false, true, 2)).toEqual([]);
    expect(() => socket.getWebSocketLink('zws2.web.telegram.org', 443, false, true, 2))
      .toThrow('Local Telegram proxy is unavailable');
  });

  it.each([
    { protocol: 'tauri:', hostname: 'localhost' },
    { protocol: 'http:', hostname: 'tauri.localhost' },
  ])('uses the native local proxy instead of a saved browser proxy on $hostname', (location) => {
    window.localStorage.setItem('egoist_relay_proxy', 'ws://localhost:9000');
    vi.stubGlobal('location', location);
    setDesktopTelegramTransport(BRIDGE);
    const socket = new PromisedWebSockets(vi.fn());

    expect(socket.getWebSocketLink('zws4-1.web.telegram.org', 443, false, true, 4))
      .toBe(`${BRIDGE}&dc=4&media=1&premium=1`);
  });

  it.each([undefined, BRIDGE])('preserves official WSS for explicit test servers with proxy %s', (bridge) => {
    vi.stubGlobal('location', { protocol: 'tauri:', hostname: 'tauri.localhost' });
    setDesktopTelegramTransport(bridge);
    const socket = new PromisedWebSockets(vi.fn());

    expect(socket.getRouteCandidates('zws2.web.telegram.org', 443, true, true, 2))
      .toEqual([{ kind: 'wss', url: 'wss://zws2.web.telegram.org:443/apiws_test_premium' }]);
  });

  it('uses official WSS in the browser without a desktop proxy', () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'web.telegram.org' });
    const socket = new PromisedWebSockets(vi.fn());

    expect(socket.getWebSocketLink('zws2.web.telegram.org', 443, false, true, 2))
      .toBe('wss://zws2.web.telegram.org:443/apiws_premium');
  });

  it('preserves the explicit browser-development proxy outside the desktop app', () => {
    window.localStorage.setItem('egoist_relay_proxy', 'ws://localhost:9000');
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'web.telegram.org' });
    const socket = new PromisedWebSockets(vi.fn());

    expect(socket.getWebSocketLink('zws4-1.web.telegram.org', 443, false, false, 4))
      .toBe('ws://localhost:9000/apiws?dc=4&media=1');
  });
});
