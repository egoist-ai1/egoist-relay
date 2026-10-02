import { describe, expect, it, vi } from 'vitest';

import initTauriApi from './initTauriApi';

const mocks = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('../browser/windowEnvironment', () => ({ IS_MAC_OS: false }));

describe('Native updater availability', () => {
  it('Does not call an unregistered updater when disabled', async () => {
    mocks.check.mockClear();
    initTauriApi();
    window.tauri.updaterEnabled = false;
    expect(await window.tauri.checkUpdate()).toBeUndefined();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('Returns the configured updater result when enabled', async () => {
    const update = { version: '9.0.0' };
    mocks.check.mockResolvedValue(update);
    window.tauri.updaterEnabled = true;
    initTauriApi();
    expect(await window.tauri.checkUpdate()).toBe(update);
  });

  it('Propagates configured updater failures', async () => {
    mocks.check.mockRejectedValue(new Error('Signature rejected'));
    window.tauri.updaterEnabled = true;
    initTauriApi();
    await expect(window.tauri.checkUpdate()).rejects.toThrow('Signature rejected');
  });
});
