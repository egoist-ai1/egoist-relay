import { afterEach, describe, expect, test } from 'vitest';

import { CHAT_HEIGHT_PX } from '../config';
import { getChatHeightPx } from './chatListMetrics';

afterEach(() => {
  document.documentElement.style.fontSize = '';
});

describe('getChatHeightPx', () => {
  test('keeps the base row height at the default root font size', () => {
    document.documentElement.style.fontSize = '16px';

    expect(getChatHeightPx()).toBe(CHAT_HEIGHT_PX);
  });

  test('scales the row height with the root font size (200% text)', () => {
    document.documentElement.style.fontSize = '32px';

    expect(getChatHeightPx()).toBe(CHAT_HEIGHT_PX * 2);
  });

  test('falls back to the base height when the font size is unknown', () => {
    document.documentElement.style.fontSize = '';

    expect(getChatHeightPx()).toBe(CHAT_HEIGHT_PX);
  });
});
