import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from '../../../lib/teact/teact';
import TeactDOM from '../../../lib/teact/teact-dom';

import type { ApiMessage } from '../../../api/types';

import { requestMutation } from '../../../lib/fasterdom/fasterdom';

import DeletedMessage from './DeletedMessage';

vi.hoisted(() => {
  // The environment helpers read media queries while the modules load
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  (globalThis as { CSS?: unknown }).CSS ??= { supports: () => false };
});

vi.mock('../../../global', () => ({
  getActions: () => ({}),
  getGlobal: () => ({}),
  withGlobal: () => (Component: (props: object) => unknown) => (props: object) => Component({
    ...props, sender: { id: '7', firstName: 'Анна', isMin: false },
  }),
}));
vi.mock('../../../global/selectors', () => ({ selectSender: () => undefined }));
vi.mock('../../common/MessageSummary', () => ({
  default: ({ message }: { message: ApiMessage }) => createElement('span', {}, message.content.text?.text),
}));
vi.mock('../../../util/localization/dateFormat', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../util/localization/dateFormat')>(),
  formatDateTime: (_lang: unknown, _date: Date, options: { date?: string }) => (
    options.date ? 'сегодня в 12:00' : '11:55'
  ),
}));
vi.mock('../../../global/helpers/peers', () => ({ getPeerTitle: () => 'Анна' }));
vi.mock('../../../hooks/useLang', async () => {
  const { default: fallback } = await import('../../../assets/localization/fallback.strings?raw');
  const strings: Record<string, string> = {};
  for (const match of fallback.matchAll(/^"([^"\n]+)"\s*=\s*("(?:[^"\\]|\\.)*");/gm)) {
    try {
      strings[match[1]] = JSON.parse(match[2]);
    } catch { /* Unused non-JSON Telegram entries */ }
  }
  return {
    default: () => (key: string, values: Record<string, string> = {}) => (strings[key] || key)
      .replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? name),
  };
});

const DELETED_AT = 1_800_000_000;
const COPY: ApiMessage = {
  id: 42,
  chatId: '100',
  date: 1_799_999_000,
  isOutgoing: false,
  content: { text: { text: 'Текст удалённого сообщения' } },
  deletedAt: DELETED_AT,
};
const PLACEHOLDER: ApiMessage = {
  id: 43,
  chatId: '100',
  date: 1_799_999_000,
  isOutgoing: false,
  content: {},
  deletedAt: DELETED_AT,
  hasNoDeletedCopy: true,
};

let container: HTMLElement;

function renderRow(message: ApiMessage) {
  return new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(createElement(DeletedMessage, { message }), container);
      resolve();
    });
  });
}

function getButton() {
  return container.querySelector<HTMLButtonElement>('button')!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    requestMutation(() => {
      TeactDOM.render(undefined, container);
      container.remove();
      resolve();
    });
  });
});

describe('DeletedMessage', () => {
  test('renders a collapsed line with the deletion time', async () => {
    await renderRow(COPY);

    expect(container.textContent).toContain('Сообщение удалено');
    expect(container.textContent).toContain('сегодня в 12:00');
    expect(getButton().getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Текст удалённого сообщения');
  });

  test('expands on click and shows the message with the author and the mark', async () => {
    await renderRow(COPY);

    getButton().click();
    await vi.waitFor(() => expect(getButton().getAttribute('aria-expanded')).toBe('true'));

    expect(container.textContent).toContain('Текст удалённого сообщения');
    expect(container.textContent).toContain('Анна');
    expect(container.textContent).toContain('отправлено 11:55');
    expect(container.textContent).toContain('удалено');
    expect(container.querySelector(`#${getButton().getAttribute('aria-controls')}`)).not.toBeNull();
  });

  test('collapses on the second click', async () => {
    await renderRow(COPY);

    getButton().click();
    await vi.waitFor(() => expect(getButton().getAttribute('aria-expanded')).toBe('true'));
    getButton().click();
    await vi.waitFor(() => expect(getButton().getAttribute('aria-expanded')).toBe('false'));

    expect(container.textContent).not.toContain('Текст удалённого сообщения');
  });

  test('does not offer expanding when the content was never saved', async () => {
    await renderRow(PLACEHOLDER);

    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('Сообщение удалено');
  });
});
