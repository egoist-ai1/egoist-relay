// Источник данных оркестратора: «один шаг» под аккаунтом Relay (страница истории, карточка источника) через
// существующий мост. Протокол 1 не меняется; расширения этапа 2 (параллельные запуски, offsetDate/minId, partialOnFlood,
// probe) включаются только после того, как Relay объявил их в status (`maxConcurrent`, `features`).
import { randomUUID } from 'node:crypto';
import { restoreResearchTextFields } from './export-format.mjs';
import { isObject } from './orch-core.mjs';
import { normalizeRequest } from './broker.mjs';
import { NO_ADVERT, parseBridgeAdvert } from './bridge-features.mjs';
import { assertPrivatePeerAllowed } from './private-peer.mjs';

const OPERATIONS = {
  telegram: ['discover', 'chat_info', 'read', 'search', 'channel_history', 'chat_export', 'download', 'probe', 'comments', 'topics', 'similar_channels', 'invite_preview'],
  x: ['discover', 'profile', 'read', 'search', 'channel_history', 'chat_export', 'download', 'article', 'read_thread'],
  instagram: ['discover', 'profile', 'read', 'search', 'channel_history', 'chat_export', 'download', 'read_thread'],
};
export const LOOKUP_OPERATIONS = Object.freeze(['invite_preview', 'similar_channels', 'topics', 'comments']);
const READY_TTL_MS = 2000;
const MAX_TEXT_BYTES = 4 * 1024 ** 2;
const MAX_UNIX_SECONDS = 4102444800;
const MAX_MESSAGE_ID = 2147483647;
const PROBE_DEADLINE_MS = 30000;
const STAGE_OPERATION = (provider, stage) => (stage === 'source_info' ? (provider === 'telegram' ? 'chat_info' : 'profile') : 'channel_history');
// Ошибки транспорта: после них объявление Relay считается устаревшим (мог перезапуститься другой версией).
const TRANSPORT_CODES = new Set(['APP_BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT', 'BRIDGE_REPLY_LOST', 'BRIDGE_PROTOCOL_INVALID', 'BRIDGE_IDENTITY_UNCONFIRMED', 'BRIDGE_RUNTIME_CHANGED', 'BRIDGE_SERVER_UNCONFIRMED', 'BRIDGE_METADATA_INVALID', 'BRIDGE_TOKEN_INVALID']);

function failure(code, extra = {}) { return Object.assign(new Error(code), { code }, extra); }
const boundedInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * Семафор платформы ёмкости N (FIFO, учёт abort). Ёмкость читается при каждом освобождении места, поэтому она может
 * меняться вместе с объявлением Relay. Мост выполняет не больше `maxConcurrent` запусков на платформу; старые задания
 * брокера и шаги оркестратора делят один затвор, и `PROVIDER_BUSY` в нормальной работе не возникает.
 */
export function createProviderGate({ capacity = 1 } = {}) {
  const limit = () => { const n = typeof capacity === 'function' ? capacity() : capacity; return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, 64) : 1; };
  const waiters = [];
  let active = 0;
  function drain() {
    while (waiters.length && active < limit()) { active++; waiters.shift().start(); }
  }
  return {
    get active() { return active; },
    get queued() { return waiters.length; },
    async run(fn, signal) {
      if (signal?.aborted) throw signal.reason ?? failure('CANCELLED');
      if (waiters.length === 0 && active < limit()) active++;
      else {
        await new Promise((resolve, reject) => {
          const waiter = { start: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
          const onAbort = () => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(signal.reason ?? failure('CANCELLED')); };
          signal?.addEventListener('abort', onAbort, { once: true });
          waiters.push(waiter);
          drain();
        });
      }
      try { return await fn(); } finally { active--; drain(); }
    },
  };
}

