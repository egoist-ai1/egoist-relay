import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_FRAME = 262144;
const MAX_PEERS = 16;
const OPERATIONS = Object.freeze({
  telegram: ['discover', 'chat_info', 'read', 'search', 'channel_history', 'chat_export', 'download', 'join_chat'],
  x: ['discover', 'profile', 'read', 'search', 'channel_history', 'chat_export', 'download', 'article', 'read_thread'],
  instagram: ['discover', 'profile', 'read', 'search', 'channel_history', 'chat_export', 'download', 'read_thread'],
});
const PRIVATE_FILES = ['.research-owned.json', 'relay-bridge.json', 'relay-bridge-token'];
const FORBIDDEN_INPUT = new Set(['script', 'eval', 'method', 'args', 'headers', 'cookies', 'session', 'authKey', 'accessHash', 'outputDirectory', 'stateRoot', 'path', 'expectedAccount']);
const LOCAL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const STARTUP_CODES = new Set(['WINDOWS_REQUIRED', 'INIT_DENIED', 'BRIDGE_ALREADY_RUNNING', 'BRIDGE_START_FAILED',
  'RESEARCH_STATE_SCOPE_INVALID', 'RESEARCH_STATE_REPARSE_DENIED', 'RESEARCH_STATE_FILE_INVALID',
  'RESEARCH_STATE_FILE_OVERSIZED', 'RESEARCH_STATE_OWNER_MISMATCH', 'RESEARCH_STATE_ACL_UNEXPECTED',
  'RESEARCH_STATE_ACL_NOT_PRIVATE', 'RESEARCH_STATE_ACL_INCOMPLETE', 'RESEARCH_STATE_UNOWNED',
  'RESEARCH_STATE_MISSING', 'RESEARCH_STATE_NOT_PRIVATE', 'RESEARCH_STATE_MARKER_INVALID', 'RESEARCH_STATE_INITIALIZATION_BUSY', 'RESEARCH_TEST_SCOPE_INVALID']);

function startupCode(error) {
  const candidate = error?.researchCode ?? error?.code;
  return STARTUP_CODES.has(candidate) ? candidate : 'BRIDGE_START_FAILED';
}

function failure(code) { const error = new Error(code); error.code = code; error.researchCode = code; return error; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value, maximum = 128) { return typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/.test(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function safePath(value) { return path.resolve(value).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, ''); }
function samePath(left, right) { return safePath(left).toLowerCase() === safePath(right).toLowerCase(); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

export function validateInput(input) {
  if (!object(input) || Buffer.byteLength(JSON.stringify(input), 'utf8') > 65536) throw failure('INVALID_INPUT');
  let nodes = 0;
  function visit(value, depth) {
    if (++nodes > 10000 || depth > 12) throw failure('INVALID_INPUT');
    if (typeof value === 'number' && !Number.isFinite(value)) throw failure('INVALID_INPUT');
    if (Array.isArray(value)) { if (value.length > 1000) throw failure('INVALID_INPUT'); for (const item of value) visit(item, depth + 1); }
    else if (object(value)) { for (const [key, item] of Object.entries(value)) { if (FORBIDDEN_INPUT.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw failure('INVALID_INPUT'); visit(item, depth + 1); } }
  }
  visit(input, 0);
  return input;
}

export function frameReader(onFrame, onFailure) {
  let buffered = Buffer.alloc(0);
  let failed = false;
  return (chunk) => {
    if (failed) return;
    let start = 0;
    for (let offset = 0; offset < chunk.length; offset++) {
      if (chunk[offset] !== 10) continue;
      if (buffered.length + offset - start > MAX_FRAME) { failed = true; onFailure('FRAME_TOO_LARGE'); return; }
      const bytes = Buffer.concat([buffered, chunk.subarray(start, offset)]);
      buffered = Buffer.alloc(0);
      start = offset + 1;
      if (bytes.length === 0) continue;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed = JSON.parse(text);
        if (!object(parsed)) throw failure('INVALID_FRAME');
        onFrame(parsed);
      } catch (error) { failed = true; onFailure(error.researchCode || 'INVALID_FRAME'); return; }
    }
    if (buffered.length + chunk.length - start > MAX_FRAME) { failed = true; onFailure('FRAME_TOO_LARGE'); return; }
    buffered = Buffer.concat([buffered, chunk.subarray(start)]);
  };
}

function inspectPaths(root) {
  let cursor = root;
  while (cursor) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw failure('RESEARCH_STATE_REPARSE_DENIED');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (fs.existsSync(root) && !samePath(fs.realpathSync.native(root), root)) throw failure('RESEARCH_STATE_REPARSE_DENIED');
  for (const name of PRIVATE_FILES) {
    const target = path.join(root, name);
    if (!fs.existsSync(target)) continue;
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) throw failure('RESEARCH_STATE_FILE_INVALID');
  }
}

function ensurePrivateRoot(root, isolatedTest, validateOnly = false) {
  inspectPaths(root);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(LOCAL_DIRECTORY, 'ensure-private-state.ps1'), '-StateRoot', root];
  if (isolatedTest) args.push('-IsolatedTest');
  if (validateOnly) args.push('-ValidateOnly');
  const result = spawnSync(executable, args, { windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 8192 });
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'RESEARCH_STATE_PRIVATE') {
    const candidate = /\bRESEARCH_[A-Z_]{1,64}\b/.exec(result.stderr || '')?.[0];
    throw failure(STARTUP_CODES.has(candidate) ? candidate : 'RESEARCH_STATE_NOT_PRIVATE');
  }
  inspectPaths(root);
}

