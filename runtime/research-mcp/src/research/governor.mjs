// Регулятор темпа аккаунта (AIMD) и размыкатель. На каждую пару (аккаунт, класс запросов) — свой интервал между запросами:
// после FLOOD_WAIT интервал растёт ×backoffFactor и весь аккаунт уходит в паузу не короче заявленной платформой,
// после spell без ошибок интервал сжимается ×1/growFactor до минимума. Паузы и счётчики переживают перезапуск демона.
import { governorFor } from './policy.mjs';

export const REQUEST_CLASSES = Object.freeze(['history', 'resolve', 'search']);
// Собственные потолки Relay: это не FLOOD_WAIT Telegram, они не должны разгонять интервал и открывать размыкатель.
export const OWN_CAP_WAIT_KINDS = Object.freeze(['RESOLVE_BUDGET', 'REQUEST_BUDGET', 'EMERGENCY_CAP']);
/** Секунды паузы из ошибки шага или done.floodWait: seconds (приоритет), иначе retryAfterMs, иначе 30. */
export function floodSecondsOf(source) {
  if (Number.isSafeInteger(source?.seconds) && source.seconds >= 0 && source.seconds <= 86400) return source.seconds;
  if (Number.isSafeInteger(source?.retryAfterMs) && source.retryAfterMs > 0) return Math.ceil(source.retryAfterMs / 1000);
  return 30;
}
export const floodWaitKindOf = source => (typeof source?.waitKind === 'string' && /^[A-Z_]{1,32}$/.test(source.waitKind) ? source.waitKind : undefined);
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

