import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createResearchBroker } from './broker.mjs';
import { JobStore, assertSafeDirectory } from './job-store.mjs';

const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work) || path.basename(path.resolve(work)).toLowerCase() !== 'work') throw Error('Explicit own task work required');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const binding = { accountRef: 'synthetic-account', accountEpoch: 'synthetic-epoch-1' };
const pending = { state: 'unavailable', reason: 'dom_account_proof_pending', operations: ['search'], ...binding };
const ready = { state: 'ready', operations: ['search'], ...binding };
const input = (query, extra = {}) => ({ provider: 'x', operation: 'search', input: { query, deadlineMs: 3000, ...extra } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check, limit = 5000) { const end = Date.now() + limit; while (Date.now() < end) { const value = await check(); if (value) return value; await pause(5); } throw Error('Bounded synthetic fixture deadline'); }
async function terminal(broker, id) { return waitFor(async () => { const value = await broker.get(id); return !['queued', 'running'].includes(value.state) && value; }); }
async function create(t, status, run = async () => ({ count: 1, coverage: 'platform_search' })) {
  const directory = path.join(work, 'broker-readiness-fix-' + randomUUID()); await assertSafeDirectory(directory, { create: true });
  const provider = { requiresAccountBinding: true, status, run };
  const broker = await createResearchBroker({ stateRoot: path.join(directory, 'state'), outputRoot: path.join(directory, 'outputs'), providers: { x: provider } });
  t.after(() => broker.close()); return { broker, directory, provider };
}

test('settles initial pending proof before submit pin and executes once under exact current binding', async t => {
  let calls = 0, runs = 0; const f = await create(t, async () => ++calls < 3 ? pending : ready, async ({ accountScope }) => {
    runs++; assert.deepEqual(accountScope, binding); return { count: 1, coverage: 'platform_search' };
  });
  const job = await f.broker.submit(input('initial proof')); assert.ok(calls >= 3);
  assert.equal((await terminal(f.broker, job.id)).state, 'completed'); assert.equal(runs, 1);
});
test('settles TTL refresh at dequeue without trusting stale ready or repeating source', async t => {
  let calls = 0, runs = 0; const f = await create(t, async () => { calls++; return calls > 1 && calls < 4 ? pending : ready; }, async ({ accountScope }) => {
    runs++; assert.deepEqual(accountScope, binding); return { count: 1, coverage: 'platform_search' };
  });
  const job = await f.broker.submit(input('TTL proof'));
  assert.equal((await terminal(f.broker, job.id)).state, 'completed'); assert.equal(runs, 1); assert.ok(calls >= 4);
});
test('genuine account epoch change after pending remains STALE_ACCOUNT before execution', async t => {
  let calls = 0, runs = 0; const f = await create(t, async () => ++calls === 1 ? ready : calls === 2 ? pending : { ...ready, accountEpoch: 'synthetic-epoch-2' }, async () => { runs++; return { count: 1 }; });
  const job = await f.broker.submit(input('changed epoch')); const result = await terminal(f.broker, job.id);
  assert.equal(result.error.code, 'STALE_ACCOUNT'); assert.equal(runs, 0);
});
for (const [state, reason, code] of [['auth_required', 'session_not_available_in_research_view', 'AUTH_REQUIRED'], ['challenge_required', 'challenge_required', 'CHALLENGE_REQUIRED'], ['rate_limited', 'rate_limited', 'RATE_LIMITED'], ['unavailable', 'app_owned_bridge_unavailable', 'PROVIDER_UNAVAILABLE'], ['unsupported', 'unsupported', 'UNSUPPORTED']]) test('settled pre-pin error stays explicit with no job: ' + code, async t => {
  let calls = 0, runs = 0; const f = await create(t, async () => ++calls === 1 ? pending : { state, reason, operations: ['search'] }, async () => { runs++; return { count: 1 }; });
  await assert.rejects(f.broker.submit(input(code)), error => error.code === code);
  assert.equal((await f.broker.status()).counts.queued, 0); assert.equal(runs, 0);
});
test('queued cancellation aborts a pending status wait and ignores late ready response', async t => {
  const gate = deferred(); let calls = 0, runs = 0;
  const f = await create(t, async () => ++calls === 1 ? ready : gate.promise, async () => { runs++; return { count: 1 }; });
  const job = await f.broker.submit(input('cancel proof')); await waitFor(() => calls >= 2);
  const before = Date.now(); assert.equal((await f.broker.cancel(job.id)).state, 'cancelled');
  gate.resolve(ready); await pause(50); assert.ok(Date.now() - before < 300); assert.equal(runs, 0); assert.equal((await f.broker.get(job.id)).state, 'cancelled');
});
test('close during a coalesced pre-pin status wait rejects submit without creating a late ID', async t => {
  const gate = deferred(); let calls = 0, runs = 0;
  const f = await create(t, async () => { calls++; return gate.promise; }, async () => { runs++; return { count: 1 }; });
  const submitted = f.broker.submit(input('close proof')); const checked = assert.rejects(submitted, error => error.code === 'BROKER_CLOSED');
  await waitFor(() => calls === 1); const before = Date.now(); const closing = f.broker.close();
  await Promise.race([closing, pause(500).then(() => { throw Error('Close must abort pre-pin wait'); })]);
  gate.resolve(ready); await checked; assert.ok(Date.now() - before < 500); assert.equal(runs, 0);
});
test('same normalized idempotency requests share one accepted ID and one source execution after proof', async t => {
  let calls = 0, runs = 0; const f = await create(t, async () => ++calls < 3 ? pending : ready, async () => { runs++; return { count: 1, coverage: 'platform_search' }; });
  const request = { ...input('idempotent proof'), idempotencyKey: 'synthetic-readiness-repeat' };
  const [a, b] = await Promise.all([f.broker.submit(request), f.broker.submit(request)]); assert.equal(a.id, b.id);
  assert.equal((await terminal(f.broker, a.id)).state, 'completed'); assert.equal(runs, 1);
  f.provider.status = async () => ({ state: 'auth_required', operations: [] }); assert.equal((await f.broker.submit(request)).id, a.id); assert.equal(runs, 1);
});
test('one execution budget includes pending proof and source; late source completion never overwrites deadline', { timeout: 5000 }, async t => {
  let calls = 0, proofStart, remaining, runs = 0, aborts = 0;
  const f = await create(t, async () => {
    calls++; if (calls === 1) return ready; proofStart ??= Date.now(); return Date.now() - proofStart < 500 ? pending : ready;
  }, async ({ input: received, signal }) => {
    runs++; remaining = received.deadlineMs; signal.addEventListener('abort', () => { aborts++; }, { once: true });
    await pause(650); return { count: 1, coverage: 'platform_search' };
  });
  const job = await f.broker.submit(input('shared budget', { deadlineMs: 1000 })); const result = await terminal(f.broker, job.id);
  assert.equal(result.state, 'interrupted'); assert.equal(result.error.code, 'DEADLINE_EXCEEDED'); assert.equal(result.error.completionUncertain, true);
  assert.ok(remaining > 0 && remaining <= 550); assert.ok(Date.now() - proofStart < 1200); assert.equal(runs, 1); assert.equal(aborts, 1);
  await pause(300); assert.equal((await f.broker.get(job.id)).state, 'interrupted');
});
test('queue residence remains separate while each dequeue gets one budget and preserves FIFO', async t => {
  const release = deferred(); const order = [], remaining = [];
  const f = await create(t, async () => ready, async ({ input: received }) => { order.push(received.query); remaining.push(received.deadlineMs); if (received.query === 'first') await release.promise; return { count: 1, coverage: 'platform_search' }; });
  const first = await f.broker.submit(input('first')); await waitFor(() => order.length === 1);
  const next = await f.broker.submit(input('second', { deadlineMs: 1000 })); await pause(250); release.resolve();
  assert.equal((await terminal(f.broker, first.id)).state, 'completed'); assert.equal((await terminal(f.broker, next.id)).state, 'completed');
  assert.deepEqual(order, ['first', 'second']); assert.ok(remaining[1] > 900 && remaining[1] <= 1000);
});
test('pre-pin20s bound includes submission-tail residence and is below documented35s IPC timeout', async t => {
  const source = await fs.readFile(new URL('./broker.mjs', import.meta.url), 'utf8');
  assert.match(source, /MAX_SUBMIT_PROOF_WAIT_MS = 20000/);
  const ipc = await fs.readFile(new URL('./ipc.mjs', import.meta.url), 'utf8'); assert.match(ipc, /timeoutMs = 35000/);
  const gate = deferred(); let calls = 0, runs = 0; const f = await create(t, async () => { calls++; return gate.promise; }, async () => { runs++; return { count: 1 }; });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const a = f.broker.submit(input('expired first')), b = f.broker.submit(input('expired tail'));
  const results = Promise.allSettled([a, b]); for (let step = 0; step < 10 && calls === 0; step++) await Promise.resolve();
  assert.equal(calls, 1); t.mock.timers.tick(20001); for (let step = 0; step < 30; step++) await Promise.resolve();
  gate.resolve(ready); const settled = await results; t.mock.timers.reset();
  assert.equal(settled[0].status, 'rejected'); assert.equal(settled[1].status, 'rejected');
  assert.equal(settled[0].reason.code, 'DEADLINE_EXCEEDED'); assert.equal(settled[1].reason.code, 'DEADLINE_EXCEEDED'); assert.equal(runs, 0);
});
test('app_initializing is the only additional initialization transient; missing settled binding still rejects pre-pin', async t => {
  let calls = 0, runs = 0;
  const f = await create(t, async () => ++calls === 1 ? { state: 'unavailable', reason: 'app_initializing', operations: ['search'] } : ready, async () => { runs++; return { count: 1, coverage: 'platform_search' }; });
  const accepted = await f.broker.submit(input('initial app')); assert.equal((await terminal(f.broker, accepted.id)).state, 'completed'); assert.equal(runs, 1);
  f.provider.status = async () => ({ state: 'ready', operations: ['search'] });
  await assert.rejects(f.broker.submit(input('missing binding')), error => error.code === 'STALE_ACCOUNT'); assert.equal(runs, 1);
});

test('pre-aborted internal submission reaches no provider RPC, allocation or durable job', async t => {
  let calls = 0, runs = 0; const f = await create(t, async () => { calls++; return ready; }, async () => { runs++; return { count: 1 }; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.broker.submit(input('preabort'), { signal: controller.signal }), error => error.code === 'CANCELLED');
  await pause(30); assert.equal(calls, 0); assert.equal(runs, 0); assert.deepEqual(await fs.readdir(path.join(f.directory, 'outputs')), []);
});

test('abort during pre-save output allocation retains only its empty owned directory and no durable job', async t => {
  const entered = deferred(), release = deferred(); const f = await create(t, async () => ready);
  const original = JobStore.prototype.createOutput; let output;
  JobStore.prototype.createOutput = async function (id) {
    const created = await original.call(this, id);
    if (this.stateRoot === path.join(f.directory, 'state')) { output = created; entered.resolve(); await release.promise; }
    return created;
  };
  t.after(() => { JobStore.prototype.createOutput = original; release.resolve(); });
  const controller = new AbortController(); const submitted = f.broker.submit(input('allocation cancel'), { signal: controller.signal });
  const checked = assert.rejects(submitted, error => error.code === 'CANCELLED'); await entered.promise; controller.abort(); release.resolve(); await checked;
  await pause(30); assert.deepEqual(await fs.readdir(path.join(f.directory, 'state', 'jobs')), []);
  assert.deepEqual(await fs.readdir(output.directory), []); assert.equal((await f.broker.status()).counts.queued, 0);
});

test('completion persistence uses the same absolute deadline and cannot overwrite durable interruption', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred(); let aborted = false;
  const f = await create(t, async () => ready, async ({ signal }) => { signal.addEventListener('abort', () => { aborted = true; }, { once: true }); return { count: 1, coverage: 'platform_search' }; });
  const original = JobStore.prototype.atomicWrite;
  JobStore.prototype.atomicWrite = async function (job) {
    if (this.stateRoot === path.join(f.directory, 'state') && job.state === 'completed') { entered.resolve(); await release.promise; }
    return original.call(this, job);
  };
  t.after(() => { JobStore.prototype.atomicWrite = original; release.resolve(); });
  const accepted = await f.broker.submit(input('persist deadline', { deadlineMs: 1000 })); await entered.promise;
  const result = await terminal(f.broker, accepted.id); assert.equal(result.state, 'interrupted'); assert.equal(result.error.code, 'DEADLINE_EXCEEDED'); assert.equal(aborted, true);
  release.resolve(); const metadata = path.join(f.directory, 'state', 'jobs', accepted.id + '.json');
  await waitFor(async () => JSON.parse(await fs.readFile(metadata, 'utf8')).state === 'interrupted');
  assert.equal((await f.broker.get(accepted.id)).state, 'interrupted');
});
