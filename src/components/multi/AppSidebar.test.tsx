import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../lib/teact/teact';
import TeactDOM from '../../lib/teact/teact-dom';

import type { AppId, InstagramAppState, XAppState } from './AppSidebar';

import { requestMutation } from '../../lib/fasterdom/fasterdom';

import AppSidebar from './AppSidebar';

vi.mock('../../hooks/useLang', () => ({ default: () => (key: string) => key }));

let container: HTMLElement;
const onSelectApp = vi.fn();

function renderSidebar(
  xAppState: XAppState = 'ready',
  activeApp: AppId = 'telegram',
  instagramAppState: InstagramAppState = 'ready',
) {
  return new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(createElement(AppSidebar, {
        activeApp, xAppState, instagramAppState, onSelectApp,
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
  test('The visible label activates the same control as its icon', async () => {
    await renderSidebar();
    const instagram = getAppButton('instagram');
    const label = instagram.querySelector<HTMLElement>('[class*="appLabel"]')!;
    expect(label.textContent).toBe('RelayInstagramTitle');
    label.click();
    expect(onSelectApp).toHaveBeenCalledExactlyOnceWith('instagram');
    expect(getAppButton('telegram').getAttribute('aria-current')).toBe('page');
    expect(instagram.getAttribute('aria-current')).toBeNull();
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
