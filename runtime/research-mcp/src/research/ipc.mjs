import net from 'node:net';
import { createHmac, timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import { MAX_FRAME_BYTES, RESEARCH_VERSION, researchError } from './config.mjs';
import { OrchError, ORCHESTRATION_CONTRACT, publicError, sha256, stable } from './orch-core.mjs';

const allowed = new Set(['capabilities', 'status', 'submit', 'get', 'cancel', 'shutdown', 'plan', 'run', 'job', 'job_control', 'records', 'stats', 'lookup', 'export', 'import_legacy']);
// Методы ядра оркестрации: параметры проверяет само ядро, ответ — конверт { ok, data }.
const ORCHESTRATED = new Set(['plan', 'run', 'job', 'job_control', 'records', 'stats', 'lookup', 'export', 'import_legacy']);
// Частые опросы не пишутся в журнал аудита: он остаётся читаемым.
const UNAUDITED = new Set(['status', 'get', 'job', 'capabilities']);
const LONG_RUNNING = new Set(['job', 'export', 'import_legacy', 'records', 'stats', 'lookup']);
const codes = new Set(['AUTH_REQUIRED', 'RATE_LIMITED', 'CHALLENGE_REQUIRED', 'UNSUPPORTED', 'INVALID_INPUT', 'INVALID_REQUEST', 'INVALID_PROVIDER', 'INVALID_OPERATION', 'INVALID_STATE', 'INVALID_RESULT', 'IDEMPOTENCY_CONFLICT', 'NOT_FOUND', 'STATE_BUSY', 'OUTPUT_EXISTS', 'BUSY', 'LINK_PATH_DENIED', 'UNSAFE_PATH', 'OUTPUT_WORKSPACE_REQUIRED', 'QUEUE_LIMIT', 'STATE_LIMIT', 'BROKER_CLOSED', 'CANCELLED', 'PROVIDER_UNAVAILABLE', 'ADAPTER_FAILED', 'DEADLINE_EXCEEDED', 'DAEMON_UNAVAILABLE', 'DAEMON_TIMEOUT', 'DAEMON_START_FAILED', 'DAEMON_BOOT_BUSY', 'DAEMON_BOOT_LOCK_INVALID', 'DAEMON_TOKEN_INVALID', 'OWN_DAEMON_RESTART_REQUIRED', 'RESEARCH_STATE_PRIVATE_FAILED', 'RESEARCH_FRAME_TOO_LARGE', 'POLICY_DENIED', 'PLAN_EXPIRED', 'CONFIRMATION_REQUIRED', 'CURSOR_STALE', 'INDEX_REBUILDING', 'ACCOUNT_RESTRICTED', 'INDEX_UNAVAILABLE']);
export function safeResearchError(error) {
  // Ошибки ядра оркестрации несут проверенные статичные тексты — их можно отдавать целиком.
  if (error instanceof OrchError) return publicError(error);
  const extra = new Set(['ACCESS_DENIED', 'STALE_ACCOUNT', 'FILE_REFERENCE_EXPIRED', 'DISK_RESERVE', 'APP_BRIDGE_UNAVAILABLE', 'BRIDGE_RUNTIME_CHANGED', 'BRIDGE_IDENTITY_UNCONFIRMED', 'DAEMON_SERVER_UNCONFIRMED', 'PROVIDER_BUSY']);
  return { code: codes.has(error?.code) || extra.has(error?.code) ? error.code : 'RESEARCH_OPERATION_FAILED', recovery: 'Read the exact job/capability state before retrying. A missing Relay-owned bridge is not missing account authorization; do not ask for a repeated login.' };
}
function authorized(candidate, token) {
  if (typeof candidate !== 'string' || !/^[0-9a-f]{64}$/.test(candidate)) return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const sign = (token, value) => createHmac('sha256', token).update(value).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * broker — прежний брокер заданий (submit/get/cancel); orchestrator — ядро оркестрации (необязательно для старых вызывающих);
 * audit — журнал аудита.
 */
export async function listenResearchDaemon({ broker, orchestrator, audit, pipePath, token, sourceHash, onShutdown }) {
  const sockets = new Set();
  let stopping = false;
  let submissions = 0;
  const reply = (socket, value) => {
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      socket.end(JSON.stringify({ id: value.id, error: { code: 'RESEARCH_FRAME_TOO_LARGE' } }) + '\n');
    } else socket.end(frame);
  };
  const server = net.createServer((socket) => {
    if (sockets.size >= 64) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(30000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let handled = false;
    let hello;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { handled = true; socket.destroy(); return; }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      void (async () => {
        let request;
        try { request = JSON.parse(utf8.decode(buffer.subarray(0, end))); } catch { handled = true; socket.destroy(); return; }
        buffer = buffer.subarray(end + 1);
        if (!request || Array.isArray(request)) { handled = true; socket.destroy(); return; }
        if (!hello) {
          if (Object.keys(request).some(key => !['id', 'challenge', 'method'].includes(key)) || request.method !== 'hello' || typeof request.id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(request.id) || !/^[a-f0-9]{64}$/.test(request.challenge ?? '') || buffer.length) { handled = true; socket.destroy(); return; }
          hello = { id: request.id, challenge: request.challenge, nonce: randomBytes(32).toString('hex') };
          socket.write(JSON.stringify({ id: hello.id, hello: { nonce: hello.nonce, pid: process.pid, sourceHash, proof: sign(token, `${hello.id}\n${hello.challenge}\n${hello.nonce}\n${process.pid}\n${sourceHash}`) } }) + '\n');
          return;
        }
        handled = true;
        if (Object.keys(request).some(key => !['id', 'challenge', 'method', 'params', 'mac'].includes(key)) || request.id !== hello.id || request.challenge !== hello.challenge || buffer.length || !authorized(request.mac, sign(token, `${hello.id}\n${hello.challenge}\n${hello.nonce}\n${request.method}\n${JSON.stringify(request.params)}`))) { socket.destroy(); return; }
        if (!allowed.has(request.method)) {
          reply(socket, { id: typeof request.id === 'string' ? request.id.slice(0, 64) : null, error: { code: 'INVALID_INPUT' } }); return;
        }
        const controller = new AbortController();
        const disconnected = () => controller.abort(researchError('CANCELLED'));
        let audited = false;
        try {
          const params = request.params ?? {};
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw researchError('INVALID_INPUT');
          let result;
          if (LONG_RUNNING.has(request.method)) socket.setTimeout(0);
          if (request.method === 'status') {
            if (orchestrator && Object.hasOwn(params, 'include')) result = await orchestrator.status(params);
            else {
              if (Object.keys(params).length) throw researchError('INVALID_INPUT');
              result = { daemon: { pid: process.pid, sourceHash, version: RESEARCH_VERSION, contract: ORCHESTRATION_CONTRACT, accountSource: 'relay_owned_bridge', relay_process_dependency: true }, broker: await broker.status() };
            }
          } else if (request.method === 'capabilities') {
            if (Object.keys(params).length) throw researchError('INVALID_INPUT');
            result = await broker.capabilities();
          } else if (ORCHESTRATED.has(request.method)) {
            if (!orchestrator) throw researchError('INVALID_INPUT');
            if (stopping) throw researchError('BUSY');
            socket.once('close', disconnected);
            if (socket.destroyed) disconnected();
            try { result = await orchestrator[request.method === 'job_control' ? 'jobControl' : request.method === 'import_legacy' ? 'importLegacy' : request.method](params, { signal: controller.signal }); }
            finally { socket.removeListener('close', disconnected); }
          } else if (request.method === 'submit') {
            if (stopping) throw researchError('BUSY');
            if (params.operation === 'join_chat') throw researchError('INVALID_INPUT');
            if (orchestrator && typeof params.operation === 'string') { orchestrator.authorizeSubmit(params.operation); audited = true; }
            socket.once('close', disconnected);
            if (socket.destroyed) disconnected();
            submissions++;
            try { result = await broker.submit(params, { signal: controller.signal }); }
            finally { submissions--; socket.removeListener('close', disconnected); }
          }
          else if (request.method === 'get' || request.method === 'cancel') {
            if (Object.keys(params).some((key) => !['jobId', 'legacyArchive'].includes(key)) || typeof params.jobId !== 'string' || (params.legacyArchive !== undefined && typeof params.legacyArchive !== 'boolean')) throw researchError('INVALID_INPUT');
            result = await broker[request.method](params.jobId, { legacyArchive: params.legacyArchive });
          } else {
            if (Object.keys(params).length) throw researchError('INVALID_INPUT');
            if (stopping || submissions) throw researchError('BUSY');
            stopping = true;
            let state;
            try {
              state = await broker.status();
              if (state.counts?.queued > 0 || state.counts?.running > 0 || state.queues?.some((item) => item.queued > 0 || item.running)) throw researchError('BUSY');
            } catch (error) { stopping = false; throw error; }
            result = { status: 'stopping_owned_daemon', relay_left_running: true };
          }
          if (audit && !UNAUDITED.has(request.method)) audit.append('tool_call', { method: request.method, args: sha256(stable(params)).slice(0, 16), ok: true });
          reply(socket, { id: request.id, result });
          if (request.method === 'shutdown') setImmediate(() => { void Promise.resolve().then(() => onShutdown?.()).catch(() => {}); });
        } catch (error) {
          const safe = safeResearchError(error);
          if (audit && !UNAUDITED.has(request.method) && !(audited && safe.code === 'POLICY_DENIED')) audit.append('tool_call', { method: request.method, args: sha256(stable(request.params ?? {})).slice(0, 16), ok: false, code: safe.code });
          reply(socket, { id: request.id, error: safe });
        }
      })().catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  return { server, async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}

export async function callResearchDaemon({ pipePath, token, expectedSourceHash, method, params = {}, timeoutMs = 35000, signal }) {
  if (signal?.aborted) throw researchError('CANCELLED');
  const id = randomUUID();
  const challenge = randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let proved = false;
    const timer = setTimeout(() => done(researchError('DAEMON_TIMEOUT')), timeoutMs);
    const abort = () => done(researchError('CANCELLED'));
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', (error) => done(Object.assign(researchError('DAEMON_UNAVAILABLE'), { causeCode: error.code })));
    socket.once('connect', () => socket.write(JSON.stringify({ id, challenge, method: 'hello' }) + '\n'));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { done(researchError('DAEMON_FRAME_TOO_LARGE')); return; }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(utf8.decode(buffer.subarray(0, end)));
        buffer = buffer.subarray(end + 1);
        if (response.id !== id) throw researchError('DAEMON_REPLY_MISMATCH');
        if (!proved) {
          const hello = response.hello;
          if (!hello || !/^[a-f0-9]{64}$/.test(hello.nonce ?? '') || !Number.isSafeInteger(hello.pid) || hello.pid <= 0 || typeof hello.sourceHash !== 'string' || hello.sourceHash.length > 128 || !authorized(hello.proof, sign(token, `${id}\n${challenge}\n${hello.nonce}\n${hello.pid}\n${hello.sourceHash}`))) throw researchError('DAEMON_SERVER_UNCONFIRMED');
          if (expectedSourceHash !== undefined && hello.sourceHash !== expectedSourceHash) throw researchError('OWN_DAEMON_RESTART_REQUIRED');
          proved = true;
          const request = { id, challenge, method, params, mac: sign(token, `${id}\n${challenge}\n${hello.nonce}\n${method}\n${JSON.stringify(params)}`) };
          const frame = JSON.stringify(request) + '\n';
          if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw researchError('RESEARCH_FRAME_TOO_LARGE');
          socket.write(frame);
          return;
        }
        if (response.error) done(Object.assign(researchError(response.error.code), { recovery: response.error.recovery, details: response.error }));
        else done(null, response.result);
      } catch (error) { done(error); }
    });
    socket.once('end', () => { if (!settled) done(researchError('DAEMON_REPLY_LOST')); });
    socket.once('close', () => { if (!settled) done(researchError('DAEMON_REPLY_LOST')); });
  });
}