export function createGovernor({ store, clock, getPolicy, audit, random = Math.random }) {
  const states = new Map();
  const dirty = new Set();

  function load() {
    for (const row of store.all('SELECT * FROM governor')) {
      states.set(`${row.account_key}|${row.class}`, {
        accountKey: row.account_key, cls: row.class, interval: row.interval_ms, nextAt: 0, cooldownUntil: row.cooldown_until, breakerUntil: row.breaker_until,
        lastErrorAt: row.last_error_at, lastGrowAt: row.last_grow_at, floods: JSON.parse(row.floods_json), usedDay: row.used_day, usedCount: row.used_count,
      });
    }
  }
  const save = state => {
    store.run(`INSERT INTO governor(account_key, class, interval_ms, cooldown_until, breaker_until, last_error_at, last_grow_at, floods_json, used_day, used_count)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_key, class) DO UPDATE SET interval_ms=excluded.interval_ms, cooldown_until=excluded.cooldown_until,
      breaker_until=excluded.breaker_until, last_error_at=excluded.last_error_at, last_grow_at=excluded.last_grow_at, floods_json=excluded.floods_json,
      used_day=excluded.used_day, used_count=excluded.used_count`, state.accountKey, state.cls, state.interval, state.cooldownUntil, state.breakerUntil, state.lastErrorAt,
      state.lastGrowAt, JSON.stringify(state.floods), state.usedDay, state.usedCount);
    dirty.delete(state);
  };
  function get(accountKey, provider, cls) {
    const key = `${accountKey}|${cls}`;
    let state = states.get(key);
    if (!state) {
      const config = governorFor(getPolicy(), provider, cls);
      state = { accountKey, cls, interval: config.initialIntervalMs, nextAt: 0, cooldownUntil: 0, breakerUntil: 0, lastErrorAt: 0, lastGrowAt: clock.now(), floods: [], usedDay: null, usedCount: 0 };
      states.set(key, state);
    }
    return state;
  }
  function grow(state, provider, now) {
    const policy = getPolicy().governor;
    const config = governorFor(getPolicy(), provider, state.cls);
    const base = Math.max(state.lastErrorAt, state.lastGrowAt);
    const windows = Math.min(20, Math.floor((now - base) / policy.growAfterMs));
    if (windows >= 1 && state.interval > config.minIntervalMs) {
      state.interval = Math.max(config.minIntervalMs, state.interval / Math.pow(policy.growFactor, windows));
      state.lastGrowAt = base + windows * policy.growAfterMs;
      dirty.add(state);
    } else if (windows >= 1) state.lastGrowAt = base + windows * policy.growAfterMs;
  }

  return {
    load,
    /** Можно ли сейчас отправить запрос этого класса. Резерв токена — отдельным вызовом take(). */
    gate(accountKey, provider, cls) {
      const now = clock.now();
      const state = get(accountKey, provider, cls);
      const config = governorFor(getPolicy(), provider, cls);
      grow(state, provider, now);
      if (now < state.breakerUntil) return { ok: false, reason: 'breaker', delayMs: state.breakerUntil - now };
      if (now < state.cooldownUntil) return { ok: false, reason: 'cooldown', delayMs: state.cooldownUntil - now };
      if (config.dailyBudget !== undefined) {
        const today = dayKey(now);
        if (state.usedDay !== today) { state.usedDay = today; state.usedCount = 0; dirty.add(state); }
        if (state.usedCount >= config.dailyBudget) return { ok: false, reason: 'daily_budget', delayMs: Date.parse(today) + DAY_MS - now + 1000 };
      }
      if (now < state.nextAt) return { ok: false, reason: 'pace', delayMs: Math.ceil(state.nextAt - now) };
      return { ok: true };
    },
    take(accountKey, provider, cls) {
      const now = clock.now();
      const state = get(accountKey, provider, cls);
      state.nextAt = now + state.interval;
      const config = governorFor(getPolicy(), provider, cls);
      if (config.dailyBudget !== undefined) {
        const today = dayKey(now);
        if (state.usedDay !== today) { state.usedDay = today; state.usedCount = 0; }
        state.usedCount++;
        dirty.add(state);
        if (state.usedCount % 20 === 0) save(state);
      }
    },
    /**
     * Получен FLOOD_WAIT на seconds секунд. Пауза = seconds × cooldownFactor + небольшой джиттер, то есть строго не короче
     * заявленной. Применяется ко всем классам аккаунта: платформа не говорит, какой вызов внутри шага вызвал ограничение.
     * waitKind из собственных потолков Relay (RESOLVE_BUDGET, REQUEST_BUDGET, EMERGENCY_CAP) даёт только паузу: интервал не растёт,
     * в счёт размыкателя «FLOOD за час» это не идёт. Повторный FLOOD, пришедший внутри уже известной паузы, — это параллельный запрос,
     * начатый до неё: пауза продлевается при необходимости, но интервал и счёт размыкателя не растут второй раз за один случай.
     */
    flood(accountKey, provider, cls, seconds, { waitKind } = {}) {
      const now = clock.now();
      const policy = getPolicy().governor;
      const waitMs = Math.max(1000, Math.ceil(seconds * 1000));
      const cooldown = Math.ceil(waitMs * policy.cooldownFactor) + Math.floor(random() * Math.min(2000, waitMs * 0.05));
      const state = get(accountKey, provider, cls);
      const config = governorFor(getPolicy(), provider, cls);
      const own = OWN_CAP_WAIT_KINDS.includes(waitKind);
      const concurrent = !own && now < state.cooldownUntil;
      let breaker;
      if (!own && !concurrent) {
        state.interval = Math.min(config.maxIntervalMs, state.interval * policy.backoffFactor);
        state.lastErrorAt = now;
        state.floods = [...state.floods.filter(time => now - time < HOUR_MS), now];
        if (state.floods.length >= policy.breaker.floodsPerHour) {
          breaker = now + policy.breaker.openMs;
          state.breakerUntil = Math.max(state.breakerUntil, breaker);
          state.floods = [];
        }
      }
      // Исчерпанный бюджет разрешения имён Relay (RESOLVE_BUDGET) касается только класса resolve: шаги history уже разрешённых каналов идут дальше.
      for (const other of waitKind === 'RESOLVE_BUDGET' ? ['resolve'] : REQUEST_CLASSES) {
        const target = get(accountKey, provider, other);
        target.cooldownUntil = Math.max(target.cooldownUntil, now + cooldown);
        if (breaker) target.breakerUntil = Math.max(target.breakerUntil, breaker);
        if (target !== state && !own && !concurrent) target.lastErrorAt = now;
        save(target);
      }
      save(state);
      audit?.append('flood_wait', { account: accountKey, class: cls, seconds: Math.ceil(seconds), ...(waitKind ? { waitKind } : {}), cooldownUntil: new Date(now + cooldown).toISOString() });
      if (breaker) audit?.append('breaker_open', { account: accountKey, class: cls, until: new Date(breaker).toISOString(), floodsPerHour: policy.breaker.floodsPerHour });
      return { cooldownUntil: now + cooldown, breakerUntil: breaker, longWait: seconds > policy.longWaitSeconds, ownCap: own || undefined, concurrent: concurrent || undefined };
    },
    /** Жёсткое ограничение без срока (PEER_FLOOD и подобные): размыкатель до решения владельца. */
    openUntilOwner(accountKey, provider, cls) {
      const state = get(accountKey, provider, cls);
      for (const other of REQUEST_CLASSES) { const target = get(accountKey, provider, other); target.breakerUntil = Number.MAX_SAFE_INTEGER; save(target); }
      audit?.append('breaker_open', { account: accountKey, class: cls, until: 'owner_decision' });
      return state;
    },
    /** Снимает только размыкатель «до решения владельца»; пауза FLOOD_WAIT и обычный размыкатель по времени остаются. */
    closeOwnerBreaker(accountKey) {
      for (const state of states.values()) if (state.accountKey === accountKey && state.breakerUntil === Number.MAX_SAFE_INTEGER) { state.breakerUntil = 0; save(state); audit?.append('breaker_closed_by_owner', { account: accountKey, class: state.cls }); }
    },
    flush() { for (const state of [...dirty]) save(state); },
    snapshot(accountKey, provider) {
      const now = clock.now();
      const result = { state: 'ok', classes: {}, usedToday: {} };
      for (const cls of REQUEST_CLASSES) {
        const state = states.get(`${accountKey}|${cls}`);
        if (!state) continue;
        grow(state, provider, now);
        result.classes[cls] = { intervalMs: Math.round(state.interval) };
        if (state.usedDay === dayKey(now)) result.usedToday[cls] = state.usedCount;
        if (now < state.breakerUntil) { result.state = 'open'; result.until = state.breakerUntil >= Number.MAX_SAFE_INTEGER ? undefined : new Date(state.breakerUntil).toISOString(); }
        else if (now < state.cooldownUntil && result.state !== 'open') { result.state = 'cooldown'; result.until = new Date(state.cooldownUntil).toISOString(); }
        else if (result.state === 'ok' && state.interval > governorFor(getPolicy(), provider, cls).initialIntervalMs) result.state = 'backoff';
      }
      return result;
    },
    intervalFor(accountKey, provider, cls) { return get(accountKey, provider, cls).interval; },
  };
}
