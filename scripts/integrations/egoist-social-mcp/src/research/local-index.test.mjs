import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createLocalResearchIndex, LOCAL_INDEX_LIMITS } from './local-index.mjs';
import { assertSafeDirectory } from './job-store.mjs';

const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work) || path.basename(path.resolve(work)).toLowerCase() !== 'work') throw new Error('Set EGOIST_RESEARCH_TEST_WORK to this active task work directory.');
const fixtureRoot = path.join(work, 'local-index-fixtures-' + randomUUID());
await assertSafeDirectory(fixtureRoot, { create: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const stats = [];
async function fixture() {
  const root = path.join(fixtureRoot, randomUUID());
  const stateRoot = path.join(root, 'state'), outputRoot = path.join(root, 'outputs');
  await assertSafeDirectory(stateRoot, { create: true }); await assertSafeDirectory(outputRoot, { create: true });
  return { stateRoot, outputRoot, root, index: createLocalResearchIndex({ stateRoot, outputRoot }) };
}
const row = (id, text = 'Рыжий лис 快速 café') => ({ schemaVersion: 1, id, provider: 'telegram', type: 'message', sourceUrl: `https://t.me/synthetic/${id}`, date: 1700000000, text });
async function job(f, rows, extras = {}) {
  const id = randomUUID(), outputDirectory = path.join(f.outputRoot, id);
  await fs.mkdir(outputDirectory);
  const bytes = rows.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + (rows.length ? '\n' : '');
  await fs.writeFile(path.join(outputDirectory, 'records.jsonl'), bytes);
  return { schemaVersion: 1, id, provider: 'telegram', operation: 'search', state: 'completed', outputDirectory, result: { count: rows.length, outcome: rows.length ? 'results' : 'empty', files: ['records.jsonl'], coverage: 'platform_search' }, ...extras };
}
const search = (f, jobs, query, extras = {}) => f.index.search({ jobIds: jobs.map(j => j.id), query, ...extras });

test('Unicode terms and phrases are literal AND; matches carry exact byte locators and hashes', async () => {
  const f = await fixture(), j = await job(f, [row('1'), row('2', 'Рыжий быстрый лис 中文 東京'), row('3', 'cafe "quoted" OR NEAR')]);
  const built = await f.index.indexJobs({ jobs: [j] });
  assert.equal(built.indexedRecords, 3); assert.equal(built.incomplete, false);
  assert.equal((await search(f, [j], 'рыжий лис')).totalMatches, 2);
  assert.equal((await search(f, [j], '"рыжий лис"')).totalMatches, 1);
  assert.equal((await search(f, [j], 'CAFÉ')).totalMatches, 2);
  assert.equal((await search(f, [j], '快速')).totalMatches, 1);
  assert.equal((await search(f, [j], 'OR NEAR')).totalMatches, 1);
  assert.equal((await search(f, [j], 'рыжий OR')).totalMatches, 0);
  const result = (await search(f, [j], '東京')).results[0];
  assert.equal(result.id, '2'); assert.equal(result.locator.line, 2);
  const bytes = await fs.readFile(result.locator.file);
  const raw = bytes.subarray(result.locator.byteOffset, result.locator.byteOffset + result.locator.byteLength);
  assert.equal(sha(raw), result.contentSha256); assert.equal(JSON.parse(raw).id, '2');
  assert.equal(result.source, 'https://t.me/synthetic/2'); assert.equal(result.timestamp, 1700000000);
  assert.equal((await search(f, [j], 'нетТакогоСлова')).state, 'no_results');
  await assert.rejects(search(f, [j], '"unfinished'), { code: 'INVALID_INDEX_REQUEST' });
  await assert.rejects(search(f, [j], '***'), { code: 'INVALID_INDEX_REQUEST' });
});

test('accepted Instagram observedText is searchable and metadata-only records retain explicit content coverage gaps', async () => {
  const f = await fixture();
  const j = await job(f, [
    { id: 'reel', provider: 'instagram', type: 'reel', sourceUrl: 'https://www.instagram.com/reel/synthetic/', description: 'selected metadata', observedText: 'наблюдаемыйТекст observedCaption' },
    { id: 'profile', provider: 'instagram', type: 'profile', description: 'profileMetadata', name: 'Synthetic profile' },
  ], { provider: 'instagram' });
  const indexed = await f.index.indexJobs({ jobs: [j] });
  assert.equal(indexed.jobs[0].missingFields.text, 0); assert.equal(indexed.jobs[0].missingFields.contentText, 1);
  assert.equal((await search(f, [j], 'наблюдаемыйТекст')).results[0].id, 'reel');
  assert.equal((await search(f, [j], 'profileMetadata')).results[0].id, 'profile');
});

test('scope and cursors do not bleed jobs; pagination is stable and query/version bound', async () => {
  const f = await fixture(), a = await job(f, Array.from({ length: 6 }, (_, i) => row('a' + i, 'needle'))), b = await job(f, [row('other', 'needle')]);
  await f.index.indexJobs({ jobs: [a, b] });
  let page = await search(f, [a], 'needle', { limit: 2 }); const ids = [];
  while (true) { ids.push(...page.results.map(r => r.id)); if (!page.nextCursor) break; page = await search(f, [a], 'needle', { limit: 2, cursor: page.nextCursor }); }
  assert.deepEqual(ids, ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
  assert.equal((await search(f, [a, b], 'needle')).totalMatches, 7);
  const first = await search(f, [a], 'needle', { limit: 2 });
  await assert.rejects(search(f, [a], 'other', { limit: 2, cursor: first.nextCursor }), { code: 'INDEX_CURSOR_STALE' });
  await assert.rejects(search(f, [a, b], 'needle', { limit: 2, cursor: first.nextCursor }), { code: 'INDEX_CURSOR_STALE' });
  const c = await job(f, [row('new', 'unrelated')]); await f.index.indexJobs({ jobs: [c] });
  await assert.rejects(search(f, [a], 'needle', { limit: 2, cursor: first.nextCursor }), { code: 'INDEX_CURSOR_STALE' });
});

test('same bytes are idempotent; changed bytes are detected even when size and mtime are restored; explicit rebuild is atomic', async () => {
  const f = await fixture(), j = await job(f, [row('one', 'before')]);
  const first = await f.index.indexJobs({ jobs: [j] }), repeat = await f.index.indexJobs({ jobs: [j] });
  assert.equal(repeat.jobs[0].state, 'unchanged'); assert.equal(repeat.revision, first.revision);
  const file = path.join(j.outputDirectory, 'records.jsonl'), original = await fs.stat(file);
  await fs.writeFile(file, JSON.stringify(row('one', 'after!')) + '\n'); await fs.utimes(file, original.atime, original.mtime);
  await assert.rejects(search(f, [j], 'before'), { code: 'INDEX_SOURCE_CHANGED' });
  await assert.rejects(f.index.indexJobs({ jobs: [j] }), { code: 'INDEX_SOURCE_CHANGED' });
  const rebuilt = await f.index.indexJobs({ jobs: [j], replaceChanged: true });
  assert.equal(rebuilt.jobs[0].state, 'rebuilt'); assert.equal((await search(f, [j], 'before')).totalMatches, 0); assert.equal((await search(f, [j], 'after')).totalMatches, 1);
});

test('completed empty is indexed zero; accepted partial is labelled incomplete; missing text/identity remains explicit', async () => {
  const f = await fixture(), empty = await job(f, []), partial = await job(f, [{ text: 'fragment' }], { state: 'partial', error: { code: 'DEADLINE_EXCEEDED' } });
  partial.result.outcome = 'partial'; partial.result.truncated = true;
  const built = await f.index.indexJobs({ jobs: [empty, partial] });
  assert.equal(built.jobs[0].indexed, 0); assert.equal(built.jobs[1].incomplete, true);
  assert.deepEqual(built.jobs[1].missingFields, { id: 1, source: 1, timestamp: 1, text: 0, contentText: 0 });
  const result = await search(f, [partial], 'fragment'); assert.equal(result.incomplete, true); assert.equal(result.results[0].source, null);
  const missing = await job(f, [{ id: 'no-text' }]); await f.index.indexJobs({ jobs: [missing] });
  assert.equal((await search(f, [missing], 'anything')).jobs[0].missingFields.text, 1);
  const zeroPartial = await job(f, [], { state: 'partial' });
  await assert.rejects(f.index.indexJobs({ jobs: [zeroPartial] }), { code: 'INDEX_JOB_UNAVAILABLE' });
  for (const state of ['running', 'queued', 'failed', 'cancelled', 'auth_required']) await assert.rejects(f.index.indexJobs({ jobs: [{ ...partial, state }] }), { code: 'INDEX_JOB_UNAVAILABLE' });
});

test('a malformed job or count mismatch rolls back the entire batch; accepted rows are never silently skipped', async () => {
  const f = await fixture(), good = await job(f, [row('good', 'kept')]), bad = await job(f, ['{bad json']);
  await assert.rejects(f.index.indexJobs({ jobs: [good, bad] }), { code: 'INVALID_CORPUS' });
  await assert.rejects(search(f, [good], 'kept'), { code: 'INDEX_MISSING' });
  const mismatch = await job(f, [row('a'), row('b')]); mismatch.result.count = 1;
  await assert.rejects(f.index.indexJobs({ jobs: [mismatch] }), { code: 'INVALID_CORPUS' });
  const provider = await job(f, [{ ...row('a'), provider: 'x' }]);
  await assert.rejects(f.index.indexJobs({ jobs: [provider] }), { code: 'INVALID_CORPUS' });
  await f.index.indexJobs({ jobs: [good] }); assert.equal((await search(f, [good], 'kept')).totalMatches, 1);
});

test('physical lines include blanks and CRLF; invalid UTF-8 is rejected; long UTF-8 lines stream across chunks', async () => {
  const f = await fixture(), j = await job(f, [row('one')]);
  const text = 'длинная '.repeat(12000) + 'needleTail';
  await fs.writeFile(path.join(j.outputDirectory, 'records.jsonl'), '\r\n' + JSON.stringify(row('one', text)) + '\r\n\n');
  await f.index.indexJobs({ jobs: [j] }); const hit = (await search(f, [j], 'needleTail')).results[0]; assert.equal(hit.locator.line, 2);
  const invalid = await job(f, [row('bad')]); await fs.writeFile(path.join(invalid.outputDirectory, 'records.jsonl'), Buffer.from([0xff, 0xfe, 10]));
  await assert.rejects(f.index.indexJobs({ jobs: [invalid] }), { code: 'INVALID_CORPUS' });
});

test('search does not auto-index; explicit input, query and resource bounds are enforced', async () => {
  const f = await fixture(), j = await job(f, [row('one')]);
  await assert.rejects(search(f, [j], 'query'), { code: 'INDEX_MISSING' });
  await assert.rejects(f.index.indexJobs({ jobs: [j, j] }), { code: 'INVALID_INDEX_REQUEST' });
  await assert.rejects(f.index.indexJobs({ jobs: [{ ...j, outputDirectory: f.outputRoot }] }), { code: 'UNSAFE_PATH' });
  await assert.rejects(f.index.indexJobs({ jobs: [{ ...j, result: { ...j.result, files: ['export.md'] } }] }), { code: 'INVALID_CORPUS' });
  await assert.rejects(search(f, [j], 'q', { limit: 101 }), { code: 'INVALID_INDEX_REQUEST' });
  await assert.rejects(search(f, [j], 'q', { deadlineMs: 0 }), { code: 'INVALID_INDEX_REQUEST' });
  await assert.rejects(search(f, [j], 'q'.repeat(1025)), { code: 'INVALID_INDEX_REQUEST' });
  await assert.rejects(search(f, [j], 'q', { cursor: 'malformed' }), { code: 'INDEX_CURSOR_STALE' });
  const over = await job(f, [row('large')]); const handle = await fs.open(path.join(over.outputDirectory, 'records.jsonl'), 'r+'); await handle.truncate(LOCAL_INDEX_LIMITS.sourceBytes + 1); await handle.close();
  await assert.rejects(f.index.indexJobs({ jobs: [over] }), { code: 'INDEX_LIMIT' });
  const longLine = await job(f, [row('long')]); await fs.writeFile(path.join(longLine.outputDirectory, 'records.jsonl'), 'x'.repeat(LOCAL_INDEX_LIMITS.lineBytes + 1));
  await assert.rejects(f.index.indexJobs({ jobs: [longLine] }), { code: 'INDEX_LIMIT' });
});

test('queued deadline and cancellation return promptly during a real paused write transaction without allowing later work to bypass it', async () => {
  const f = await fixture(), kept = await job(f, [row('kept', 'durable')]), paused = await job(f, [row('paused', 'active')]), timedOut = await job(f, [row('timed-out', 'never accepted')]);
  await f.index.indexJobs({ jobs: [kept] });
  const file = path.join(paused.outputDirectory, 'records.jsonl'), sourceStat = await fs.stat(file), probe = await fs.open(file, 'r');
  const prototype = Object.getPrototypeOf(probe), originalRead = prototype.read; await probe.close();
  let release, started, blocked = false;
  const gate = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { started = resolve; });
  prototype.read = async function (...args) {
    if (!blocked && (await this.stat()).ino === sourceStat.ino) { blocked = true; started(); await gate; }
    return Reflect.apply(originalRead, this, args);
  };
  const predecessor = f.index.indexJobs({ jobs: [paused], deadlineMs: 5000 }); predecessor.catch(() => {});
  let fallback;
  try {
    await observed;
    assert.ok((await fs.stat(path.join(f.stateRoot, 'local-index', 'index.sqlite-journal'))).size > 0);
    fallback = setTimeout(release, 250);
    const since = Date.now(), controller = new AbortController();
    const expired = f.index.indexJobs({ jobs: [timedOut], deadlineMs: 25 });
    const cancelled = search(f, [kept], 'durable', { signal: controller.signal, deadlineMs: 5000 });
    const abort = setTimeout(() => controller.abort(), 25);
    await Promise.all([assert.rejects(expired, { code: 'INDEX_DEADLINE' }), assert.rejects(cancelled, { code: 'INDEX_CANCELLED' })]); clearTimeout(abort);
    assert.ok(Date.now() - since < 150, 'Queued deadlines/cancellation must not wait for the predecessor to finish');
    let followingFinished = false;
    const following = search(f, [kept], 'durable').then(value => { followingFinished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(followingFinished, false);
    release(); await predecessor; assert.equal((await following).totalMatches, 1);
    await assert.rejects(search(f, [timedOut], 'never'), { code: 'INDEX_MISSING' });
  } finally { clearTimeout(fallback); release(); await predecessor; prototype.read = originalRead; }
});

test('cancel and deadline roll back; subsequent operation and factory restart recover the original snapshot', async () => {
  const f = await fixture(), kept = await job(f, [row('kept', 'original')]); await f.index.indexJobs({ jobs: [kept] });
  const large = await job(f, Array.from({ length: 1000 }, (_, i) => row('bulk' + i, 'load '.repeat(100))));
  const controller = new AbortController(); let observedTransaction = false;
  const timer = setInterval(async () => { try { if ((await fs.stat(path.join(f.stateRoot, 'local-index', 'index.sqlite-journal'))).size > 0) { observedTransaction = true; controller.abort(); } } catch {} }, 1);
  const fallback = setTimeout(() => controller.abort(), 5000);
  try { await assert.rejects(f.index.indexJobs({ jobs: [large], signal: controller.signal }), { code: 'INDEX_CANCELLED' }); }
  finally { clearInterval(timer); clearTimeout(fallback); }
  assert.equal(observedTransaction, true, 'Cancellation must occur after the actual owned write transaction starts');
  await assert.rejects(search(f, [large], 'load'), { code: 'INDEX_MISSING' });
  assert.equal((await search(f, [kept], 'original')).totalMatches, 1);
  await assert.rejects(f.index.indexJobs({ jobs: [large], deadlineMs: 1 }), { code: 'INDEX_DEADLINE' });
  const restarted = createLocalResearchIndex(f); assert.equal((await restarted.search({ jobIds: [kept.id], query: 'original' })).totalMatches, 1);
});

test('source hardlinks, job junctions, unsafe state ancestry, SQLite hardlinks and WAL links are denied', async () => {
  const f = await fixture(), j = await job(f, [row('one')]);
  const file = path.join(j.outputDirectory, 'records.jsonl'), alias = path.join(f.root, 'alias.jsonl'); await fs.link(file, alias);
  await assert.rejects(f.index.indexJobs({ jobs: [j] }), { code: 'UNSAFE_PATH' }); await fs.unlink(alias);
  const original = j.outputDirectory + '-real'; await fs.rename(j.outputDirectory, original); await fs.symlink(original, j.outputDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.index.indexJobs({ jobs: [j] }), { code: 'UNSAFE_PATH' }); await fs.unlink(j.outputDirectory); await fs.rename(original, j.outputDirectory);
  await f.index.indexJobs({ jobs: [j] }); const dbFile = path.join(f.stateRoot, 'local-index', 'index.sqlite'); await fs.link(dbFile, path.join(f.root, 'db-copy'));
  await assert.rejects(search(f, [j], 'лис'), { code: 'UNSAFE_PATH' }); await fs.unlink(path.join(f.root, 'db-copy'));
  await fs.symlink(f.outputRoot, path.join(f.root, 'linked-output'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createLocalResearchIndex({ stateRoot: f.stateRoot, outputRoot: path.join(f.root, 'linked-output') }).search({ jobIds: [j.id], query: 'лис' }), { code: 'UNSAFE_PATH' });
  await fs.link(file, dbFile + '-wal'); await assert.rejects(search(f, [j], 'лис'), { code: 'UNSAFE_PATH' }); await fs.unlink(dbFile + '-wal');
  await fs.writeFile(dbFile + '-wal', 'foreign'); await assert.rejects(search(f, [j], 'лис'), { code: 'INDEX_INVALID_DB' });
});

test('live owner is never stolen, stale recognized dead owner is recoverable, unknown schema is preserved', async () => {
  const f = await fixture(), j = await job(f, [row('one')]); await f.index.indexJobs({ jobs: [j] });
  const lock = path.join(f.stateRoot, 'local-index', 'index.lock'); await fs.writeFile(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  await assert.rejects(search(f, [j], 'лис'), { code: 'INDEX_BUSY' }); await fs.unlink(lock);
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' }); await once(child, 'exit');
  await fs.writeFile(lock, JSON.stringify({ pid: child.pid, nonce: randomUUID() })); assert.equal((await search(f, [j], 'лис')).totalMatches, 1);
  const dbFile = path.join(f.stateRoot, 'local-index', 'index.sqlite'); const db = new DatabaseSync(dbFile); db.exec('CREATE TABLE foreign_data(secret TEXT)'); db.close();
  const before = sha(await fs.readFile(dbFile)); await assert.rejects(search(f, [j], 'лис'), { code: 'INDEX_INVALID_DB' }); assert.equal(sha(await fs.readFile(dbFile)), before);
});

test('concurrent factories are bounded and the independent writer never mixes transactions', async () => {
  const f = await fixture(), a = await job(f, Array.from({ length: 1000 }, (_, i) => row('a' + i, 'alpha'))), b = await job(f, [row('b', 'beta')]);
  const other = createLocalResearchIndex(f);
  const first = f.index.indexJobs({ jobs: [a] });
  // Wait for the actual exclusive marker rather than treating a timeout as proof of a writer.
  const end = Date.now() + 3000; while (true) { try { await fs.stat(path.join(f.stateRoot, 'local-index', 'index.lock')); break; } catch { if (Date.now() > end) throw new Error('fixture did not acquire lock'); await new Promise(resolve => setTimeout(resolve, 1)); } }
  await assert.rejects(other.indexJobs({ jobs: [b] }), { code: 'INDEX_BUSY' }); await first;
  await other.indexJobs({ jobs: [b] }); assert.equal((await search(f, [a, b], 'beta')).totalMatches, 1);
  const pages = await Promise.all(Array.from({ length: 8 }, () => search(f, [a], 'alpha'))); assert.ok(pages.every(page => page.totalMatches === 1000));
});

test('large observed fields keep MCP pages under an explicit byte budget and cursor retains every match', async () => {
  const f = await fixture();
  const j = await job(f, Array.from({ length: 100 }, (_, i) => ({ ...row('wide-' + i, 'needle ' + '界'.repeat(5000)), source: undefined, sourceUrl: 'https://t.me/' + '界'.repeat(300) + '"\\\n\t'.repeat(600) })));
  await f.index.indexJobs({ jobs: [j] });
  let page = await search(f, [j], 'needle', { limit: 100 }); const seen = new Set(); let pages = 0;
  assert.equal(page.byteLimited, true);
  while (true) {
    pages++; assert.ok(Buffer.byteLength(JSON.stringify(page)) <= LOCAL_INDEX_LIMITS.resultBytes);
    const envelope = { jsonrpc: '2.0', id: 'synthetic-output-envelope', result: { content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page, isError: false } };
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 262144, 'Full MCP text plus structured content must fit one frame even with Unicode/control/backslash escaping');
    for (const result of page.results) { assert.equal(seen.has(result.id), false); seen.add(result.id); assert.ok(result.snippet.length <= 4096); }
    if (!page.nextCursor) break;
    page = await search(f, [j], 'needle', { limit: 100, cursor: page.nextCursor });
  }
  assert.ok(pages > 1); assert.equal(seen.size, 100);
});

test('abrupt owned-process interruption leaves no accepted half-snapshot and hot-journal recovery keeps prior data', { timeout: 30000 }, async () => {
  const f = await fixture(), kept = await job(f, [row('original', 'durable')]);
  await f.index.indexJobs({ jobs: [kept] });
  const bulk = [];
  for (let group = 0; group < 20; group++) bulk.push(await job(f, Array.from({ length: 1000 }, (_, i) => row(`crash-${group}-${i}`, 'recovery load '.repeat(300)))));
  const request = path.join(f.root, 'owned-crash-request.json'); await fs.writeFile(request, JSON.stringify({ stateRoot: f.stateRoot, outputRoot: f.outputRoot, jobs: bulk }));
  const childCode = `import fs from 'node:fs/promises'; import {createLocalResearchIndex} from ${JSON.stringify(new URL('./local-index.mjs', import.meta.url).href)}; const value=JSON.parse(await fs.readFile(process.argv[1],'utf8')); await createLocalResearchIndex(value).indexJobs({jobs:value.jobs});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, request], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString().slice(0, 1024); }); const exited = once(child, 'exit');
  const journal = path.join(f.stateRoot, 'local-index', 'index.sqlite-journal');
  const end = Date.now() + 15000;
  while (true) {
    if (child.exitCode !== null) throw new Error('Owned crash fixture exited before its transaction: ' + stderr);
    try {
      if ((await fs.stat(journal)).size > 512) {
        const handle = await fs.open(journal, 'r'); const magic = Buffer.alloc(8);
        try { await handle.read(magic, 0, 8, 0); } finally { await handle.close(); }
        if (magic.toString('hex') === 'd9d505f920a163d7') break;
      }
    } catch {}
    if (Date.now() >= end) throw new Error('Owned crash fixture did not open a journal');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  child.kill(); await exited;
  assert.equal((await search(f, [kept], 'durable')).totalMatches, 1);
  await assert.rejects(search(f, [bulk[0]], 'recovery'), { code: 'INDEX_MISSING' });
  await assert.rejects(fs.stat(path.join(f.stateRoot, 'local-index', 'index.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
});

test('replaced database identity and source identity are rejected, and closed factory recreation remains explicit', async () => {
  const f = await fixture(), j = await job(f, [row('one')]); await f.index.indexJobs({ jobs: [j] });
  const dbFile = path.join(f.stateRoot, 'local-index', 'index.sqlite'); await fs.rename(dbFile, dbFile + '.old'); await fs.copyFile(dbFile + '.old', dbFile);
  await assert.rejects(search(f, [j], 'лис'), { code: 'UNSAFE_PATH' });
  const restarted = createLocalResearchIndex(f); assert.equal((await restarted.search({ jobIds: [j.id], query: 'лис' })).totalMatches, 1);
  const file = path.join(j.outputDirectory, 'records.jsonl'); await fs.rename(file, file + '.old'); await fs.writeFile(file, JSON.stringify(row('two', 'changed')) + '\n');
  await assert.rejects(restarted.search({ jobIds: [j.id], query: 'лис' }), { code: 'INDEX_SOURCE_CHANGED' });
});

test('100000-row selected-source stress: known answers, full hashing, pagination and repeat indexing', { timeout: 300000 }, async () => {
  const f = await fixture(), jobs = []; const startRss = process.memoryUsage().rss; let sourceBytes = 0;
  for (let group = 0; group < 100; group++) {
    const rows = Array.from({ length: 1000 }, (_, i) => row(`${group}-${i}`, `synthetic corpus ${group} record ${i} research indexing скорость качество 東京 ${i % 100 === 7 ? 'knownanswer' : 'ordinary'} ${'bounded fixture text '.repeat(8)}`));
    const selected = await job(f, rows); jobs.push(selected); sourceBytes += (await fs.stat(path.join(selected.outputDirectory, 'records.jsonl'))).size;
  }
  const start = performance.now(); const built = await f.index.indexJobs({ jobs }); const buildMs = performance.now() - start;
  assert.equal(built.indexedRecords, 100000);
  const searches = [];
  for (const [query, expected] of [['knownanswer', 1000], ['скорость качество', 100000], ['absentknownanswer', 0], ['東京', 100000]]) {
    const since = performance.now(), result = await search(f, jobs, query, { limit: 25 });
    searches.push({ query, expected, actual: result.totalMatches, endToEndMs: performance.now() - since }); assert.equal(result.totalMatches, expected);
  }
  let page = await search(f, jobs, 'knownanswer', { limit: 100 }); const matched = new Set();
  do { for (const row of page.results) { const locator = row.jobId + ':' + row.locator.line; assert.equal(matched.has(locator), false); matched.add(locator); } if (!page.nextCursor) break; page = await search(f, jobs, 'knownanswer', { limit: 100, cursor: page.nextCursor }); } while (true);
  assert.equal(matched.size, 1000);
  const since = performance.now(), repeated = await f.index.indexJobs({ jobs }); const repeatMs = performance.now() - since;
  assert.ok(repeated.jobs.every(job => job.state === 'unchanged')); assert.equal(repeated.revision, built.revision);
  const stat = await fs.stat(path.join(f.stateRoot, 'local-index', 'index.sqlite'));
  stats.push({ scenario: '100000_rows', records: 100000, selectedJobs: jobs.length, sourceBytes, databaseBytes: stat.size, buildMs, repeatMs, searches, startRss, finalRss: process.memoryUsage().rss, runtime: process.version, platform: process.platform });
});

test.after(async () => { await fs.writeFile(path.join(work, 'local-index-test-metrics.json'), JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), stats }, null, 2) + '\n'); });







