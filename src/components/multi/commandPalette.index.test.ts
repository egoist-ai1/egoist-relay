import { describe, expect, test } from 'vitest';

import type { PaletteEntry } from './commandPalette.index';

import { buildPaletteIndex, normalizeForSearch, queryPalette } from './commandPalette.index';

const entry = (
  id: string, group: PaletteEntry['group'], title: string, keywords?: string[],
): PaletteEntry => ({
  id, group, title, keywords, payload: undefined,
});

const ids = (entries: PaletteEntry[]) => entries.map((value) => value.id);

describe('Command palette index', () => {
  test('Normalization ignores case, yo and compatibility forms', () => {
    expect(normalizeForSearch('ЁЖИК Ёлка')).toBe('ежик елка');
    expect(normalizeForSearch('ＡＢＣ')).toBe('abc');
  });

  test('Query is matched by word starts and ignores yo/ye and case', () => {
    const index = buildPaletteIndex([
      entry('1', 'telegram', 'Артём Волков'),
      entry('2', 'telegram', 'Бриф Q4'),
    ]);
    expect(ids(queryPalette(index, 'артем'))).toEqual(['1']);
    expect(ids(queryPalette(index, 'АРТЁМ в'))).toEqual(['1']);
    expect(ids(queryPalette(index, 'q4 бр'))).toEqual(['2']);
    expect(ids(queryPalette(index, 'зебра'))).toEqual([]);
  });

  test('Ranks title word starts above keywords above substrings and keeps source order on ties', () => {
    const index = buildPaletteIndex([
      entry('substring', 'saved', 'Мегабриф.mp4'),
      entry('keyword', 'saved', 'Видео.mp4', ['бриф']),
      entry('second-title', 'saved', 'Новый бриф'),
      entry('first-title', 'saved', 'Бриф Q4'),
    ]);
    expect(ids(queryPalette(index, 'бриф'))).toEqual(['first-title', 'second-title', 'keyword', 'substring']);
  });

  test('Short tokens are not matched inside words', () => {
    const index = buildPaletteIndex([entry('1', 'telegram', 'Марина')]);
    expect(ids(queryPalette(index, 'ри'))).toEqual([]);
    expect(ids(queryPalette(index, 'рин'))).toEqual(['1']);
  });

  test('Results are grouped in the fixed order and limited per group', () => {
    const entries: PaletteEntry[] = [
      entry('saved-1', 'saved', 'Отчёт 1'),
      entry('action-1', 'actions', 'Открыть отчёты'),
      ...Array.from({ length: 12 }, (_, i) => entry(`chat-${i}`, 'telegram', `Отчёт чат ${i}`)),
    ];
    const found = ids(queryPalette(buildPaletteIndex(entries), 'отчёт'));
    expect(found[0]).toBe('action-1');
    expect(found.filter((id) => id.startsWith('chat-'))).toHaveLength(8);
    expect(found[found.length - 1]).toBe('saved-1');
  });

  test('Empty query shows a short selection of every group in source order', () => {
    const entries: PaletteEntry[] = [
      ...Array.from({ length: 9 }, (_, i) => entry(`a${i}`, 'actions', `Действие ${i}`)),
      ...Array.from({ length: 9 }, (_, i) => entry(`t${i}`, 'telegram', `Чат ${i}`)),
      ...Array.from({ length: 9 }, (_, i) => entry(`s${i}`, 'saved', `Файл ${i}`)),
    ];
    const found = ids(queryPalette(buildPaletteIndex(entries), '  '));
    expect(found.filter((id) => id.startsWith('a'))).toHaveLength(8);
    expect(found.filter((id) => id.startsWith('t'))).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(found.filter((id) => id.startsWith('s'))).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  test('Ten thousand entries are searched within the response budget', () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => entry(`e${i}`, i % 2 ? 'telegram' : 'saved',
      `Запись номер ${i} про бриф и релиз`, [`host${i}.example`]));
    const index = buildPaletteIndex(entries);
    const startedAt = performance.now();
    const found = queryPalette(index, 'бриф рел');
    const elapsed = performance.now() - startedAt;
    expect(found.length).toBe(16);
    expect(elapsed).toBeLessThan(100);
  });
});
