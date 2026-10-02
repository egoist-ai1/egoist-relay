import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { assertSafeDirectory, assertSafeFile, isJobId, safeOutputName, ResearchBrokerError } from './job-store.mjs';

import { restoreResearchTextFields, isPageDescription } from './export-format.mjs';

export const LOCAL_INDEX_LIMITS = Object.freeze({
  jobsPerCall: 100, recordsPerJob: 1000, records: 1_000_000,
  sourceBytes: 128 * 1024 ** 2, batchBytes: 1024 ** 3, lineBytes: 8 * 1024 ** 2,
  databaseBytes: 2 * 1024 ** 3, reserveBytes: 64 * 1024 ** 2,
  queryBytes: 1024, terms: 32, resultsPerPage: 100, resultBytes: 80 * 1024, queuedCalls: 8,
});
const APP_ID = 0x45534958;
const VERSION = 2;
const NORMALIZATION_REVISION = 'text-roles-1';
const SCHEMA = [
  'CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE jobs (job_id TEXT PRIMARY KEY, provider TEXT NOT NULL, state TEXT NOT NULL, incomplete INTEGER NOT NULL, coverage TEXT, source_sha TEXT NOT NULL, source_bytes INTEGER NOT NULL, records INTEGER NOT NULL, missing_json TEXT NOT NULL, indexed_at TEXT NOT NULL)',
  'CREATE TABLE records (rowid INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE, line INTEGER NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL, record_id TEXT, source TEXT, provider TEXT NOT NULL, type TEXT, timestamp_json TEXT, text TEXT NOT NULL, content_sha TEXT NOT NULL, text_sha TEXT NOT NULL, UNIQUE(job_id,line))',
  "CREATE VIRTUAL TABLE records_fts USING fts5(text, content='records', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')",
];
const EXPECTED_NAMES = new Set(['index_meta', 'jobs', 'records', 'records_fts', 'records_fts_data', 'records_fts_idx', 'records_fts_docsize', 'records_fts_config']);
const message = {
  INVALID_INDEX_REQUEST: 'Local index arguments are invalid.',
  INDEX_JOB_UNAVAILABLE: 'Only accepted completed jobs or nonempty accepted partial jobs can be indexed.',
  INVALID_CORPUS: 'An accepted source has invalid records or inconsistent coverage.',
  INDEX_SOURCE_CHANGED: 'An indexed source changed. Explicitly rebuild its selected job snapshot.',
  INDEX_NORMALIZATION_CHANGED: 'The selected derived snapshot uses older text roles. Explicitly rebuild its selected job snapshot.',
  INDEX_MISSING: 'A selected job is not indexed. Index the exact accepted job first.',
  INDEX_INVALID_DB: 'The derived index is invalid or uses an unsupported schema; it was not replaced.',
  INDEX_BUSY: 'Another local index operation owns this private index. Retry after it finishes.',
  INDEX_LIMIT: 'The local index reached its explicit resource bound; no snapshot was committed.',
  INDEX_CANCELLED: 'The local index operation was cancelled; no unfinished snapshot was committed.',
  INDEX_DEADLINE: 'The local index operation reached its deadline; no unfinished snapshot was committed.',
  INDEX_CURSOR_STALE: 'The cursor does not match this query and index snapshot.',
  INDEX_DISK_RESERVE: 'The index needs more free space while preserving its disk reserve.',
  INDEX_STORAGE_FAILED: 'Local derived index storage failed; no unfinished snapshot was committed.',
};
function fail(code) { return new ResearchBrokerError(code, message[code] ?? 'A local index path is unsafe.'); }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function exact(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function within(parent, child) { const r = path.relative(parent, child); return !r || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function control({ signal, end }) { if (signal?.aborted) throw fail('INDEX_CANCELLED'); if (Date.now() >= end) throw fail('INDEX_DEADLINE'); }
function waitForTurn(predecessor, ctl) {
  control(ctl);
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = error => {
      if (done) return;
      done = true; clearTimeout(timer); ctl.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => settle(fail('INDEX_CANCELLED'));
    const timer = setTimeout(() => settle(fail('INDEX_DEADLINE')), Math.max(1, ctl.end - Date.now()));
    ctl.signal?.addEventListener('abort', abort, { once: true });
    if (ctl.signal?.aborted) abort();
    predecessor.then(() => settle(), () => settle());
  });
}
function options(value, allowed, defaultMs, maximumMs) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw fail('INVALID_INDEX_REQUEST');
  const deadlineMs = value.deadlineMs ?? defaultMs;
  if (!integer(deadlineMs, 1, maximumMs)) throw fail('INVALID_INDEX_REQUEST');
  return { signal: value.signal, end: Date.now() + deadlineMs };
}
function normalizeIds(jobIds) {
  if (!Array.isArray(jobIds) || !integer(jobIds.length, 1, LOCAL_INDEX_LIMITS.jobsPerCall) || jobIds.some(id => !isJobId(id)) || new Set(jobIds).size !== jobIds.length) throw fail('INVALID_INDEX_REQUEST');
  const normalized = jobIds.map(id => id.toLowerCase()).sort();
  if (new Set(normalized).size !== normalized.length) throw fail('INVALID_INDEX_REQUEST');
  return normalized;
}
function acceptedJob(job, outputRoot) {
  if (!object(job) || !isJobId(job.id) || !['telegram', 'x', 'instagram'].includes(job.provider) || !object(job.result) || !['completed', 'partial'].includes(job.state) || job.state === 'partial' && job.result.count === 0) throw fail('INDEX_JOB_UNAVAILABLE');
  if (!integer(job.result.count, 0, LOCAL_INDEX_LIMITS.recordsPerJob) || !['results', 'empty', 'partial'].includes(job.result.outcome) || !Array.isArray(job.result.files) || job.result.files.length > 1000 || job.result.files.some(name => !safeOutputName(name)) || !job.result.files.includes('records.jsonl')) throw fail('INVALID_CORPUS');
  if (job.state === 'completed' && job.error || job.result.count === 0 && job.result.outcome !== 'empty' || job.result.count > 0 && job.result.outcome === 'empty') throw fail('INVALID_CORPUS');
  const id = job.id.toLowerCase();
  const directory = path.join(outputRoot, id);
  if (typeof job.outputDirectory !== 'string' || !path.isAbsolute(job.outputDirectory) || !exact(path.resolve(job.outputDirectory), directory)) throw fail('UNSAFE_PATH');
  if (job.result.coverage !== undefined && (typeof job.result.coverage !== 'string' || job.result.coverage.length > 128)) throw fail('INVALID_CORPUS');
  return { id, provider: job.provider, state: job.state, incomplete: job.state !== 'completed' || job.result.outcome === 'partial' || job.result.truncated === true || Boolean(job.result.nextCursor), count: job.result.count, coverage: job.result.coverage ?? null, directory, file: path.join(directory, 'records.jsonl') };
}
async function openSource(file) {
  const before = await assertSafeFile(file);
  if (before.size > LOCAL_INDEX_LIMITS.sourceBytes) throw fail('INDEX_LIMIT');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!same(before, opened) || opened.nlink !== 1 || !opened.isFile() || before.size !== opened.size) throw fail('UNSAFE_PATH');
    return { handle, before, file, directory: (await assertSafeDirectory(path.dirname(file))).stat };
  } catch (error) { await handle.close(); throw error; }
}
async function verifySource(source, bytes) {
  const [after, named, directory] = await Promise.all([source.handle.stat(), assertSafeFile(source.file), assertSafeDirectory(path.dirname(source.file))]);
  if (!same(source.before, after) || !same(source.before, named) || !same(source.directory, directory.stat) || bytes !== source.before.size || after.size !== source.before.size || after.mtimeMs !== source.before.mtimeMs || after.ctimeMs !== source.before.ctimeMs || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) throw fail('INDEX_SOURCE_CHANGED');
}
async function scanSource(source, ctl, onLine) {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, line = 0, offset = 0, pending = Buffer.alloc(0);
  async function accept(raw, physicalBytes) {
    line++;
    if (raw.length > LOCAL_INDEX_LIMITS.lineBytes) throw fail('INDEX_LIMIT');
    if (onLine) {
      let text;
      try { text = decoder.decode(raw).replace(/\r$/, ''); } catch { throw fail('INVALID_CORPUS'); }
      if (line === 1) text = text.replace(/^\uFEFF/, '');
      if (text.trim()) await onLine({ raw, text, line, offset, length: raw.length });
    }
    offset += physicalBytes;
  }
  for (;;) {
    control(ctl);
    const read = await source.handle.read(chunk, 0, chunk.length, bytes);
    if (!read.bytesRead) break;
    const data = chunk.subarray(0, read.bytesRead);
    digest.update(data); bytes += read.bytesRead;
    if (bytes > LOCAL_INDEX_LIMITS.sourceBytes) throw fail('INDEX_LIMIT');
    if (onLine) {
      let start = 0;
      for (;;) {
        const newline = data.indexOf(10, start);
        if (newline === -1) break;
        const piece = data.subarray(start, newline);
        const raw = pending.length ? Buffer.concat([pending, piece]) : piece;
        await accept(raw, raw.length + 1); pending = Buffer.alloc(0); start = newline + 1;
      }
      if (start < data.length) {
        if (pending.length + data.length - start > LOCAL_INDEX_LIMITS.lineBytes) throw fail('INDEX_LIMIT');
        pending = Buffer.concat([pending, data.subarray(start)]);
      }
    }
  }
  if (onLine && pending.length) await accept(pending, pending.length);
  control(ctl); await verifySource(source, bytes);
  return { sha256: digest.digest('hex'), bytes };
}
function recordFields(raw, job) {
  let record;
  try { record = JSON.parse(raw.text); } catch { throw fail('INVALID_CORPUS'); }
  if (!object(record) || record.provider !== undefined && record.provider !== job.provider || record.schemaVersion !== undefined && record.schemaVersion !== 1) throw fail('INVALID_CORPUS');
  try { record = restoreResearchTextFields(record); } catch { throw fail('INVALID_CORPUS'); }
  const scalar = (value, max) => typeof value === 'string' && value.length && value.length <= max ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  const id = scalar(record.id, 256), source = scalar(record.sourceUrl ?? record.source, 4096), type = scalar(record.type, 128);
  const timestamp = record.timestamp ?? record.date ?? record.publishedAt;
  const timestampJson = (typeof timestamp === 'string' && timestamp.length <= 128 || typeof timestamp === 'number' && Number.isFinite(timestamp)) ? JSON.stringify(timestamp) : null;
  const texts = [...new Set(['text', 'caption', 'observedText', 'title', 'name', 'description', 'bio', 'username'].filter(key => key !== 'description' || !isPageDescription({ ...record, provider: job.provider })).map(key => record[key]).filter(value => typeof value === 'string' && value.trim()))];
  const text = texts.join('\n');
  const hasContentText = ['text', 'caption', 'observedText'].some(key => typeof record[key] === 'string' && record[key].trim());
  return { id, source, type, timestampJson, text, hasContentText, contentSha: hash(raw.raw), textSha: hash(text) };
}
function literalQuery(query) {
  if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > LOCAL_INDEX_LIMITS.queryBytes || query.includes('\0')) throw fail('INVALID_INDEX_REQUEST');
  const phrases = []; let current = '', quoted = false;
  const push = () => { const tokens = current.normalize('NFC').match(/[\p{L}\p{N}\p{M}_]+/gu) ?? []; if (tokens.length) phrases.push(tokens.join(' ')); current = ''; };
  for (const char of query) {
    if (char === '"') { push(); quoted = !quoted; }
    else if (/\s/u.test(char) && !quoted) push();
    else current += char;
  }
  if (quoted) throw fail('INVALID_INDEX_REQUEST');
  push();
  if (!phrases.length || phrases.length > LOCAL_INDEX_LIMITS.terms) throw fail('INVALID_INDEX_REQUEST');
  return { match: [...new Set(phrases)].map(term => '"' + term.replaceAll('"', '""') + '"').join(' AND '), normalized: [...new Set(phrases)].join('\u001f') };
}
function cursorDecode(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw fail('INDEX_CURSOR_STALE');
  let cursor; try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw fail('INDEX_CURSOR_STALE'); }
  if (!object(cursor) || Object.keys(cursor).sort().join(',') !== 'offset,snapshot,version' || cursor.version !== 1 || !integer(cursor.offset, 1, LOCAL_INDEX_LIMITS.records) || !/^[0-9a-f]{64}$/.test(cursor.snapshot)) throw fail('INDEX_CURSOR_STALE');
  return cursor;
}

