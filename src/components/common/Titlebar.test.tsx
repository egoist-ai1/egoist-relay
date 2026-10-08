import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../lib/teact/teact';
import TeactDOM from '../../lib/teact/teact-dom';

import type { AppId } from '../multi/AppSidebar';

import { requestMutation } from '../../lib/fasterdom/fasterdom';
import dragScript from '../../../tauri/vendor/tauri/src/window/scripts/drag.js?raw';

import Titlebar from './Titlebar';

const nativeWindow = vi.hoisted(() => ({
  isMaximized: false,
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  releaseResize: vi.fn(),
  subscribeResize: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../../util/browser/globalEnvironment', () => ({ IS_TAURI: true }));
vi.mock('../../util/browser/windowEnvironment', () => ({ IS_MAC_OS: false }));
vi.mock('./icons/Icon', () => ({ default: () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeWindow.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(nativeWindow.isMaximized),
    onResized: () => {
      nativeWindow.subscribeResize();
      return Promise.resolve(nativeWindow.releaseResize);
    },
    minimize: nativeWindow.minimize,
    toggleMaximize: nativeWindow.toggleMaximize,
    close: nativeWindow.close,
  }),
}));
vi.mock('../../hooks/useLang', async () => {
  const { default: fallback } = await import('../../assets/localization/fallback.strings?raw');
  const strings: Record<string, string> = {};
  for (const match of fallback.matchAll(/^"([^"\n]+)"\s*=\s*("(?:[^"\\]|\\.)*");/gm)) {
    try {
      strings[match[1]] = JSON.parse(match[2]);
    } catch { /* Unused non-JSON Telegram entries */ }
  }
  return { default: () => (key: string) => strings[key] || key };
});

let container: HTMLElement;
const onLoginX = vi.fn();
const onNavigate = vi.fn();
const onToggleOperations = vi.fn();

function renderTitlebar(
  activeApp: AppId = 'telegram',
  isNavigating?: boolean,
  notice?: string,
  isOperationsOpen?: boolean,
  operationCount?: number,
) {
  return new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(createElement(Titlebar, {
        activeApp, isNavigating, notice, isOperationsOpen, operationCount, onToggleOperations,
        canNavigate: true, isXAuthRequired: activeApp === 'x', onLoginX, onNavigate,
      }), container);
      resolve();
    });
  });
}

