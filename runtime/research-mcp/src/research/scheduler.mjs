// Планировщик задач оркестратора. Один шаг = один запрос к мосту (≤ slice записей с курсором). Между шагами —
// регулятор темпа аккаунта; FLOOD_WAIT, обрывы моста, смена аккаунта и нехватка диска переводят работу в ожидание и
// возобновляют её сами. Чекпоинт шага атомарен: записи + курсор + счётчики в одной транзакции SQLite.
// Состояние «running» хранится только в памяти: после kill -9 задача возвращается в очередь с последним курсором.
import { normalizeRecord } from './normalize-item.mjs';
import { isoTime, isoToUnixSeconds } from './orch-core.mjs';
import { floodSecondsOf, floodWaitKindOf } from './governor.mjs';
import { assertReadAllowed } from './policy.mjs';

const TASK_STATES = ['pending', 'running', 'waiting', 'done', 'partial', 'denied', 'unavailable', 'failed', 'skipped'];
const TERMINAL_JOB = new Set(['completed', 'completed_with_gaps', 'failed', 'cancelled']);
const MAX_ATTEMPTS = 6;
const MAX_CURSOR_RESETS = 3;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 300000;
const STATUS_TTL_MS = 5000;
const PROGRESS_EVERY_MS = 5000;

const BRIDGE_CODES = new Set(['APP_BRIDGE_UNAVAILABLE', 'BRIDGE_TIMEOUT', 'BRIDGE_REPLY_LOST', 'BRIDGE_PROTOCOL_INVALID', 'BRIDGE_IDENTITY_UNCONFIRMED', 'BRIDGE_RUNTIME_CHANGED', 'BRIDGE_SERVER_UNCONFIRMED', 'BRIDGE_METADATA_INVALID', 'BRIDGE_TOKEN_INVALID', 'BRIDGE_FRAME_TOO_LARGE', 'BRIDGE_INSTALL_UNCONFIRMED', 'DAEMON_UNAVAILABLE', 'REPLY_TRANSPORT_UNAVAILABLE']);
const STALE_CODES = new Set(['STALE_ACCOUNT', 'CURSOR_SOURCE_MISMATCH', 'INVALID_CURSOR', 'CURSOR_ANCHOR_NOT_FOUND', 'CURSOR_STALE', 'STALE_CURSOR']);
const DENIED_CODES = new Set(['ACCESS_DENIED', 'INACCESSIBLE']);
const UNAVAILABLE_CODES = new Set(['SOURCE_UNAVAILABLE', 'DOM_SOURCE_UNSUPPORTED', 'UNSUPPORTED', 'THREAD_DOM_UNSUPPORTED', 'ARTICLE_DOM_UNSUPPORTED', 'EMPTY_SOURCE_NOT_CONFIRMED', 'TIMESTAMP_FILTER_UNSUPPORTED', 'SOURCE_CHANGED']);
// Ограничение аккаунта: Relay шлёт ACCOUNT_RESTRICTED (PEER_FLOOD, USER_DEACTIVATED*); остальные — запас на прямые коды платформы.
const OWNER_CODES = new Set(['PEER_FLOOD', 'ACCOUNT_RESTRICTED', 'USER_DEACTIVATED', 'SESSION_REVOKED']);

class Fifo {
  constructor() { this.items = []; this.head = 0; }
  get size() { return this.items.length - this.head; }
  push(value) { this.items.push(value); }
  peek() { return this.items[this.head]; }
  shift() {
    const value = this.items[this.head++];
    if (this.head > 1024 && this.head * 2 > this.items.length) { this.items = this.items.slice(this.head); this.head = 0; }
    return value;
  }
}

/** Класс ошибки шага → поведение планировщика. Сырые тексты платформы сюда не попадают: используется только code. */
export function classifyError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'ADAPTER_FAILED';
  // FLOOD_WAIT — синоним RATE_LIMITED на будущее: мост сегодня шлёт RATE_LIMITED с seconds/waitKind.
  if (code === 'RATE_LIMITED' || code === 'FLOOD_WAIT') return { kind: 'flood', code };
  // BUSY — Relay занят прошлой операцией, INITIALIZING — ещё запускается: оба ждут без траты попыток источника.
  if (code === 'PROVIDER_BUSY' || code === 'BUSY') return { kind: 'busy', code };
  if (code === 'INITIALIZING') return { kind: 'bridge', code };
  if (BRIDGE_CODES.has(code)) return { kind: 'bridge', code };
  if (STALE_CODES.has(code)) return { kind: 'stale', code };
  if (DENIED_CODES.has(code)) return { kind: 'denied', code };
  if (UNAVAILABLE_CODES.has(code)) return { kind: 'unavailable', code };
  if (code === 'CHALLENGE_REQUIRED') return { kind: 'challenge', code };
  if (code === 'AUTH_REQUIRED') return { kind: 'auth', code };
  if (code === 'DISK_RESERVE' || code === 'ENOSPC' || error?.errcode === 13 || /SQLITE_FULL|database or disk is full/i.test(String(error?.message))) return { kind: 'disk', code: 'DISK_RESERVE' };
  if (OWNER_CODES.has(code)) return { kind: 'owner', code };
  return { kind: 'transient', code: /^[A-Z_]{1,64}$/.test(code) ? code : 'ADAPTER_FAILED' };
}

