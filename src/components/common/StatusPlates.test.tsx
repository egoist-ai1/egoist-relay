import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../lib/teact/teact';
import TeactDOM from '../../lib/teact/teact-dom';

import type { MemoryUsage } from '../../util/tauri/relayMemory';
import type { NetworkStatus } from '../../util/tauri/relayNetwork';

import { requestMutation } from '../../lib/fasterdom/fasterdom';
import { NOT_CONFIGURED_STATUS } from '../../util/tauri/relayNetwork';

import StatusPlates from './StatusPlates';

vi.mock('../../util/browser/globalEnvironment', () => ({ IS_TAURI: true }));
vi.mock('../../hooks/useLang', async () => {
  const { default: fallback } = await import('../../assets/localization/fallback.strings?raw');
  const strings: Record<string, string> = {};
  for (const match of fallback.matchAll(/^"([^"\n]+)"\s*=\s*("(?:[^"\\]|\\.)*");/gm)) {
    try {
      strings[match[1]] = JSON.parse(match[2]);
    } catch { /* Unused non-JSON Telegram entries */ }
  }
  return {
    default: () => (key: string, params?: Record<string, string | number>) => (
      (strings[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
    ),
  };
});

let container: HTMLElement;
const onOpenNetworkSettings = vi.fn();

function renderPlates(network?: NetworkStatus, memory?: MemoryUsage, isInteractive = true) {
  return new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(createElement(StatusPlates, {
        network, memory, onOpenNetworkSettings: isInteractive ? onOpenNetworkSettings : undefined,
      }), container);
      resolve();
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('Status plates of the title bar', () => {
  test('Render nothing until there is a network status or a memory reading', async () => {
    await renderPlates();
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  test('Network plate names the state in text and opens network settings on click', async () => {
    await renderPlates({ ...NOT_CONFIGURED_STATUS, state: 'dnsOnly' });
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('Только DNS');
    expect(button.getAttribute('aria-label')).toBe('Сеть: Только DNS. Открыть настройки сети');
    expect(button.dataset.level).toBe('warn');
    button.click();
    expect(onOpenNetworkSettings).toHaveBeenCalledTimes(1);
  });

  test('Network plate is inert without a handler (screen lock)', async () => {
    await renderPlates({ ...NOT_CONFIGURED_STATUS, state: 'tunnel' }, undefined, false);
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  });

  test('Down state uses its own level, not only a different colour', async () => {
    await renderPlates({ ...NOT_CONFIGURED_STATUS, state: 'down' });
    expect(container.querySelector<HTMLButtonElement>('button')!.dataset.level).toBe('down');
  });

  test('Memory plate shows megabytes and gigabytes with the process count in the tooltip', async () => {
    await renderPlates(undefined, { bytes: 1536 * 1024 * 1024, processes: 14 });
    const plate = container.querySelector<HTMLElement>('[role="status"]')!;
    expect(plate.textContent).toBe('1,5 ГБ');
    expect(plate.title).toBe('Память приложения: 1,5 ГБ, процессов: 14');
    await renderPlates(undefined, { bytes: 300 * 1024 * 1024, processes: 6 });
    expect(container.querySelector('[role="status"]')!.textContent).toBe('300 МБ');
  });
});