/** Строгая проверка входа шага. Старые поля проходят ту же проверку брокера; новые поля этапа 2 проверяются здесь теми же границами моста. */
function buildStepInput({ provider, operation, source, cursor, limit, after, before, topicId, deadlineMs, offsetDate, minId }, advert) {
  const request = { provider, operation, input: { channel: source.ref, limit, pageSize: Math.min(100, limit), deadlineMs } };
  if (cursor) request.input.cursor = cursor;
  // Границы времени относятся к записям истории. Карточка источника (профиль, chat_info) времени не имеет: в X и Instagram мост отвечает
  // TIMESTAMP_FILTER_UNSUPPORTED на запись без времени, и source_info с датами цели падал бы.
  if (operation === 'channel_history') {
    if (after !== undefined) request.input.after = after;
    if (before !== undefined) request.input.before = before;
  }
  // Тема форума — понятие Telegram: Relay отвергает topicId в запросах X и Instagram (INVALID_INPUT), поэтому он уходит только в историю Telegram.
  if (topicId !== undefined && provider === 'telegram' && operation === 'channel_history') request.input.topicId = topicId;
  const input = normalizeRequest(request).input;
  if (offsetDate !== undefined && !boundedInt(offsetDate, 1, MAX_UNIX_SECONDS)) throw failure('INVALID_REQUEST');
  if (minId !== undefined && !boundedInt(minId, 1, MAX_MESSAGE_ID)) throw failure('INVALID_REQUEST');
  // Новое поле уходит мосту только при объявленной возможности: иначе Relay отверг бы его как INVALID_INPUT.
  if (provider === 'telegram' && operation === 'channel_history') {
    if (offsetDate !== undefined && advert.features.has('offset_date')) input.offsetDate = offsetDate;
    if (minId !== undefined && advert.features.has('min_id')) input.minId = minId;
    if (advert.features.has('flood_wait')) input.partialOnFlood = true;
  }
  return input;
}