function getButton(name: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeWindow.isMaximized = false;
  nativeWindow.toggleMaximize.mockImplementation(() => {
    nativeWindow.isMaximized = !nativeWindow.isMaximized;
    return Promise.resolve();
  });
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

describe('Titlebar uses external connectivity without network controls', () => {
  test.each(['telegram', 'x', 'instagram'] as const)(
    '%s has window controls and no network badge, reconnect, VPN or DNS action', async (app) => {
      await renderTitlebar(app);
      expect(container.textContent).not.toMatch(/Локальные службы|DNS|VPN/);
      expect(container.querySelector('[class*="network"]')).toBeNull();
      expect(container.querySelector('[aria-label*="Перезапустить"]')).toBeNull();
      expect(getButton('Свернуть')).toBeInstanceOf(HTMLButtonElement);
      expect(getButton('Развернуть')).toBeInstanceOf(HTMLButtonElement);
      expect(getButton('Close')).toBeInstanceOf(HTMLButtonElement);
      expect(nativeWindow.invoke).not.toHaveBeenCalled();
    },
  );

  test('Retains social navigation and disables it during a pending navigation', async () => {
    await renderTitlebar('instagram');
    for (const name of ['Назад', 'Вперёд', 'Главная', 'Обновить страницу']) getButton(name).click();
    expect(onNavigate.mock.calls.map(([action]) => action)).toEqual(['back', 'forward', 'home', 'reload']);
    await renderTitlebar('instagram', true);
    for (const name of ['Назад', 'Вперёд', 'Главная', 'Обновить страницу']) {
      expect(getButton(name).disabled).toBe(true);
      getButton(name).click();
    }
    expect(onNavigate).toHaveBeenCalledTimes(4);
    expect(nativeWindow.invoke).not.toHaveBeenCalled();
  });

  test('Retains full accessible X login and ordinary operation notices', async () => {
    await renderTitlebar('x', undefined, 'Не удалось сохранить файл');
    const login = getButton('Вход по логину X');
    expect(login.title).toBe('Вход по логину X');
    expect(login.textContent).toContain('Войти');
    login.click();
    expect(onLoginX).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Не удалось сохранить файл');
    expect(nativeWindow.invoke).not.toHaveBeenCalled();
  });

  test('Retains the operations shortcut, expanded state and active count alongside window controls', async () => {
    await renderTitlebar('telegram', undefined, undefined, undefined, 3);
    const operations = getButton('Загрузки и пересылки');
    expect(operations.getAttribute('aria-keyshortcuts')).toBe('Control+J');
    expect(operations.getAttribute('aria-controls')).toBe('relay-media-operations');
    expect(operations.getAttribute('aria-expanded')).toBe('false');
    expect(operations.textContent).toBe('3');
    operations.click();
    expect(onToggleOperations).toHaveBeenCalledTimes(1);
    await renderTitlebar('instagram', undefined, undefined, true, 0);
    expect(getButton('Загрузки и пересылки').getAttribute('aria-expanded')).toBe('true');
    expect(getButton('Загрузки и пересылки').textContent).toBe('');
    expect(getButton('Обновить страницу')).toBeInstanceOf(HTMLButtonElement);
    expect(getButton('Close')).toBeInstanceOf(HTMLButtonElement);
  });

  test('Caption text triggers the shipped drag contract while action buttons retain their own behavior', async () => {
    await renderTitlebar();
    const initialNativeInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    const listenerSpy = vi.spyOn(document, 'addEventListener');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true, value: { invoke: nativeWindow.invoke },
    });
    try {
      runInThisContext(dragScript.replace('__TEMPLATE_os_name__', '\'windows\''));
      const captions = container.querySelectorAll('[class*="brand"], [class*="appTitle"]');
      expect(captions).toHaveLength(2);
      captions.forEach((caption, index) => {
        caption.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true, cancelable: true }));
        expect(nativeWindow.invoke).toHaveBeenNthCalledWith(index + 1, 'plugin:window|start_dragging');
      });
      captions[1].dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true, cancelable: true }));
      expect(nativeWindow.invoke).toHaveBeenNthCalledWith(3, 'plugin:window|internal_toggle_maximize');
      for (const button of container.querySelectorAll('button')) {
        button.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true, cancelable: true }));
      }
      expect(nativeWindow.invoke).toHaveBeenCalledTimes(3);
    } finally {
      for (const [type, listener, options] of listenerSpy.mock.calls) {
        document.removeEventListener(type, listener, options);
      }
      listenerSpy.mockRestore();
      if (initialNativeInternals) Object.defineProperty(window, '__TAURI_INTERNALS__', initialNativeInternals);
      else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  test('Retains minimize, maximize/restore and close through the window API', async () => {
    await renderTitlebar();
    await vi.waitFor(() => expect(nativeWindow.subscribeResize).toHaveBeenCalledTimes(1));
    getButton('Свернуть').click();
    await vi.waitFor(() => expect(nativeWindow.minimize).toHaveBeenCalledTimes(1));
    getButton('Развернуть').click();
    await vi.waitFor(() => expect(getButton('Восстановить')).toBeInstanceOf(HTMLButtonElement));
    getButton('Восстановить').click();
    await vi.waitFor(() => expect(nativeWindow.toggleMaximize).toHaveBeenCalledTimes(2));
    getButton('Close').click();
    await vi.waitFor(() => expect(nativeWindow.close).toHaveBeenCalledTimes(1));
    expect(nativeWindow.minimize).toHaveBeenCalledExactlyOnceWith();
    expect(nativeWindow.close).toHaveBeenCalledExactlyOnceWith();
    expect(nativeWindow.invoke).not.toHaveBeenCalled();
  });
});