function atomicOwnedWrite(root, fileName, bytes) {
  const temporary = path.join(root, `${fileName}.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    inspectPaths(root);
    fs.renameSync(temporary, path.join(root, fileName));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function startBridge(init, sendNative) {
  if (process.platform !== 'win32') throw failure('WINDOWS_REQUIRED');
  if (!keys(init, ['type', 'protocolVersion', 'runtimeId', 'appPid', 'appStartedAt', 'executablePath', 'stateRoot', 'isolatedTest'])
    || init.type !== 'init' || init.protocolVersion !== 1 || !identifier(init.runtimeId, 64)
    || init.appPid !== process.ppid || !Number.isSafeInteger(init.appStartedAt) || init.appStartedAt <= 0
    || typeof init.executablePath !== 'string' || !path.isAbsolute(init.executablePath)
    || typeof init.stateRoot !== 'string' || !path.isAbsolute(init.stateRoot) || typeof init.isolatedTest !== 'boolean') throw failure('INIT_DENIED');
  const expected = init.isolatedTest && process.env.EGOIST_RELAY_SMOKE_TEST === '1' && process.env.EGOIST_RELAY_TEST_PROFILE
    ? path.join(process.env.EGOIST_RELAY_TEST_PROFILE, 'research') : path.join(process.env.USERPROFILE || '', '.egoist-research');
  if (init.isolatedTest && process.env.EGOIST_RELAY_SMOKE_TEST !== '1') throw failure('INIT_DENIED');
  if (!samePath(init.stateRoot, expected)) throw failure('RESEARCH_STATE_SCOPE_INVALID');
  const stateRoot = safePath(init.stateRoot);
  ensurePrivateRoot(stateRoot, init.isolatedTest);
  const metadataPath = path.join(stateRoot, 'relay-bridge.json');
  if (fs.existsSync(metadataPath)) {
    const previous = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (Number.isSafeInteger(previous.helperPid) && alive(previous.helperPid)) throw failure('BRIDGE_ALREADY_RUNNING');
  }
  const canonical = safePath(fs.realpathSync.native(stateRoot));
  const pipePath = `\\\\.\\pipe\\EgoistRelayAccountBridge-${createHash('sha256').update(canonical.toLowerCase(), 'utf8').digest('hex').slice(0, 24)}-${init.runtimeId}`;
  const secret = randomBytes(32).toString('hex');
  const peers = new Set();
  const pending = new Map();
  const providers = new Map();
  let closed = false;

  function output(peer, id, event) {
    const bytes = Buffer.from(JSON.stringify({ id, event }) + '\n', 'utf8');
    if (bytes.length - 1 > MAX_FRAME || peer.destroyed || peer.writableEnded) return false;
    if (peer.writableLength + bytes.length > 1048576) { peer.destroy(); return false; }
    peer.write(bytes);
    return true;
  }
  async function outputWithDrain(peer, id, event, expiresAt) {
    if (!output(peer, id, event)) return false;
    if (!peer.writableNeedDrain) return true;
    return new Promise(resolve => {
      let timer;
      const finish = accepted => {
        clearTimeout(timer);
        peer.removeListener('drain', drained);
        peer.removeListener('close', stopped);
        peer.removeListener('error', stopped);
        resolve(accepted);
      };
      const drained = () => finish(true);
      const stopped = () => finish(false);
      peer.once('drain', drained);
      peer.once('close', stopped);
      peer.once('error', stopped);
      timer = setTimeout(stopped, Math.max(1, expiresAt - Date.now()));
      timer.unref();
      if (peer.destroyed || peer.writableEnded) stopped();
      else if (!peer.writableNeedDrain) drained();
    });
  }
  function terminal(peer, id, code, completionUncertain = false) {
    peer.finalizing = true;
    output(peer, id, { kind: 'error', code, reason: completionUncertain ? 'cancelled_completion_uncertain' : code,
      ...(completionUncertain ? { completionUncertain: true } : {}) });
    peer.end(); peer.setTimeout(1000, () => peer.destroy());
  }
  function release(request, cancelOwner) {
    if (!pending.delete(request.requestId)) return;
    clearTimeout(request.timer);
    if (request.provider) providers.delete(request.provider);
    if (cancelOwner) sendNative({ type: 'cancel', requestId: request.requestId, nonce: request.nonce });
  }
  function hmac(message) { return createHmac('sha256', secret).update(message, 'utf8').digest('hex'); }
  function authenticated(frame, peer) {
    if (!peer.hello || frame.id !== peer.hello.id || frame.challenge !== peer.hello.challenge
      || typeof frame.mac !== 'string' || !/^[a-f0-9]{64}$/.test(frame.mac)) return false;
    const expected = hmac(`${frame.id}\n${frame.challenge}\n${peer.hello.nonce}\n${init.runtimeId}\n${frame.method}\n${JSON.stringify(frame.params ?? {})}`);
    return timingSafeEqual(Buffer.from(frame.mac, 'hex'), Buffer.from(expected, 'hex'));
  }
  function external(peer, frame) {
    if (peer.finalizing) return;
    if (identifier(frame.id, 64)) peer.externalId = frame.id;
    if (frame.method === 'hello') {
      if (peer.hello || peer.requestAccepted || !keys(frame, ['id', 'challenge', 'method']) || !identifier(frame.id, 64)
        || typeof frame.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(frame.challenge)) { terminal(peer, peer.externalId ?? 'denied', 'BRIDGE_DENIED'); return; }
      peer.hello = { id: frame.id, challenge: frame.challenge, nonce: randomBytes(32).toString('hex') };
      output(peer, frame.id, { kind: 'hello', runtimeId: init.runtimeId, appPid: init.appPid, helperPid: process.pid, challenge: frame.challenge, nonce: peer.hello.nonce,
        proof: hmac(`${frame.id}\n${frame.challenge}\n${peer.hello.nonce}\n${init.runtimeId}\n${init.appPid}\n${process.pid}`) });
      return;
    }
    if (!keys(frame, ['id', 'challenge', 'mac', 'method', 'params']) || !identifier(frame.id, 64) || !authenticated(frame, peer)) { terminal(peer, peer.externalId ?? 'denied', 'BRIDGE_DENIED'); return; }
    if (peer.requestAccepted) { terminal(peer, frame.id, 'ONE_REQUEST_PER_CONNECTION'); return; }
    peer.requestAccepted = true;
    clearTimeout(peer.authenticationTimer);
    const params = frame.params ?? {};
    if (frame.method === 'cancel') {
      if (!keys(params, ['jobId']) || !identifier(params.jobId)) { terminal(peer, frame.id, 'INVALID_REQUEST'); return; }
      const target = [...pending.values()].find((item) => item.jobId === params.jobId);
      if (!target) { terminal(peer, frame.id, 'JOB_NOT_FOUND'); return; }
      release(target, true);
      terminal(target.peer, target.externalId, 'CANCELLED', Boolean(target.provider));
      output(peer, frame.id, { kind: 'done', outcome: 'cancelled', count: 0, coverage: { schemaVersion: 1, complete: true } });
      peer.end();
      return;
    }
    if (!['status', 'capabilities', 'run'].includes(frame.method)) { terminal(peer, frame.id, 'UNSUPPORTED'); return; }
    const run = frame.method === 'run';
    if ((!run && (!keys(params, []) || pending.size >= 11)) || (run && (!keys(params, ['provider', 'operation', 'input', 'jobId', 'expectedAccount'])
      || !OPERATIONS[params.provider]?.includes(params.operation) || !identifier(params.jobId)
      || !keys(params.expectedAccount, ['accountRef', 'accountEpoch']) || !identifier(params.expectedAccount.accountRef,160)
      || !(identifier(params.expectedAccount.accountEpoch,128) || Number.isSafeInteger(params.expectedAccount.accountEpoch) && params.expectedAccount.accountEpoch >= 0)))) { terminal(peer, frame.id, 'INVALID_REQUEST'); return; }
    if (run && (providers.has(params.provider) || [...pending.values()].some((item) => item.jobId === params.jobId))) { terminal(peer, frame.id, 'PROVIDER_BUSY'); return; }
    if (run) validateInput(params.input);
    const requestId = randomUUID();
    const nonce = randomBytes(32).toString('hex');
    const deadlineMs = run ? 300000 : 10000;
    const request = { requestId, nonce, externalId: frame.id, peer, method: frame.method, provider: run ? params.provider : undefined, jobId: run ? params.jobId : undefined, expiresAt: Date.now() + deadlineMs };
    request.timer = setTimeout(() => { if (pending.has(requestId)) { release(request, true); terminal(peer, frame.id, 'DEADLINE_EXCEEDED', run); } }, deadlineMs);
    request.timer.unref();
    pending.set(requestId, request);
    if (run) providers.set(params.provider, requestId);
    const dispatch = { type: 'request', requestId, nonce, method: frame.method, deadlineMs };
    if (run) Object.assign(dispatch, { provider: params.provider, operation: params.operation, input: params.input, jobId: params.jobId, expectedAccount: params.expectedAccount });
    sendNative(dispatch);
  }
  const server = net.createServer((peer) => {
    if (peers.size >= MAX_PEERS || closed) { peer.destroy(); return; }
    peers.add(peer);
    peer.authenticationTimer = setTimeout(() => peer.destroy(), 5000);
    peer.authenticationTimer.unref();
    peer.on('data', frameReader((frame) => external(peer, frame), (code) => terminal(peer, peer.externalId ?? 'invalid', code)));
    peer.on('error', () => {});
    peer.on('close', () => {
      clearTimeout(peer.authenticationTimer);
      peers.delete(peer);
      for (const request of pending.values()) if (request.peer === peer) release(request, true);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ path: pipePath, readableAll: false, writableAll: false }, resolve); });
  const metadata = { schemaVersion: 1, protocolVersion: 1, runtimeId: init.runtimeId, appPid: init.appPid, appStartedAt: init.appStartedAt, executablePath: init.executablePath, helperPid: process.pid, pipePath, isolatedTest: init.isolatedTest };
  const cleanupMetadata = () => {
    try {
      inspectPaths(stateRoot);
      const current = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (current.runtimeId === init.runtimeId && current.helperPid === process.pid) {
        fs.unlinkSync(metadataPath);
        fs.unlinkSync(path.join(stateRoot, 'relay-bridge-token'));
      }
    } catch { /* A later owner or changed path must never be removed. */ }
  };
  try {
    atomicOwnedWrite(stateRoot, 'relay-bridge-token', secret);
    atomicOwnedWrite(stateRoot, 'relay-bridge.json', JSON.stringify(metadata));
    ensurePrivateRoot(stateRoot, init.isolatedTest, true);
  } catch (error) { server.close(); for (const peer of peers) peer.destroy(); cleanupMetadata(); throw error; }
  server.on('error', () => close());
  async function nativeEvent(frame) {
    if (!keys(frame, ['type', 'requestId', 'nonce', 'event']) || frame.type !== 'event' || !object(frame.event)) throw failure('INVALID_NATIVE_EVENT');
    const request = pending.get(frame.requestId);
    if (!request || frame.nonce !== request.nonce) return;
    const event = frame.event;
    if (!['status', 'scope', 'records', 'media_open', 'media_chunk', 'media_close', 'done', 'error'].includes(event.kind)) throw failure('INVALID_NATIVE_EVENT');
    if (event.kind === 'error') {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(event.code) ? event.code : 'PROVIDER_ERROR';
      const uncertain = event.completionUncertain === true;
      event.code = code;
      event.reason = uncertain ? (['CANCELLED', 'DEADLINE_EXCEEDED'].includes(code) ? 'cancelled_completion_uncertain' : 'remote_completion_uncertain') : code;
      if (!uncertain) delete event.completionUncertain;
    }
    if (event.kind === 'status') event.runtimeId = init.runtimeId;
    const isTerminal = event.kind === 'error' || event.kind === 'done' || (request.method !== 'run' && event.kind === 'status');
    if (!await outputWithDrain(request.peer, request.externalId, event, request.expiresAt)) { release(request, true); request.peer.destroy(); return; }
    if (pending.get(frame.requestId) !== request) return;
    if (isTerminal) { release(request, false); request.peer.end(); }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const request of [...pending.values()]) release(request, true);
    for (const peer of peers) peer.destroy();
    server.close();
    cleanupMetadata();
  }
  return { metadata, nativeEvent, close };
}

async function main() {
  let bridge;
  let initialized = false;
  let initializing;
  let closing = false;
  const queued = [];
  const delivery = [];
  let deliveryBytes = 0;
  let delivering = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    bridge?.close();
    process.stdin.destroy();
    if (process.exitCode === undefined) process.exitCode = 0;
  };
  const sendNative = (frame) => {
    if (closing) return;
    const bytes = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(bytes, 'utf8') - 1 > MAX_FRAME) throw failure('FRAME_TOO_LARGE');
    if (process.stdout.writableLength + Buffer.byteLength(bytes,'utf8') > 1048576) {
      process.exitCode = 1;
      stop();
      return;
    }
    process.stdout.write(bytes);
  };
  async function deliverNative() {
    if (delivering || !bridge || closing) return;
    delivering = true;
    process.stdin.pause();
    try {
      while (delivery.length && !closing) {
        const item = delivery.shift();
        await bridge.nativeEvent(item.frame);
        deliveryBytes -= item.bytes;
      }
    } catch {
      process.exitCode = 1;
      stop();
    } finally {
      delivering = false;
      if (!closing) process.stdin.resume();
    }
  }
  function enqueueNative(frame) {
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
    if (deliveryBytes + bytes > 1048576) throw failure('NATIVE_QUEUE_LIMIT');
    deliveryBytes += bytes;
    delivery.push({ frame, bytes });
    void deliverNative();
  }
  process.stdout.on('error', () => { process.exitCode = 1; stop(); });
  process.stdin.on('data', frameReader((frame) => {
    if (!initialized) {
      initialized = true;
      initializing = startBridge(frame, sendNative).then((started) => {
        bridge = started;
        sendNative({ type: 'startup_ready', protocolVersion: 1, runtimeId: bridge.metadata.runtimeId, helperPid: process.pid });
        for (const event of queued.splice(0)) enqueueNative(event);
      }).catch((error) => {
        sendNative({ type: 'startup_error', protocolVersion: 1,
          runtimeId: identifier(frame.runtimeId, 64) ? frame.runtimeId : '', helperPid: process.pid, code: startupCode(error) });
        process.exitCode = 1;
        stop();
      });
    } else if (!bridge) {
      if (queued.length >= 16) throw failure('NATIVE_QUEUE_LIMIT');
      queued.push(frame);
    } else enqueueNative(frame);
  }, () => { process.exitCode = 1; stop(); }));
  process.stdin.on('end', () => { void Promise.resolve(initializing).finally(stop); });
  process.stdin.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setTimeout(() => { if (!initialized) stop(); }, 10000).unref();
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) await main();
