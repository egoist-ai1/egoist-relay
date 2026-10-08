import { afterEach, describe, expect, test } from 'vitest';

import { CHAT_HEIGHT_PX, PEER_PICKER_ITEM_HEIGHT_PX } from '../config';
import { getChatHeightPx, getPeerPickerItemHeightPx } from './chatListMetrics';

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

describe('getPeerPickerItemHeightPx', () => {
  test('scales the picker row pitch with the root font size', () => {
    document.documentElement.style.fontSize = '16px';
    expect(getPeerPickerItemHeightPx()).toBe(PEER_PICKER_ITEM_HEIGHT_PX);

    document.documentElement.style.fontSize = '32px';
    expect(getPeerPickerItemHeightPx()).toBe(PEER_PICKER_ITEM_HEIGHT_PX * 2);
  });
});
