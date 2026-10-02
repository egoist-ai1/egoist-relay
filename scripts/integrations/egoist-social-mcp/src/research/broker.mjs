import { createHash, randomUUID } from 'node:crypto';
import { JobStore, ResearchBrokerError, cloneJSON, inspectOutputFiles, isJobId } from './job-store.mjs';

export { ResearchBrokerError } from './job-store.mjs';
export const RESEARCH_PROVIDERS = Object.freeze(['telegram', 'x', 'instagram']);
export const RESEARCH_OPERATIONS = Object.freeze(['search', 'read', 'channel_history', 'download', 'discover', 'chat_info', 'chat_export', 'join_chat', 'profile', 'article', 'read_thread', 'transcribe']);
const STATES = ['queued', 'running', 'rate_limited', 'auth_required', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'];
const PROVIDER_STATES = ['ready', 'auth_required', 'unavailable', 'rate_limited', 'challenge_required', 'unsupported'];
const COVERAGE = ['channel', 'account_channels', 'public_channels', 'platform_search', 'profile', 'thread', 'post', 'article', 'membership'];
const HOSTS = {
  telegram: new Set(['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me']),
  x: new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']),
  instagram: new Set(['instagram.com', 'www.instagram.com']),
};
const ERRORS = {
  AUTH_REQUIRED: 'The selected account is not authorized in Relay. A missing bridge is a different state.',
  ACCESS_DENIED: 'This account cannot access the selected source; this is not an empty result.',
  STALE_ACCOUNT: 'The bound account changed; accepted data remains in its original partial export.',
  FILE_REFERENCE_EXPIRED: 'The source media reference expired; refresh the exact source before a bounded retry.',
  DISK_RESERVE: 'The bounded job stopped to preserve its required free disk reserve.',
  CHALLENGE_REQUIRED: 'The provider requires a first-party account challenge to be completed.',
  RATE_LIMITED: 'The provider paused this job because of a rate limit. No automatic retry was scheduled.',
  UNSUPPORTED: 'This provider does not support the requested operation.',
  PROVIDER_UNAVAILABLE: 'The provider is unavailable; this is not an empty research result.',
  PROVIDER_BUSY: 'The prior owned operation has not settled. No new platform operation was attempted.',
  ADAPTER_FAILED: 'The provider failed. Its raw error was not recorded.',
  DOM_SOURCE_UNAVAILABLE: 'The selected source DOM did not become available within its bounded readiness wait.',
  DOM_SOURCE_UNSUPPORTED: 'The accessible page did not expose supported source records; an empty result was not confirmed.',
  SOURCE_UNAVAILABLE: 'The platform reports that the selected source is unavailable.',
  SOURCE_CHANGED: 'The observed page no longer matches the exact requested source.',
  CURSOR_ANCHOR_NOT_FOUND: 'The checked continuation anchor was not observed; accepted data was preserved.',
  CURSOR_SOURCE_MISMATCH: 'The continuation does not match the provider, source or account scope.',
  INVALID_CURSOR: 'The continuation cursor failed its bounded source contract.',
  TIMESTAMP_FILTER_UNSUPPORTED: 'The source does not expose timestamps required by the requested filter.',
  THREAD_DOM_UNSUPPORTED: 'The exact requested thread does not expose a supported message DOM.',
  ARTICLE_DOM_UNSUPPORTED: 'The exact requested article does not expose a supported article DOM.',
  EMPTY_SOURCE_NOT_CONFIRMED: 'No records were observed and the platform did not confirm an empty source.',
  INCOMPLETE_SOURCE_READ: 'The source stream did not settle its declared record, text or media state.',
  EXTRACTION_FAILED: 'The bounded source extractor failed; raw page errors were not recorded.',
  FRAME_TOO_LARGE: 'A source event exceeded the finite transport frame bound.',
  REPLY_TRANSPORT_UNAVAILABLE: 'The app-owned source reply transport is unavailable.',
  MEDIA_SIZE_CHANGED: 'Observed media changed size during the bounded download.',
  TEXT_LIMIT: 'Observed source text exceeded the finite text limit.',
  INVALID_RESULT: 'The provider returned an invalid result contract.',
  UNSAFE_PATH: 'An output or state entry failed the filesystem safety check.',
  DEADLINE_EXCEEDED: 'The finite job deadline elapsed. Completion is uncertain and was not retried.',
  BROKER_CLOSED: 'The broker closed while this job was active. It was not retried.',
  PROCESS_INTERRUPTED: 'The previous broker stopped before completion. Submit a new job with a checked cursor to resume.',
  CANCELLED: 'The user cancelled this owned job. Accepted output files were retained.',
};
const MAX_ACTIVE_PER_PROVIDER = 64;
const MAX_HISTORY = 10000;
const MAX_EVIDENCE = 50;
const CLOSE_WAIT_MS = 2000;
const MAX_PROVIDER_STATUS_MS = 5000;
const MAX_SUBMIT_PROOF_WAIT_MS = 20000;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) { throw new ResearchBrokerError(code, message); }
function keys(object, allowed, code = 'INVALID_REQUEST') {
  if (!isObject(object) || Object.keys(object).some(key => !allowed.includes(key))) fail(code, 'The research object contains unsupported fields.');
}
function boundedInteger(value, minimum, maximum, code = 'INVALID_REQUEST') {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code, 'A research numeric field is outside its supported bounds.');
  return value;
}
function string(value, maximum, code = 'INVALID_REQUEST') {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(code, 'A research text field is invalid.');
  return value;
}
function cursor(value, code = 'INVALID_REQUEST') {
  const accepted = string(value, 2048, code);
  if (/(?:bearer\s|authorization|password|cookie|(?:access[_-]?token|token|secret)=)/i.test(accepted)) fail(code, 'A cursor contains unsupported credential markers.');
  return accepted;
}
function sourceURL(value, provider, { evidence = false, code = 'INVALID_REQUEST' } = {}) {
  string(value, evidence ? 512 : 2048, code);
  let parsed;
  try { parsed = new URL(value); } catch { fail(code, 'A research source URL is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !HOSTS[provider].has(parsed.hostname.toLowerCase())) fail(code, 'A research source URL must use the requested first-party HTTPS host.');
  if (evidence) { parsed.search = ''; parsed.hash = ''; }
  else {
    for (const [key, val] of parsed.searchParams) {
      if (!['s', 't', 'single', 'comment', 'img_index'].includes(key) || val.length > 64 || !/^[a-z0-9_-]*$/i.test(val)) fail(code, 'A source URL contains unsupported parameters.');
    }
    parsed.hash = '';
  }
  return parsed.toString();
}
function channel(value, provider) {
  string(value, 256);
  if (value.startsWith('https://')) return sourceURL(value, provider);
  if (provider === 'instagram' && /^#[\p{L}\p{N}_]{1,100}$/u.test(value)) return value;
  if (!/^@?[a-z0-9_.]{1,128}$/i.test(value) && !/^-?[0-9]{1,20}$/.test(value)) fail('INVALID_REQUEST', 'A channel must be a public handle, numeric identifier or first-party HTTPS URL.');
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function normalizeRequest(request) {
  keys(request, ['provider', 'operation', 'input', 'idempotencyKey']);
  if (!RESEARCH_PROVIDERS.includes(request.provider) || !RESEARCH_OPERATIONS.includes(request.operation)) fail('INVALID_REQUEST', 'The provider or operation is not supported.');
  const input = request.input;
  if ((['join_chat', 'chat_info'].includes(request.operation) && request.provider !== 'telegram') ||
      (request.operation === 'article' && request.provider !== 'x') ||
      (['read_thread', 'profile'].includes(request.operation) && request.provider === 'telegram')) fail('INVALID_REQUEST', 'This operation does not apply to the selected provider.');
  const common = ['limit', 'pageSize', 'deadlineMs', 'cursor'];
  const fields = ['search', 'discover'].includes(request.operation) ? ['query', 'channel', 'scope']
    : ['channel_history', 'chat_export', 'chat_info', 'profile', 'join_chat'].includes(request.operation)
      ? ['channel', 'topicId', 'after', 'before', 'includeMedia', 'exportFormats', 'confirmedJoin']
      : ['url', 'urls', 'includeMedia', ...(request.provider === 'telegram' ? [] : ['includeReplies']), 'exportFormats', ...(request.operation === 'transcribe' ? ['language'] : [])];
  keys(input, [...common, ...fields]);
  const normalized = {
    limit: boundedInteger(input.limit ?? (request.operation === 'transcribe' ? 20 : 100), 1, request.operation === 'transcribe' ? 20 : 1000),
    pageSize: boundedInteger(input.pageSize ?? 50, 1, 100),
    deadlineMs: boundedInteger(input.deadlineMs ?? 120000, 1000, 300000),
  };
  normalized.pageSize = Math.min(normalized.pageSize, normalized.limit);
  if (request.operation === 'transcribe') {
    normalized.language = input.language ?? 'auto';
    if (!/^(?:auto|[a-z]{2,3})$/.test(normalized.language)) fail('INVALID_REQUEST', 'Use an available language code or auto.');
    normalized.includeMedia = true;
  }
  if (input.cursor !== undefined) normalized.cursor = cursor(input.cursor);
  if (['search', 'discover'].includes(request.operation)) {
    normalized.query = string(input.query, 512).trim();
    if (!normalized.query) fail('INVALID_REQUEST', 'A search query must contain text.');
    if (input.channel !== undefined) normalized.channel = channel(input.channel, request.provider);
    if (input.scope !== undefined) {
      if (!['public_groups', 'dialogs', 'profiles', 'tags', 'posts'].includes(input.scope)) fail('INVALID_REQUEST', 'A discovery scope is invalid.');
      normalized.scope = input.scope;
    }
  } else if (['channel_history', 'chat_export', 'chat_info', 'profile', 'join_chat'].includes(request.operation)) {
    normalized.channel = channel(input.channel, request.provider);
    if (request.operation === 'join_chat') {
      if (input.confirmedJoin !== true) fail('INVALID_REQUEST', 'Joining is available only through the explicit group-join tool.');
      normalized.confirmedJoin = true;
      normalized.limit = 1;
      normalized.pageSize = 1;
    } else if (input.confirmedJoin !== undefined) fail('INVALID_REQUEST', 'A read operation cannot join a group.');
    if (input.topicId !== undefined) normalized.topicId = boundedInteger(input.topicId, 1, 2147483647);
    for (const name of ['after', 'before']) if (input[name] !== undefined) normalized[name] = boundedInteger(input[name], 0, 4102444800);
    if (normalized.after !== undefined && normalized.before !== undefined && normalized.after > normalized.before) fail('INVALID_REQUEST', 'The date interval is reversed.');
  }
  else {
    if ((input.url !== undefined) === (input.urls !== undefined)) fail('INVALID_REQUEST', 'Specify one URL or one URL list.');
    if (input.url !== undefined) normalized.url = sourceURL(input.url, request.provider);
    else {
      if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > (request.operation === 'transcribe' ? 20 : 1000)) fail('INVALID_REQUEST', 'The URL list exceeds the finite operation bound.');
      normalized.urls = input.urls.map(value => sourceURL(value, request.provider));
    }
  }
  for (const name of ['includeMedia', 'includeReplies']) if (input[name] !== undefined) {
    if (typeof input[name] !== 'boolean') fail('INVALID_REQUEST', 'A collection flag must be a boolean.');
    normalized[name] = input[name];
  }
  if (request.operation === 'transcribe') normalized.includeMedia = true;
  if (input.exportFormats !== undefined) {
    if (!Array.isArray(input.exportFormats) || input.exportFormats.length < 1 || input.exportFormats.length > 3 ||
        input.exportFormats.some(format => !['jsonl', 'markdown', 'html'].includes(format))) fail('INVALID_REQUEST', 'Export formats are invalid.');
    normalized.exportFormats = [...new Set(input.exportFormats)].sort();
  }
  if (request.operation === 'read_thread') {
    if (normalized.urls || !normalized.url) fail('INVALID_REQUEST', 'Read one exact selected conversation.');
    const parsed = new URL(normalized.url);
    const pattern = request.provider === 'x' ? /^\/(?:messages|i\/chat)\/[0-9]{1,64}(?:-[0-9]{1,64})?\/?$/ : /^\/direct\/t\/[0-9]{1,64}\/?$/;
    if (!pattern.test(parsed.pathname)) fail('INVALID_REQUEST', 'An exact first-party conversation URL is required.');
  }
  let idempotencyHash;
  if (request.idempotencyKey !== undefined) idempotencyHash = digest(string(request.idempotencyKey, 256));
  const requestHash = digest(stable({ provider: request.provider, operation: request.operation, input: normalized }));
  return { provider: request.provider, operation: request.operation, input: normalized, idempotencyHash, requestHash };
}

function validateCompactResult(result, provider, limit) {
  keys(result, ['outcome', 'count', 'nextCursor', 'files', 'evidence', 'truncated', 'coverage', 'evidenceTruncated'], 'INVALID_STATE');
  boundedInteger(result.count, 0, limit, 'INVALID_STATE');
  if (!['results', 'empty', 'partial'].includes(result.outcome)) fail('INVALID_STATE', 'A persisted research outcome is invalid.');
  if (result.nextCursor !== undefined) cursor(result.nextCursor, 'INVALID_STATE');
  if (!Array.isArray(result.files) || result.files.length > 1000 || result.files.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name) || name.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) fail('INVALID_STATE', 'Persisted research files are invalid.');
  if (!Array.isArray(result.evidence) || result.evidence.length > MAX_EVIDENCE) fail('INVALID_STATE', 'Persisted research evidence is invalid.');
  for (const item of result.evidence) {
    keys(item, ['url', 'kind', 'id'], 'INVALID_STATE');
    if (sourceURL(item.url, provider, { evidence: true, code: 'INVALID_STATE' }) !== item.url) fail('INVALID_STATE', 'A persisted evidence URL is invalid.');
    if (item.kind !== undefined && !['post', 'channel', 'media', 'search'].includes(item.kind)) fail('INVALID_STATE', 'A persisted evidence kind is invalid.');
    if (item.id !== undefined && (typeof item.id !== 'string' || !/^[a-z0-9_.:-]{1,128}$/i.test(item.id))) fail('INVALID_STATE', 'A persisted evidence identifier is invalid.');
  }
  for (const flag of ['truncated', 'evidenceTruncated']) if (result[flag] !== undefined && typeof result[flag] !== 'boolean') fail('INVALID_STATE', 'A persisted result flag is invalid.');
  if (result.coverage !== undefined && !COVERAGE.includes(result.coverage)) fail('INVALID_STATE', 'A persisted coverage claim is invalid.');
}

function validateStoredJob(job, id) {
  keys(job, ['schemaVersion', 'id', 'provider', 'operation', 'state', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'requestHash', 'idempotencyHash', 'limits', 'result', 'error'], 'INVALID_STATE');
  if (job.schemaVersion !== 1 || job.id !== id || !isJobId(id) || !RESEARCH_PROVIDERS.includes(job.provider) || !RESEARCH_OPERATIONS.includes(job.operation) || !STATES.includes(job.state)) fail('INVALID_STATE', 'Persisted research job fields are invalid.');
  for (const field of ['createdAt', 'updatedAt', 'startedAt', 'finishedAt']) {
    if (job[field] !== undefined && (typeof job[field] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(job[field]) || Number.isNaN(Date.parse(job[field])))) fail('INVALID_STATE', 'A persisted research timestamp is invalid.');
  }
  if (!job.createdAt || !job.updatedAt || !/^[a-f0-9]{64}$/.test(job.requestHash) || (job.idempotencyHash !== undefined && !/^[a-f0-9]{64}$/.test(job.idempotencyHash))) fail('INVALID_STATE', 'Persisted research metadata is incomplete.');
  keys(job.limits, ['limit', 'pageSize', 'deadlineMs'], 'INVALID_STATE');
  boundedInteger(job.limits.limit, 1, 1000, 'INVALID_STATE');
  boundedInteger(job.limits.pageSize, 1, 100, 'INVALID_STATE');
  if (job.limits.pageSize > job.limits.limit) fail('INVALID_STATE', 'A persisted page size exceeds the result limit.');
  boundedInteger(job.limits.deadlineMs, 1000, 300000, 'INVALID_STATE');
  validateCompactResult(job.result, job.provider, job.limits.limit);
  if (job.error !== undefined) {
    keys(job.error, ['code', 'retryAfterMs', 'completionUncertain'], 'INVALID_STATE');
    if (!Object.hasOwn(ERRORS, job.error.code)) fail('INVALID_STATE', 'A persisted research error code is invalid.');
    if (job.error.retryAfterMs !== undefined) boundedInteger(job.error.retryAfterMs, 0, 86400000, 'INVALID_STATE');
    if (job.error.completionUncertain !== undefined && typeof job.error.completionUncertain !== 'boolean') fail('INVALID_STATE', 'A persisted completion flag is invalid.');
  }
}

async function boundedStatus(provider) {
  if (!provider) return { state: 'unavailable', operations: [] };
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(() => provider.status()), new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'unavailable', operations: [], reason: 'provider_status_timeout' }), MAX_PROVIDER_STATUS_MS); })]);
    if (!isObject(result) || !PROVIDER_STATES.includes(result.state)) return { state: 'unavailable', operations: [] };
    const operations = Array.isArray(result.operations) ? result.operations.filter(operation => RESEARCH_OPERATIONS.includes(operation)) : [];
    const accepted = { state: result.state, operations: [...new Set(operations)] };
    if (typeof result.reason === 'string' && /^[a-z_]{1,96}$/.test(result.reason)) accepted.reason = result.reason;
    if (typeof result.accountRef === 'string' && /^[a-z0-9_.:-]{1,128}$/i.test(result.accountRef) &&
        ((typeof result.accountEpoch === 'string' && result.accountEpoch.length > 0 && result.accountEpoch.length <= 128) || Number.isSafeInteger(result.accountEpoch))) {
      accepted.accountRef = result.accountRef;
      accepted.accountEpoch = result.accountEpoch;
    }
    return accepted;
  } catch { return { state: 'unavailable', operations: [] }; }
  finally { clearTimeout(timer); }
}

