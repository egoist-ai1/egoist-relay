// Общие примитивы ядра оркестрации: ошибки с проверенными текстами восстановления, ID, хэши, нормализация текста.
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export const ORCHESTRATION_CONTRACT = 1;
export const ITEM_SCHEMA_VERSION = 2;

// Тексты ниже статичны и проверены: в ответ никогда не попадают сырые сообщения платформы, пути или секреты.
const CODES = {
  INVALID_INPUT: ['Fix the argument named in the message and call again.', false],
  NOT_FOUND: ['The ID is unknown. Use an ID returned by social_plan, social_run or social_job.', false],
  ACCESS_DENIED: ['This account cannot read the source. It is not an empty source; ask the owner for access or skip it.', false],
  UNAVAILABLE: ['The data is unavailable now; it is not an empty result. Check social_status and retry later.', true],
  UNSUPPORTED: ['The platform or build does not support this stage. Remove it from the goal.', false],
  RATE_LIMITED: ['The platform asked to slow down. Jobs wait and resume on their own; do not resubmit.', true],
  CHALLENGE_REQUIRED: ['The platform requires a first-party account challenge. The owner must complete it; then resume the job.', false],
  AUTH_REQUIRED: ['The Relay account is not authorized. A missing bridge is a different state; check social_status.', false],
  STALE_ACCOUNT: ['The bound account changed. Read the job state; affected sources restart under the new account.', true],
  POLICY_DENIED: ['The owner policy forbids this action. Only the owner can change policy.json.', false],
  IDEMPOTENCY_CONFLICT: ['This idempotencyKey belongs to a different request. Use a new key for a different request.', false],
  CURSOR_STALE: ['The cursor does not match these filters. Repeat the call without a cursor.', false],
  DISK_RESERVE: ['Free disk space is below the reserve. Free space; the job resumes by itself.', true],
  BRIDGE_UNAVAILABLE: ['The Relay account bridge is unavailable. It is not a lost login; jobs wait and resume by themselves.', true],
  ADAPTER_FAILED: ['The operation failed; details were not recorded. Read the job state before retrying.', true],
  PLAN_EXPIRED: ['The plan expired. Create a new plan with social_plan.', false],
  CONFIRMATION_REQUIRED: ['The plan needs owner confirmation. Show the reasons, then call social_run with acknowledgeRisk=true.', false],
  BUSY: ['The service is busy. Retry shortly.', true],
  STATE_LIMIT: ['A bounded state limit was reached. Finish or cancel earlier jobs.', false],
  ACCOUNT_RESTRICTED: ["The platform restricted the Relay account. Wait for the owner to decide in Relay; do not retry.", false],
  INDEX_UNAVAILABLE: ["The text index failed to rebuild; export with query is unavailable until the service restarts. Do not retry. Export without query, or use social_records, which answers with corpus.incomplete=true.", false],
  INDEX_REBUILDING: ['The text index is being rebuilt after an update. Retry in a minute, or query without text search (records and stats still answer with corpus.incomplete=true).', true],
};
export const ERROR_CODES = Object.freeze(Object.keys(CODES));

export class OrchError extends Error {
  constructor(code, message, extra = {}) {
    super(String(message ?? code).slice(0, 300));
    this.name = 'OrchError';
    this.code = CODES[code] ? code : 'ADAPTER_FAILED';
    this.recovery = extra.recovery ?? CODES[this.code][0];
    this.retryable = extra.retryable ?? CODES[this.code][1];
    if (Number.isSafeInteger(extra.retryAfterMs) && extra.retryAfterMs >= 0) this.retryAfterMs = Math.min(extra.retryAfterMs, 86400000);
    if (extra.completionUncertain === true) this.completionUncertain = true;
  }
}
export const fail = (code, message, extra) => { throw new OrchError(code, message, extra); };

