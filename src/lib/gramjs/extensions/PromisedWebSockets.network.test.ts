import { afterEach, describe, expect, it, vi } from 'vitest';

import PromisedWebSockets from './PromisedWebSockets';

afterEach(() => {
  window.localStorage.removeItem('egoist_relay_proxy');
  vi.unstubAllGlobals();
});

describe('desktop Telegram network inheritance', () => {
  it.each([
    { protocol: 'tauri:', hostname: 'localhost' },
    { protocol: 'http:', hostname: 'tauri.localhost' },
  ])('uses official WSS despite the retired saved bridge on $hostname', (location) => {
    window.localStorage.setItem('egoist_relay_proxy', 'ws://127.0.0.1:17884');
    vi.stubGlobal('location', location);
    vi.stubGlobal('name', 'relayProxyPort=19544');
    const socket = new PromisedWebSockets(vi.fn());

    expect(socket.getWebSocketLink('zws2.web.telegram.org', 443, true, true, 2))
      .toBe('wss://zws2.web.telegram.org:443/apiws_test_premium');
  });

  it('preserves the explicit browser-development proxy outside the desktop app', () => {
    window.localStorage.setItem('egoist_relay_proxy', 'ws://localhost:9000');
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'web.telegram.org' });
    const socket = new PromisedWebSockets(vi.fn());

    expect(socket.getWebSocketLink('zws4-1.web.telegram.org', 443, false, false, 4))
      .toBe('ws://localhost:9000/apiws?dc=4&media=1');
  });
});
