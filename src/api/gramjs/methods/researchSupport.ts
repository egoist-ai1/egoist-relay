// Чистые помощники исследовательского пути GramJS: бюджеты запросов, кэш пиров, описание FLOOD_WAIT и смещения медиа.
// Модуль не обращается к клиенту и не хранит ничего на диске, поэтому проверяется юнит-тестами без аккаунта.

function getSystemTime() {
  return Date.now();
}

export const MEDIA_ALIGN_BYTES = 1024 ** 2;
export const SPOOL_CHUNK_BYTES = MEDIA_ALIGN_BYTES;

const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const MAX_WAIT_SECONDS = 86400;
const PEER_CACHE_TTL_MS = 6 * 3600000;
const PEER_CACHE_MAX_ENTRIES = 5000;

export type WaitKind = 'FLOOD_WAIT' | 'PREMIUM_FLOOD_WAIT' | 'SLOWMODE_WAIT'
  | 'RESOLVE_BUDGET' | 'REQUEST_BUDGET';

export type FloodInfo = {
  seconds: number;
  waitKind: WaitKind;
};

type BudgetRule = {
  limit: number;
  windowMs: number;
};

// Скользящие окна: запрос принимается, только если свободно место во всех окнах сразу
export class RequestBudget {
  private readonly stamps: number[][];

  constructor(private readonly rules: BudgetRule[], private readonly getNow: () => number = getSystemTime) {
    this.stamps = rules.map(() => []);
  }

  // Возвращает 0, если запрос принят и записан, иначе миллисекунды до освобождения места
  take(): number {
    const now = this.getNow();
    let waitMs = 0;
    this.rules.forEach((rule, index) => {
      const list = this.stamps[index];
      while (list.length && now - list[0] >= rule.windowMs) {
        list.shift();
      }
      if (list.length >= rule.limit) {
        waitMs = Math.max(waitMs, list[0] + rule.windowMs - now);
      }
    });
    if (waitMs > 0) {
      return waitMs;
    }
    this.stamps.forEach((list) => list.push(now));
    return 0;
  }
}

export function createResolveBudget(getNow?: () => number) {
  return new RequestBudget([{ limit: 12, windowMs: MINUTE_MS }, { limit: 500, windowMs: DAY_MS }], getNow);
}

export function createRequestBudget(getNow?: () => number) {
  return new RequestBudget([{ limit: 240, windowMs: MINUTE_MS }], getNow);
}

export function buildBudgetError(waitKind: 'RESOLVE_BUDGET' | 'REQUEST_BUDGET', waitMs: number) {
  const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.ceil(waitMs / 1000)));
  return Object.assign(new Error('RATE_LIMITED'), {
    seconds, waitKind, retryAfterMs: seconds * 1000,
  });
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

// Кэш разрешённых имён и числовых идентификаторов; привязан к эпохе аккаунта и пропадает вместе с ней
export class PeerCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  private epoch = '';

  constructor(private readonly getNow: () => number = getSystemTime) {
  }

  get(epoch: string, key: string): T | undefined {
    this.bind(epoch);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.getNow()) {
      this.entries.delete(key);
      return undefined;
    }
    // Свежее обращение переносит запись в конец порядка вставки
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(epoch: string, key: string, value: T) {
    this.bind(epoch);
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.getNow() + PEER_CACHE_TTL_MS });
    while (this.entries.size > PEER_CACHE_MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  get size() {
    return this.entries.size;
  }

  private bind(epoch: string) {
    if (this.epoch !== epoch) {
      this.entries.clear();
      this.epoch = epoch;
    }
  }
}

export function normalizePeerCacheKey(value: string) {
  return value.replace(/^@/, '').toLowerCase();
}

// Ошибки GramJS с ожиданием: секунды берутся из ответа платформы, а не из текста
export function describeFlood(error: unknown): FloodInfo | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const message = 'errorMessage' in error && typeof error.errorMessage === 'string' ? error.errorMessage
    : error instanceof Error ? error.message : '';
  if (!/FLOOD|RATE_LIMIT|SLOWMODE_WAIT/.test(message) || /^PEER_FLOOD$/.test(message)) {
    return undefined;
  }
  const rawSeconds = 'seconds' in error ? Number(error.seconds) : NaN;
  const rawRetry = 'retryAfterMs' in error ? Number(error.retryAfterMs) : NaN;
  const seconds = Number.isFinite(rawSeconds) && rawSeconds >= 0 ? rawSeconds
    : Number.isFinite(rawRetry) && rawRetry >= 0 ? rawRetry / 1000 : 0;
  const knownKind = 'waitKind' in error && (error.waitKind === 'RESOLVE_BUDGET' || error.waitKind === 'REQUEST_BUDGET')
    ? error.waitKind : undefined;
  const waitKind: WaitKind = knownKind ?? (/PREMIUM/.test(message) ? 'PREMIUM_FLOOD_WAIT'
    : /SLOWMODE/.test(message) ? 'SLOWMODE_WAIT' : 'FLOOD_WAIT');
  return { seconds: Math.min(MAX_WAIT_SECONDS, Math.ceil(seconds)), waitKind };
}

// Смещение возобновления выровнено по границе 1 МиБ (требование upload.getFile) и лежит внутри файла
export function isValidResumeOffset(offset: unknown, size?: number): offset is number {
  return typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0
    && offset % MEDIA_ALIGN_BYTES === 0 && (size === undefined || offset < size);
}

export type MediaRange = {
  start: number;
  end: number;
};

// Диапазоны скачивания от смещения до конца файла; каждый лежит в одной границе 1 МиБ
export function planMediaRanges(size: number, resumeFrom: number): MediaRange[] {
  if (!Number.isSafeInteger(size) || size <= 0 || !isValidResumeOffset(resumeFrom, size)) {
    throw new Error('RESUME_MISMATCH');
  }
  const ranges: MediaRange[] = [];
  for (let start = resumeFrom; start < size; start += MEDIA_ALIGN_BYTES) {
    ranges.push({ start, end: Math.min(size, start + MEDIA_ALIGN_BYTES) - 1 });
  }
  return ranges;
}

export async function buildMediaFingerprint(parts: Array<string | number | bigint>) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.map(String).join('|')));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
