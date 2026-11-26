// Ядро оркестрации в демоне: источники → план → задание → результаты → экспорт. Источником данных служат шаговые
// адаптеры платформ (мост Relay либо синтетический провайдер); хранилище — SQLite; планировщик — scheduler.mjs.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { assertSafeDirectory, assertSafeFile } from './job-store.mjs';
import { openStore } from './orch-store.mjs';
import { createRawArchive } from './raw-archive.mjs';
import { createGovernor, floodSecondsOf, floodWaitKindOf } from './governor.mjs';
import { createScheduler, classifyError } from './scheduler.mjs';
import { createQueries } from './records-query.mjs';
import { normalizeRecord } from './normalize-item.mjs';
import { realClock } from './clock.mjs';
import { DEFAULT_POLICY, assertReadAllowed, checkJoin, governorFor } from './policy.mjs';
import { canonicalSource, readSourceFile, resolveSources, supportsHistory } from './source-input.mjs';
import { ORCHESTRATION_CONTRACT, createAccountAlias, OrchError, fail, isId, isObject, isoTime, isoToUnixSeconds, newId, parseIso, safeEcho, sha256, stable } from './orch-core.mjs';
import { RESEARCH_VERSION } from './config.mjs';
import { LOOKUPS, parseLookup, projectLookupRecord } from './lookup.mjs';

const STAGES = ['source_info', 'posts', 'comments', 'reactions', 'members', 'media_meta', 'media_files', 'transcripts'];
const NOT_IMPLEMENTED = { comments: 'stage_not_implemented', reactions: 'stage_not_implemented', media_files: 'stage_not_implemented', transcripts: 'stage_not_implemented', members: 'disabled_by_policy' };
const TERMINAL = new Set(['completed', 'completed_with_gaps', 'failed', 'cancelled']);
const PRIORITY = { low: 0, normal: 1, high: 2 };
const LEGACY_IMPORT_OPERATIONS = new Set(['channel_history', 'chat_export', 'profile', 'chat_info']);

function only(params, allowed, name = 'arguments') {
  if (!isObject(params)) fail('INVALID_INPUT', `${name} must be an object.`);
  for (const key of Object.keys(params)) if (!allowed.includes(key)) fail('INVALID_INPUT', `${name}.${key} is not supported.`);
}
const hashKey = key => {
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) fail('INVALID_INPUT', 'idempotencyKey must be 8..128 characters.');
  return sha256('idem\u0000' + key);
};

