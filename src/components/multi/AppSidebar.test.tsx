import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../lib/teact/teact';
import TeactDOM from '../../lib/teact/teact-dom';

import type { AppId, InstagramAppState, XAppState } from './AppSidebar';

import { requestMutation } from '../../lib/fasterdom/fasterdom';

import AppSidebar from './AppSidebar';

vi.mock('../../hooks/useLang', () => ({ default: () => (key: string) => key }));

let container: HTMLElement;
const onSelectApp = vi.fn();
const onOpenSettings = vi.fn();

function renderSidebar(
  xAppState: XAppState = 'ready',
  activeApp: AppId = 'telegram',
  instagramAppState: InstagramAppState = 'ready',
  hiddenApps?: AppId[],
) {
  return new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(createElement(AppSidebar, {
        activeApp, xAppState, instagramAppState, hiddenApps, onSelectApp, onOpenSettings,
      }), container);
      resolve();
    });
  });
}

function getAppButton(app: string) {
  return container.querySelector<HTMLButtonElement>(`[data-relay-app="${app}"]`)!;
}

function pressNavigationKey(button: HTMLButtonElement, key: string) {
  button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  onSelectApp.mockClear();
  onOpenSettings.mockClear();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => new Promise<void>((resolve) => {
  requestMutation(() => {
    TeactDOM.render(undefined, container);
    container.remove();
    resolve();
  });
}));