function readinessCode(state) {
  return state.state === 'auth_required' ? 'AUTH_REQUIRED' : state.state === 'challenge_required' ? 'CHALLENGE_REQUIRED' : state.state === 'rate_limited' ? 'RATE_LIMITED' : state.state === 'unsupported' ? 'UNSUPPORTED' : 'PROVIDER_UNAVAILABLE';
}
function proofPending(state) {
  return state.state === 'unavailable' && ['dom_account_proof_pending', 'app_initializing'].includes(state.reason);
}
function waitWithSignal(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function waitBudget(milliseconds) {
  const controller = new AbortController();
  const deadline = Date.now() + milliseconds;
  const expired = () => controller.abort(new ResearchBrokerError('DEADLINE_EXCEEDED', ERRORS.DEADLINE_EXCEEDED));
  const timer = setTimeout(expired, milliseconds);
  return {
    controller, signal: controller.signal, deadline,
    check() {
      if (!controller.signal.aborted && Date.now() >= deadline) expired();
      if (controller.signal.aborted) throw controller.signal.reason;
      return deadline - Date.now();
    },
    async pause() {
      this.check();
      let timer;
      try { await waitWithSignal(new Promise(resolve => { timer = setTimeout(resolve, Math.min(100, this.check())); }), controller.signal); }
      finally { clearTimeout(timer); }
    },
    dispose() { clearTimeout(timer); },
  };
}

function compactError(error) {
  const code = Object.hasOwn(ERRORS, error?.code) ? error.code : 'ADAPTER_FAILED';
  const accepted = { code };
  if (error.completionUncertain === true) accepted.completionUncertain = true;
  if (code === 'RATE_LIMITED' && Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 86400000) accepted.retryAfterMs = error.retryAfterMs;
  return accepted;
}

function publicJob(job, store) {
  const accepted = cloneJSON(job);
  delete accepted.requestHash;
  delete accepted.idempotencyHash;
  accepted.outputDirectory = store.outputPath(job.id);
  if (accepted.error) accepted.error.message = ERRORS[accepted.error.code];
  return accepted;
}

/**
 * Independent FIFO worker per provider. Adapters are trusted local code and own
 * their transport and authorization. This core never attaches to the Relay UI.
 */
export async function createResearchBroker({ stateRoot, outputRoot, providers = {} } = {}) {
  keys(providers, RESEARCH_PROVIDERS);
  for (const provider of Object.values(providers)) if (!provider || typeof provider.status !== 'function' || typeof provider.run !== 'function') fail('INVALID_REQUEST', 'Every configured provider must implement status and run.');
  const store = new JobStore({ stateRoot, outputRoot, validateJob: validateStoredJob });
  const loaded = await store.open();
  const jobs = new Map(loaded.map(job => [job.id, job]));
  const idempotency = new Map();
  const requests = new Map();
  const queues = new Map(RESEARCH_PROVIDERS.map(provider => [provider, []]));
  const active = new Map();
  const pumping = new Map();
  const readinessChecks = new Map();
  const pendingSubmissions = new Set();
  const waitingJobs = new Map();
  let submissionTail = Promise.resolve();
  let closing = false;
  let closed = false;
  let closePromise;

  async function persist(job, patch) {
    Object.assign(job, patch, { updatedAt: now() });
    await store.save(job);
  }
  async function terminal(job, state, error) {
    if (job.state !== 'queued' && job.state !== 'running') return;
    await persist(job, { state, finishedAt: now(), ...(error ? { error } : {}) });
  }
  try {
    for (const job of loaded) {
      if (job.idempotencyHash) {
        if (idempotency.has(job.idempotencyHash)) fail('INVALID_STATE', 'The persisted idempotency map contains duplicate keys.');
        idempotency.set(job.idempotencyHash, job.id);
      }
      // Input and auth values are deliberately not persisted. Even queued work
      // needs a new explicit submit after a process loss; no uncertain replay.
      if (job.state === 'running' || job.state === 'queued') await terminal(job, 'interrupted', { code: 'PROCESS_INTERRUPTED', ...(job.state === 'running' ? { completionUncertain: true } : {}) });
    }
  } catch (error) { await store.close(); throw error; }

  function ensureOpen() { if (closing || closed) fail('BROKER_CLOSED', ERRORS.BROKER_CLOSED); }
  function findJob(id) {
    if (!isJobId(id)) fail('INVALID_REQUEST', 'A generated research job identifier is required.');
    const job = jobs.get(id);
    if (!job) fail('NOT_FOUND', 'The research job was not found.');
    return job;
  }

  function probeReadiness(provider) {
    if (readinessChecks.has(provider)) return readinessChecks.get(provider);
    const check = boundedStatus(providers[provider]).finally(() => {
      if (readinessChecks.get(provider) === check) readinessChecks.delete(provider);
    });
    readinessChecks.set(provider, check);
    return check;
  }
  function readiness(provider) {
    if (active.has(provider)) return Promise.resolve({ state: 'unavailable', operations: [] });
    return probeReadiness(provider);
  }
  async function settledReadiness(provider, budget, waitBusy) {
    for (;;) {
      budget.check();
      const state = await waitWithSignal(probeReadiness(provider), budget.signal);
      budget.check();
      if (!proofPending(state) && !(waitBusy && state.state === 'unavailable' && state.reason === 'provider_busy')) return state;
      await budget.pause();
    }
  }

  async function acceptResult(job, value, prior = job.result) {
    keys(value, ['state', 'count', 'nextCursor', 'files', 'evidence', 'truncated', 'coverage'], 'INVALID_RESULT');
    if (value.state !== undefined && !['completed', 'partial'].includes(value.state)) fail('INVALID_RESULT', ERRORS.INVALID_RESULT);
    const result = { ...cloneJSON(prior), count: value.count === undefined ? prior.count : boundedInteger(value.count, 0, job.limits.limit, 'INVALID_RESULT') };
    if (result.count < prior.count) fail('INVALID_RESULT', 'Cumulative research count cannot decrease after an accepted checkpoint.');
    if (value.nextCursor !== undefined) result.nextCursor = cursor(value.nextCursor, 'INVALID_RESULT');
    if (value.files !== undefined) {
      if (!Array.isArray(value.files) || value.files.length > 1000) fail('INVALID_RESULT', ERRORS.INVALID_RESULT);
      result.files = await inspectOutputFiles(store.outputPath(job.id), [...prior.files, ...value.files], active.get(job.provider)?.identity);
    } else await inspectOutputFiles(store.outputPath(job.id), result.files, active.get(job.provider)?.identity);
    if (value.evidence !== undefined) {
      if (!Array.isArray(value.evidence) || value.evidence.length > 1000) fail('INVALID_RESULT', ERRORS.INVALID_RESULT);
      const evidence = [];
      for (const item of value.evidence) {
        keys(item, ['url', 'kind', 'id'], 'INVALID_RESULT');
        const accepted = { url: sourceURL(item.url, job.provider, { evidence: true, code: 'INVALID_RESULT' }) };
        if (item.kind !== undefined) {
          if (!['post', 'channel', 'media', 'search'].includes(item.kind)) fail('INVALID_RESULT', ERRORS.INVALID_RESULT);
          accepted.kind = item.kind;
        }
        if (item.id !== undefined) {
          if (typeof item.id !== 'string' || !/^[a-z0-9_.:-]{1,128}$/i.test(item.id)) fail('INVALID_RESULT', ERRORS.INVALID_RESULT);
          accepted.id = item.id;
        }
        if (evidence.length < MAX_EVIDENCE) evidence.push(accepted);
      }
      const merged = [...prior.evidence, ...evidence];
      result.evidence = [...new Map(merged.map(item => [stable(item), item])).values()].slice(0, MAX_EVIDENCE);
      result.evidenceTruncated = Boolean(prior.evidenceTruncated || value.evidence.length > MAX_EVIDENCE || merged.length > MAX_EVIDENCE);
    }
    if (value.truncated !== undefined) {
      if (typeof value.truncated !== 'boolean') fail('INVALID_RESULT', ERRORS.INVALID_RESULT);
      result.truncated = value.truncated;
    }
    if (value.coverage !== undefined) {
      if (!COVERAGE.includes(value.coverage)) fail('INVALID_RESULT', ERRORS.INVALID_RESULT);
      result.coverage = value.coverage;
    }
    result.outcome = value.state === 'partial' ? 'partial' : result.count === 0 ? 'empty' : 'results';
    return result;
  }

  async function execute(job) {
    const provider = providers[job.provider];
    const budget = waitBudget(job.limits.deadlineMs);
    const controller = budget.controller;
    let sourceStarted = false;
    let checkpointTail = Promise.resolve();
    waitingJobs.set(job.id, controller);
    const interrupted = () => {
      if (controller.signal.reason?.code === 'DEADLINE_EXCEEDED') void terminal(job, sourceStarted ? 'interrupted' : 'failed', { code: 'DEADLINE_EXCEEDED', ...(sourceStarted ? { completionUncertain: true } : {}) }).catch(() => {});
    };
    controller.signal.addEventListener('abort', interrupted, { once: true });
    try {
      const providerReadiness = await settledReadiness(job.provider, budget, true);
      if (closing || job.state !== 'queued') return;
      if (providerReadiness.state !== 'ready') {
        const code = readinessCode(providerReadiness);
        await terminal(job, code === 'RATE_LIMITED' ? 'rate_limited' : ['AUTH_REQUIRED', 'CHALLENGE_REQUIRED'].includes(code) ? 'auth_required' : 'failed', { code });
        return;
      }
      if (!providerReadiness.operations.includes(job.operation)) { await terminal(job, 'failed', { code: 'UNSUPPORTED' }); return; }
      const request = requests.get(job.id);
      if (provider.requiresAccountBinding && (!request.accountScope || providerReadiness.accountRef !== request.accountScope.accountRef || providerReadiness.accountEpoch !== request.accountScope.accountEpoch)) {
        await terminal(job, 'failed', { code: 'STALE_ACCOUNT' }); return;
      }
      budget.check();
      const running = { id: job.id, controller, identity: request.identity };
      active.set(job.provider, running);
      await persist(job, { state: 'running', startedAt: now() });
      if (closing || job.state !== 'running' || controller.signal.aborted) return;
      const remaining = budget.check();
      const onCheckpoint = value => {
        const step = checkpointTail.then(async () => {
          if (closing || !['running', 'cancelled', 'interrupted'].includes(job.state) || (controller.signal.aborted && value.state !== 'partial')) return false;
          const result = await acceptResult(job, value);
          if (closing || !['running', 'cancelled', 'interrupted'].includes(job.state) || (controller.signal.aborted && value.state !== 'partial')) return false;
          await persist(job, { result });
          return true;
        });
        checkpointTail = step.catch(() => {});
        return step;
      };
      sourceStarted = true;
      const value = await provider.run({ operation: job.operation, input: { ...cloneJSON(request.input), deadlineMs: remaining }, accountScope: request.accountScope, jobId: job.id, outputDirectory: store.outputPath(job.id), signal: controller.signal, onCheckpoint });
      await checkpointTail;
      if (closing || job.state !== 'running' || controller.signal.aborted) return;
      budget.check();
      const result = await acceptResult(job, value);
      if (closing || job.state !== 'running' || controller.signal.aborted) return;
      budget.check();
      // Keep the in-memory state running through the durable completion write:
      // a deadline during filesystem settlement can still persist interruption.
      const completed = { ...job, result, state: value.state === 'partial' ? 'partial' : 'completed', finishedAt: now(), updatedAt: now() };
      await store.save(completed);
      if (closing || job.state !== 'running' || controller.signal.aborted) return;
      budget.check();
      Object.assign(job, completed);
    } catch (error) {
      await checkpointTail;
      if (closing || !['queued', 'running'].includes(job.state)) return;
      if (controller.signal.aborted) {
        if (controller.signal.reason?.code === 'DEADLINE_EXCEEDED') await terminal(job, sourceStarted ? 'interrupted' : 'failed', { code: 'DEADLINE_EXCEEDED', ...(sourceStarted ? { completionUncertain: true } : {}) });
        return;
      }
      const accepted = compactError(error);
      const state = accepted.code === 'RATE_LIMITED' ? 'rate_limited' : ['AUTH_REQUIRED', 'CHALLENGE_REQUIRED'].includes(accepted.code) ? 'auth_required' : job.result.count > 0 || job.result.files.length > 0 ? 'partial' : 'failed';
      if (state === 'partial') job.result.outcome = 'partial';
      await terminal(job, state, accepted);
    } finally {
      budget.dispose(); controller.signal.removeEventListener('abort', interrupted);
      waitingJobs.delete(job.id);
      if (active.get(job.provider)?.id === job.id) active.delete(job.provider);
      requests.delete(job.id);
    }
  }

  function pump(provider) {
    if (closing || pumping.has(provider)) return;
    const execution = (async () => {
      const queue = queues.get(provider);
      while (!closing && queue.length > 0) {
        const id = queue.shift();
        const job = jobs.get(id);
        if (job.state !== 'queued') { requests.delete(id); continue; }
        try { await execute(job); }
        catch { await terminal(job, 'failed', { code: 'ADAPTER_FAILED' }).catch(() => {}); }
        finally { requests.delete(id); }
      }
    })().finally(() => { pumping.delete(provider); });
    pumping.set(provider, execution);
  }

  async function capabilities() {
    const states = await Promise.all(RESEARCH_PROVIDERS.map(async provider => {
      const { accountRef, accountEpoch, ...state } = await readiness(provider);
      return { provider, configured: Boolean(providers[provider]), ...state };
    }));
    return { schemaVersion: 1, providers: states };
  }

  return {
    capabilities,
    async status() {
      const counts = Object.fromEntries(STATES.map(state => [state, 0]));
      for (const job of jobs.values()) counts[job.state]++;
      return {
        schemaVersion: 1, closed: closing || closed,
        ...await capabilities(), counts,
        queues: RESEARCH_PROVIDERS.map(provider => ({ provider, queued: queues.get(provider).filter(id => jobs.get(id).state === 'queued').length, running: active.get(provider)?.id ?? null })),
      };
    },
    async submit(request, { signal } = {}) {
      const normalized = normalizeRequest(request);
      const budget = waitBudget(MAX_SUBMIT_PROOF_WAIT_MS);
      pendingSubmissions.add(budget.controller);
      const disconnected = () => budget.controller.abort(new ResearchBrokerError('CANCELLED', ERRORS.CANCELLED));
      if (signal?.aborted) disconnected();
      else signal?.addEventListener('abort', disconnected, { once: true });
      const cleanup = () => { budget.dispose(); pendingSubmissions.delete(budget.controller); signal?.removeEventListener('abort', disconnected); };
      let committing = false;
      const submit = submissionTail.catch(() => {}).then(async () => {
        ensureOpen(); budget.check();
        if (normalized.idempotencyHash && idempotency.has(normalized.idempotencyHash)) {
          const prior = jobs.get(idempotency.get(normalized.idempotencyHash));
          if (prior.requestHash !== normalized.requestHash) fail('IDEMPOTENCY_CONFLICT', 'This idempotency key belongs to a different normalized research request.');
          return publicJob(prior, store);
        }
        if (jobs.size >= MAX_HISTORY) fail('STATE_LIMIT', 'Research job history reached its bounded limit.');
        const pending = [...jobs.values()].filter(job => job.provider === normalized.provider && ['queued', 'running'].includes(job.state)).length;
        if (pending >= MAX_ACTIVE_PER_PROVIDER) fail('QUEUE_LIMIT', 'This provider queue reached its bounded limit.');
        // Only the app-owned adapter binds an account. This private binding is
        // never an external input or persisted account identity.
        let accountScope;
        if (providers[normalized.provider]?.requiresAccountBinding) {
          const state = await settledReadiness(normalized.provider, budget, false);
          if (state.state !== 'ready' && !(state.state === 'unavailable' && state.reason === 'provider_busy')) fail(readinessCode(state), ERRORS[readinessCode(state)]);
          if (state.accountRef === undefined || state.accountEpoch === undefined) fail('STALE_ACCOUNT', ERRORS.STALE_ACCOUNT);
          if (!state.operations.includes(normalized.operation)) fail('UNSUPPORTED', ERRORS.UNSUPPORTED);
          accountScope = { accountRef: state.accountRef, accountEpoch: state.accountEpoch };
        }
        ensureOpen(); budget.check();
        const id = randomUUID();
        const output = await store.createOutput(id);
        ensureOpen(); budget.check();
        const createdAt = now();
        const job = {
          schemaVersion: 1, id, provider: normalized.provider, operation: normalized.operation, state: 'queued', createdAt, updatedAt: createdAt,
          requestHash: normalized.requestHash,
          ...(normalized.idempotencyHash ? { idempotencyHash: normalized.idempotencyHash } : {}),
          limits: { limit: normalized.input.limit, pageSize: normalized.input.pageSize, deadlineMs: normalized.input.deadlineMs },
          result: { outcome: 'empty', count: 0, files: [], evidence: [], truncated: false },
        };
        ensureOpen(); budget.check();
        // The atomic save is the irreversible commit handoff. Do not abandon
        // its result or cancel an accepted durable job on a caller disconnect.
        committing = true;
        cleanup();
        await store.save(job);
        jobs.set(id, job);
        if (job.idempotencyHash) idempotency.set(job.idempotencyHash, id);
        requests.set(id, { input: normalized.input, accountScope, identity: output.identity });
        queues.get(job.provider).push(id);
        setImmediate(() => pump(job.provider));
        return publicJob(job, store);
      });
      submissionTail = submit.then(() => {}, () => {});
      // Abort tail/proof waiting promptly, but let a started durable save settle.
      const waiting = waitWithSignal(submit, budget.signal).catch(error => {
        if (committing) return submit;
        throw error;
      });
      return waiting.finally(cleanup);
    },
    async get(id) { return publicJob(findJob(id), store); },
    async cancel(id) {
      ensureOpen();
      const job = findJob(id);
      if (job.state === 'running' || job.state === 'queued') {
        waitingJobs.get(id)?.abort(new ResearchBrokerError('CANCELLED', ERRORS.CANCELLED));
        const running = active.get(job.provider);
        if (running?.id === id) {
          clearTimeout(running.deadline);
          running.controller.abort(new ResearchBrokerError('CANCELLED', ERRORS.CANCELLED));
        }
        await terminal(job, 'cancelled', { code: 'CANCELLED', ...(job.state === 'running' ? { completionUncertain: true } : {}) });
      }
      return publicJob(job, store);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const controller of pendingSubmissions) controller.abort(new ResearchBrokerError('BROKER_CLOSED', ERRORS.BROKER_CLOSED));
      for (const controller of waitingJobs.values()) controller.abort(new ResearchBrokerError('BROKER_CLOSED', ERRORS.BROKER_CLOSED));
      closePromise = (async () => {
        await submissionTail;
        for (const job of jobs.values()) {
          const running = active.get(job.provider);
          if (running?.id === job.id) {
            clearTimeout(running.deadline);
            running.controller.abort(new ResearchBrokerError('BROKER_CLOSED', ERRORS.BROKER_CLOSED));
          }
          await terminal(job, job.state === 'running' ? 'interrupted' : 'cancelled', { code: 'BROKER_CLOSED', ...(job.state === 'running' ? { completionUncertain: true } : {}) });
        }
        const providerClosures = Object.values(providers).map(provider => Promise.resolve().then(() => provider.close?.()).catch(() => {}));
        let timer;
        await Promise.race([Promise.allSettled([...pumping.values(), ...providerClosures]), new Promise(resolve => { timer = setTimeout(resolve, CLOSE_WAIT_MS); })]);
        clearTimeout(timer);
        const pendingProviders = [...active.keys()];
        await store.close();
        closed = true;
        return { closed: true, pendingProviders };
      })();
      return closePromise;
    },
  };
}
