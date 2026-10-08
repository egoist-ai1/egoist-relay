import { describe, expect, test } from 'vitest';

import {
  formatSessionAgo, formatSessionDateTime, formatSessionTime, getSessionTimes, isValidSessionDate,
} from './sessionTime';

// 2026-10-08 11:23:07 UTC
const UNIX = Date.UTC(2026, 9, 8, 11, 23, 7) / 1000;

describe('sessionTime', () => {
  test('форматирует дату входа с секундами, 24 ч, без «г.» и точек', () => {
    expect(formatSessionDateTime(UNIX, 'ru', 'Europe/Moscow')).toBe('8 окт 2026, 14:23:07');
    expect(formatSessionDateTime(UNIX, 'ru', 'UTC')).toBe('8 окт 2026, 11:23:07');
  });

  test('относительное время на русском', () => {
    const now = (UNIX + 3 * 24 * 3600 + 100) * 1000;
    expect(formatSessionAgo(UNIX, 'ru', now)).toBe('3 дня назад');
    expect(formatSessionAgo(UNIX, 'ru', (UNIX + 5 * 3600) * 1000)).toBe('5 часов назад');
    expect(formatSessionAgo(UNIX, 'ru', UNIX * 1000 - 5000)).toBe('0 секунд назад');
  });

  test('неизвестное время не выдумывается', () => {
    expect(isValidSessionDate(0)).toBe(false);
    expect(isValidSessionDate(undefined)).toBe(false);
    expect(isValidSessionDate(NaN)).toBe(false);
    expect(formatSessionTime(0)).toBeUndefined();
    expect(getSessionTimes({ dateCreated: 0, dateActive: UNIX }, 'ru', UNIX * 1000).login).toBeUndefined();
  });

  test('getSessionTimes отдаёт вход и активность раздельно', () => {
    const result = getSessionTimes({ dateCreated: UNIX - 86400, dateActive: UNIX }, 'ru', UNIX * 1000);
    expect(result.login?.ago).toMatch(/1 день назад|вчера/);
    expect(result.active?.ago).toBe('0 секунд назад');
  });
});
