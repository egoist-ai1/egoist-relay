import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebAppOutboundEvent } from '../../types/webapp';

import { createNativeWebAppFrame, isNativeFrameCovered, shouldUseNativeWebApp } from './botWebApps';
const native = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: {
  payload: any;
}) => void>(),
releases: [] as ReturnType<typeof vi.fn>[] }));
vi.mock('../browser/globalEnvironment', () => ({ IS_TAURI: true }));
vi.mock('../browser/windowEnvironment', () => ({ IS_WINDOWS: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn((name, callback) => {
  native.listeners.set(name, callback);
  const release = vi.fn(() => native.listeners.delete(name));
  native.releases.push(release);
  return Promise.resolve(release);
}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  innerSize: () => Promise.resolve({ width: 800, height: 560 }), scaleFactor: () => Promise.resolve(1),
}) }));
let scheduled: FrameRequestCallback[];
async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    scheduled.splice(0).forEach((callback) => callback(0));
  }
}
function setup() {
  document.body.innerHTML = '<div class="Modal open"><iframe></iframe></div>';
  const frame = document.querySelector('iframe')!;
  frame.getBoundingClientRect = () => ({ x: 72, y: 80, width: 320, height: 400 } as DOMRect);
  let visible = true;
  const options = { isVisible: () => visible, onMessage: vi.fn(), onLoad: vi.fn(), onError: vi.fn(),
    onEscape: vi.fn(), onDownloads: vi.fn() };
  const adapter = createNativeWebAppFrame(frame, 'https://shop.example/#tgWebAppData=synthetic', options);
  return { frame, options, adapter, setVisible: (value: boolean) => {
    visible = value;
  } };
}
function event(id: string, kind: string, data?: string) {
  native.listeners.get('relay-mini-app-event')?.({ payload: { id, kind, data } });
}
function openedId() {
  return native.invoke.mock.calls.find(([command]) => command === 'relay_mini_app_open')![1].id;
}
beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(undefined);
  native.listeners.clear();
  native.releases.splice(0);
  scheduled = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    scheduled.push(callback);
    return scheduled.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    disconnect = vi.fn();
  });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 560, configurable: true });
  document.documentElement.dataset.relayActiveApp = 'telegram';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