export async function createOrchestrator({ stateRoot, outputRoot, workspaceRoot, providers, clock = realClock, policy: loadedPolicy, audit, diskFree, random = Math.random, directory, autostart = true, archiveOptions = {}, storeOptions = {}, accountAlias, exportDeadlineMs } = {}) {
  // Наружу (social_status) уходит только алиас accountRef; внутри демона (регулятор, БД, мост) accountRef остаётся как есть.
  const aliasOf = accountAlias ?? audit?.accountAlias ?? createAccountAlias();
  const policyState = loadedPolicy ?? { policy: structuredClone(DEFAULT_POLICY), source: 'default' };
  const getPolicy = () => policyState.policy;
  const storeDirectory = directory ?? path.join(stateRoot, 'store');
  const startedAt = clock.now();
  const store = await openStore({ directory: storeDirectory, clock, ...storeOptions });
  const archive = createRawArchive({ directory: path.join(storeDirectory, 'raw'), ...archiveOptions });
  const damaged = await archive.open(store.all('SELECT provider, seq, committed_bytes, sealed FROM segments'));
  if (damaged.length) audit?.append('raw_segment_damaged', { segments: damaged });
  const governor = createGovernor({ store, clock, getPolicy, audit, random });
  governor.load();
  const free = diskFree ?? (async () => { const stat = await fs.statfs(storeDirectory); return Number(stat.bavail) * Number(stat.bsize); });

  // ---------- уведомления для long-poll ----------
  const jobSeq = new Map();
  const waiters = new Map();
  function notify(jobId, seq) {
    if (!jobId || !seq) return;
    if (seq > (jobSeq.get(jobId) ?? 0)) jobSeq.set(jobId, seq);
    const set = waiters.get(jobId);
    if (!set) return;
    for (const waiter of [...set]) if (seq > waiter.since) { set.delete(waiter); waiter.resolve(true); }
  }
  const currentSeq = jobId => {
    let seq = jobSeq.get(jobId);
    if (seq === undefined) { seq = store.one('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE job_id=?', jobId).seq; jobSeq.set(jobId, seq); }
    return seq;
  };
  function waitForChange(jobId, since, ms, signal) {
    return new Promise(resolve => {
      const stop = new AbortController();
      const waiter = { since, resolve: value => { stop.abort(); signal?.removeEventListener('abort', onAbort); resolve(value); } };
      const onAbort = () => { waiters.get(jobId)?.delete(waiter); waiter.resolve(false); };
      if (signal?.aborted) { resolve(false); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!waiters.has(jobId)) waiters.set(jobId, new Set());
      waiters.get(jobId).add(waiter);
      clock.sleep(ms, stop.signal).then(timedOut => { if (timedOut) { waiters.get(jobId)?.delete(waiter); signal?.removeEventListener('abort', onAbort); resolve(false); } });
    });
  }

  const scheduler = createScheduler({ store, archive, governor, providers, clock, audit, getPolicy, diskFree: free, notify, random });
  const queries = createQueries({ store, archive, clock, getPolicy, outputRoot });
  scheduler.recover();
  if (autostart) scheduler.start();
  // Сверка и пересборка текстового индекса идут в фоне порциями, не задерживая старт; запросы с query на это время помечаются неполными.
  setImmediate(() => { store.maintainFts(); });
  let closed = false;
  const exportsInFlight = new Map();

  const sourceIdOf = (source, accountRef) => 'src_' + sha256(stable([source.provider, source.canonical, aliasOf(accountRef)])).slice(0, 16);
  const legacySourceIdOf = source => 'src_' + sha256(`${source.provider}\u0000${source.canonical}`).slice(0, 16);

  async function providerState(provider) {
    let timer;
    try {
      return await Promise.race([providers[provider].status({ force: true }), new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'unavailable', operations: [], reason: 'provider_status_timeout' }), 5000); })]);
    } catch { return { state: 'unavailable', operations: [], reason: 'status_failed' }; }
    finally { clearTimeout(timer); }
  }
  const hasIdentity = state => state?.state === 'ready' && typeof state.accountRef === 'string' && state.accountRef && state.accountEpoch !== undefined;
  const currentStates = async names => new Map(await Promise.all([...new Set(names)].map(async provider => [provider, await providerState(provider)])));
  const jobAccounts = jobId => store.all(`SELECT DISTINCT s.provider, s.account_ref AS accountRef
    FROM tasks t JOIN sources s ON s.source_id=t.source_id WHERE t.job_id=? ORDER BY s.provider`, jobId);
  async function assertProfileAccess(bindings, legacyArchive = false) {
    assertReadAllowed(getPolicy());
    if (!bindings.length || bindings.every(row => row.accountRef === null)) {
      if (!legacyArchive) fail('ACCESS_DENIED', 'This archive has no verified account binding. Select the legacy archive explicitly.');
      return;
    }
    if (legacyArchive) fail('ACCESS_DENIED', 'The selected job belongs to a bound profile.');
    const states = await currentStates(bindings.map(row => row.provider));
    assertReadAllowed(getPolicy());
    for (const row of bindings) {
      const active = states.get(row.provider);
      if (!row.accountRef || !hasIdentity(active) || row.accountRef !== active.accountRef) fail('STALE_ACCOUNT', 'The profile bound to this job is not active. Switch to that profile.');
    }
  }
  function stagesOf(provider, status) {
    if (status.state !== 'ready') return [];
    const ops = status.operations ?? [];
    const stages = [];
    if (ops.includes(provider === 'telegram' ? 'chat_info' : 'profile')) stages.push('source_info');
    if (ops.includes('channel_history')) stages.push('posts', 'media_meta');
    return stages;
  }

  // ---------- plan ----------
  async function plan(params) {
    assertReadAllowed(getPolicy());
    only(params, ['sources', 'sourceFile', 'sourceListId', 'goal', 'accountRef', 'probe'], 'plan');
    const given = ['sources', 'sourceFile', 'sourceListId'].filter(key => params[key] !== undefined);
    if (given.length !== 1) fail('INVALID_INPUT', 'Provide exactly one of sources, sourceFile or sourceListId.');
    const goal = params.goal;
    only(goal, ['collect', 'after', 'before', 'query', 'perSourceLimit', 'mode', 'media', 'topicId'], 'goal');
    if (!Array.isArray(goal.collect) || !goal.collect.length || goal.collect.length > STAGES.length || goal.collect.some(stage => !STAGES.includes(stage))) fail('INVALID_INPUT', 'goal.collect must list known stages.');
    const collect = [...new Set(goal.collect)];
    const perSourceLimit = goal.perSourceLimit ?? 10000;
    if (!Number.isSafeInteger(perSourceLimit) || perSourceLimit < 1 || perSourceLimit > 10000000) fail('INVALID_INPUT', 'goal.perSourceLimit must be 1..10000000.');
    for (const name of ['after', 'before']) if (goal[name] !== undefined && isoToUnixSeconds(goal[name]) === undefined) fail('INVALID_INPUT', `goal.${name} must be an ISO 8601 date-time between 1970-01-01 and 2099-12-31.`);
    if (goal.after !== undefined && goal.before !== undefined && parseIso(goal.after) >= parseIso(goal.before)) fail('INVALID_INPUT', 'goal.after must be earlier than goal.before.');
    const mode = goal.mode ?? 'new';
    if (!['new', 'refresh', 'resume_all'].includes(mode)) fail('INVALID_INPUT', 'goal.mode must be new, refresh or resume_all.');
    const mediaPolicy = goal.media?.policy ?? 'none';
    if (goal.query !== undefined) fail('UNSUPPORTED', 'goal.query (search inside sources) is not available in this stage; collect history and search it with social_records.');

    let rows;
    let listNote;
    let savedProfiles;
    if (params.sources !== undefined) {
      if (!Array.isArray(params.sources) || !params.sources.length || params.sources.length > 200) fail('INVALID_INPUT', 'sources must have 1..200 entries.');
      rows = params.sources.map(entry => (isObject(entry) ? entry : {}));
    } else if (params.sourceFile !== undefined) {
      const parsed = await readSourceFile(params.sourceFile, { workspaceRoot });
      rows = parsed.rows;
      listNote = parsed.rejected;
    } else {
      if (!isId(params.sourceListId, 'lst')) fail('INVALID_INPUT', 'sourceListId is invalid.');
      const saved = store.listSources(params.sourceListId);
      if (!saved.length) fail('NOT_FOUND', 'The saved source list was not found.');
      savedProfiles = new Map(saved.map(row => [row.provider, row.accountRef]));
      rows = saved.map(row => ({ provider: row.provider, ref: row.ref, kind: row.kind, label: row.label }));
    }
    const resolved = resolveSources(rows);
    // Положительный числовой ID Telegram — пользователь или бот, то есть личный диалог: без readPrivateThread в policy.json он не планируется.
    const privateDenied = getPolicy().readPrivateThread ? 0 : resolved.sources.filter(source => source.provider === 'telegram' && /^peer:\d+$/.test(source.canonical)).length;
    if (privateDenied) resolved.sources = resolved.sources.filter(source => !(source.provider === 'telegram' && /^peer:\d+$/.test(source.canonical)));
    const invalid = [...(listNote ?? []).map(item => ({ ref: `line ${item.line}`, reason: item.reason })), ...resolved.invalid].slice(0, 20);
    const invalidCount = (listNote?.length ?? 0) + resolved.invalid.length;
    if (!resolved.sources.length) fail('INVALID_INPUT', `No valid sources (${invalidCount} rejected). Reasons: ${[...new Set(invalid.map(item => item.reason))].slice(0, 5).join(', ') || 'none given'}${privateDenied ? `; ${privateDenied} personal-dialog IDs are off by owner policy (readPrivateThread)` : ''}.`);
    if (resolved.sources.length > getPolicy().limits.maxSourcesPerJob) fail('INVALID_INPUT', `At most ${getPolicy().limits.maxSourcesPerJob} sources per job.`);

    const wantsPosts = collect.includes('posts') || collect.includes('media_meta');
    const wantsInfo = collect.includes('source_info');
    const unsupported = [];
    if (privateDenied) unsupported.push({ provider: 'telegram', stage: 'posts', reason: 'private_dialog_denied_by_policy', count: privateDenied });
    for (const stage of collect) if (NOT_IMPLEMENTED[stage]) unsupported.push({ stage, reason: NOT_IMPLEMENTED[stage] });
    const activeProfiles = await currentStates(resolved.sources.map(source => source.provider));
    for (const [provider, state] of activeProfiles) {
      if (!hasIdentity(state)) fail('AUTH_REQUIRED', 'Connect the profile for each selected platform before planning.');
      if (params.accountRef !== undefined && aliasOf(state.accountRef) !== params.accountRef) fail('STALE_ACCOUNT', 'The selected profile is no longer active.');
      if (savedProfiles && savedProfiles.get(provider) !== state.accountRef) fail('STALE_ACCOUNT', 'The saved list is not bound to the active profile. Create a new plan from its sources.');
    }
    const sources = resolved.sources.map(source => {
      const accountRef = activeProfiles.get(source.provider).accountRef;
      return { ...source, accountRef, sourceId: sourceIdOf(source, accountRef) };
    });
    const byProvider = {};
    let historySources = 0; let infoSources = 0;
    const statuses = {};
    for (const source of sources) {
      byProvider[source.provider] = (byProvider[source.provider] ?? 0) + 1;
      statuses[source.provider] ??= activeProfiles.get(source.provider);
      if (wantsPosts) { if (supportsHistory(source)) historySources++; else unsupported.push({ provider: source.provider, stage: 'posts', reason: `kind_${source.kind}_not_supported`, count: 1 }); }
      if (wantsInfo) { if (['channel', 'group', 'profile'].includes(source.kind)) infoSources++; else unsupported.push({ provider: source.provider, stage: 'source_info', reason: `kind_${source.kind}_not_supported`, count: 1 }); }
    }
    if (!historySources && !infoSources) fail('INVALID_INPUT', 'None of the sources has a stage that this build can collect (posts or source_info for channels, profiles and hashtags).');
    // Одинаковые причины схлопываются: ответ остаётся компактным при тысячах источников.
    const merged = new Map();
    for (const entry of unsupported) { const key = `${entry.provider ?? ''}|${entry.stage}|${entry.reason}`; const prior = merged.get(key); if (prior) prior.count = (prior.count ?? 1) + (entry.count ?? 1); else merged.set(key, { ...entry }); }
    const unsupportedList = [...merged.values()].slice(0, 20);

    // Оценка. Числа сообщений даёт probe Relay (этап 2): точный счёт по всем источникам — basis count_probe, по выборке — sample.
    // Неизвестное число (probe не вернул messages, не объявлен, сбой) — верхняя граница perSourceLimit на источник.
    const probing = params.probe !== false;
    const notes = [];
    let basis = 'unknown'; let min = 0; let max = 0; let probedRequests;
    const probeAttempts = {};
    if (wantsPosts) {
      const historyList = sources.filter(supportsHistory);
      const known = new Map();       // sourceId -> число сообщений (с учётом perSourceLimit)
      const unknownProbed = new Set(); // probe выполнен, но число неизвестно
      const approximate = new Set();   // число сообщений приблизительное (probe.inexact содержит messages)
      const stopped = new Set();     // платформы, на которых пробы прекращены (сбой, пауза аккаунта)
      const failures = new Set();
      const capable = source => probing && statuses[source.provider]?.state === 'ready' && providers[source.provider].supportsProbe === true && typeof providers[source.provider].probe === 'function';
      const perProvider = {};
      const sample = [];
      for (const source of historyList) {
        if (sample.length >= 25 || !capable(source)) continue;
        const cap = providers[source.provider].probeSample ?? 25;
        if ((perProvider[source.provider] ?? 0) >= cap) continue;
        perProvider[source.provider] = (perProvider[source.provider] ?? 0) + 1;
        sample.push(source);
      }
      for (const source of sample) {
        if (stopped.has(source.provider)) continue;
        const status = statuses[source.provider];
        const accountKey = `${source.provider}:${status.accountRef}`;
        // Во время паузы, размыкателя или исчерпанного суточного бюджета аккаунта проб нет; обычный темп (pace) план не ждёт.
        const gate = governor.gate(accountKey, source.provider, 'resolve');
        if (!gate.ok && gate.reason !== 'pace') { stopped.add(source.provider); failures.add(gate.reason); continue; }
        governor.take(accountKey, source.provider, 'resolve');
        audit?.count(accountKey, 'resolve', 'probe');
        probeAttempts[source.provider] = (probeAttempts[source.provider] ?? 0) + 1;
        let result;
        try { result = await providers[source.provider].probe({ source, accountScope: { accountRef: status.accountRef, accountEpoch: status.accountEpoch } }); }
        catch (error) {
          stopped.add(source.provider);
          const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'ADAPTER_FAILED';
          failures.add(code);
          if (classifyError(error).kind === 'flood') governor.flood(accountKey, source.provider, 'resolve', floodSecondsOf(error), { waitKind: floodWaitKindOf(error) });
          continue;
        }
        if (Number.isSafeInteger(result?.items) && result.items >= 0) { known.set(source.sourceId, Math.min(perSourceLimit, result.items)); if (Array.isArray(result.inexact) && result.inexact.includes('messages')) approximate.add(source.sourceId); } else unknownProbed.add(source.sourceId);
      }
      const exact = historyList.length > 0 && known.size === historyList.length && approximate.size === 0;
      if (exact) {
        const total = [...known.values()].reduce((sum, value) => sum + value, 0);
        probedRequests = [...known.values()].reduce((sum, value) => sum + Math.max(1, Math.ceil(value / getPolicy().limits.sliceRecords)), 0);
        basis = 'count_probe'; max = total; min = total;
      } else if (known.size > 0) {
        basis = 'sample';
        for (const provider of new Set(historyList.map(source => source.provider))) {
          const mine = historyList.filter(source => source.provider === provider);
          const mineKnown = mine.filter(source => known.has(source.sourceId));
          const mineUnknown = mine.filter(source => !known.has(source.sourceId));
          if (!mineKnown.length) { max += mine.length * perSourceLimit; continue; }
          const total = mineKnown.reduce((sum, source) => sum + known.get(source.sourceId), 0);
          const unprobedHere = mineUnknown.filter(source => !unknownProbed.has(source.sourceId)).length;
          const unknownHere = mineUnknown.length - unprobedHere;
          if (unprobedHere === 0 && !mineKnown.some(source => approximate.has(source.sourceId))) { max += total; min += total; } else {
            const average = total / mineKnown.length;
            max += Math.ceil(average * (mineKnown.length + unprobedHere) * 1.2); min += Math.floor(average * (mineKnown.length + unprobedHere) * 0.8);
          }
          max += unknownHere * perSourceLimit;
        }
      } else max = historyList.length * perSourceLimit;
      if (probing && known.size === 0 && !unknownProbed.size && !failures.size) notes.push('probe_unavailable: the bridge does not advertise the probe operation; estimate is an upper bound by perSourceLimit.');
      if (failures.size) notes.push(`probe_failed: ${[...failures].slice(0, 3).join(', ')}; the rest is an upper bound by perSourceLimit or an extrapolation from the sample.`);
      if (unknownProbed.size) notes.push(`probe_count_unknown: ${unknownProbed.size} sources returned no message count; counted as perSourceLimit.`);
      if (known.size && known.size < historyList.length) notes.push(`probe_sample: ${known.size} of ${historyList.length} sources were counted; the rest is extrapolated or an upper bound.`);
      if (approximate.size) notes.push(`probe_inexact: ${approximate.size} message counts are approximate; the estimate keeps a margin.`);
      if (known.size) notes.push(`probe_used: ${known.size} sources counted by the bridge (basis ${basis}).`);
    }
    if (mode === 'refresh') {
      const refreshing = [...new Set(sources.map(source => source.provider))].filter(provider => providers[provider].hasFeature?.('min_id'));
      notes.push(refreshing.length
        ? 'refresh_uses_min_id: Telegram sources whose history was collected completely read only messages newer than the newest known one; other sources are read in full and the store drops duplicates.'
        : 'refresh_is_full_pass: the bridge does not advertise min_id; every source is read in full and the store drops duplicates.');
    }
    if (goal.topicId !== undefined && sources.some(source => source.provider !== 'telegram')) notes.push('topic_id_telegram_only: goal.topicId applies to Telegram history; X and Instagram sources ignore it.');
    if (mediaPolicy !== 'none') notes.push('media_files_not_implemented: only media metadata is stored in this stage.');
    const slice = getPolicy().limits.sliceRecords;
    const historyRequests = wantsPosts ? (probedRequests ?? historySources * Math.max(1, Math.ceil(max / Math.max(1, historySources) / slice))) : 0;
    const requests = {};
    const provider0 = Object.keys(byProvider);
    for (const provider of provider0) {
      const count = sources.filter(source => source.provider === provider && supportsHistory(source)).length;
      const infos = sources.filter(source => source.provider === provider && ['channel', 'group', 'profile'].includes(source.kind) && wantsInfo).length;
      const share = historySources ? count / historySources : 0;
      requests[`${provider}.history`] = Math.round(historyRequests * share);
      const resolves = (providers[provider].resolvesPerStep ? count : 0) + infos + (probeAttempts[provider] ?? 0);
      if (resolves) requests[`${provider}.resolve`] = resolves;
    }
    let durationP50 = 0;
    for (const provider of provider0) {
      const status = statuses[provider];
      const account = status.accountRef ?? 'plan';
      const historyInterval = governor.intervalFor(`${provider}:${account}`, provider, 'history');
      const resolveCfg = governorFor(getPolicy(), provider, 'resolve');
      const history = (requests[`${provider}.history`] ?? 0) * historyInterval;
      const resolves = requests[`${provider}.resolve`] ?? 0;
      let resolveTime = resolves * resolveCfg.initialIntervalMs;
      if (resolveCfg.dailyBudget !== undefined && resolveCfg.dailyBudget > 0 && resolves > resolveCfg.dailyBudget) resolveTime = Math.max(resolveTime, (Math.ceil(resolves / resolveCfg.dailyBudget) - 1) * 86400000);
      durationP50 = Math.max(durationP50, history + resolveTime);
    }
    // Запас на FLOOD_WAIT: опыт Telegram — до трети времени в паузах при плотном обходе (гипотеза до пилота этапа 2).
    const estimate = { items: { min, max, basis }, mediaBytes: { min: 0, max: 0, basis: 'unknown' }, durationMs: { p50: Math.round(durationP50), p90: Math.round(durationP50 * 1.6) }, accountRequests: requests };

    const reasons = []; let level = 'low';
    const bump = to => { if (['low', 'medium', 'high'].indexOf(to) > ['low', 'medium', 'high'].indexOf(level)) level = to; };
    if (byProvider.x) { reasons.push('x_reads_rendered_pages_terms_may_forbid_automation'); bump(byProvider.x > 200 ? 'high' : 'medium'); }
    if (byProvider.instagram) { reasons.push('instagram_has_aggressive_protection_terms_may_forbid_automation'); bump(byProvider.instagram > 50 ? 'high' : 'medium'); }
    if ((byProvider.telegram ?? 0) > 1000) { reasons.push('many_telegram_sources_resolve_flood_risk'); bump(byProvider.telegram > 3000 ? 'high' : 'medium'); }
    for (const provider of provider0) {
      const resolveCfg = governorFor(getPolicy(), provider, 'resolve');
      if (resolveCfg.dailyBudget && (requests[`${provider}.resolve`] ?? 0) > resolveCfg.dailyBudget) { reasons.push(`${provider}_resolve_budget_exceeds_one_day`); bump('medium'); }
    }
    if (max > 5000000) { reasons.push('very_large_collection'); bump('medium'); }
    const confirmationReasons = [];
    if (sources.length > getPolicy().confirm.sources) confirmationReasons.push(`sources_over_${getPolicy().confirm.sources}`);
    if (max > getPolicy().confirm.items) confirmationReasons.push(`items_over_${getPolicy().confirm.items}`);
    if (level === 'high') confirmationReasons.push('risk_high');
    for (const [provider, status] of Object.entries(statuses)) if (status.state !== 'ready') notes.push(`provider_${provider}_${status.state}: the job will wait until it is ready.`);

    if (Object.keys(probeAttempts).length) await assertProfileAccess(sources);
    const listId = 'lst_' + sha256(stable(sources.map(source => [source.sourceId, source.kind, source.label ?? null]))).slice(0, 16);
    const now = clock.now();
    const planId = newId('pln');
    const planGoal = { collect, after: goal.after, before: goal.before, perSourceLimit, mode, media: { policy: mediaPolicy }, topicId: goal.topicId };
    const expiresAt = now + getPolicy().limits.planTtlMinutes * 60000;
    store.tx(() => {
      store.upsertSources(sources);
      store.saveList(listId, sources);
      store.run('INSERT INTO plans(plan_id, created_at, expires_at, list_id, goal_json, account_ref, estimate_json, risk_json, confirmation_json, spec_hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
        planId, now, expiresAt, listId, JSON.stringify(planGoal), params.accountRef ?? null, JSON.stringify(estimate), JSON.stringify({ level, reasons }), JSON.stringify({ required: confirmationReasons.length > 0, reasons: confirmationReasons }), sha256(stable({ listId, planGoal })));
    });
    audit?.append('plan_created', { planId, sources: sources.length, level, confirmationRequired: confirmationReasons.length > 0 });
    return {
      ok: true,
      data: {
        planId, sourceListId: listId, expiresAt: isoTime(expiresAt),
        sources: { total: rows.length, valid: sources.length, duplicates: resolved.duplicates, byProvider, invalid },
        estimate, risk: { level, reasons }, unsupported: unsupportedList,
        confirmationRequired: confirmationReasons.length > 0, confirmationReasons,
      },
      ...(notes.length ? { notes } : {}),
    };
  }

  // ---------- run ----------
  async function run(params) {
    assertReadAllowed(getPolicy());
    only(params, ['planId', 'idempotencyKey', 'acknowledgeRisk', 'priority', 'name'], 'run');
    if (!isId(params.planId, 'pln')) fail('INVALID_INPUT', 'planId is invalid.');
    const keyHash = hashKey(params.idempotencyKey);
    const plan = store.one('SELECT * FROM plans WHERE plan_id=?', params.planId);
    if (!plan) fail('NOT_FOUND', 'The plan was not found.');
    const sources = store.listSources(plan.list_id);
    await assertProfileAccess(sources.map(row => ({ provider: row.provider, accountRef: row.accountRef })));
    const prior = store.one("SELECT ref_id, spec_hash FROM idempotency WHERE key_hash=? AND scope='run'", keyHash);
    if (prior) {
      if (prior.spec_hash !== params.planId) fail('IDEMPOTENCY_CONFLICT', 'This key was used with a different plan.');
      const job = store.one('SELECT job_id, state, created_at FROM jobs WHERE job_id=?', prior.ref_id);
      return { ok: true, data: { jobId: job.job_id, state: scheduler.summary(job.job_id)?.state ?? job.state, existing: true, createdAt: isoTime(job.created_at) } };
    }
    if (plan.expires_at < clock.now()) fail('PLAN_EXPIRED', 'The plan expired.');
    const confirmation = JSON.parse(plan.confirmation_json);
    if (confirmation.required && params.acknowledgeRisk !== true) fail('CONFIRMATION_REQUIRED', 'Plan requires confirmation: ' + confirmation.reasons.join(', '));
    if (params.priority !== undefined && PRIORITY[params.priority] === undefined) fail('INVALID_INPUT', 'priority must be low, normal or high.');
    if (params.name !== undefined && (typeof params.name !== 'string' || params.name.length > 128)) fail('INVALID_INPUT', 'name must be up to 128 characters.');
    if (store.one("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','waiting','paused')").n >= getPolicy().limits.maxActiveJobs) fail('STATE_LIMIT', 'Too many active jobs.');
    const goal = JSON.parse(plan.goal_json);
    const stages = [];
    if (goal.collect.includes('source_info')) stages.push('source_info');
    if (goal.collect.includes('posts') || goal.collect.includes('media_meta')) stages.push('posts');
    const jobId = newId('job');
    const now = clock.now();
    const estimate = JSON.parse(plan.estimate_json);
    store.tx(() => {
      store.run('INSERT INTO jobs(job_id, plan_id, name, state, priority, ack_risk, created_at, goal_json, est_items, snapshot_version) VALUES (?,?,?,?,?,?,?,?,?,3)',
        jobId, plan.plan_id, params.name ? safeEcho(params.name, 128) : null, 'queued', PRIORITY[params.priority ?? 'normal'], params.acknowledgeRisk === true ? 1 : 0, now, plan.goal_json, estimate.items?.max ?? null);
      const insert = store.db.prepare('INSERT INTO tasks(job_id, source_id, provider, stage, state, cursor, cursor_account, gap_reason, updated_at, min_id) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const source of sources) {
        for (const stage of stages) {
          const supported = stage === 'posts' ? supportsHistory(source) : ['channel', 'group', 'profile'].includes(source.kind);
          let cursor = null; let cursorAccount = null;
          if (supported && stage === 'posts' && goal.mode === 'resume_all') {
            const resume = store.one('SELECT resume_cursor, resume_account FROM sources WHERE source_id=?', source.sourceId);
            if (resume?.resume_cursor) { cursor = resume.resume_cursor; cursorAccount = resume.resume_account; }
          }
          // refresh: только то, что новее известного. Нижняя граница фиксируется в задаче сейчас (после перезапуска демона она не должна расти
          // вместе с собираемым), и только для источника, чья прошлая история прочитана полностью (состояние done); иначе полный проход.
          let minId = null;
          if (supported && stage === 'posts' && goal.mode === 'refresh' && source.provider === 'telegram' && store.one('SELECT state FROM sources WHERE source_id=?', source.sourceId)?.state === 'done') minId = store.maxMessageId(source.sourceId) ?? null;
          insert.run(jobId, source.sourceId, source.provider, stage, supported ? 'pending' : 'skipped', cursor, cursorAccount, supported ? null : `kind_${source.kind}_not_supported`, now, minId);
        }
      }
      store.run("INSERT INTO idempotency(key_hash, scope, ref_id, spec_hash) VALUES (?, 'run', ?, ?)", keyHash, jobId, params.planId);
      store.appendEvent(jobId, null, 'job_created', { sources: sources.length, stages });
    });
    store.run("UPDATE sources SET state='pending' WHERE state IN ('new','done','partial','failed','denied','unavailable') AND source_id IN (SELECT source_id FROM tasks WHERE job_id=? AND state='pending')", jobId);
    scheduler.addJob(store.one('SELECT * FROM jobs WHERE job_id=?', jobId), goal);
    audit?.append('job_created', { jobId, planId: params.planId, sources: sources.length, stages });
    return { ok: true, data: { jobId, state: scheduler.summary(jobId)?.state ?? 'queued', existing: false, createdAt: isoTime(now) } };
  }

  // ---------- job ----------
  function jobRow(jobId) {
    if (!isId(jobId, 'job')) fail('INVALID_INPUT', 'jobId is invalid.');
    const row = store.one('SELECT * FROM jobs WHERE job_id=?', jobId);
    if (!row) fail('NOT_FOUND', 'The job was not found.');
    return row;
  }
  function jobSummary(row) {
    const live = scheduler.summary(row.job_id);
    let counts;
    if (live) counts = live.counts;
    else {
      counts = { pending: 0, running: 0, waiting: 0, done: 0, partial: 0, denied: 0, unavailable: 0, failed: 0, skipped: 0 };
      for (const entry of store.all('SELECT state, COUNT(*) AS n FROM tasks WHERE job_id=? GROUP BY state', row.job_id)) counts[entry.state] = entry.n;
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const state = live?.state ?? row.state;
    const items = live?.itemsNew ?? row.items_new;
    const started = row.started_at ?? row.created_at;
    const elapsed = Math.max(1, (TERMINAL.has(state) && row.finished_at ? row.finished_at : clock.now()) - started);
    const rate = items / (elapsed / 60000);
    const progress = {
      sources: { total, done: counts.done, running: counts.running, waiting: counts.waiting, queued: counts.pending, partial: counts.partial, denied: counts.denied, unavailable: counts.unavailable, failed: counts.failed, skipped: counts.skipped },
      items, duplicates: live?.itemsDup ?? row.items_dup, mediaFiles: 0, mediaBytes: 0, gaps: counts.partial + counts.denied + counts.unavailable + counts.failed + counts.skipped,
      itemsPerMin: Math.round(rate * 10) / 10, requests: live?.requests ?? row.requests,
    };
    if (!TERMINAL.has(state) && row.est_items && rate > 0) {
      const remaining = Math.max(0, row.est_items - items);
      progress.eta = { p50Ms: Math.round(remaining / rate * 60000), p90Ms: Math.round(remaining / rate * 60000 * 1.5), basis: 'plan_upper_bound' };
    }
    return { state, reason: live?.reason ?? row.state_reason ?? undefined, until: live?.until, progress, counts };
  }
  async function job(params, { signal } = {}) {
    only(params, ['jobId', 'view', 'wait', 'limit', 'cursor', 'legacyArchive'], 'job');
    const view = params.view ?? 'summary';
    if (!['summary', 'sources', 'events', 'errors'].includes(view)) fail('INVALID_INPUT', 'view is invalid.');
    const limit = params.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('INVALID_INPUT', 'limit must be 1..200.');
    const wait = params.wait ?? {};
    only(wait, ['maxSeconds', 'sinceSeq'], 'wait');
    const maxSeconds = wait.maxSeconds ?? 0;
    if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 0 || maxSeconds > 50) fail('INVALID_INPUT', 'wait.maxSeconds must be 0..50.');
    let row = jobRow(params.jobId);
    const bindings = jobAccounts(row.job_id);
    await assertProfileAccess(bindings, params.legacyArchive === true);
    const baseline = wait.sinceSeq ?? currentSeq(row.job_id);
    if (maxSeconds > 0 && !TERMINAL.has(scheduler.summary(row.job_id)?.state ?? row.state) && currentSeq(row.job_id) <= baseline) {
      await waitForChange(row.job_id, baseline, maxSeconds * 1000, signal);
      await assertProfileAccess(bindings, params.legacyArchive === true);
    }
    row = jobRow(params.jobId);
    const summary = jobSummary(row);
    const data = { jobId: row.job_id, state: summary.state, seq: currentSeq(row.job_id), progress: summary.progress };
    if (summary.reason) data.stateReason = summary.reason;
    if (row.name) data.name = row.name;
    const waiting = scheduler.waiting(row.job_id);
    if (waiting.length) data.waiting = waiting;
    let page;
    if (view === 'sources' || view === 'errors') {
      const after = params.cursor ? Number(params.cursor) : 0;
      if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_INPUT', 'cursor is invalid.');
      const filter = view === 'errors' ? "AND t.state IN ('failed','denied','unavailable','partial','skipped')" : '';
      const rows = store.all(`SELECT t.task_id, t.stage, t.state, t.items, t.attempts, t.gap_reason, t.last_error, t.waiting_until, t.waiting_reason, s.source_id, s.provider, s.ref, s.kind, s.label
        FROM tasks t JOIN sources s ON s.source_id = t.source_id WHERE t.job_id=? AND t.task_id > ? ${filter} ORDER BY t.task_id LIMIT ?`, row.job_id, after, limit + 1);
      const slice = rows.slice(0, limit);
      data.view = slice.map(entry => {
        const live = scheduler.taskInfo(entry.task_id);
        return { sourceId: entry.source_id, provider: entry.provider, ref: entry.ref, kind: entry.kind, stage: entry.stage, state: live?.state ?? (entry.state === 'pending' ? 'queued' : entry.state), items: live?.items ?? entry.items, attempts: live?.attempts ?? entry.attempts,
          ...(entry.gap_reason ? { reason: entry.gap_reason } : {}), ...(entry.last_error && ['failed', 'denied', 'unavailable'].includes(entry.state) ? { code: entry.last_error } : {}),
          ...(entry.waiting_until ? { waitingUntil: isoTime(entry.waiting_until), waitingReason: entry.waiting_reason } : {}) };
      });
      page = { returned: slice.length, hasMore: rows.length > limit };
      if (page.hasMore) page.nextCursor = String(slice.at(-1).task_id);
    } else if (view === 'events') {
      const after = params.cursor !== undefined ? Number(params.cursor) : (wait.sinceSeq ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_INPUT', 'cursor is invalid.');
      const rows = store.all('SELECT seq, ts, kind, source_id, data_json FROM events WHERE job_id=? AND seq > ? ORDER BY seq LIMIT ?', row.job_id, after, limit + 1);
      const slice = rows.slice(0, limit);
      data.view = slice.map(entry => ({ seq: entry.seq, at: isoTime(entry.ts), kind: entry.kind, ...(entry.source_id ? { sourceId: entry.source_id } : {}), ...(entry.data_json ? { data: JSON.parse(entry.data_json) } : {}) }));
      page = { returned: slice.length, hasMore: rows.length > limit };
      if (page.hasMore) page.nextCursor = String(slice.at(-1).seq);
    }
    return { ok: true, data, ...(page ? { page } : {}) };
  }

  async function jobControl(params) {
    only(params, ['jobId', 'action', 'sourceIds', 'legacyArchive'], 'job_control');
    const row = jobRow(params.jobId);
    if (!['pause', 'resume', 'cancel', 'retry_failed'].includes(params.action)) fail('INVALID_INPUT', 'action must be pause, resume, cancel or retry_failed.');
    if (params.sourceIds !== undefined && (!Array.isArray(params.sourceIds) || params.sourceIds.length > 500 || params.sourceIds.some(id => !isId(id, 'src')))) fail('INVALID_INPUT', 'sourceIds must be up to 500 source IDs.');
    await assertProfileAccess(jobAccounts(row.job_id), params.legacyArchive === true);
    if (params.legacyArchive === true && ['resume', 'retry_failed'].includes(params.action)) fail('ACCESS_DENIED', 'Legacy jobs cannot run without a confirmed profile. Create a new plan.');
    const live = scheduler.summary(row.job_id);
    const state = live?.state ?? row.state;
    let affected = 0;
    if (params.action === 'retry_failed') {
      if (state === 'cancelled') fail('INVALID_INPUT', 'A cancelled job cannot be retried; create a new plan.');
      affected = scheduler.retryFailed(row.job_id, params.sourceIds);
    } else if (TERMINAL.has(state)) {
      affected = 0; // повтор на завершённом задании безопасен и ничего не меняет
    } else if (params.action === 'pause') { scheduler.pause(row.job_id); affected = jobSummary(jobRow(row.job_id)).progress.sources.queued; }
    else if (params.action === 'resume') { scheduler.resume(row.job_id); affected = jobSummary(jobRow(row.job_id)).progress.sources.queued; }
    else { affected = jobSummary(row).progress.sources.queued + jobSummary(row).progress.sources.waiting + jobSummary(row).progress.sources.running; scheduler.cancel(row.job_id); }
    audit?.append('job_control', { jobId: row.job_id, action: params.action, affected });
    const after = jobSummary(jobRow(row.job_id));
    return { ok: true, data: { jobId: row.job_id, state: after.state, affectedSources: affected } };
  }

  // ---------- status ----------
  async function status(params = {}) {
    only(params, ['include'], 'status');
    const include = new Set(params.include ?? ['accounts', 'queues']);
    for (const item of include) if (!['accounts', 'capabilities', 'queues', 'governor', 'disk'].includes(item)) fail('INVALID_INPUT', 'include contains an unknown section.');
    const list = [];
    for (const provider of Object.keys(providers)) {
      const state = await providerState(provider);
      const entry = { provider, state: ['ready', 'initializing', 'auth_required', 'challenge_required', 'rate_limited', 'unavailable', 'unsupported'].includes(state.state) ? state.state : 'unavailable' };
      if (state.reason) entry.reason = state.reason;
      if (include.has('accounts') && state.accountRef) entry.accountRef = aliasOf(state.accountRef);
      if (include.has('capabilities')) {
        entry.stages = stagesOf(provider, state);
        // Возможности Relay (этап 2): сколько запусков платформа принимает разом и какие расширения объявлены.
        if (Number.isSafeInteger(state.maxConcurrent)) entry.maxConcurrent = state.maxConcurrent;
        if (Array.isArray(state.features) && state.features.length) entry.features = state.features;
      }
      if (include.has('governor') && state.accountRef) entry.governor = governor.snapshot(`${provider}:${state.accountRef}`, provider);
      if (include.has('queues')) entry.queue = scheduler.queueDepth(provider);
      list.push(entry);
    }
    const data = { daemon: { version: RESEARCH_VERSION, contract: ORCHESTRATION_CONTRACT, uptimeS: Math.round((clock.now() - startedAt) / 1000), pid: process.pid }, providers: list,
      policy: { source: policyState.source, read: getPolicy().read, readPrivateThread: getPolicy().readPrivateThread, join: getPolicy().join.enabled, ...(policyState.error ? { error: policyState.error } : {}) },
      jobs: { active: scheduler.activeJobs(), total: store.one('SELECT COUNT(*) AS n FROM jobs').n } };
    data.index = { state: store.ftsState, ...(store.ftsFailure ? { reason: store.ftsFailure } : {}) };
    if (include.has('disk')) {
      let bytes = 0; try { bytes = await free(); } catch { /* значение неизвестно */ }
      data.disk = { freeGiB: Math.round(bytes / 1024 ** 3 * 10) / 10, reserveGiB: getPolicy().diskReserveGiB };
      data.store = { items: store.itemCount(), sources: store.counts().sources };
    }
    return { ok: true, data };
  }

  // ---------- записи ----------
  const idScope = scope => {
    if (scope === undefined) return {};
    only(scope, ['jobIds', 'sourceIds', 'providers', 'accountRef', 'legacyArchive'], 'scope');
    if (scope.jobIds !== undefined && (!Array.isArray(scope.jobIds) || !scope.jobIds.length || scope.jobIds.length > 100 || scope.jobIds.some(id => !isId(id, 'job')))) fail('INVALID_INPUT', 'scope.jobIds must contain 1..100 job IDs.');
    if (scope.sourceIds !== undefined && (!Array.isArray(scope.sourceIds) || !scope.sourceIds.length || scope.sourceIds.length > 500 || scope.sourceIds.some(id => !isId(id, 'src')))) fail('INVALID_INPUT', 'scope.sourceIds must contain 1..500 source IDs.');
    if (scope.providers !== undefined && (!Array.isArray(scope.providers) || !scope.providers.length || scope.providers.length > 3 || scope.providers.some(provider => !Object.hasOwn(providers, provider)))) fail('INVALID_INPUT', 'scope.providers must contain 1..3 known platforms.');
    if (scope.accountRef !== undefined && (typeof scope.accountRef !== 'string' || !scope.accountRef || scope.accountRef.length > 128)) fail('INVALID_INPUT', 'scope.accountRef must be an account alias.');
    if (scope.legacyArchive !== undefined && typeof scope.legacyArchive !== 'boolean') fail('INVALID_INPUT', 'scope.legacyArchive must be boolean.');
    if (scope.legacyArchive && scope.accountRef) fail('INVALID_INPUT', 'Legacy archive and a verified profile are separate scopes.');
    return scope;
  };
  async function authorizeResultScope(input) {
    const scope = idScope(input);
    const legacy = scope.legacyArchive === true;
    for (const jobId of scope.jobIds ?? []) jobRow(jobId);
    const bindings = (scope.jobIds ?? []).flatMap(jobAccounts);
    if (scope.jobIds?.length) await assertProfileAccess(bindings, legacy);
    const states = legacy ? new Map() : await currentStates(scope.providers?.length ? scope.providers : Object.keys(providers));
    const activeProfiles = [...states].filter(([provider, state]) => hasIdentity(state)
      && (scope.accountRef === undefined || aliasOf(state.accountRef) === scope.accountRef)
      && (!scope.jobIds?.length || bindings.some(row => row.provider === provider && row.accountRef === state.accountRef)))
      .map(([provider, state]) => ({ provider, accountRef: state.accountRef }));
    if ((scope.accountRef || (scope.jobIds?.length && !legacy)) && !activeProfiles.length) fail('STALE_ACCOUNT', 'No active profile matches the requested scope.');
    return { ...scope, activeProfiles, readPrivateThread: getPolicy().readPrivateThread === true };
  }
  async function revalidateResultScope(scope) {
    if (scope.activeProfiles.length) await assertProfileAccess(scope.activeProfiles);
    assertReadAllowed(getPolicy());
    if (scope.readPrivateThread && !getPolicy().readPrivateThread) fail('POLICY_DENIED', 'The owner revoked access to private threads.');
  }
  async function records(params) {
    assertReadAllowed(getPolicy());
    only(params, ['scope', 'filter', 'query', 'order', 'fields', 'textMaxChars', 'limit', 'maxBytes', 'cursor'], 'records');
    const scope = await authorizeResultScope(params.scope);
    const result = await queries.records({ ...params, scope });
    await revalidateResultScope(scope);
    return { ok: true, ...result };
  }
  async function stats(params) {
    assertReadAllowed(getPolicy());
    only(params, ['scope', 'filter', 'query', 'groupBy', 'metrics', 'topTerms', 'limit', 'cursor'], 'stats');
    if (!['hour', 'day', 'week', 'month', 'source', 'author', 'type', 'lang'].includes(params.groupBy)) fail('INVALID_INPUT', 'groupBy is invalid.');
    const scope = await authorizeResultScope(params.scope);
    const result = queries.stats({ ...params, scope });
    await revalidateResultScope(scope);
    return { ok: true, ...result };
  }
  async function exportRecords(params) {
    assertReadAllowed(getPolicy());
    only(params, ['scope', 'filter', 'query', 'format', 'columns', 'media', 'name', 'maxRows', 'cursor', 'idempotencyKey'], 'export');
    if (!['csv', 'jsonl', 'markdown', 'html'].includes(params.format)) fail('INVALID_INPUT', 'format must be csv, jsonl, markdown or html.');
    const keyHash = hashKey(params.idempotencyKey);
    const { idempotencyKey, ...spec } = params;
    void idempotencyKey;
    const scope = await authorizeResultScope(spec.scope);
    const specHash = sha256(stable({ ...spec, scope }));
    const run = async () => {
      const prior = store.one("SELECT ref_id, spec_hash FROM idempotency WHERE key_hash=? AND scope='export'", keyHash);
      if (prior) {
        if (prior.spec_hash !== specHash) fail('IDEMPOTENCY_CONFLICT', 'This key was used with a different export.');
        await revalidateResultScope(scope);
        return { ok: true, data: { ...JSON.parse(store.one('SELECT result_json FROM exports WHERE export_id=?', prior.ref_id).result_json), existing: true } };
      }
      if ((await free()) < getPolicy().diskReserveGiB * 1024 ** 3) fail('DISK_RESERVE', 'Free disk space is below the reserve.');
      const result = await queries.export({ ...spec, scope }, { diskFree: free, authorize: () => revalidateResultScope(scope), ...(exportDeadlineMs ? { deadlineMs: exportDeadlineMs } : {}) });
      store.tx(() => {
        store.run('INSERT INTO exports(export_id, created_at, spec_hash, result_json) VALUES (?,?,?,?)', result.exportId, clock.now(), specHash, JSON.stringify(result));
        store.run("INSERT INTO idempotency(key_hash, scope, ref_id, spec_hash) VALUES (?, 'export', ?, ?)", keyHash, result.exportId, specHash);
      });
      audit?.append('export', { exportId: result.exportId, format: params.format, rows: result.rows, bytes: result.files[0]?.bytes, sha256: result.files[0]?.sha256 });
      return { ok: true, data: result };
    };
    // Повтор с тем же ключом дожидается первого вызова, а не пишет второй файл.
    const running = exportsInFlight.get(keyHash);
    if (running) {
      if (running.specHash !== specHash) fail('IDEMPOTENCY_CONFLICT', 'This key is in use for a different export.');
      const value = await running.promise;
      await revalidateResultScope(scope);
      return { ok: true, data: { ...value.data, existing: true } };
    }
    const promise = run().finally(() => exportsInFlight.delete(keyHash));
    exportsInFlight.set(keyHash, { specHash, promise });
    return promise;
  }

  // ---------- точечные чтения Telegram (инвайт, похожие каналы, темы, комментарии) ----------
  const PROVIDER_STATE_CODE = { auth_required: 'AUTH_REQUIRED', challenge_required: 'CHALLENGE_REQUIRED', rate_limited: 'RATE_LIMITED', unavailable: 'BRIDGE_UNAVAILABLE', initializing: 'BRIDGE_UNAVAILABLE', unsupported: 'UNSUPPORTED' };
  const LOOKUP_CODE_BY_KIND = { denied: 'ACCESS_DENIED', stale: 'STALE_ACCOUNT', bridge: 'BRIDGE_UNAVAILABLE', busy: 'BUSY', challenge: 'CHALLENGE_REQUIRED', auth: 'AUTH_REQUIRED', unavailable: 'UNAVAILABLE', owner: 'ACCOUNT_RESTRICTED', transient: 'ADAPTER_FAILED' };
  /**
   * Только чтение: без вступления, без отправки. Те же охрана и темп, что у заданий: политика read, личные диалоги закрыты,
   * запрос идёт через затвор платформы и регулятор аккаунта; пауза платформы (FLOOD_WAIT) запоминается регулятором и возвращается
   * как RATE_LIMITED с retryAfterMs — вызов не ждёт и не повторяется сам.
   */
  async function lookup(params, { signal } = {}) {
    assertReadAllowed(getPolicy());
    const request = parseLookup(params, { allowPrivate: getPolicy().readPrivateThread === true });
    const spec = LOOKUPS[request.kind];
    const adapter = providers.telegram;
    if (!adapter || typeof adapter.lookup !== 'function') fail('UNSUPPORTED', 'This build has no Telegram lookup adapter.');
    const status = await providerState('telegram');
    if (status.state !== 'ready') fail(PROVIDER_STATE_CODE[status.state] ?? 'UNAVAILABLE', `Telegram is ${status.state}.`);
    if (adapter.hasFeature?.(request.kind) !== true) fail('UNSUPPORTED', `Relay does not advertise ${request.kind}; update Relay.`);
    const accountScope = { accountRef: status.accountRef, accountEpoch: status.accountEpoch };
    const accountKey = `telegram:${accountScope.accountRef}`;
    let gate = governor.gate(accountKey, 'telegram', spec.cls);
    if (!gate.ok && gate.reason === 'pace' && gate.delayMs <= 15000) {
      await clock.sleep(gate.delayMs, signal);
      gate = governor.gate(accountKey, 'telegram', spec.cls);
    }
    if (!gate.ok) fail('RATE_LIMITED', `The account is pacing requests (${gate.reason}).`, { retryAfterMs: gate.delayMs });
    governor.take(accountKey, 'telegram', spec.cls);
    audit?.count(accountKey, spec.cls, 'lookup_' + request.kind);
    let step;
    try {
      step = await adapter.lookup({ operation: request.kind, channel: request.channel, url: request.url, query: request.query, cursor: request.cursor, limit: request.limit, accountScope, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      const info = classifyError(error);
      if (info.kind === 'flood') {
        const seconds = floodSecondsOf(error);
        const waitKind = floodWaitKindOf(error);
        governor.flood(accountKey, 'telegram', waitKind === 'RESOLVE_BUDGET' ? 'resolve' : 'history', seconds, { waitKind });
        fail('RATE_LIMITED', 'The platform asked to slow down.', { retryAfterMs: seconds * 1000 });
      }
      if (info.kind === 'owner') {
        governor.openUntilOwner(accountKey, 'telegram', spec.cls);
        audit?.append('awaiting_owner', { provider: 'telegram', code: info.code, via: 'lookup' });
      }
      const code = ['INVALID_INPUT', 'INVALID_REQUEST', 'INVALID_CURSOR'].includes(error?.code) ? 'INVALID_INPUT' : error?.code === 'NOT_FOUND' ? 'NOT_FOUND' : error?.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : LOOKUP_CODE_BY_KIND[info.kind] ?? 'ADAPTER_FAILED';
      fail(code, `The ${request.kind} lookup failed (${code.toLowerCase()}).`);
    }
    if (step.floodWait) {
      const waitKind = floodWaitKindOf(step.floodWait);
      governor.flood(accountKey, 'telegram', waitKind === 'RESOLVE_BUDGET' ? 'resolve' : 'history', floodSecondsOf(step.floodWait), { waitKind });
    }
    const items = step.records.map(record => projectLookupRecord(request.kind, record)).filter(item => item !== undefined);
    const data = { kind: request.kind, items, untrusted: true, outcome: step.outcome, ...(step.partial ? { partial: true } : {}) };
    const page = { returned: items.length, hasMore: Boolean(step.nextCursor) };
    if (step.nextCursor) page.nextCursor = step.nextCursor;
    return { ok: true, data, page };
  }

  // ---------- права на прежние операции брокера ----------
  /** Политика владельца для submit: чтение можно выключить целиком, личные диалоги (read_thread) выключены по умолчанию. */
  function authorizeSubmit(operation) {
    const policy = getPolicy();
    const deny = reason => {
      audit?.append('policy_denied', { action: operation, reason });
      throw new OrchError('POLICY_DENIED', reason, { recovery: 'This operation is off in the owner policy. Only the owner can change policy.json.' });
    };
    if (!policy.read) deny('read is disabled by policy');
    if (operation === 'read_thread' && !policy.readPrivateThread) deny('readPrivateThread is disabled by policy');
  }

  // ---------- вступление в группу ----------
  /** Проверка политики перед submit_join: отказ и разрешение записываются в журнал до действия. */
  function authorizeJoin(channel) {
    const today = new Date(clock.now()).toISOString().slice(0, 10);
    const key = `join:${today}`;
    const used = Number(store.getMeta(key) ?? 0);
    let target;
    try { target = checkJoin(getPolicy(), channel, used); }
    catch (error) {
      audit?.append('policy_denied', { action: 'join_chat', reason: error.message, target: safeEcho(String(channel ?? ''), 80) });
      throw error;
    }
    audit?.appendStrict('join_authorized', { target: target.slice(0, 200), usedToday: used + 1 });
    store.setMeta(key, used + 1);
    return target;
  }

  // ---------- импорт старых заданий ----------
  async function importLegacy(params = {}) {
    assertReadAllowed(getPolicy());
    only(params, ['jobIds'], 'import');
    const jobsDir = path.join(stateRoot, 'jobs');
    let ids = params.jobIds;
    if (!ids) ids = (await fs.readdir(jobsDir).catch(() => [])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
    if (ids.length > 10000) fail('INVALID_INPUT', 'Too many jobs to import in one call.');
    const result = { jobs: 0, items: 0, duplicates: 0, skipped: [] };
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) { result.skipped.push({ jobId: String(id).slice(0, 40), reason: 'not_a_legacy_job_id' }); continue; }
      let legacy;
      try { await assertSafeFile(path.join(jobsDir, id + '.json')); legacy = JSON.parse(await fs.readFile(path.join(jobsDir, id + '.json'), 'utf8')); }
      catch { result.skipped.push({ jobId: id, reason: 'job_unreadable' }); continue; }
      if (legacy.profileBinding) { result.skipped.push({ jobId: id, reason: 'bound_job_kept_in_original_profile' }); continue; }
      if (!['completed', 'partial'].includes(legacy.state) || !(legacy.result?.count > 0)) { result.skipped.push({ jobId: id, reason: 'no_accepted_records' }); continue; }
      if (!LEGACY_IMPORT_OPERATIONS.has(legacy.operation)) { result.skipped.push({ jobId: id, reason: 'operation_not_imported' }); continue; }
      const directoryOf = path.join(outputRoot, id);
      let manifest;
      try { await assertSafeDirectory(directoryOf); manifest = JSON.parse(await fs.readFile(path.join(directoryOf, 'export-manifest.json'), 'utf8')); } catch { result.skipped.push({ jobId: id, reason: 'manifest_missing' }); continue; }
      let source;
      try { source = canonicalSource(legacy.provider, String(manifest.provenance?.sources?.[0] ?? '')); } catch { result.skipped.push({ jobId: id, reason: 'source_unknown' }); continue; }
      const sourceId = legacySourceIdOf(source);
      store.upsertSources([{ ...source, sourceId }]);
      const fullyRead = manifest.partial === false && !manifest.nextCursor;
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const kept = []; const lines = [];
        for (const record of batch) {
          const normalized = normalizeRecord(legacy.provider, record);
          if (normalized.skip) continue;
          kept.push(normalized.item);
          lines.push(Buffer.from(JSON.stringify({ v: 1, src: sourceId, job: id, at: clock.now(), rec: record, legacy: true })));
        }
        batch = [];
        if (!kept.length) return;
        const { fresh, dropped } = store.freshIndexes(legacy.provider, sourceId, id, kept);
        result.duplicates += dropped;
        if (!fresh.length) return;
        const newItems = fresh.map(index => kept[index]); const newLines = fresh.map(index => lines[index]);
        const placed = await archive.append(legacy.provider, newLines);
        try {
          const counts = store.tx(() => store.insertItems({ provider: legacy.provider, sourceId, jobId: id, items: newItems, raw: placed }));
          archive.commit(legacy.provider);
          result.items += counts.created; result.duplicates += counts.duplicates;
          store.run('UPDATE sources SET items = items + ? WHERE source_id=?', counts.created, sourceId);
        } catch (error) { await archive.rollback(legacy.provider).catch(() => {}); throw error; }
      };
      const lines = readline.createInterface({ input: createReadStream(path.join(directoryOf, 'records.jsonl'), { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        batch.push(record);
        if (batch.length >= 100) await flush();
      }
      await flush();
      store.run("UPDATE sources SET state=?, state_reason=?, last_checked=? WHERE source_id=? AND state='new'", fullyRead ? 'done' : 'partial', fullyRead ? null : 'imported_partial', clock.now(), sourceId);
      result.jobs++;
    }
    audit?.append('legacy_import', { jobs: result.jobs, items: result.items, duplicates: result.duplicates, skipped: result.skipped.length });
    return { ok: true, data: result };
  }

  return {
    store, archive, governor, scheduler, plan, run, job, jobControl, status, records, stats, lookup, export: exportRecords, authorizeJoin, authorizeSubmit, importLegacy,
    sourceIdOf,
    getPolicy,
    setPolicy(next) {
      const previous = getPolicy();
      policyState.policy = next.policy; policyState.source = next.source; policyState.error = next.error;
      scheduler.policyChanged(previous);
    },
    async close() {
      if (closed) return;
      closed = true;
      await scheduler.close();
      governor.flush();
      audit?.flush();
      await archive.close();
      await store.close();
    },
  };
}
