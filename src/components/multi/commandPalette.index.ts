// Индекс палитры команд живёт только в памяти и собирается при открытии палитры из уже загруженных данных:
// ничего не пишется на диск, тексты сообщений не индексируются.

export type PaletteGroup = 'actions' | 'telegram' | 'saved';

export type PaletteEntry<T = unknown> = {
  id: string;
  group: PaletteGroup;
  title: string;
  subtitle?: string;
  keywords?: string[];
  payload: T;
};

type IndexedEntry<T> = {
  entry: PaletteEntry<T>;
  order: number;
  title: string;
  titleWords: string[];
  keywordWords: string[];
  text: string;
};

export type PaletteIndex<T = unknown> = IndexedEntry<T>[];

export const PALETTE_GROUPS: PaletteGroup[] = ['actions', 'telegram', 'saved'];

// Без запроса показываем короткую подборку; с запросом — не больше строк на группу
const EMPTY_QUERY_LIMITS: Record<PaletteGroup, number> = { actions: 8, telegram: 5, saved: 5 };
const GROUP_LIMIT = 8;
const SUBSTRING_MIN_LENGTH = 3;

const RE_NOT_WORD = /[^\p{L}\p{M}\p{N}]+/u;

/** Регистр, совместимые формы символов, «ё» как «е». */
export function normalizeForSearch(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
}

function splitWords(normalized: string) {
  return normalized.split(RE_NOT_WORD).filter(Boolean);
}

export function buildPaletteIndex<T>(entries: PaletteEntry<T>[]): PaletteIndex<T> {
  return entries.map((entry, order) => {
    const title = normalizeForSearch(entry.title);
    const keywords = normalizeForSearch((entry.keywords || []).join(' '));
    return {
      entry,
      order,
      title,
      titleWords: splitWords(title),
      keywordWords: splitWords(keywords),
      text: `${title} ${keywords}`,
    };
  });
}

// 0 — слово названия, 1 — слово из ключевых слов, 2 — подстрока; undefined — не найдено
function matchToken(item: IndexedEntry<unknown>, token: string): number | undefined {
  if (item.titleWords.some((word) => word.startsWith(token))) return 0;
  if (item.keywordWords.some((word) => word.startsWith(token))) return 1;
  if (token.length >= SUBSTRING_MIN_LENGTH && item.text.includes(token)) return 2;
  return undefined;
}

function scoreEntry(item: IndexedEntry<unknown>, tokens: string[], query: string) {
  let worst = 0;
  for (const token of tokens) {
    const tier = matchToken(item, token);
    if (tier === undefined) return undefined;
    worst = Math.max(worst, tier);
  }
  return worst * 2 + (item.title.startsWith(query) ? 0 : 1);
}

/** Результаты по группам в порядке `PALETTE_GROUPS`; при равной оценке сохраняется порядок исходного списка. */
export function queryPalette<T>(index: PaletteIndex<T>, rawQuery: string): PaletteEntry<T>[] {
  const query = normalizeForSearch(rawQuery).trim();
  const tokens = splitWords(query);
  const result: PaletteEntry<T>[] = [];

  for (const group of PALETTE_GROUPS) {
    const items = index.filter((item) => item.entry.group === group);
    if (!tokens.length) {
      result.push(...items.slice(0, EMPTY_QUERY_LIMITS[group]).map((item) => item.entry));
      continue;
    }
    const scored: { item: IndexedEntry<T>; score: number }[] = [];
    for (const item of items) {
      const score = scoreEntry(item, tokens, query);
      if (score !== undefined) scored.push({ item, score });
    }
    scored.sort((a, b) => a.score - b.score || a.item.order - b.item.order);
    result.push(...scored.slice(0, GROUP_LIMIT).map(({ item }) => item.entry));
  }

  return result;
}

export type PalettePayload =
  { type: 'app'; app: 'telegram' | 'x' | 'instagram' }
  | { type: 'operations' }
  | { type: 'relaySettings' }
  | { type: 'telegramSettings' }
  | { type: 'chat'; id: string }
  | { type: 'file'; operationId: string; index: number }
  | { type: 'telegramSearch'; query: string };
