import { describe, expect, it, vi } from 'vitest';

import { normalizeMemoryUsage, splitMemory } from './relayMemory';

vi.mock('../browser/globalEnvironment', () => ({ IS_TAURI: false }));

describe('Memory usage', () => {
  it('Accepts only a positive byte count', () => {
    const bytes = 3 * 1024 * 1024;
    expect(normalizeMemoryUsage({ bytes, processes: 9 })).toEqual({ bytes, processes: 9 });
    expect(normalizeMemoryUsage({ bytes: 0, processes: 1 })).toBeUndefined();
    expect(normalizeMemoryUsage({ bytes: 'many' })).toBeUndefined();
    expect(normalizeMemoryUsage(undefined)).toBeUndefined();
    expect(normalizeMemoryUsage({ bytes: 5 })).toEqual({ bytes: 5, processes: 0 });
  });

  it('Shows megabytes below a gigabyte and gigabytes with a decimal comma above', () => {
    expect(splitMemory(512 * 1024 * 1024)).toEqual({ unit: 'mb', value: '512' });
    expect(splitMemory(1023.4 * 1024 * 1024)).toEqual({ unit: 'mb', value: '1023' });
    expect(splitMemory(1536 * 1024 * 1024)).toEqual({ unit: 'gb', value: '1,5' });
    expect(splitMemory(100)).toEqual({ unit: 'mb', value: '1' });
  });
});
