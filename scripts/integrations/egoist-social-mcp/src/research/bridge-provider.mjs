import { formatResearchMarkdown, formatResearchHtml, restoreResearchTextFields } from './export-format.mjs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertSafeDirectory, assertSafeFile, isJobId, ResearchBrokerError } from './job-store.mjs';
import { getTranscriptionCapabilities, transcribeDownloadedMedia } from './transcribe-media.mjs';
const OPERATIONS = {
  telegram: ['discover', 'chat_info', 'read', 'search', 'channel_history', 'chat_export', 'download', 'join_chat'],
  x: ['discover', 'profile', 'read', 'search', 'channel_history', 'chat_export', 'download', 'article', 'read_thread'],
  instagram: ['discover', 'profile', 'read', 'search', 'channel_history', 'chat_export', 'download', 'read_thread'],
};
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/webm': 'webm', 'application/pdf': 'pdf', 'application/zip': 'zip' };
const MAX_FILE = 1024 ** 3;
const MAX_JOB = 2 * 1024 ** 3;
const RESERVE = 1024 ** 3;
const MAX_TEXT_BYTES = 32 * 1024 ** 2;
const fail = (code, reason = '') => Object.assign(new ResearchBrokerError(code, code), { reason });
const stableId = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const jsonObject = value => value && typeof value === 'object' && !Array.isArray(value);
const safeCode = code => ({ INACCESSIBLE: 'ACCESS_DENIED', PAID_SEARCH_UNSUPPORTED: 'UNSUPPORTED', MEDIA_UNSUPPORTED: 'UNSUPPORTED' })[code] ?? code;
let transcriptionProbe;
let transcriptionProbeAt = 0;
function transcriptionCapabilities() {
  if (!transcriptionProbe || Date.now() - transcriptionProbeAt > 30000) {
    transcriptionProbeAt = Date.now(); transcriptionProbe = getTranscriptionCapabilities();
  }
  return transcriptionProbe;
}

