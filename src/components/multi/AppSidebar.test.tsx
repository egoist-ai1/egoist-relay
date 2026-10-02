import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../lib/teact/teact';
import TeactDOM from '../../lib/teact/teact-dom';

import { requestMutation } from '../../lib/fasterdom/fasterdom';

import AppSidebar from './AppSidebar';

vi.mock('../../hooks/useLang', () => ({ default: () => (key: string) => key }));

let container: HTMLElement;
const onSelectApp = vi.fn();

function renderSidebar(xAppState: 'ready' | 'loading' | 'error' | 'auth-required' = 'ready') {
  return new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(createElement(AppSidebar, {
        activeApp: 'telegram', xAppState, instagramAppState: 'ready', onSelectApp,
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
    const label = instagram.querySelector<HTMLElement>('span:last-child')!;
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