describe('Windows Mini App native host', () => {
  it('accepts credential-free HTTPS Mini Apps only', () => {
    expect(shouldUseNativeWebApp('https://shop.example/#tgWebAppData=synthetic')).toBe(true);
    for (const url of [undefined, 'http://shop.example', 'https://user:secret@shop.example',
      'javascript:alert(1)', 'invalid']) {
      expect(shouldUseNativeWebApp(url)).toBe(false);
    }
  });
  it('keeps native content behind other modals and services', () => {
    document.body.innerHTML = '<div class="Modal open"><iframe></iframe></div>';
    const frame = document.querySelector('iframe')!;
    expect(isNativeFrameCovered(frame)).toBe(false);
    document.body.insertAdjacentHTML('beforeend', '<div class="Modal open"></div>');
    expect(isNativeFrameCovered(frame)).toBe(true);
    document.body.lastElementChild!.remove();
    document.documentElement.dataset.relayActiveApp = 'x';
    expect(isNativeFrameCovered(frame)).toBe(true);
  });
  it('preserves source fragments, waits for load and routes only its own session events', async () => {
    const { adapter, options } = setup();
    adapter.sendEvent({ eventType: 'theme_changed', eventData: { theme_params: {} } } as WebAppOutboundEvent);
    await flush();
    const id = openedId();
    expect(native.invoke.mock.calls.find(([command]) => command === 'relay_mini_app_open')![1].url)
      .toBe('https://shop.example/#tgWebAppData=synthetic');
    expect(native.invoke.mock.calls.filter(([command]) => command === 'relay_mini_app_send')).toHaveLength(0);
    event('foreign-session', 'event', 'foreign');
    event(id, 'event', '{"eventType":"web_app_ready"}');
    expect(options.onMessage).toHaveBeenCalledOnce();
    event(id, 'loaded');
    await flush();
    expect(native.invoke.mock.calls.some(([command]) => command === 'relay_mini_app_send')).toBe(true);
    expect(native.invoke.mock.calls.some(([command, args]) => command === 'relay_mini_app_update'
      && args.visible)).toBe(true);
    adapter.dispose();
    await flush();
    event(id, 'event', 'late');
    expect(options.onMessage).toHaveBeenCalledOnce();
    expect(native.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'relay_mini_app_close')).toHaveLength(1);
  });
  it('hides and restores without recreating the native document; shortcuts only reach the active tab', async () => {
    const { adapter, options, setVisible } = setup();
    await flush();
    const id = openedId();
    event(id, 'loaded');
    await flush();
    event(id, 'escape');
    native.listeners.get('relay-media-toggle')?.({ payload: {} });
    expect(options.onEscape).toHaveBeenCalledOnce();
    expect(options.onDownloads).toHaveBeenCalledOnce();
    setVisible(false);
    adapter.update();
    await flush();
    event(id, 'escape');
    native.listeners.get('relay-media-toggle')?.({ payload: {} });
    expect(options.onEscape).toHaveBeenCalledOnce();
    expect(options.onDownloads).toHaveBeenCalledOnce();
    expect(native.invoke.mock.calls.at(-1)![1].visible).toBe(false);
    setVisible(true);
    adapter.update();
    await flush();
    expect(native.invoke.mock.calls.at(-1)![1].visible).toBe(true);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'relay_mini_app_open')).toHaveLength(1);
    adapter.dispose();
    await flush();
  });
  it('mounts inactive frames with hidden minimal bounds and shows them after measurement', async () => {
    const { adapter, frame, setVisible, options } = setup();
    setVisible(false);
    frame.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 } as DOMRect);
    await flush();
    const id = openedId();
    expect(native.invoke.mock.calls.find(([command]) => command === 'relay_mini_app_open')![1].bounds)
      .toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(options.onError).not.toHaveBeenCalled();
    event(id, 'loaded');
    await flush();
    expect(native.invoke.mock.calls.at(-1)![1].visible).toBe(false);
    frame.getBoundingClientRect = () => ({ x: 72, y: 80, width: 320, height: 400 } as DOMRect);
    setVisible(true);
    adapter.update();
    await flush();
    expect(native.invoke.mock.calls.at(-1)![1].visible).toBe(true);
    adapter.dispose();
    await flush();
  });
  it('closes a late native creation exactly once and drops pending commands', async () => {
    let complete!: () => void;
    native.invoke.mockImplementation((command) => command === 'relay_mini_app_open'
      ? new Promise<void>((resolve) => {
        complete = resolve;
      }) : Promise.resolve());
    const { adapter, options } = setup();
    await flush();
    const id = openedId();
    adapter.dispose();
    adapter.reload('https://shop.example/new');
    complete();
    await flush();
    event(id, 'loaded');
    expect(options.onLoad).not.toHaveBeenCalled();
    expect(native.invoke.mock.calls.filter(([command]) => command === 'relay_mini_app_close')).toHaveLength(1);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'relay_mini_app_reload')).toHaveLength(0);
  });
  it('reports one load error and allows a manual reload', async () => {
    const { adapter, options } = setup();
    await flush();
    const id = openedId();
    event(id, 'error');
    event(id, 'error');
    expect(options.onError).toHaveBeenCalledOnce();
    adapter.reload('https://shop.example/retry');
    await flush();
    expect(native.invoke.mock.calls.some(([command, args]) => command === 'relay_mini_app_reload'
      && args.url === 'https://shop.example/retry')).toBe(true);
    event(id, 'error');
    expect(options.onError).toHaveBeenCalledTimes(2);
    adapter.dispose();
    await flush();
  });
});