export function createScheduler({ store, archive, governor, providers, clock, audit, getPolicy, diskFree, notify, random = Math.random }) {
  const jobs = new Map();        // jobId -> задание в памяти (только незавершённые)
  const tasks = new Map();       // taskId -> задача в памяти (только незавершённых заданий)
  const queues = new Map();      // provider -> Map(jobId -> { fresh, cont, turn })
  const waitHeap = new Map();    // provider -> отсортированный [{ until, taskId }]
  const running = new Map();     // provider -> Set(taskId)
  const holds = new Map();       // provider -> { reason, until } причина ожидания всей платформы (лимит, размыкатель, владелец)
  const statusCache = new Map(); // provider -> { value, at }
  const blocks = new Map();      // provider -> { reason, retryAt, attempts } недоступность моста/аккаунта/диска
  const controllers = new Map(); // taskId -> AbortController
  let diskState = { ok: true, checkedAt: -Infinity };
  let closing = false;
  let loopPromise;
  const wake = {};
  const resetWake = () => { wake.promise = new Promise(resolve => { wake.resolve = resolve; }); };
  resetWake();
  const poke = () => { wake.resolve(); resetWake(); };
  for (const provider of Object.keys(providers)) { queues.set(provider, new Map()); waitHeap.set(provider, []); running.set(provider, new Set()); }

  // ---------- счётчики и состояние заданий ----------
  const emptyCounts = () => Object.fromEntries(TASK_STATES.map(state => [state, 0]));
  function setTaskState(task, state) {
    const job = jobs.get(task.jobId);
    if (job) {
      job.counts[task.state]--; job.counts[state]++;
      if (task.state === 'pending') job.pending[task.provider]--;
      if (state === 'pending') job.pending[task.provider] = (job.pending[task.provider] ?? 0) + 1;
    }
    task.state = state;
  }
  function jobHold(job) {
    let best;
    const now = clock.now();
    for (const [provider, pending] of Object.entries(job.pending)) {
      if (pending <= 0) continue;
      const hold = holds.get(provider);
      const block = blocks.get(provider);
      const candidate = hold && (hold.until === undefined || hold.until > now) ? hold : block ? { reason: block.reason, until: block.retryAt } : undefined;
      if (candidate && (!best || (candidate.until ?? Infinity) < (best.until ?? Infinity))) best = candidate;
    }
    return best;
  }
  function earliestTaskWait(job) {
    let earliest;
    for (const heap of waitHeap.values()) for (const entry of heap) {
      const task = tasks.get(entry.taskId);
      if (task?.jobId === job.jobId && task.state === 'waiting' && (!earliest || entry.until < earliest.until)) {
        earliest = { until: entry.until, reason: task.waitingReason ?? 'retry_backoff' };
      }
    }
    return earliest;
  }
  function deriveJobState(job) {
    const c = job.counts;
    if (job.cancelled) return { state: 'cancelled' };
    if (c.pending + c.running + c.waiting === 0) {
      const gaps = c.partial + c.denied + c.unavailable + c.failed + c.skipped;
      if (c.failed > 0 && c.failed === gaps + c.done) return { state: 'failed', reason: 'all_sources_failed' };
      return gaps ? { state: 'completed_with_gaps', reason: 'gaps_listed_by_source' } : { state: 'completed' };
    }
    if (job.paused) return { state: 'paused', reason: job.reason === 'profile_binding_unknown' ? job.reason : 'paused_by_owner' };
    if (!getPolicy().read) return { state: 'waiting', reason: 'policy_denied' };
    if (c.running > 0) return { state: 'running' };
    const hold = jobHold(job);
    if (hold) return { state: 'waiting', reason: hold.reason, until: hold.until };
    if (c.waiting > 0 && c.pending === 0) return { state: 'waiting', ...earliestTaskWait(job) };
    if (!job.started) return { state: 'queued' };
    return { state: 'running' };
  }
  function refreshJob(job, { force = false } = {}) {
    if (job.finalized) return;
    const next = deriveJobState(job);
    if (next.state === job.state && next.reason === job.reason && !force) return;
    const previous = job.state;
    const now = clock.now();
    const terminal = TERMINAL_JOB.has(next.state);
    if (terminal) maybeProgress(job, now, true);
    job.state = next.state; job.reason = next.reason; job.until = next.until;
    store.run('UPDATE jobs SET state=?, state_reason=?, finished_at=?, paused=?, items_new=?, items_dup=?, requests=? WHERE job_id=?', next.state, next.reason ?? null, terminal ? now : null, job.paused ? 1 : 0, job.itemsNew, job.itemsDup, job.requests, job.jobId);
    const seq = store.appendEvent(job.jobId, null, 'job_state', { state: next.state, reason: next.reason, until: next.until ? isoTime(next.until) : undefined, from: previous });
    notify(job.jobId, seq);
    audit?.append('job_state', { jobId: job.jobId, state: next.state, reason: next.reason, from: previous });
    if (terminal) finalizeJob(job);
  }
  /** Завершённое задание выгружается из памяти: дальше его читают из БД. */
  function finalizeJob(job) {
    job.finalized = true;
    for (const taskId of job.taskIds) {
      const task = tasks.get(taskId);
      controllers.get(taskId)?.abort();
      if (task) tasks.delete(taskId);
    }
    for (const byJob of queues.values()) byJob.delete(job.jobId);
    for (const [provider, heap] of waitHeap) waitHeap.set(provider, heap.filter(entry => tasks.has(entry.taskId)));
    jobs.delete(job.jobId);
    audit?.flush();
    governor.flush();
  }
  function maybeProgress(job, now, force = false) {
    if (!force && now - job.progressAt < PROGRESS_EVERY_MS) return;
    job.progressAt = now;
    const seq = store.appendEvent(job.jobId, null, 'progress', { items: job.itemsNew, duplicates: job.itemsDup, sources: { ...job.counts } });
    notify(job.jobId, seq);
  }

  // ---------- очереди ----------
  function enqueue(task) {
    const byJob = queues.get(task.provider);
    let entry = byJob.get(task.jobId);
    if (!entry) { entry = { fresh: new Fifo(), cont: new Fifo(), turn: 0 }; byJob.set(task.jobId, entry); }
    (task.cursor ? entry.cont : entry.fresh).push(task.taskId);
  }
  function insertWait(provider, until, taskId) {
    const heap = waitHeap.get(provider);
    let low = 0; let high = heap.length;
    while (low < high) { const mid = (low + high) >> 1; if (heap[mid].until <= until) low = mid + 1; else high = mid; }
    heap.splice(low, 0, { until, taskId });
  }
  function promoteDue(provider, now) {
    const heap = waitHeap.get(provider);
    while (heap.length && heap[0].until <= now) {
      const { taskId } = heap.shift();
      const task = tasks.get(taskId);
      if (!task || task.state !== 'waiting') continue;
      setTaskState(task, 'pending');
      task.waitingUntil = null; task.waitingReason = null;
      enqueue(task);
    }
  }

  // ---------- состояние платформы ----------
  async function providerStatus(provider, { force = false } = {}) {
    const cached = statusCache.get(provider);
    if (!force && cached && clock.now() - cached.at < STATUS_TTL_MS) return cached.value;
    let value;
    try { value = await providers[provider].status({ force }); } catch { value = { state: 'unavailable', operations: [], reason: 'status_failed' }; }
    statusCache.set(provider, { value, at: clock.now() });
    return value;
  }
  function eventsForProvider(provider, kind, data) {
    for (const job of jobs.values()) if ((job.pending[provider] ?? 0) > 0 || job.counts.running > 0) notify(job.jobId, store.appendEvent(job.jobId, null, kind, data));
  }
  function setBlock(provider, reason, minimumMs = BASE_BACKOFF_MS) {
    const previous = blocks.get(provider);
    const attempts = previous && previous.reason === reason ? previous.attempts + 1 : 1;
    const delay = Math.min(60000, minimumMs * 2 ** Math.min(attempts - 1, 4));
    blocks.set(provider, { reason, retryAt: clock.now() + delay, attempts });
    if (!previous || previous.reason !== reason) eventsForProvider(provider, 'bridge_state', { provider, state: reason });
    for (const job of jobs.values()) refreshJob(job);
    return delay;
  }
  function clearBlock(provider) {
    const previous = blocks.get(provider);
    if (!blocks.delete(provider)) return;
    if (previous.reason !== 'provider_busy') eventsForProvider(provider, 'bridge_state', { provider, state: 'ready' });
    for (const job of jobs.values()) refreshJob(job);
  }
  async function checkDisk() {
    const now = clock.now();
    if (now - diskState.checkedAt < 5000) return diskState.ok;
    let ok = true;
    try { ok = (await diskFree()) >= getPolicy().diskReserveGiB * 1024 ** 3; } catch { ok = true; }
    if (ok !== diskState.ok) { for (const job of jobs.values()) notify(job.jobId, store.appendEvent(job.jobId, null, ok ? 'disk_ok' : 'disk_low', {})); audit?.append(ok ? 'disk_ok' : 'disk_low', {}); }
    diskState = { ok, checkedAt: now };
    return ok;
  }

  // ---------- выбор задачи ----------
  /**
   * Первый шаг источника (без курсора) может потратить настоящее разрешение имени. Страницы по курсору его не тратят: Relay держит пира в кэше.
   * Если карточка источника (source_info) в этом задании уже собрана, имя разрешено и лежит в кэше Relay, второй раз бюджет не расходуется.
   */
  function needsResolve(task, adapter) {
    if (task.cursor) return false;
    if (adapter.resolvesPerStep) return true;
    if (task.provider !== 'telegram') return false;
    // Relay уже отвечал RESOLVE_BUDGET на этом шаге: его кэш имён пуст (перезапуск, смена epoch, вытеснение), готовый source_info имени не гарантирует.
    if (task.forceResolve) return true;
    return !store.one("SELECT 1 AS ok FROM tasks WHERE job_id=? AND source_id=? AND stage='source_info' AND state='done'", task.jobId, task.sourceId);
  }
  /** Возвращает { task, needs } либо { delayMs } — когда стоит проснуться снова. */
  function pick(provider, accountRef, accountKey, now) {
    const adapter = providers[provider];
    let delay; let hold;
    const order = [...queues.get(provider)].map(([jobId, entry]) => [jobs.get(jobId), entry]).filter(([job]) => job && !job.paused && !job.cancelled);
    order.sort((a, b) => b[0].priority - a[0].priority || a[0].lastServed - b[0].lastServed);
    for (const [, entry] of order) {
      for (const side of entry.turn === 0 ? ['fresh', 'cont'] : ['cont', 'fresh']) {
        const queue = entry[side];
        while (queue.size && tasks.get(queue.peek())?.state !== 'pending') queue.shift();
        if (!queue.size) continue;
        const task = tasks.get(queue.peek());
        if (!getPolicy().readPrivateThread && task.provider === 'telegram' && /^peer:\d+$/.test(task.source.canonical)) {
          queue.shift();
          endTask(task, 'denied', { code: 'ACCESS_DENIED', reason: 'private_dialog_denied_by_policy' });
          delay = 1;
          continue;
        }
        if (task.accountRef !== accountRef) {
          queue.shift();
          waitTask(task, 'profile_changed', 5000);
          delay = Math.min(delay ?? 5000, 5000);
          continue;
        }
        const needs = task.stage === 'source_info' ? ['resolve'] : [needsResolve(task, adapter) ? 'resolve' : null, 'history'].filter(Boolean);
        let blockedBy;
        for (const cls of needs) { const gate = governor.gate(accountKey, provider, cls); if (!gate.ok) { blockedBy = gate; break; } }
        if (blockedBy) {
          delay = delay === undefined ? blockedBy.delayMs : Math.min(delay, blockedBy.delayMs);
          if (blockedBy.reason !== 'pace') hold = { reason: blockedBy.reason === 'breaker' && blockedBy.delayMs > 30 * 86400000 ? 'awaiting_owner' : 'rate_limit', until: blockedBy.delayMs > 30 * 86400000 ? undefined : now + blockedBy.delayMs };
          continue;
        }
        queue.shift();
        entry.turn = 1 - entry.turn;
        for (const cls of needs) governor.take(accountKey, provider, cls);
        return { task, needs };
      }
    }
    if (hold) holds.set(provider, hold);
    return { delayMs: delay };
  }

  // ---------- выполнение шага ----------
  const backoffMs = attempts => { const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1)); return base + Math.floor(random() * base * 0.1); };
  function waitTask(task, reason, ms) {
    const until = clock.now() + ms;
    store.run('UPDATE tasks SET state=?, waiting_until=?, waiting_reason=?, last_error=?, attempts=?, cursor=?, cursor_account=?, cursor_resets=?, items=?, oldest_ts=?, offset_date=?, updated_at=? WHERE task_id=?',
      'waiting', until, reason, task.lastError ?? null, task.attempts, task.cursor ?? null, task.cursorAccount ?? null, task.cursorResets, task.items, task.oldestTs ?? null, task.offsetDate ?? null, clock.now(), task.taskId);
    task.waitingUntil = until; task.waitingReason = reason;
    setTaskState(task, 'waiting');
    insertWait(task.provider, until, task.taskId);
  }
  function endTask(task, state, { reason, code, emptyConfirmed = false } = {}) {
    const now = clock.now();
    store.tx(() => {
      store.run('UPDATE tasks SET state=?, gap_reason=?, last_error=?, waiting_until=NULL, waiting_reason=NULL, empty_confirmed=?, partial=?, updated_at=? WHERE task_id=?', state, reason ?? null, code ?? null, emptyConfirmed ? 1 : 0, state === 'partial' ? 1 : 0, now, task.taskId);
      store.run('UPDATE sources SET state=?, state_reason=?, last_checked=?, empty_confirmed=? WHERE source_id=?', state, reason ?? code ?? null, now, emptyConfirmed ? 1 : 0, task.sourceId);
      notify(task.jobId, store.appendEvent(task.jobId, task.sourceId, 'source_state', { state, reason: reason ?? code }));
    });
    setTaskState(task, state);
  }
  function returnTask(task) { setTaskState(task, 'pending'); enqueue(task); }
  /** Тот же аккаунт Relay (accountRef), сменилась только сессия клиента (epoch): курсор мог потерять привязку, но якорь источника цел. */
  const sameAccountOtherEpoch = (cursorAccount, accountScope) => typeof cursorAccount === 'string' && cursorAccount !== `${accountScope.accountRef}:${accountScope.accountEpoch}` && cursorAccount.startsWith(`${accountScope.accountRef}:`);
  /**
   * Курсор привязан к аккаунту и эпохе: при смене источник продолжается заново (дубликаты отсекает хранилище).
   * Telegram-история продолжается с offsetDate самой старой уже собранной записи (+1 с: граничная запись придёт дублем, а не потеряется), счётчик items
   * не обнуляется. Если при этом сменилась только эпоха при том же accountRef (перезапуск Relay), это не потеря якоря и в счёт из MAX_CURSOR_RESETS не идёт.
   * Остальное (X, Instagram с DOM-якорем, нет объявленного offset_date, нет собранных записей) — прежнее поведение: чтение с начала и items = 0.
   */
  function resetCursor(task, reason, accountId, accountScope) {
    const resumable = task.provider === 'telegram' && task.stage === 'posts' && Number.isSafeInteger(task.oldestTs) && task.oldestTs > 0 && providers[task.provider].hasFeature?.('offset_date') === true;
    const epochOnly = resumable && accountScope !== undefined && sameAccountOtherEpoch(task.cursorAccount, accountScope);
    if (!epochOnly) {
      task.cursorResets++;
      if (task.cursorResets > MAX_CURSOR_RESETS) return false;
    }
    task.cursor = null; task.cursorAccount = accountId;
    if (resumable) task.offsetDate = task.oldestTs + 1;
    else { task.items = 0; task.offsetDate = undefined; task.oldestTs = undefined; }
    notify(task.jobId, store.appendEvent(task.jobId, task.sourceId, 'cursor_reset', { reason }));
    return true;
  }

  async function runTask(task, needs, status) {
    const adapter = providers[task.provider];
    const job = jobs.get(task.jobId);
    const controller = new AbortController();
    controllers.set(task.taskId, controller);
    running.get(task.provider).add(task.taskId);
    setTaskState(task, 'running');
    if (!job.started) { job.started = true; store.run('UPDATE jobs SET started_at=COALESCE(started_at, ?) WHERE job_id=?', clock.now(), job.jobId); }
    refreshJob(job);
    const accountScope = { accountRef: status.accountRef, accountEpoch: status.accountEpoch };
    const accountKey = `${task.provider}:${accountScope.accountRef}`;
    const accountId = `${accountScope.accountRef}:${accountScope.accountEpoch}`;
    let aborted = false;
    try {
      assertReadAllowed(getPolicy());
      if (task.cursor && task.cursorAccount && task.cursorAccount !== accountId && !resetCursor(task, 'account_changed', accountId, accountScope)) { endTask(task, 'failed', { code: 'STALE_ACCOUNT', reason: 'account_unstable' }); return; }
      const slice = getPolicy().limits.sliceRecords;
      const remaining = task.limit === undefined ? slice : Math.max(1, Math.min(slice, task.limit - task.items));
      audit?.count(accountKey, needs.join('+'), task.stage === 'source_info' ? 'source_info' : 'channel_history');
      const step = await adapter.step({ stage: task.stage, source: task.source, cursor: task.cursor ?? undefined, limit: remaining, after: isoToUnixSeconds(job.goal.after), before: isoToUnixSeconds(job.goal.before), topicId: job.goal.topicId, minId: task.minId, offsetDate: task.offsetDate, accountScope, signal: controller.signal });
      // Частичный успех (done с floodWait): пауза платформы вступает в силу сразу, ещё до чекпоинта, иначе планировщик успел бы отправить
      // следующий шаг в окно паузы. Страница фиксируется ниже как обычная.
      if (step.floodWait) applyFlood(task, step.floodWait, accountKey);
      if (controller.signal.aborted || job.cancelled) { aborted = true; return; }
      await checkpoint(task, job, step, accountId, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || job.cancelled) { aborted = true; return; }
      await handleError(task, error, accountKey);
    } finally {
      controllers.delete(task.taskId);
      running.get(task.provider).delete(task.taskId);
      if (aborted && task.state === 'running') {
        if (controller.signal.reason?.code === 'POLICY_DENIED') returnTask(task);
        else setTaskState(task, 'pending');
      }
      refreshJob(job);
      poke();
    }
  }

  async function checkpoint(task, job, step, accountId, signal) {
    assertReadAllowed(getPolicy());
    const now = clock.now();
    const kept = []; const lines = []; let skipped = 0;
    for (const record of step.records) {
      const result = normalizeRecord(task.provider, record);
      if (result.skip) { skipped++; continue; }
      kept.push(result.item);
      lines.push(Buffer.from(JSON.stringify({ v: 1, src: task.sourceId, job: task.jobId, at: now, rec: record })));
    }
    const fetched = step.records.length;
    // Самая старая запись задачи: якорь для продолжения по offsetDate, если курсор будет потерян (только Telegram).
    let oldestTs = task.oldestTs;
    if (task.provider === 'telegram') for (const item of kept) if (item.type === 'post' && item.ts > 0 && (oldestTs === undefined || item.ts < oldestTs)) oldestTs = item.ts;
    const itemsTotal = task.items + fetched;
    const limitReached = task.limit !== undefined && itemsTotal >= task.limit;
    const hasMore = Boolean(step.nextCursor);
    const finished = !hasMore || limitReached;
    const cursorAfter = hasMore ? step.nextCursor : null;
    let taskState = 'pending'; let gapReason; let emptyConfirmed = false;
    if (finished) {
      emptyConfirmed = step.outcome === 'empty' && itemsTotal === 0 && !step.partial;
      if (step.partial && !hasMore) { taskState = 'partial'; gapReason = 'platform_partial'; }
      else if (itemsTotal === 0 && !emptyConfirmed) { taskState = 'partial'; gapReason = 'empty_not_confirmed'; }
      else taskState = 'done';
    }
    const events = [];
    if (finished && taskState !== 'done') events.push({ kind: 'source_state', data: { state: taskState, reason: gapReason } });
    if (skipped) events.push({ kind: 'records_skipped', data: { count: skipped } });
    // Дубли отбрасываются до записи в архив, чтобы сегменты не копили осиротевшие строки; oldestTs выше считан по всем записям
    const { fresh, dropped } = store.freshIndexes(task.provider, task.sourceId, task.jobId, kept);
    const newItems = fresh.map(index => kept[index]);
    if (dropped) { const newLines = fresh.map(index => lines[index]); lines.length = 0; lines.push(...newLines); }
    const placed = lines.length ? await archive.append(task.provider, lines) : { locators: [], rotated: [], tail: undefined };
    let result;
    try {
      signal.throwIfAborted();
      assertReadAllowed(getPolicy());
      result = store.commitPage({
        task: { task_id: task.taskId }, sourceId: task.sourceId, provider: task.provider, jobId: task.jobId, items: newItems, droppedDuplicates: dropped, raw: placed,
        step: { fetched, cursor: cursorAfter, cursorAccount: accountId, oldestTs, offsetDate: task.offsetDate, taskState, emptyConfirmed, partial: taskState === 'partial', gapReason, limitReached,
          sourceState: taskState === 'pending' ? 'running' : taskState, sourceReason: gapReason, resumeCursor: cursorAfter, resumeAccount: cursorAfter ? accountId : null },
        events, now,
      });
      if (lines.length) archive.commit(task.provider);
    } catch (error) {
      if (lines.length) await archive.rollback(task.provider).catch(() => {});
      throw error;
    }
    task.items = itemsTotal; task.oldestTs = oldestTs; task.newItems += result.created; task.pages++; task.attempts = 0; task.cursor = cursorAfter; task.cursorAccount = accountId; task.forceResolve = false;
    job.lastServed = now; job.itemsNew += result.created; job.itemsDup += result.duplicates; job.requests++;
    for (const seq of result.seqs) notify(task.jobId, seq);
    setTaskState(task, taskState);
    if (taskState === 'pending') enqueue(task);
    maybeProgress(job, now);
  }

  /**
   * Пауза платформы. Секунды: error.seconds (приоритет), иначе retryAfterMs, иначе 30. Пауза не короче заявленной (×1,1 + джиттер в governor).
   * Собственные потолки Relay (waitKind RESOLVE_BUDGET/REQUEST_BUDGET/EMERGENCY_CAP) ставят только паузу, без роста интервала и без счёта размыкателя.
   */
  function applyFlood(task, source, accountKey) {
    const seconds = floodSecondsOf(source);
    const waitKind = floodWaitKindOf(source);
    const result = governor.flood(accountKey, task.provider, waitKind === 'RESOLVE_BUDGET' ? 'resolve' : 'history', seconds, { waitKind });
    notify(task.jobId, store.appendEvent(task.jobId, null, 'flood_wait', { seconds, ...(waitKind ? { waitKind } : {}), until: isoTime(result.cooldownUntil), breakerUntil: result.breakerUntil ? isoTime(result.breakerUntil) : undefined, longWait: result.longWait || undefined }));
    if (!result.ownCap && !result.concurrent) notify(task.jobId, store.appendEvent(task.jobId, null, 'throttle_change', { class: 'history', intervalMs: Math.round(governor.intervalFor(accountKey, task.provider, 'history')) }));
    // Пауза только класса resolve не останавливает платформу целиком: hold ставит pick(), если все задачи упёрлись в неё
    if (waitKind !== 'RESOLVE_BUDGET') holds.set(task.provider, { reason: 'rate_limit', until: result.breakerUntil ?? result.cooldownUntil });
    return result;
  }

  async function handleError(task, error, accountKey) {
    const info = classifyError(error);
    switch (info.kind) {
      case 'flood': {
        const result = applyFlood(task, error, accountKey);
        if (floodWaitKindOf(error) === 'RESOLVE_BUDGET') {
          // Бюджет разрешений исчерпан до сети: возврат в очередь «как есть» вертелся бы в темпе history. Задача спит до конца паузы resolve
          // и после неё снова считается нуждающейся в разрешении имени (см. needsResolve).
          task.forceResolve = true;
          waitTask(task, 'rate_limit', Math.max(1000, result.cooldownUntil - clock.now()));
        } else returnTask(task);
        return;
      }
      case 'busy': returnTask(task); blocks.set(task.provider, { reason: 'provider_busy', retryAt: clock.now() + 3000, attempts: 1 }); return;
      case 'bridge': case 'auth': case 'challenge':
        returnTask(task);
        statusCache.delete(task.provider);
        setBlock(task.provider, info.kind === 'bridge' ? 'bridge_unavailable' : info.kind === 'auth' ? 'account_unavailable' : 'challenge_required');
        if (info.kind === 'challenge') audit?.append('challenge_required', { provider: task.provider });
        return;
      case 'disk':
        returnTask(task);
        diskState = { ok: false, checkedAt: clock.now() };
        setBlock(task.provider, 'disk_low', 30000);
        notify(task.jobId, store.appendEvent(task.jobId, null, 'disk_low', {}));
        return;
      case 'stale': {
        statusCache.delete(task.provider);
        const status = await providerStatus(task.provider, { force: true });
        if (status.state !== 'ready') { returnTask(task); setBlock(task.provider, status.state === 'auth_required' ? 'account_unavailable' : 'bridge_unavailable'); return; }
        if (status.accountRef !== task.accountRef) { waitTask(task, 'profile_changed', 5000); return; }
        if (!resetCursor(task, info.code, `${status.accountRef}:${status.accountEpoch}`, { accountRef: status.accountRef, accountEpoch: status.accountEpoch })) { endTask(task, 'failed', { code: 'STALE_ACCOUNT', reason: 'account_unstable' }); return; }
        returnTask(task);
        return;
      }
      case 'denied': endTask(task, 'denied', { code: 'ACCESS_DENIED', reason: 'access_denied' }); return;
      case 'unavailable': endTask(task, 'unavailable', { code: info.code, reason: 'source_unavailable' }); return;
      case 'owner':
        returnTask(task);
        governor.openUntilOwner(accountKey, task.provider, 'history');
        holds.set(task.provider, { reason: 'awaiting_owner', until: undefined });
        notify(task.jobId, store.appendEvent(task.jobId, null, 'awaiting_owner', { code: info.code }));
        audit?.append('awaiting_owner', { provider: task.provider, code: info.code });
        return;
      default:
        task.attempts++;
        task.lastError = info.code;
        if (task.attempts >= MAX_ATTEMPTS) { endTask(task, 'failed', { code: info.code, reason: 'attempts_exceeded' }); return; }
        waitTask(task, 'retry_backoff', backoffMs(task.attempts));
    }
  }

  // ---------- главный цикл ----------
  /** Ёмкость платформы читается динамически: адаптер пересчитывает её по последнему готовому статусу Relay и лимиту владельца. */
  const capacityOf = provider => { const value = providers[provider].maxConcurrent; return Math.max(1, Math.min(Number.isSafeInteger(value) ? value : 1, 64)); };
  async function pass() {
    if (!getPolicy().read) {
      for (const job of jobs.values()) refreshJob(job);
      return Infinity;
    }
    const now = clock.now();
    let nextWake = Infinity;
    const diskOk = await checkDisk();
    for (const provider of Object.keys(providers)) {
      if (closing) break;
      promoteDue(provider, now);
      const heap = waitHeap.get(provider);
      if (heap.length) nextWake = Math.min(nextWake, heap[0].until);
      let hasWork = false;
      for (const [jobId, entry] of queues.get(provider)) {
        const job = jobs.get(jobId);
        if (!job || job.cancelled) { queues.get(provider).delete(jobId); continue; }
        if (!job.paused && (entry.fresh.size || entry.cont.size)) hasWork = true;
      }
      if (!hasWork) { holds.delete(provider); continue; }
      let block = blocks.get(provider);
      if (!diskOk) {
        if (!block || block.reason !== 'disk_low') setBlock(provider, 'disk_low', 30000);
        nextWake = Math.min(nextWake, blocks.get(provider).retryAt);
        continue;
      }
      if (block?.reason === 'disk_low') { clearBlock(provider); block = undefined; }
      if (block && block.retryAt > now) { nextWake = Math.min(nextWake, block.retryAt); continue; }
      // Ёмкость занята: статус не спрашиваем. Пока шаги идут, мост отвечает «занят» (provider_busy), и такой ответ нельзя принять за сбой моста.
      if (running.get(provider).size >= capacityOf(provider)) continue;
      const status = await providerStatus(provider, { force: Boolean(block) });
      if (!getPolicy().read) break;
      if (status.state === 'unavailable' && status.reason === 'provider_busy') {
        // Мост занят чужим запуском: подождать, а не объявлять его недоступным.
        blocks.set(provider, { reason: 'provider_busy', retryAt: clock.now() + 3000, attempts: 1 });
        nextWake = Math.min(nextWake, blocks.get(provider).retryAt);
        continue;
      }
      if (status.state !== 'ready' || status.accountRef === undefined || status.accountEpoch === undefined) {
        const reason = status.state === 'auth_required' ? 'account_unavailable' : status.state === 'challenge_required' ? 'challenge_required' : status.state === 'rate_limited' ? 'rate_limit' : 'bridge_unavailable';
        nextWake = Math.min(nextWake, clock.now() + setBlock(provider, reason));
        continue;
      }
      if (block) clearBlock(provider);
      const accountKey = `${provider}:${status.accountRef}`;
      while (!closing && running.get(provider).size < capacityOf(provider)) {
        const picked = pick(provider, status.accountRef, accountKey, clock.now());
        if (!picked.task) {
          if (picked.delayMs !== undefined) nextWake = Math.min(nextWake, clock.now() + Math.max(1, picked.delayMs));
          break;
        }
        holds.delete(provider);
        // Шаг может закончиться, когда БД уже закрыта (остановка демона): такой отказ не должен стать необработанным.
        runTask(picked.task, picked.needs, status).catch(() => {});
      }
    }
    for (const job of [...jobs.values()]) refreshJob(job);
    return nextWake;
  }

  async function loop() {
    while (!closing) {
      let nextWake;
      try { nextWake = await pass(); } catch { nextWake = clock.now() + 1000; }
      if (closing) break;
      const stop = new AbortController();
      const ms = Number.isFinite(nextWake) ? Math.max(1, nextWake - clock.now()) : 60000;
      await Promise.race([clock.sleep(ms, stop.signal), wake.promise]);
      stop.abort();
    }
  }

  // ---------- загрузка и управление ----------
  function registerJob(row, goal) {
    const job = { jobId: row.job_id, goal, priority: row.priority, paused: Boolean(row.paused), cancelled: false, started: Boolean(row.started_at), state: row.state, reason: row.state_reason ?? undefined,
      counts: emptyCounts(), pending: {}, lastServed: row.last_served_at ?? 0, itemsNew: row.items_new ?? 0, itemsDup: row.items_dup ?? 0, requests: row.requests ?? 0, progressAt: 0,
      estItems: row.est_items, taskIds: [], finalized: false };
    jobs.set(job.jobId, job);
    return job;
  }
  function attachTasks(job, rows) {
    for (const row of rows) {
      const state = TASK_STATES.includes(row.state) && row.state !== 'running' ? row.state : 'pending';
      const task = { taskId: row.task_id, jobId: row.job_id, sourceId: row.source_id, provider: row.provider, stage: row.stage, state, cursor: row.cursor, cursorAccount: row.cursor_account, attempts: row.attempts,
        cursorResets: row.cursor_resets, oldestTs: Number.isSafeInteger(row.oldest_ts) && row.oldest_ts > 0 ? row.oldest_ts : undefined, offsetDate: Number.isSafeInteger(row.offset_date) && row.offset_date > 0 ? row.offset_date : undefined, minId: Number.isSafeInteger(row.min_id) && row.min_id > 0 ? row.min_id : undefined, waitingUntil: row.waiting_until, waitingReason: row.waiting_reason, lastError: row.last_error, items: row.items, newItems: row.new_items, pages: row.pages,
        limit: job.goal.perSourceLimit, accountRef: row.account_ref, source: { ref: row.ref, kind: row.kind, canonical: row.canonical } };
      tasks.set(task.taskId, task);
      job.taskIds.push(task.taskId);
      job.counts[state]++;
      if (state === 'pending') { job.pending[task.provider] = (job.pending[task.provider] ?? 0) + 1; enqueue(task); }
      else if (state === 'waiting') insertWait(task.provider, task.waitingUntil ?? clock.now(), task.taskId);
    }
  }
  const taskRowsOf = jobId => store.all('SELECT t.*, s.ref, s.kind, s.canonical, s.account_ref FROM tasks t JOIN sources s ON s.source_id = t.source_id WHERE t.job_id=? ORDER BY t.task_id', jobId);

  return {
    /** После запуска демона: незавершённые задания продолжаются с последних подтверждённых курсоров. */
    recover() {
      const rows = store.all("SELECT * FROM jobs WHERE state NOT IN ('completed','completed_with_gaps','failed','cancelled')");
      for (const row of rows) {
        const job = registerJob(row, JSON.parse(row.goal_json));
        attachTasks(job, taskRowsOf(row.job_id));
        notify(job.jobId, store.appendEvent(job.jobId, null, 'resumed', { pending: job.counts.pending + job.counts.waiting }));
        audit?.append('job_resumed', { jobId: job.jobId });
        refreshJob(job, { force: true });
      }
      return rows.length;
    },
    addJob(row, goal) {
      const job = registerJob(row, goal);
      attachTasks(job, taskRowsOf(row.job_id));
      refreshJob(job, { force: true });
      poke();
      return job;
    },
    start() { loopPromise = loop(); },
    policyChanged(previous) {
      for (const [taskId, controller] of controllers) {
        if (!getPolicy().read || (previous.readPrivateThread && !getPolicy().readPrivateThread && tasks.get(taskId)?.provider === 'telegram')) {
          controller.abort(Object.assign(new Error('Owner policy revoked reading.'), { code: 'POLICY_DENIED' }));
        }
      }
      poke();
    },
    poke,
    pause(jobId) { const job = jobs.get(jobId); if (!job) return; job.paused = true; refreshJob(job); },
    resume(jobId) {
      const job = jobs.get(jobId);
      if (!job) return;
      job.paused = false;
      // Решение владельца снимает только размыкатель «до решения владельца»; паузы FLOOD_WAIT остаются в силе.
      // Только для провайдеров и аккаунтов самого задания. ОГРАНИЧЕНИЕ: resume доступен агенту MCP, так что настоящее «только владелец» требует отдельного механизма (не сделано).
      const jobProviders = new Set(job.taskIds.map(taskId => tasks.get(taskId)?.provider).filter(Boolean));
      for (const [provider, cached] of statusCache) if (jobProviders.has(provider) && cached.value.accountRef !== undefined) governor.closeOwnerBreaker(`${provider}:${cached.value.accountRef}`);
      for (const provider of jobProviders) holds.delete(provider);
      refreshJob(job, { force: true });
      poke();
    },
    cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) return;
      job.cancelled = true;
      store.tx(() => {
        for (const taskId of job.taskIds) {
          const task = tasks.get(taskId);
          if (!task) continue;
          controllers.get(taskId)?.abort();
          if (['pending', 'waiting', 'running'].includes(task.state)) {
            job.counts[task.state]--; job.counts.skipped++;
            if (task.state === 'pending') job.pending[task.provider]--;
            task.state = 'skipped';
            store.run("UPDATE tasks SET state='skipped', gap_reason='cancelled', updated_at=? WHERE task_id=? AND state IN ('pending','waiting','running')", clock.now(), taskId);
          }
        }
      });
      refreshJob(job, { force: true });
      poke();
    },
    /** Повтор источников в состояниях failed/partial: заново в очередь, курсор сохраняется. Возвращает число источников. */
    retryFailed(jobId, sourceIds) {
      const wanted = sourceIds?.length ? new Set(sourceIds) : undefined;
      const rows = store.all("SELECT task_id, source_id FROM tasks WHERE job_id=? AND state IN ('failed','partial')", jobId).filter(row => !wanted || wanted.has(row.source_id));
      if (!rows.length) return 0;
      store.tx(() => { for (const row of rows) store.run("UPDATE tasks SET state='pending', attempts=0, gap_reason=NULL, last_error=NULL, partial=0, updated_at=? WHERE task_id=?", clock.now(), row.task_id); });
      let job = jobs.get(jobId);
      if (job) {
        for (const row of rows) {
          const task = tasks.get(row.task_id);
          if (!task) continue;
          job.counts[task.state]--; task.state = 'pending'; task.attempts = 0; job.counts.pending++; job.pending[task.provider] = (job.pending[task.provider] ?? 0) + 1; enqueue(task);
        }
      } else {
        const jobRow = store.one('SELECT * FROM jobs WHERE job_id=?', jobId);
        store.run("UPDATE jobs SET state='running', finished_at=NULL WHERE job_id=?", jobId);
        job = registerJob({ ...jobRow, state: 'running', paused: 0 }, JSON.parse(jobRow.goal_json));
        attachTasks(job, taskRowsOf(jobId));
      }
      notify(jobId, store.appendEvent(jobId, null, 'retry_failed', { sources: rows.length }));
      refreshJob(job, { force: true });
      poke();
      return rows.length;
    },
    summary(jobId) {
      const job = jobs.get(jobId);
      return job ? { counts: { ...job.counts }, state: job.state, reason: job.reason, until: job.until, itemsNew: job.itemsNew, itemsDup: job.itemsDup, requests: job.requests } : undefined;
    },
    waiting(jobId) {
      const job = jobs.get(jobId);
      if (!job) return [];
      const result = new Map();
      const add = (reason, until, count) => {
        const entry = result.get(reason) ?? { reason, until, sources: 0 };
        entry.sources += count;
        if (until !== undefined && (entry.until === undefined || until < entry.until)) entry.until = until;
        result.set(reason, entry);
      };
      for (const heap of waitHeap.values()) for (const entry of heap) { const task = tasks.get(entry.taskId); if (task?.jobId === jobId) add(task.waitingReason ?? 'retry_backoff', entry.until, 1); }
      for (const [provider, pending] of Object.entries(job.pending)) {
        if (pending <= 0) continue;
        const hold = holds.get(provider) ?? (blocks.get(provider) && { reason: blocks.get(provider).reason, until: blocks.get(provider).retryAt });
        if (hold && (hold.until === undefined || hold.until > clock.now())) add(hold.reason, hold.until, pending);
      }
      return [...result.values()].map(entry => ({ reason: entry.reason, ...(entry.until !== undefined ? { until: isoTime(entry.until) } : {}), sources: entry.sources }));
    },
    queueDepth(provider) {
      let queued = 0;
      for (const entry of queues.get(provider).values()) queued += entry.fresh.size + entry.cont.size;
      return { queuedTasks: queued, runningTasks: running.get(provider).size };
    },
    activeJobs: () => jobs.size,
    taskInfo(taskId) { const task = tasks.get(taskId); return task ? { state: task.state === 'pending' ? 'queued' : task.state, items: task.items, attempts: task.attempts } : undefined; },
    isActive: jobId => jobs.has(jobId),
    async close() {
      closing = true;
      poke();
      for (const controller of controllers.values()) controller.abort();
      await loopPromise?.catch(() => {});
      for (let i = 0; i < 100 && [...running.values()].some(set => set.size); i++) await new Promise(resolve => setTimeout(resolve, 20));
    },
  };
}
