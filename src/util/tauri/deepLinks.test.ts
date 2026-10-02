import { describe, expect, it } from 'vitest';

import { normalizeNativeDeepLinks } from './deepLinks';

describe('native deep links', () => {
  it('accepts the native array contract and legacy single string', () => {
    const first = 'tg://resolve?domain=telegram';
    const second = 'tg://join?invite=test';
    expect(normalizeNativeDeepLinks([first, second])).toEqual([first, second]);
    expect(normalizeNativeDeepLinks(first)).toEqual([first]);
    expect(normalizeNativeDeepLinks(encodeURIComponent(first))).toEqual([first]);
  });
  it('preserves encoded delimiters and Cyrillic in share text', () => {
    const link = 'tg://msg_url?url=https%3A%2F%2Fexample.org&text=%D0%A2%D0%B5%D1%81%D1%82%26next%3Dvalue';
    const result = normalizeNativeDeepLinks([link]);
    expect(result).toEqual([link]);
    expect(new URL(result[0]).searchParams.get('text')).toBe('Тест&next=value');
  });
  it('skips malformed entries while retaining later links', () => {
    expect(normalizeNativeDeepLinks([undefined, {}, 'tg://resolve?domain=%ZZ', 'tg://resolve?domain=%E0%A4',
      'https://example.org', 'tg://user:password@resolve', 'tg://', 'tg://resolve\n', 'tg://settings']))
      .toEqual(['tg://settings']);
  });
  it('bounds payload processing', () => {
    expect(normalizeNativeDeepLinks(Array(50).fill('tg://settings'))).toHaveLength(16);
    expect(normalizeNativeDeepLinks(`tg://resolve?domain=${'x'.repeat(16384)}`)).toEqual([]);
    expect(normalizeNativeDeepLinks(JSON.parse('null'))).toEqual([]);
  });
});