export function createRelayBridgeProvider({ provider, bridge }, { diskFree = async directory => { const stat = await fs.statfs(directory); return stat.bavail * stat.bsize; }, transcribeMedia = transcribeDownloadedMedia } = {}) {
  if (!OPERATIONS[provider] || !bridge) throw fail('INVALID_PROVIDER');
  return {
    requiresAccountBinding: true,
    async status() {
      try {
        const value = await bridge.status();
        const selected = value.providers.find(item => item.provider === provider);
        if (!selected || !['ready', 'auth_required', 'challenge_required', 'rate_limited', 'unavailable', 'unsupported', 'initializing'].includes(selected.state)) return { state: 'unavailable', operations: [], reason: 'invalid_bridge_status' };
        const operations = Array.isArray(selected.operations) ? selected.operations.filter(operation => OPERATIONS[provider].includes(operation)) : [];
        if (selected.state === 'ready' && operations.includes('download') && (await transcriptionCapabilities()).available) operations.push('transcribe');
        return { state: selected.state === 'initializing' ? 'unavailable' : selected.state, operations,
          reason: /^[a-z_]{1,96}$/i.test(selected.reason ?? '') ? selected.reason.toLowerCase() : selected.state === 'initializing' ? 'app_initializing' : undefined,
          accountRef: selected.accountRef, accountEpoch: selected.accountEpoch };
      } catch (error) {
        return { state: 'unavailable', operations: [], reason: error.code === 'APP_BRIDGE_UNAVAILABLE' ? 'app_owned_bridge_unavailable' : 'app_owned_bridge_unconfirmed' };
      }
    },
    async run({ operation, input, accountScope, jobId, outputDirectory, signal, onCheckpoint = async () => {} }) {
      if (!(OPERATIONS[provider].includes(operation) || operation === 'transcribe') || !isJobId(jobId)) throw fail('UNSUPPORTED');
      const jobStartedAt = Date.now();
      const { stat: originalDirectory } = await assertSafeDirectory(outputDirectory);
      async function verifyDirectory() {
        const { stat: current } = await assertSafeDirectory(outputDirectory);
        if (current.ino !== originalDirectory.ino || current.dev !== originalDirectory.dev) throw fail('UNSAFE_PATH');
      }
      const provenance = { provider, operation, sources: input.urls ?? [input.url ?? input.channel].filter(Boolean),
        ...(input.query ? { query: input.query, querySha256: createHash('sha256').update(input.query).digest('hex') } : {}),
        filters: Object.fromEntries(['scope', 'topicId', 'after', 'before', 'includeMedia', 'includeReplies'].filter(key => input[key] !== undefined).map(key => [key, input[key]])),
        limits: { limit: input.limit, pageSize: input.pageSize, deadlineMs: input.deadlineMs },
        ...(input.cursor ? { initialCursor: input.cursor } : {}), accountScope };
      let sourceHandle;
      let sourceBytes = 0;
      let totalMediaBytes = 0;
      let mediaStarted = 0;
      let mediaDeclaredTotal = 0;
      let pendingTextBytes = 0;
      let count = 0;
      let nextCursor;
      let coverage;
      let sourceCoverage;
      let partial = false;
      let settled = false;
      let scope;
      let transcription;
      const records = [];
      const ids = new Set();
      const media = new Map();
      const mediaIds = new Set();
      const files = [];
      const evidence = [];
      const manifest = [];
      const textParts = new Map();
      let partHandle;
      let partBytes = 0;
      async function writeNew(name, bytes) {
        await verifyDirectory();
        if (bytes.length > 128 * 1024 ** 2 || await diskFree(outputDirectory) < RESERVE + bytes.length) throw fail('DISK_RESERVE');
        const target = join(outputDirectory, name);
        await assertSafeFile(target, { optional: true });
        const handle = await fs.open(target, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        files.push(name);
      }
      async function checkpoint() {
        await sourceHandle?.sync();
        await onCheckpoint({ state: partial ? 'partial' : 'completed', count, files: [...files], evidence: [...evidence], ...(nextCursor ? { nextCursor } : {}), ...(coverage ? { coverage } : {}), truncated: partial });
      }
      function checkScope(event) {
        if (event.kind === 'scope' || event.accountRef !== undefined || event.accountEpoch !== undefined) {
          if (typeof event.accountRef !== 'string' || !/^[a-z0-9_.:-]{1,128}$/i.test(event.accountRef) ||
              !['string', 'number'].includes(typeof event.accountEpoch) || String(event.accountEpoch).length > 128) throw fail('STALE_ACCOUNT');
          const current = `${event.accountRef}:${event.accountEpoch}`;
          if (!accountScope || event.accountRef !== accountScope.accountRef || event.accountEpoch !== accountScope.accountEpoch) throw fail('STALE_ACCOUNT');
          if (scope && current !== scope) throw fail('STALE_ACCOUNT');
          scope = current;
        }
      }
      async function acceptRecord(record) {
        if (!jsonObject(record)) throw fail('INVALID_RESULT');
        if (record.textPart !== undefined) {
          const part = record.textPart;
          if (!jsonObject(part) || typeof record.id !== 'string' || !Number.isSafeInteger(part.index) || part.index < 0 || part.index > 1024 || typeof part.text !== 'string' || typeof part.final !== 'boolean') throw fail('INVALID_RESULT');
          const partKey = `${record.type ?? 'post'}:${record.id}`;
          const pending = textParts.get(partKey) ?? { next: 0, text: '', base: record };
          if (part.index > 0 && (record.textFields !== undefined || record.source !== pending.base.source || record.type !== pending.base.type)) throw fail('INVALID_RESULT');
          if (pending.next !== part.index || Buffer.byteLength(pending.text) + Buffer.byteLength(part.text) > 4 * 1024 ** 2) throw fail('INVALID_RESULT');
          pending.next++;
          pendingTextBytes += Buffer.byteLength(part.text);
          if (pendingTextBytes + sourceBytes > MAX_TEXT_BYTES) throw fail('STATE_LIMIT');
          pending.text += part.text;
          await verifyDirectory();
          if (!partHandle) { partHandle = await fs.open(join(outputDirectory, 'record-parts.jsonl'), 'wx', 0o600); files.push('record-parts.jsonl'); }
          const partLine = JSON.stringify(record) + '\n';
          if (await diskFree(outputDirectory) < RESERVE + Buffer.byteLength(partLine)) throw fail('DISK_RESERVE');
          if (partBytes + Buffer.byteLength(partLine) > MAX_TEXT_BYTES) throw fail('STATE_LIMIT');
          await partHandle.writeFile(partLine);
          partBytes += Buffer.byteLength(partLine);
          if (!part.final) { textParts.set(partKey, pending); return; }
          textParts.delete(partKey);
          pendingTextBytes -= Buffer.byteLength(pending.text);
          record = { ...pending.base, text: pending.text };
          delete record.textPart;
        }
        try { record = restoreResearchTextFields(record); } catch { throw fail('INVALID_RESULT'); }
        if (typeof record.sourceUrl !== 'string' && typeof record.source === 'string') record = { ...record, sourceUrl: record.source };
        const key = `${record.type ?? 'post'}:${record.id ?? record.sourceUrl ?? createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
        if (ids.has(key)) return;
        if (count >= input.limit) { partial = true; return; }
        const accepted = { ...record, schemaVersion: 1, provider, extractedAt: new Date().toISOString() };
        const bytes = Buffer.from(JSON.stringify(accepted) + '\n');
        if (sourceBytes + bytes.length > MAX_TEXT_BYTES) throw fail('STATE_LIMIT');
        if (await diskFree(outputDirectory) < RESERVE + bytes.length) throw fail('DISK_RESERVE');
        await verifyDirectory();
        if (!sourceHandle) {
          sourceHandle = await fs.open(join(outputDirectory, 'records.jsonl'), 'wx', 0o600);
          files.push('records.jsonl');
        }
        await sourceHandle.writeFile(bytes);
        sourceBytes += bytes.length;
        ids.add(key);
        count++;
        records.push(accepted);
        if (typeof record.sourceUrl === 'string' && evidence.length < 50) {
          try {
            const source = new URL(record.sourceUrl);
            const hosts = provider === 'telegram' ? ['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me'] : provider === 'x' ? ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'] : ['instagram.com', 'www.instagram.com'];
            if (source.protocol === 'https:' && !source.username && !source.password && !source.port && hosts.includes(source.hostname)) {
              source.search = ''; source.hash = '';
              evidence.push({ url: source.toString(), kind: record.type === 'chat' || record.type === 'profile' ? 'channel' : 'post' });
            }
          } catch { /* A private peer locator need not have a public URL. */ }
        }
      }
      async function onEvent(event) {
        if (settled || signal.aborted) return;
        checkScope(event);
        if (['records', 'media_open', 'media_chunk', 'media_close', 'done'].includes(event.kind) && !scope) throw fail('STALE_ACCOUNT');
        if (event.coverage !== undefined) {
          const fallback = ({ discover: 'platform_search', search: 'platform_search', profile: 'profile', read_thread: 'thread', article: 'article', channel_history: 'channel', chat_export: 'channel', chat_info: 'channel', join_chat: 'membership' })[operation] ?? 'post';
          if (!jsonObject(event.coverage) && typeof event.coverage !== 'string') throw fail('INVALID_RESULT');
          sourceCoverage = event.coverage;
          coverage = jsonObject(event.coverage) ? event.coverage.scope ?? fallback : ({ accessible_chat: 'channel', selected_membership: 'membership', account_server_search: 'public_channels', account_dialogs: 'account_channels', account_message_search: 'platform_search' })[event.coverage] ?? event.coverage;
          if (!['channel', 'account_channels', 'public_channels', 'platform_search', 'profile', 'thread', 'post', 'article', 'membership'].includes(coverage)) throw fail('INVALID_RESULT');
        }
        if (event.nextCursor !== undefined) nextCursor = event.nextCursor;
        partial ||= event.partial === true;
        if (event.kind === 'records') {
          if (!Array.isArray(event.records) || event.records.length > 100) throw fail('INVALID_RESULT');
          for (const record of event.records) await acceptRecord(record);
          await checkpoint();
        } else if (event.kind === 'media_open') {
          if (typeof event.mediaId !== 'string' || event.mediaId.length > 128 || mediaIds.has(event.mediaId) || !Number.isSafeInteger(event.declaredBytes) || event.declaredBytes < 1 || event.declaredBytes > MAX_FILE || mediaDeclaredTotal + event.declaredBytes > MAX_JOB || ++mediaStarted > 500 || media.size >= 8) throw fail('INVALID_RESULT');
          mediaDeclaredTotal += event.declaredBytes;
          mediaIds.add(event.mediaId);
          if (await diskFree(outputDirectory) < RESERVE + event.declaredBytes) throw fail('DISK_RESERVE');
          await verifyDirectory();
          const extension = MIME_EXT[event.mimeType] ?? 'bin';
          const name = `media-${String(mediaStarted).padStart(3, '0')}-${stableId(event.mediaId)}.${extension}`;
          const partPath = join(outputDirectory, name + '.part');
          const handle = await fs.open(partPath, 'wx', 0o600);
          media.set(event.mediaId, { handle, partPath, name, sequence: 0, size: 0, expected: event.declaredBytes, mimeType: event.mimeType, sourceUrl: event.sourceUrl, hash: createHash('sha256') });
        } else if (event.kind === 'media_chunk') {
          const active = media.get(event.mediaId);
          if (!active || event.sequence !== active.sequence || typeof event.base64 !== 'string' || event.base64.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.base64)) throw fail('INVALID_RESULT');
          const bytes = Buffer.from(event.base64, 'base64');
          if (!bytes.length || bytes.length > 49152 || bytes.toString('base64') !== event.base64 || active.size + bytes.length > active.expected || totalMediaBytes + bytes.length > MAX_JOB) throw fail('INVALID_RESULT');
          if (await diskFree(outputDirectory) < RESERVE + bytes.length) throw fail('DISK_RESERVE');
          await verifyDirectory();
          await active.handle.writeFile(bytes);
          active.hash.update(bytes);
          active.size += bytes.length;
          totalMediaBytes += bytes.length;
          active.sequence++;
        } else if (event.kind === 'media_close') {
          const active = media.get(event.mediaId);
          if (!active || !Number.isSafeInteger(event.totalBytes) || event.totalBytes !== active.size || active.size !== active.expected) throw fail('INVALID_RESULT');
          await active.handle.sync();
          await verifyDirectory();
          const partIdentity = await active.handle.stat();
          await active.handle.close();
          active.handle = undefined;
          await assertSafeFile(active.partPath);
          const current = await fs.lstat(active.partPath);
          if (partIdentity.ino !== current.ino || partIdentity.size !== current.size) throw fail('UNSAFE_PATH');
          await fs.link(active.partPath, join(outputDirectory, active.name));
          await fs.unlink(active.partPath);
          await assertSafeFile(join(outputDirectory, active.name));
          files.push(active.name);
          manifest.push({ mediaId: event.mediaId, file: active.name, bytes: active.size, sha256: active.hash.digest('hex'), mimeType: active.mimeType, sourceUrl: active.sourceUrl });
          media.delete(event.mediaId);
          await checkpoint();
        } else if (event.kind === 'done') {
          if (!['results', 'empty', 'partial'].includes(event.outcome) || !Number.isSafeInteger(event.count) || event.count !== count || textParts.size || media.size) throw fail('INVALID_RESULT');
          if (event.outcome === 'empty' && count !== 0 || event.outcome === 'results' && count === 0) throw fail('INVALID_RESULT');
          partial ||= event.outcome === 'partial';
        }
      }
      let final;
      try {
        const collectionInput = { ...input };
        delete collectionInput.language;
        if (operation === 'transcribe') collectionInput.includeMedia = true;
        final = await bridge.call('run', { provider, operation: operation === 'transcribe' ? 'download' : operation, input: collectionInput, jobId, expectedAccount: accountScope }, { signal, onEvent });
        if (!final || signal.aborted) throw signal.reason ?? fail('CANCELLED');
        if (textParts.size || media.size) throw fail('INVALID_RESULT');
        if (!sourceHandle) await writeNew('records.jsonl', Buffer.alloc(0));
        await sourceHandle?.sync();
        if (operation === 'transcribe') {
          const selected = manifest.filter(item => /^(audio|video)\//.test(item.mimeType));
          if (!selected.length) { partial = true; transcription = { state: 'unsupported', reason: 'no_supported_audio_video', unprocessedMedia: manifest.length }; }
          else {
            const remaining = input.deadlineMs - (Date.now() - jobStartedAt);
            if (remaining <= 0) throw fail('DEADLINE_EXCEEDED');
            transcription = await transcribeMedia({ outputDirectory, media: selected.slice(0, 20), signal, deadlineMs: remaining, language: input.language ?? 'auto',
              onCheckpoint: async value => { for (const name of value.files) if (!files.includes(name)) files.push(name); partial ||= value.state !== 'completed'; await checkpoint(); } });
            transcription.unprocessedMedia = Math.max(0, selected.length - 20);
            partial ||= transcription.state !== 'completed' || transcription.unprocessedMedia > 0;
          }
        }
        const formats = input.exportFormats ?? (operation === 'chat_export' ? ['jsonl', 'markdown', 'html'] : ['jsonl']);
        const exportOptions = { provider, operation, jobId, records, manifest, partial, coverage };
        if (formats.includes('markdown')) await writeNew('export.md', Buffer.from(formatResearchMarkdown(exportOptions)));
        if (formats.includes('html')) await writeNew('export.html', Buffer.from(formatResearchHtml(exportOptions)));
        if (manifest.length) await writeNew('media-manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, provider, jobId, files: manifest }, null, 2) + '\n'));
        await writeNew('export-manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, provider, operation, jobId, provenance, count, coverage, sourceCoverage, partial, nextCursor, transcription, accountScopeBound: Boolean(scope), files, extractionFinishedAt: new Date().toISOString(), mediaBytes: totalMediaBytes }, null, 2) + '\n'));
        await checkpoint();
        settled = true;
        return { state: partial ? 'partial' : 'completed', count, files, evidence, truncated: partial, ...(nextCursor ? { nextCursor } : {}), ...(coverage ? { coverage } : {}) };
      } catch (error) {
        partial = true;
        try {
          await sourceHandle?.truncate(sourceBytes);
          await partHandle?.truncate(partBytes);
          for (const active of media.values()) await active.handle?.truncate(active.size);
          await sourceHandle?.sync();
          await partHandle?.sync();
          await writeNew('partial-manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, provider, jobId, provenance, count, nextCursor, coverage, sourceCoverage, failure: { code: safeCode(error.code ?? 'ADAPTER_FAILED'), completionUncertain: error.completionUncertain === true || ['CANCELLED', 'DEADLINE_EXCEEDED'].includes(error.code) }, partial: true, files: [...files], pendingTextParts: textParts.size,
            incompleteMedia: [...media.values()].map(active => ({ file: active.name + '.part', bytes: active.size, expectedBytes: active.expected })) }, null, 2) + '\n'));
          await checkpoint();
        } catch { /* Preserve the original operation failure and accepted source bytes. */ }
        const failure = fail(safeCode(error.code ?? 'ADAPTER_FAILED'), error.reason);
        if (error.completionUncertain === true) failure.completionUncertain = true;
        if (Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 86400000) failure.retryAfterMs = error.retryAfterMs;
        throw failure;
      } finally {
        settled = true;
        await sourceHandle?.close();
        await partHandle?.close();
        for (const active of media.values()) await active.handle?.close();
        // Incomplete .part files retain accepted bytes; they are never promoted as media.
      }
    },
    async close() {},
  };
}
