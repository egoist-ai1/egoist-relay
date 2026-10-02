import net from 'node:net';
import { readFile, lstat } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertPlainAncestors, MAX_FRAME_BYTES, researchError } from './config.mjs';
import { ensureRelayBridgeStarted } from './bridge-start.mjs';
const runFile = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EVENT_KINDS = new Set(['status', 'records', 'media_open', 'media_chunk', 'media_close', 'done', 'error', 'scope']);
const hmac = (token, text) => createHmac('sha256', token).update(text).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sameHex = (left, right) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export async function readRelayBridgeMetadata(config) {
  await assertPlainAncestors(config.bridgeMetadataPath);
  await assertPlainAncestors(config.bridgeTokenPath);
  let metadataInfo;
  try { metadataInfo = await lstat(config.bridgeMetadataPath); }
  catch (error) { if (error.code === 'ENOENT') throw researchError('APP_BRIDGE_UNAVAILABLE'); throw error; }
  const tokenInfo = await lstat(config.bridgeTokenPath);
  if (!metadataInfo.isFile() || metadataInfo.nlink !== 1 || metadataInfo.size > 16384 || !tokenInfo.isFile() || tokenInfo.nlink !== 1 || tokenInfo.size !== 64) throw researchError('BRIDGE_METADATA_INVALID');
  let metadata;
  try { metadata = JSON.parse(await readFile(config.bridgeMetadataPath, 'utf8')); }
  catch { throw researchError('BRIDGE_METADATA_INVALID'); }
  if (metadata.schemaVersion !== 1 || metadata.protocolVersion !== 1 || !UUID.test(metadata.runtimeId ?? '') ||
      !Number.isSafeInteger(metadata.appPid) || metadata.appPid <= 0 || !Number.isSafeInteger(metadata.helperPid) || metadata.helperPid <= 0 ||
      !Number.isSafeInteger(metadata.appStartedAt) || metadata.appStartedAt <= 0 ||
      typeof metadata.executablePath !== 'string' || resolve(metadata.executablePath).toLowerCase() !== resolve(config.relayExecutablePath).toLowerCase() ||
      metadata.pipePath !== `${config.bridgePipePath}-${metadata.runtimeId}` || typeof metadata.isolatedTest !== 'boolean') throw researchError('BRIDGE_METADATA_INVALID');
  const token = await readFile(config.bridgeTokenPath, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw researchError('BRIDGE_TOKEN_INVALID');
  const after = await lstat(config.bridgeMetadataPath);
  if (metadataInfo.ino !== after.ino || metadataInfo.mtimeMs !== after.mtimeMs || metadataInfo.size !== after.size) throw researchError('BRIDGE_RUNTIME_CHANGED');
  return { metadata, token };
}

async function verifyRelayProcess(config, metadata) {
  try {
    const result = await runFile(config.powershellPath, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../../scripts/verify-relay-bridge.ps1', import.meta.url)), '-MetadataPath', config.bridgeMetadataPath, '-ExpectedExecutable', config.relayExecutablePath], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const value = JSON.parse(result.stdout.trim());
    if (!value.ok || value.appPid !== metadata.appPid || value.helperPid !== metadata.helperPid || Math.abs(value.appStartedAt - metadata.appStartedAt) > 2) throw researchError('BRIDGE_IDENTITY_UNCONFIRMED');
  } catch { throw researchError('BRIDGE_IDENTITY_UNCONFIRMED'); }
}

export function createRelayBridgeClient(config, { readMetadata = readRelayBridgeMetadata, verifyProcess = verifyRelayProcess, connectSocket = path => net.createConnection(path), activateBridge = ensureRelayBridgeStarted } = {}) {
  const sockets = new Set();
  let closed = false;
  let statusPending;
  async function call(method, params = {}, { signal, onEvent = async () => {} } = {}) {
    if (closed || !['status', 'capabilities', 'run', 'cancel'].includes(method)) throw researchError('APP_BRIDGE_UNAVAILABLE');
    let owner;
    try { owner = await readMetadata(config); await verifyProcess(config, owner.metadata); }
    catch (error) {
      if (!['APP_BRIDGE_UNAVAILABLE', 'BRIDGE_IDENTITY_UNCONFIRMED', 'ENOENT'].includes(error.code)) throw error;
      await activateBridge(config);
      owner = await readMetadata(config); await verifyProcess(config, owner.metadata);
    }
    const { metadata, token } = owner;
    if (signal?.aborted) throw signal.reason ?? researchError('CANCELLED');
    const id = randomUUID();
    const challenge = randomBytes(32).toString('hex');
    const timeoutMs = method === 'run' ? Math.min(300000, Math.max(1000, params.input?.deadlineMs ?? 120000)) + 5000 : 5000;
    return new Promise((resolveResult, reject) => {
      const socket = connectSocket(metadata.pipePath);
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      let proved = false;
      let serverNonce;
      let ended = false;
      let settled = false;
      let processing = Promise.resolve();
      let abortTimer;
      const timer = setTimeout(() => finish(researchError('BRIDGE_TIMEOUT')), timeoutMs);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(abortTimer);
        signal?.removeEventListener('abort', abort);
        sockets.delete(socket);
        socket.destroy();
        error ? reject(error) : resolveResult(result);
      }
      function send(requestMethod, requestParams) {
        const request = { id, challenge, method: requestMethod, params: requestParams };
        request.mac = hmac(token, `${id}\n${challenge}\n${serverNonce}\n${metadata.runtimeId}\n${requestMethod}\n${JSON.stringify(requestParams)}`);
        const bytes = Buffer.from(JSON.stringify(request) + '\n');
        if (bytes.length > MAX_FRAME_BYTES) throw researchError('BRIDGE_FRAME_TOO_LARGE');
        socket.write(bytes);
      }
      function abort() {
        if (!proved) { finish(signal.reason ?? researchError('CANCELLED')); return; }
        // The run connection's closure cancels its own native job. Hold the provider
        // until its stream settles or the finite cancellation acknowledgement window ends.
        if (params.jobId) void call('cancel', { jobId: params.jobId }).catch(() => {});
        abortTimer = setTimeout(() => finish(signal.reason ?? researchError('CANCELLED')), 2500);
      }
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => socket.write(JSON.stringify({ id, challenge, method: 'hello' }) + '\n'));
      socket.on('error', () => { ended = true; void processing.finally(() => finish(researchError('APP_BRIDGE_UNAVAILABLE'))); });
      socket.on('close', () => { ended = true; void processing.finally(() => { if (!settled) finish(researchError('BRIDGE_REPLY_LOST')); }); });
      socket.on('data', chunk => {
        socket.pause();
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_FRAME_BYTES * 2) { finish(researchError('BRIDGE_FRAME_TOO_LARGE')); return; }
        const lines = [];
        while (buffer.includes(10)) {
          const end = buffer.indexOf(10);
          if (end > MAX_FRAME_BYTES) { finish(researchError('BRIDGE_FRAME_TOO_LARGE')); return; }
          lines.push(buffer.subarray(0, end));
          buffer = buffer.subarray(end + 1);
        }
        if (buffer.length > MAX_FRAME_BYTES) { finish(researchError('BRIDGE_FRAME_TOO_LARGE')); return; }
        processing = processing.then(async () => {
          for (const line of lines) {
            if (settled) break;
            let value;
            try { value = JSON.parse(utf8.decode(line)); } catch { throw researchError('BRIDGE_PROTOCOL_INVALID'); }
            if (value.id !== id || !value.event || typeof value.event !== 'object') throw researchError('BRIDGE_PROTOCOL_INVALID');
            const event = value.event;
            if (!proved) {
              if (!/^[a-f0-9]{64}$/.test(event.nonce ?? '')) throw researchError('BRIDGE_SERVER_UNCONFIRMED');
              const expected = hmac(token, `${id}\n${challenge}\n${event.nonce}\n${metadata.runtimeId}\n${metadata.appPid}\n${metadata.helperPid}`);
              if (event.kind !== 'hello' || event.runtimeId !== metadata.runtimeId || event.appPid !== metadata.appPid || event.helperPid !== metadata.helperPid || event.challenge !== challenge || !sameHex(event.proof, expected)) throw researchError('BRIDGE_SERVER_UNCONFIRMED');
              serverNonce = event.nonce;
              proved = true;
              send(method, params);
              continue;
            }
            if (!EVENT_KINDS.has(event.kind)) throw researchError('BRIDGE_PROTOCOL_INVALID');
            if (event.kind === 'error') {
              const code = /^[A-Z_]{1,64}$/.test(event.code ?? '') ? event.code : 'ADAPTER_FAILED';
              const failure = researchError(code);
              failure.reason = /^[a-z_]{1,96}$/.test(event.reason ?? '') ? event.reason : 'relay_bridge_operation_failed';
              failure.completionUncertain = event.completionUncertain === true;
              if (Number.isSafeInteger(event.retryAfterMs) && event.retryAfterMs >= 0) failure.retryAfterMs = event.retryAfterMs;
              throw failure;
            }
            if (event.kind === 'status') {
              if (event.runtimeId !== metadata.runtimeId || !Array.isArray(event.providers)) throw researchError('BRIDGE_PROTOCOL_INVALID');
              if (method === 'run') {
                const current = event.providers.find(item => item.provider === params.provider);
                if (!current || current.state !== 'ready' || !params.expectedAccount || current.accountRef !== params.expectedAccount.accountRef || current.accountEpoch !== params.expectedAccount.accountEpoch) throw researchError('STALE_ACCOUNT');
                await onEvent(event); continue;
              }
              finish(undefined, event);
              return;
            }
            if (method === 'cancel' && event.kind === 'done') { finish(undefined, event); return; }
            if (method !== 'run') throw researchError('BRIDGE_PROTOCOL_INVALID');
            await onEvent(event);
            if (event.kind === 'done') {
              const latest = await readMetadata(config);
              if (latest.metadata.runtimeId !== metadata.runtimeId) throw researchError('BRIDGE_RUNTIME_CHANGED');
              finish(signal?.aborted ? signal.reason ?? researchError('CANCELLED') : undefined, event);
            }
          }
        }).catch(error => finish(error)).finally(() => { if (!settled && !ended) socket.resume(); });
      });
    });
  }
  return {
    call,
    status() {
      statusPending ??= call('status').finally(() => { statusPending = undefined; });
      return statusPending;
    },
    async close() { closed = true; for (const socket of sockets) socket.destroy(); sockets.clear(); },
  };
}