/** Безопасное публичное описание ошибки: только проверенные поля. */
export function publicError(error) {
  if (error instanceof OrchError) {
    const result = { code: error.code, message: error.message, recovery: error.recovery, retryable: error.retryable };
    if (error.retryAfterMs !== undefined) result.retryAfterMs = error.retryAfterMs;
    if (error.completionUncertain) result.completionUncertain = true;
    return result;
  }
  return { code: 'ADAPTER_FAILED', message: 'Internal operation failed; details were not recorded.', recovery: CODES.ADAPTER_FAILED[0], retryable: true };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function newId(prefix, length = 16) {
  const bytes = randomBytes(length);
  let text = '';
  for (const byte of bytes) text += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${text}`;
}
export const ID_PATTERN = '^[a-z]{1,4}_[a-z0-9]{8,32}$';
export const isId = (value, prefix) => typeof value === 'string' && new RegExp(ID_PATTERN).test(value) && (!prefix || value.startsWith(prefix + '_'));

export const sha256 = value => createHash('sha256').update(value).digest('hex');

/**
 * Локальный алиас аккаунта для всего, что уходит наружу (ответы MCP, журнал аудита). accountRef от Relay — SHA-256 от userId с публичным доменом,
 * при низкой энтропии userId его перебирают офлайн; алиас = HMAC-SHA256(ключ демона, accountRef), 20 hex, перебору не поддаётся.
 * Ключ выводится через HKDF из постоянного секрета демона (IPC-токен) с отдельной меткой; без секрета (тесты) — случайный на процесс.
 * Принимает и «provider:accountRef»: алиас считается от части после первого двоеточия.
 */
export function createAccountAlias(secret) {
  const key = secret === undefined ? randomBytes(32) : Buffer.from(hkdfSync('sha256', Buffer.from(String(secret).trim(), 'utf8'), Buffer.alloc(0), 'egoist-social-mcp/account-alias/v1', 32));
  const alias = ref => createHmac('sha256', key).update(String(ref)).digest('hex').slice(0, 20);
  return value => {
    const text = String(value);
    const cut = text.indexOf(':');
    return cut < 0 ? alias(text) : text.slice(0, cut + 1) + alias(text.slice(cut + 1));
  };
}
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

// Признаки учётных данных: такие значения не эхо-копируются в ответы, журналы и хранилище.
// Срабатывает на формы «ключ=значение», заголовки и bearer; обычные слова вроде @tokenomics не задеваются.
const CREDENTIAL = /(?:^|[?&;,\s])(?:access_?token|auth_?token|refresh_?token|token|auth|key|api_?key|secret|passw(?:or)?d|session(?:_?id)?|cookie|authorization)\s*[=:]|bearer\s+\S|(?:authorization|cookie)\s*:/i;
export const looksSecret = text => typeof text === 'string' && CREDENTIAL.test(text);
export function safeEcho(text, limit = 80) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return looksSecret(flat) ? '[redacted]' : flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

// Фолдинг для полнотекстового поиска: SQLite unicode61 не склеивает ё и е, поэтому делаем это сами. NFKC склеивает совместимые формы
// (лигатуры «ﬁ», полноширинные и «математические» буквы, «№»). Версия свёртки лежит в meta хранилища: смена версии пересобирает FTS.
export const FOLD_VERSION = '2';
export function foldText(text) {
  return String(text).normalize('NFKC').replaceAll('ё', 'е').replaceAll('Ё', 'Е');
}
/** Свёртка с сохранением длины строки (для смещений во фрагменте): только ё/е и регистр. */
export const foldKeepLength = text => String(text).replaceAll('ё', 'е').replaceAll('Ё', 'Е').toLowerCase();
export function detectLang(text) {
  if (!text) return null;
  let cyrillic = 0; let latin = 0; let letters = 0;
  for (const char of text.slice(0, 2000)) {
    const code = char.codePointAt(0);
    if ((code >= 0x400 && code <= 0x4ff)) { cyrillic++; letters++; }
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) { latin++; letters++; }
    else if (/\p{L}/u.test(char)) letters++;
  }
  if (letters < 3) return null;
  if (cyrillic / letters >= 0.5) return 'ru';
  if (latin / letters >= 0.7) return 'en';
  return null;
}

export const isoTime = ms => new Date(ms).toISOString();
export const parseIso = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : undefined; };
export function boundedInt(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export const MAX_BRIDGE_SECONDS = 4102444800;
/** ISO 8601 → целые Unix-секунды моста (округление вниз); вне 0..4102444800 или не дата — undefined. */
export function isoToUnixSeconds(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return undefined;
  const seconds = Math.floor(ms / 1000);
  return seconds >= 0 && seconds <= MAX_BRIDGE_SECONDS ? seconds : undefined;
}
