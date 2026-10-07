import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: true, handleError: vi.fn() }));

vi.mock('../browser/globalEnvironment', () => ({
  get IS_TAURI() {
    return native.isTauri;
  },
}));
vi.mock('../handleError', () => ({ handleError: native.handleError }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function load() {
  vi.resetModules();
  return import('./nativeTheme');
}

describe('syncNativeTheme', () => {
  beforeEach(() => {
    native.isTauri = true;
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(undefined);
    native.handleError.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('sends the colour and the theme flag to relay_set_theme', async () => {
    const { syncNativeTheme } = await load();
    syncNativeTheme('#F5F5F2', false);
    await flush();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith('relay_set_theme', { background: '#F5F5F2', isDark: false });
    expect(native.handleError).not.toHaveBeenCalled();
  });

  it('does nothing outside Tauri', async () => {
    native.isTauri = false;
    const { syncNativeTheme } = await load();
    syncNativeTheme('#0E0E0F', true);
    await flush();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '#FFF', '#0E0E0F80', 'rgba(14, 14, 15, 1)', 'var(--bg)', '0E0E0F', '#GGGGGG', ' #0E0E0F'])(
    'skips a value that is not #RRGGBB: %s',
    async (value) => {
      const { syncNativeTheme } = await load();
      syncNativeTheme(value, true);
      await flush();
      expect(native.invoke).not.toHaveBeenCalled();
    },
  );

  it('does not repeat an identical successful call but sends a changed one', async () => {
    const { syncNativeTheme } = await load();
    syncNativeTheme('#0E0E0F', true);
    syncNativeTheme('#0e0e0f', true);
    await flush();
    syncNativeTheme('#0E0E0F', true);
    syncNativeTheme('#F5F5F2', false);
    await flush();
    expect(native.invoke.mock.calls.map((call) => call[1])).toEqual([
      { background: '#0E0E0F', isDark: true },
      { background: '#F5F5F2', isDark: false },
    ]);
  });

  it('logs a failure through handleError without throwing and retries next time', async () => {
    native.invoke.mockRejectedValueOnce('Background must be #RRGGBB');
    const { syncNativeTheme } = await load();
    expect(() => syncNativeTheme('#0E0E0F', true)).not.toThrow();
    await flush();
    expect(native.handleError).toHaveBeenCalledTimes(1);
    expect(native.handleError.mock.calls[0][0]).toBeInstanceOf(Error);

    syncNativeTheme('#0E0E0F', true);
    await flush();
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });
});

describe('applyAntigravityTheme', () => {
  beforeEach(() => {
    native.isTauri = true;
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(undefined);
    native.handleError.mockReset();
  });

  it('syncs the Lagom background and base of the selected theme to the native shell', async () => {
    vi.resetModules();
    const { applyAntigravityTheme } = await import('../antigravityThemes');
    applyAntigravityTheme('lagom-light');
    await flush();
    expect(native.invoke).toHaveBeenCalledWith('relay_set_theme', { background: '#F5F5F2', isDark: false });

    applyAntigravityTheme('lagom-dark');
    await flush();
    expect(native.invoke).toHaveBeenLastCalledWith('relay_set_theme', { background: '#0E0E0F', isDark: true });
  });
});