/** Derived FTS search over exact accepted exports. This module never calls an account or discovers files. */
export function createLocalResearchIndex({ stateRoot, outputRoot }) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot) || typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw fail('UNSAFE_PATH');
  stateRoot = path.resolve(stateRoot); outputRoot = path.resolve(outputRoot);
  if (within(stateRoot, outputRoot) || within(outputRoot, stateRoot)) throw fail('UNSAFE_PATH');
  const directory = path.join(stateRoot, 'local-index');
  const dbFile = path.join(directory, 'index.sqlite');
  const lockFile = path.join(directory, 'index.lock');
  let rootIdentity, outputIdentity, indexIdentity, dbIdentity, journalIdentity, tail = Promise.resolve(), pending = 0;
  async function roots() {
    const root = await assertSafeDirectory(stateRoot, { create: true });
    const output = await assertSafeDirectory(outputRoot);
    const index = await assertSafeDirectory(directory, { create: true });
    for (const [old, current] of [[rootIdentity, root.stat], [outputIdentity, output.stat], [indexIdentity, index.stat]]) if (old && !same(old, current)) throw fail('UNSAFE_PATH');
    rootIdentity ??= root.stat; outputIdentity ??= output.stat; indexIdentity ??= index.stat;
  }
  async function acquire() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await roots();
      let handle;
      try { handle = await fs.open(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const before = await assertSafeFile(lockFile);
        if (!before.size || before.size > 1024) throw fail('INDEX_BUSY');
        const owned = await fs.open(lockFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        let owner;
        try { if (!same(before, await owned.stat())) throw fail('UNSAFE_PATH'); owner = JSON.parse(await owned.readFile('utf8')); } catch (error) { if (error.code === 'UNSAFE_PATH') throw error; throw fail('INDEX_BUSY'); } finally { await owned.close(); }
        if (!object(owner) || !integer(owner.pid, 1, 2147483647) || !isJobId(owner.nonce)) throw fail('INDEX_BUSY');
        let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw fail('INDEX_BUSY');
        const current = await assertSafeFile(lockFile);
        if (!same(before, current) || current.size !== before.size || current.mtimeMs !== before.mtimeMs) continue;
        await fs.unlink(lockFile); continue;
      }
      let stat;
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); await handle.sync(); stat = await handle.stat(); } finally { await handle.close(); }
      return stat;
    }
    throw fail('INDEX_BUSY');
  }
  async function databaseFiles() {
    const current = await assertSafeFile(dbFile);
    if (!dbIdentity || !same(dbIdentity, current)) throw fail('UNSAFE_PATH');
    if (current.size > LOCAL_INDEX_LIMITS.databaseBytes) throw fail('INDEX_LIMIT');
    for (const suffix of ['-wal', '-shm']) if (await assertSafeFile(dbFile + suffix, { optional: true })) throw fail('INDEX_INVALID_DB');
    const journal = await assertSafeFile(dbFile + '-journal', { optional: true });
    if (journal && journalIdentity && !same(journalIdentity, journal)) throw fail('UNSAFE_PATH');
    journalIdentity = journal;
  }
  async function checkedDatabase({ create = false } = {}) {
    await roots();
    let stat = await assertSafeFile(dbFile, { optional: true });
    if (!stat && !create) throw fail('INDEX_MISSING');
    if (!stat) { const handle = await fs.open(dbFile, 'wx', 0o600); try { stat = await handle.stat(); } finally { await handle.close(); } }
    if (stat.size > LOCAL_INDEX_LIMITS.databaseBytes) throw fail('INDEX_LIMIT');
    if (dbIdentity && !same(dbIdentity, stat)) throw fail('UNSAFE_PATH');
    dbIdentity ??= stat;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = await assertSafeFile(dbFile + suffix, { optional: true });
      // This index only uses DELETE journals. Recovery may consume a safe hot journal.
      if (sidecar && suffix !== '-journal') throw fail('INDEX_INVALID_DB');
    }
    journalIdentity = await assertSafeFile(dbFile + '-journal', { optional: true });
    const db = new DatabaseSync(dbFile, { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false, timeout: 0 });
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA synchronous=FULL;');
      db.enableDefensive(true);
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const app = db.prepare('PRAGMA application_id').get().application_id;
      const catalog = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if (!stat.size && version === 0 && catalog.length === 0 && create) {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA page_size=4096; PRAGMA max_page_count=524288; BEGIN IMMEDIATE;');
        try { for (const sql of SCHEMA) db.exec(sql); db.prepare('INSERT INTO index_meta VALUES (?,?)').run('revision', '0'); db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=${VERSION}; COMMIT;`); } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      } else {
        if (version !== VERSION || app !== APP_ID || catalog.length !== EXPECTED_NAMES.size || catalog.some(item => !EXPECTED_NAMES.has(item.name) || item.type !== 'table')) throw fail('INDEX_INVALID_DB');
        for (const sql of SCHEMA) if (!catalog.some(item => item.sql === sql)) throw fail('INDEX_INVALID_DB');
        const revision = db.prepare("SELECT value FROM index_meta WHERE key='revision'").get()?.value;
        if (!/^(?:0|[1-9][0-9]{0,14})$/.test(revision ?? '')) throw fail('INDEX_INVALID_DB');
        if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('INDEX_INVALID_DB');
        if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw fail('INDEX_INVALID_DB');
      }
      const after = await assertSafeFile(dbFile);
      if (!same(stat, after)) throw fail('UNSAFE_PATH');
      await databaseFiles();
      return db;
    } catch (error) { db.close(); if (error?.code === 'ERR_SQLITE_ERROR') throw fail('INDEX_INVALID_DB'); throw error; }
  }
  async function serial(ctl, fn) {
    control(ctl);
    if (pending >= LOCAL_INDEX_LIMITS.queuedCalls) throw fail('INDEX_BUSY');
    pending++;
    const prior = tail;
    let release; tail = new Promise(resolve => { release = resolve; });
    let granted = false;
    try {
      await waitForTurn(prior, ctl); control(ctl); granted = true;
      const owner = await acquire(); let db;
      try { return await fn(async create => (db = await checkedDatabase({ create }))); }
      finally {
        if (db) db.close();
        await roots();
        const owned = await assertSafeFile(lockFile);
        if (!same(owner, owned)) throw fail('UNSAFE_PATH');
        await fs.unlink(lockFile);
      }
    } catch (error) { if (error instanceof ResearchBrokerError) throw error; throw fail('INDEX_STORAGE_FAILED'); }
    finally {
      const releaseSlot = () => { pending--; release(); };
      if (granted) releaseSlot();
      else prior.then(releaseSlot, releaseSlot);
    }
  }
  async function diskReserve(needed = 0) {
    const disk = await fs.statfs(directory);
    if (Number(disk.bavail) * Number(disk.bsize) < LOCAL_INDEX_LIMITS.reserveBytes + needed) throw fail('INDEX_DISK_RESERVE');
  }
  return Object.freeze({
    async indexJobs(input) {
      const ctl = options(input, ['jobs', 'replaceChanged', 'signal', 'deadlineMs'], 300000, 300000);
      if (!Array.isArray(input.jobs) || !integer(input.jobs.length, 1, LOCAL_INDEX_LIMITS.jobsPerCall) || input.replaceChanged !== undefined && typeof input.replaceChanged !== 'boolean') throw fail('INVALID_INDEX_REQUEST');
      const jobs = input.jobs.map(job => acceptedJob(job, outputRoot));
      if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw fail('INVALID_INDEX_REQUEST');
      return serial(ctl, async open => {
        const db = await open(true); control(ctl);
        const report = []; let batchBytes = 0, modified = false;
        db.exec('BEGIN IMMEDIATE');
        try {
          const insertJob = db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)');
          const insert = db.prepare('INSERT INTO records(job_id,line,byte_offset,byte_length,record_id,source,provider,type,timestamp_json,text,content_sha,text_sha) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
          const fts = db.prepare('INSERT INTO records_fts(rowid,text) VALUES (?,?)');
          const find = db.prepare('SELECT * FROM jobs WHERE job_id=?');
          let retained = db.prepare('SELECT count(*) AS count FROM records').get().count;
          for (const job of jobs) {
            control(ctl); await roots(); await databaseFiles();
            const source = await openSource(job.file);
            try {
              batchBytes += source.before.size;
              if (batchBytes > LOCAL_INDEX_LIMITS.batchBytes) throw fail('INDEX_LIMIT');
              const prior = find.get(job.id);
              if (prior) {
                const normalization = db.prepare('SELECT value FROM index_meta WHERE key=?').get('normalization:' + job.id)?.value;
                const checked = await scanSource(source, ctl);
                const sameSnapshot = checked.sha256 === prior.source_sha && prior.provider === job.provider && prior.records === job.count && prior.state === job.state && prior.incomplete === Number(job.incomplete) && prior.coverage === job.coverage;
                if (normalization === NORMALIZATION_REVISION && sameSnapshot) {
                  report.push({ jobId: job.id, state: 'unchanged', indexed: prior.records, incomplete: Boolean(prior.incomplete), coverage: prior.coverage, sourceSha256: prior.source_sha, sourceBytes: prior.source_bytes, missingFields: JSON.parse(prior.missing_json) }); continue;
                }
                if (!sameSnapshot && !input.replaceChanged) throw fail('INDEX_SOURCE_CHANGED');
                const removeFts = db.prepare("INSERT INTO records_fts(records_fts,rowid,text) VALUES ('delete',?,?)");
                for (const row of db.prepare('SELECT rowid,text FROM records WHERE job_id=?').iterate(job.id)) removeFts.run(row.rowid, row.text);
                db.prepare('DELETE FROM jobs WHERE job_id=?').run(job.id);
                retained -= prior.records;
              }
              await diskReserve(source.before.size * 5);
              const missing = { id: 0, source: 0, timestamp: 0, text: 0, contentText: 0 }; let records = 0;
              // The FK parent is private inside this transaction and never exposed before COMMIT.
              insertJob.run(job.id, job.provider, job.state, Number(job.incomplete), job.coverage, '', source.before.size, 0, '{}', new Date().toISOString());
              db.prepare('INSERT OR REPLACE INTO index_meta VALUES (?,?)').run('normalization:' + job.id, NORMALIZATION_REVISION);
              const scanned = await scanSource(source, ctl, async raw => {
                records++;
                if (records > job.count) throw fail('INVALID_CORPUS');
                if (retained + records > LOCAL_INDEX_LIMITS.records) throw fail('INDEX_LIMIT');
                const fields = recordFields(raw, job);
                if (!fields.id) missing.id++; if (!fields.source) missing.source++; if (!fields.timestampJson) missing.timestamp++; if (!fields.text) missing.text++; if (!fields.hasContentText) missing.contentText++;
                const inserted = insert.run(job.id, raw.line, raw.offset, raw.length, fields.id, fields.source, job.provider, fields.type, fields.timestampJson, fields.text, fields.contentSha, fields.textSha);
                fts.run(inserted.lastInsertRowid, fields.text);
                if (records % 256 === 0) { await databaseFiles(); await yieldTurn(); control(ctl); await databaseFiles(); }
              });
              if (records !== job.count) throw fail('INVALID_CORPUS');
              db.prepare('UPDATE jobs SET source_sha=?,records=?,missing_json=? WHERE job_id=?').run(scanned.sha256, records, JSON.stringify(missing), job.id);
              retained += records; modified = true;
              report.push({ jobId: job.id, state: prior ? 'rebuilt' : 'indexed', indexed: records, incomplete: job.incomplete, coverage: job.coverage, sourceSha256: scanned.sha256, sourceBytes: scanned.bytes, missingFields: missing });
            } finally { await source.handle.close(); }
          }
          control(ctl); await roots(); await databaseFiles(); await diskReserve();
          if (modified) db.prepare("UPDATE index_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='revision'").run();
          db.exec('COMMIT');
          await databaseFiles();
          return { schemaVersion: 1, state: 'indexed', jobs: report, indexedRecords: report.reduce((sum, job) => sum + job.indexed, 0), incomplete: report.some(job => job.incomplete), revision: db.prepare("SELECT value FROM index_meta WHERE key='revision'").get().value, limits: LOCAL_INDEX_LIMITS };
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      });
    },
    async search(input) {
      const ctl = options(input, ['jobIds', 'query', 'limit', 'cursor', 'signal', 'deadlineMs'], 30000, 300000);
      const ids = normalizeIds(input.jobIds), query = literalQuery(input.query), limit = input.limit ?? 20;
      if (!integer(limit, 1, LOCAL_INDEX_LIMITS.resultsPerPage)) throw fail('INVALID_INDEX_REQUEST');
      const cursor = input.cursor === undefined ? undefined : cursorDecode(input.cursor);
      return serial(ctl, async open => {
        const db = await open(false); control(ctl);
        db.exec('PRAGMA query_only=ON; BEGIN');
        try {
          const jobs = [], sources = [], sourceIdentities = [];
          for (const id of ids) {
            const job = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(id);
            if (!job) throw fail('INDEX_MISSING');
            if (db.prepare('SELECT value FROM index_meta WHERE key=?').get('normalization:' + id)?.value !== NORMALIZATION_REVISION) throw fail('INDEX_NORMALIZATION_CHANGED');
            const file = path.join(outputRoot, id, 'records.jsonl');
            const source = await openSource(file);
            try { const checked = await scanSource(source, ctl); if (checked.sha256 !== job.source_sha || checked.bytes !== job.source_bytes) throw fail('INDEX_SOURCE_CHANGED'); }
            finally { await source.handle.close(); }
            sourceIdentities.push(source);
            sources.push([id, job.source_sha]);
            jobs.push({ jobId: id, indexed: job.records, incomplete: Boolean(job.incomplete), coverage: job.coverage, sourceSha256: job.source_sha, missingFields: JSON.parse(job.missing_json) });
          }
          const revision = db.prepare("SELECT value FROM index_meta WHERE key='revision'").get().value;
          const snapshot = hash(JSON.stringify({ revision, sources, query: query.normalized, limit }));
          if (cursor && cursor.snapshot !== snapshot) throw fail('INDEX_CURSOR_STALE');
          const offset = cursor?.offset ?? 0;
          const marks = ids.map(() => '?').join(',');
          const args = [query.match, ...ids];
          const count = db.prepare(`SELECT count(*) AS count FROM records_fts JOIN records r ON r.rowid=records_fts.rowid WHERE records_fts MATCH ? AND r.job_id IN (${marks})`).get(...args).count;
          const rows = db.prepare(`SELECT r.job_id,r.line,r.byte_offset,r.byte_length,r.record_id,r.source,r.provider,r.type,r.timestamp_json,r.content_sha,r.text_sha,bm25(records_fts) AS score,substr(snippet(records_fts,0,'[',']',' … ',32),1,4096) AS snippet FROM records_fts JOIN records r ON r.rowid=records_fts.rowid WHERE records_fts MATCH ? AND r.job_id IN (${marks}) ORDER BY score,r.job_id,r.line LIMIT ? OFFSET ?`).all(...args, limit, offset);
          control(ctl); await roots(); await databaseFiles();
          for (const source of sourceIdentities) {
            const named = await assertSafeFile(source.file);
            if (!same(source.before, named) || named.size !== source.before.size || named.mtimeMs !== source.before.mtimeMs || named.ctimeMs !== source.before.ctimeMs) throw fail('INDEX_SOURCE_CHANGED');
            if (!same(source.directory, (await assertSafeDirectory(path.dirname(source.file))).stat)) throw fail('UNSAFE_PATH');
          }
          const base = { schemaVersion: 1, state: count ? 'results' : 'no_results', queryMode: 'literal_unicode_and_phrases', snapshotSha256: snapshot, totalMatches: count, incomplete: jobs.some(job => job.incomplete), jobs };
          const results = []; let resultBytes = Buffer.byteLength(JSON.stringify(base)) + 2048;
          for (const row of rows) {
            const result = { jobId: row.job_id, id: row.record_id, source: row.source, provider: row.provider, type: row.type, timestamp: row.timestamp_json === null ? null : JSON.parse(row.timestamp_json), snippet: row.snippet, contentSha256: row.content_sha, indexedTextSha256: row.text_sha, locator: { file: path.join(outputRoot, row.job_id, 'records.jsonl'), line: row.line, byteOffset: row.byte_offset, byteLength: row.byte_length }, score: row.score };
            const bytes = Buffer.byteLength(JSON.stringify(result)) + 1;
            if (resultBytes + bytes > LOCAL_INDEX_LIMITS.resultBytes) break;
            results.push(result); resultBytes += bytes;
          }
          if (rows.length && !results.length) throw fail('INDEX_LIMIT');
          db.exec('COMMIT');
          return { ...base, results, returned: results.length, byteLimited: results.length < rows.length, ...(offset + results.length < count ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, snapshot, offset: offset + results.length })).toString('base64url') } : {}) };
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      });
    },
  });
}