describe('AppSidebar complete navigation tile', () => {
  test('Icon-only rail keeps an accessible name and tooltip for every service', async () => {
    await renderSidebar();
    for (const [app, title] of [['telegram', 'RelayTelegramTitle'], ['x', 'RelayXTitle'],
      ['instagram', 'RelayInstagramTitle']]) {
      const button = getAppButton(app);
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.title).toBe(title);
      expect(button.querySelector('[class*="stateDot"]')).toBeNull();
    }
    getAppButton('instagram').click();
    expect(onSelectApp).toHaveBeenCalledExactlyOnceWith('instagram');
    expect(getAppButton('telegram').getAttribute('aria-current')).toBe('page');
  });

  test('A sleeping service shows the sleep mark, but loading and errors win over sleep', async () => {
    await new Promise<void>((resolve) => {
      requestMutation(() => {
        TeactDOM.render(createElement(AppSidebar, {
          activeApp: 'telegram',
          xAppState: 'ready',
          instagramAppState: 'error',
          sleepingApps: ['x', 'instagram'],
          onSelectApp,
        }), container);
        resolve();
      });
    });
    const x = getAppButton('x');
    expect(x.dataset.relayIndicator).toBe('sleep');
    expect(x.getAttribute('aria-label')).toContain('RelayServiceSleeping');
    expect(getAppButton('instagram').dataset.relayIndicator).toBe('error');
    x.click();
    expect(onSelectApp).toHaveBeenCalledExactlyOnceWith('x');
  });

  test('A sleeping service tooltip names the time it fell asleep', async () => {
    await new Promise<void>((resolve) => {
      requestMutation(() => {
        TeactDOM.render(createElement(AppSidebar, {
          activeApp: 'telegram',
          xAppState: 'ready',
          instagramAppState: 'ready',
          sleepingApps: ['x', 'instagram'],
          sleepingSince: { x: new Date(2026, 9, 25, 14, 32).getTime() },
          onSelectApp,
        }), container);
        resolve();
      });
    });
    // С известным временем подпись берётся из ключа с временем, без него остаётся общая
    expect(getAppButton('x').title).toBe('RelayXTitle · RelayServiceSleepingSince');
    expect(getAppButton('instagram').title).toBe('RelayInstagramTitle · RelayServiceSleeping');
  });

  test('Unavailable network route shows the error dot, direct stays quiet', async () => {
    await new Promise<void>((resolve) => {
      requestMutation(() => {
        TeactDOM.render(createElement(AppSidebar, {
          activeApp: 'telegram',
          xAppState: 'ready',
          instagramAppState: 'ready',
          networkRoutes: { telegram: 'tunnel', x: 'unavailable', instagram: 'direct' },
          onSelectApp,
        }), container);
        resolve();
      });
    });
    const x = getAppButton('x');
    expect(x.dataset.relayIndicator).toBe('error');
    expect(x.getAttribute('aria-label')).toContain('RelayNetRailUnavailable');
    expect(x.querySelector('[class*="stateDotError"]')).not.toBeNull();
    const instagram = getAppButton('instagram');
    expect(instagram.dataset.relayIndicator).toBeUndefined();
    expect(instagram.getAttribute('aria-label')).toContain('RelayNetRailDirect');
    expect(getAppButton('telegram').dataset.relayIndicator).toBeUndefined();
  });

  test('Arrow keys wrap and Home/End retain the current app until activation', async () => {
    await renderSidebar();
    const telegram = getAppButton('telegram');
    const instagram = getAppButton('instagram');
    telegram.focus();
    pressNavigationKey(telegram, 'ArrowUp');
    expect(document.activeElement).toBe(instagram);
    pressNavigationKey(instagram, 'ArrowDown');
    expect(document.activeElement).toBe(telegram);
    pressNavigationKey(telegram, 'End');
    expect(document.activeElement).toBe(instagram);
    pressNavigationKey(instagram, 'Home');
    expect(document.activeElement).toBe(telegram);
    expect(onSelectApp).not.toHaveBeenCalled();
  });

  test('Hidden services are not rendered and Telegram cannot be hidden', async () => {
    await renderSidebar('ready', 'telegram', 'ready', ['x', 'telegram']);
    expect(container.querySelector('[data-relay-app="x"]')).toBeNull();
    expect(getAppButton('telegram')).not.toBeNull();
    expect(getAppButton('instagram')).not.toBeNull();
  });

  test('Settings button opens app settings and stays out of service navigation', async () => {
    await renderSidebar('ready', 'telegram', 'ready', ['x', 'instagram']);
    const settings = container.querySelector<HTMLButtonElement>('[data-relay-settings]')!;
    expect(settings.getAttribute('aria-label')).toBe('RelayAppSettingsOpen');
    settings.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onSelectApp).not.toHaveBeenCalled();
    const telegram = getAppButton('telegram');
    telegram.focus();
    pressNavigationKey(telegram, 'ArrowDown');
    expect(document.activeElement).toBe(telegram);
  });

  test('Keyboard navigation wraps over the visible services only', async () => {
    await renderSidebar('ready', 'telegram', 'ready', ['x']);
    const telegram = getAppButton('telegram');
    const instagram = getAppButton('instagram');
    telegram.focus();
    pressNavigationKey(telegram, 'ArrowDown');
    expect(document.activeElement).toBe(instagram);
    pressNavigationKey(instagram, 'ArrowDown');
    expect(document.activeElement).toBe(telegram);
    pressNavigationKey(telegram, 'End');
    expect(document.activeElement).toBe(instagram);
    pressNavigationKey(instagram, 'ArrowUp');
    expect(document.activeElement).toBe(telegram);
    pressNavigationKey(telegram, 'Home');
    expect(document.activeElement).toBe(telegram);
  });

  test.each(['telegram', 'x', 'instagram'] as const)(
    'Preserves the selected %s pane relationship after switching services', async (activeApp) => {
      await renderSidebar('ready', activeApp);
      for (const app of ['telegram', 'x', 'instagram']) {
        const button = getAppButton(app);
        expect(button.getAttribute('aria-controls')).toBe(`relay-${app}-pane`);
        expect(button.hasAttribute('aria-pressed')).toBe(false);
        expect(button.tabIndex).toBe(app === activeApp ? 0 : -1);
        if (app === activeApp) expect(button.getAttribute('aria-current')).toBe('page');
        else expect(button.getAttribute('aria-current')).toBeNull();
      }
    },
  );

  test.each([
    ['loading', 'RelayInstagramLoadingTitle', 'true'],
    ['error', 'RelayInstagramErrorTitle', 'false'],
  ] as const)('Exposes Instagram %s without losing its service action', async (state, title, busy) => {
    await renderSidebar('ready', 'telegram', state);
    const button = getAppButton('instagram');
    expect(button.getAttribute('aria-label')).toContain(title);
    expect(button.getAttribute('aria-busy')).toBe(busy);
    expect(button.disabled).toBe(false);
    button.click();
    expect(onSelectApp).toHaveBeenCalledExactlyOnceWith('instagram');
  });

  test.each([
    ['loading', 'RelayXLoadingTitle', 'true'],
    ['error', 'RelayXErrorTitle', 'false'],
    ['auth-required', 'RelayXDirectLoginTitle', 'false'],
  ] as const)('Exposes %s in the accessible name without disabling navigation', async (state, title, busy) => {
    await renderSidebar(state);
    const button = getAppButton('x');
    expect(button.getAttribute('aria-label')).toContain(title);
    expect(button.getAttribute('aria-busy')).toBe(busy);
    expect(button.disabled).toBe(false);
    button.click();
    expect(onSelectApp).toHaveBeenCalledExactlyOnceWith('x');
  });
});