/** Преобразует состояние ответа моста в состояние платформы для планировщика. */
export function createBridgeStepProvider({ provider, bridge, gate = createProviderGate(), now = Date.now, getParallelLimit = () => 3, probeSample = 12, allowPrivateDialogs = () => false, guardRead = signal => signal }) {
  if (!OPERATIONS[provider] || !bridge) throw failure('INVALID_PROVIDER');
  let ready;
  let advert = NO_ADVERT;
  const adapter = {
    provider,
    // Динамические свойства: читаются планировщиком и оркестратором каждый раз по последнему готовому статусу Relay.
    // Без объявления = 1; сверху ещё лимит владельца policy.limits.telegramParallel.
    get maxConcurrent() { return Math.max(1, Math.min(advert.maxConcurrent, Number(getParallelLimit()) || 1)); },
    // При объявленном peer_cache Relay не тратит запрос разрешения имени на каждом шаге: бюджет resolve не расходуется на страницах.
    get resolvesPerStep() { return provider === 'telegram' && !advert.features.has('peer_cache'); },
    get supportsProbe() { return provider === 'telegram' && advert.features.has('probe'); },
    probeSample,
    hasFeature: name => advert.features.has(name),
    stages: ['source_info', 'posts'],
    async status({ force = false } = {}) {
      if (!force && ready && now() < ready.until) return { ...ready.value };
      ready = undefined;
      try {
        const value = await bridge.status();
        const selected = value.providers?.find(item => item.provider === provider);
        if (!selected) return { state: 'unavailable', operations: [], reason: 'invalid_bridge_status' };
        const accepted = {
          state: selected.state === 'initializing' ? 'unavailable' : selected.state,
          operations: Array.isArray(selected.operations) ? selected.operations.filter(operation => OPERATIONS[provider].includes(operation)) : [],
          reason: /^[a-z_]{1,96}$/i.test(selected.reason ?? '') ? selected.reason.toLowerCase() : selected.state === 'initializing' ? 'app_initializing' : undefined,
          accountRef: selected.accountRef, accountEpoch: selected.accountEpoch,
        };
        // Объявление берётся только из готового статуса: занятость (provider_busy) и сбои его не сбрасывают.
        if (selected.state === 'ready') advert = parseBridgeAdvert(selected, provider);
        if (provider === 'telegram') { accepted.maxConcurrent = adapter.maxConcurrent; accepted.features = [...advert.features]; }
        if (accepted.state === 'ready') ready = { value: accepted, until: now() + READY_TTL_MS };
        return { ...accepted };
      } catch (error) {
        advert = NO_ADVERT;
        return { state: 'unavailable', operations: [], reason: error.code === 'APP_BRIDGE_UNAVAILABLE' ? 'app_owned_bridge_unavailable' : 'app_owned_bridge_unconfirmed' };
      }
    },
    async step({ stage, source, cursor, limit, after, before, topicId, offsetDate, minId, accountScope, signal, deadlineMs = 120000 }) {
      const operation = STAGE_OPERATION(provider, stage);
      const input = buildStepInput({ provider, operation, source, cursor, limit, after, before, topicId, deadlineMs, offsetDate, minId }, advert);
      const result = await runCollect({ operation, input, accountScope, signal, limit });
      return result.step;
    },
    /** Оценка размера источника без чтения сообщений. Неизвестное число — `items: undefined` (оценка остаётся верхней границей). */
    async probe({ source, accountScope, signal }) {
      if (!adapter.supportsProbe) throw failure('UNSUPPORTED');
      const channel = normalizeRequest({ provider, operation: 'chat_info', input: { channel: source.ref, limit: 1, pageSize: 1, deadlineMs: PROBE_DEADLINE_MS } }).input.channel;
      const { records } = await runCollect({ operation: 'probe', input: { channel, deadlineMs: PROBE_DEADLINE_MS }, accountScope, signal, limit: 10 });
      const record = records.find(item => item.type === 'telegram.probe');
      const counts = isObject(record?.counts) ? record.counts : {};
      const count = name => (boundedInt(counts[name], 0, Number.MAX_SAFE_INTEGER) ? counts[name] : undefined);
      const media = {};
      for (const name of ['photo', 'video', 'document', 'music', 'voice', 'gif']) if (count(name) !== undefined) media[name] = count(name);
      // inexact — имена приблизительных счётчиков (например, messages, если Telegram не вернул точное число).
      const inexact = Array.isArray(record?.inexact) ? record.inexact.filter(name => typeof name === 'string' && /^[a-z_]{1,32}$/.test(name)).slice(0, 16) : [];
      return { items: count('messages'), participants: count('participants'), media, ...(inexact.length ? { inexact } : {}) };
    },
    /**
     * Точечное чтение Telegram без вступления и отправки: предпросмотр инвайта, похожие каналы, темы форума, комментарии под постом.
     * Работает только при объявленной Relay возможности с тем же именем; иначе UNSUPPORTED (мост не получает неизвестную операцию).
     */
    async lookup({ operation, channel, url, query, cursor, limit, accountScope, signal, deadlineMs = 60000 }) {
      if (provider !== 'telegram' || !LOOKUP_OPERATIONS.includes(operation) || !advert.features.has(operation)) throw failure('UNSUPPORTED');
      if (!boundedInt(limit, 1, 100)) throw failure('INVALID_REQUEST');
      const input = { limit, pageSize: limit, deadlineMs };
      if (operation === 'comments') input.url = url; else input.channel = channel;
      if (operation === 'topics' && query !== undefined) input.query = query;
      if (cursor !== undefined && (operation === 'topics' || operation === 'comments')) input.cursor = cursor;
      return (await runCollect({ operation, input, accountScope, signal, limit })).step;
    },
  };

  /** Один запуск моста: события собираются в записи; контракт событий проверяется здесь. */
  function runCollect({ operation, input, accountScope, signal, limit }) {
    signal = guardRead(signal);
    return gate.run(async () => {
      ready = undefined;
      const records = []; const keys = new Set(); const parts = new Map();
      let nextCursor; let partial = false; let scoped = false; let doneEvent;
      const accept = record => {
        if (!isObject(record)) throw failure('INVALID_RESULT');
        assertPrivatePeerAllowed(provider, record, allowPrivateDialogs);
        if (record.textPart !== undefined) {
          const part = record.textPart;
          if (!isObject(part) || typeof record.id !== 'string' || !Number.isSafeInteger(part.index) || part.index < 0 || part.index > 1024 || typeof part.text !== 'string' || typeof part.final !== 'boolean') throw failure('INVALID_RESULT');
          const key = `${record.type ?? 'post'}:${record.id}`;
          const pending = parts.get(key) ?? { next: 0, text: '', base: record };
          if (pending.next !== part.index || Buffer.byteLength(pending.text) + Buffer.byteLength(part.text) > MAX_TEXT_BYTES) throw failure('INVALID_RESULT');
          pending.next++; pending.text += part.text;
          if (!part.final) { parts.set(key, pending); return; }
          parts.delete(key);
          record = { ...pending.base, text: pending.text };
          delete record.textPart;
        }
        try { record = restoreResearchTextFields(record); } catch { throw failure('INVALID_RESULT'); }
        const key = `${record.type ?? 'post'}:${record.id ?? record.sourceUrl ?? JSON.stringify(record).length}`;
        if (keys.has(key)) return;
        keys.add(key);
        if (records.length >= limit) { partial = true; return; }
        records.push(record);
      };
      let final;
      try {
        final = await bridge.call('run', { provider, operation, input, jobId: randomUUID(), expectedAccount: accountScope }, {
          signal,
          onEvent: async event => {
            if (event.kind === 'scope') {
              if (!accountScope || event.accountRef !== accountScope.accountRef || event.accountEpoch !== accountScope.accountEpoch) throw failure('STALE_ACCOUNT');
              scoped = true; return;
            }
            if (event.kind === 'status') return;
            if (!scoped) throw failure('STALE_ACCOUNT');
            if (event.nextCursor !== undefined) nextCursor = event.nextCursor;
            partial ||= event.partial === true;
            if (event.kind === 'records') {
              if (!Array.isArray(event.records) || event.records.length > 100) throw failure('INVALID_RESULT');
              for (const record of event.records) accept(record);
            } else if (event.kind === 'done') {
              if (!['results', 'empty', 'partial'].includes(event.outcome) || !Number.isSafeInteger(event.count) || parts.size) throw failure('INVALID_RESULT');
              if (event.count !== keys.size && event.count !== records.length) throw failure('INVALID_RESULT');
              if (event.outcome === 'empty' && records.length) throw failure('INVALID_RESULT');
              partial ||= event.outcome === 'partial';
              doneEvent = event;
            } else throw failure('INVALID_RESULT');
          },
        });
      } catch (error) {
        if (TRANSPORT_CODES.has(error?.code)) advert = NO_ADVERT;
        throw error;
      } finally { ready = undefined; }
      if (!final || !doneEvent) throw failure('BRIDGE_REPLY_LOST');
      const step = { records, nextCursor, partial, outcome: doneEvent.outcome, coverage: typeof doneEvent.coverage === 'string' ? doneEvent.coverage : undefined };
      // Частичный успех: Relay отдал страницу и сообщил паузу платформы (done.reason FLOOD_WAIT). Страницу не теряем.
      if (doneEvent.reason === 'FLOOD_WAIT' || doneEvent.floodWait !== undefined) {
        const wait = isObject(doneEvent.floodWait) ? doneEvent.floodWait : {};
        step.floodWait = {};
        if (boundedInt(wait.seconds, 0, 86400)) step.floodWait.seconds = wait.seconds;
        if (/^[A-Z_]{1,32}$/.test(wait.waitKind ?? '')) step.floodWait.waitKind = wait.waitKind;
      }
      return { step, records };
    }, signal);
  }
  return adapter;
}
