import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createResearchBroker, RESEARCH_OPERATIONS } from './broker.mjs';
import { assertSafeDirectory, inspectOutputFiles, safeOutputName } from './job-store.mjs';

// Fixtures are synthetic and stay in an explicitly selected Agent Brain task work.
const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work) || path.basename(path.resolve(work)).toLowerCase() !== 'work') {
  throw new Error('Set EGOIST_RESEARCH_TEST_WORK to the active task work directory.');
}
const fixtureRoot = path.join(work, 'research-broker-fixtures-' + randomUUID());
await assertSafeDirectory(fixtureRoot, { create: true });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(10);
  }
  throw new Error('Synthetic fixture condition did not complete within its deadline.');
}
const terminalStates = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'auth_required', 'rate_limited']);
const waitJob = (broker, id) => waitFor(async () => {
  const job = await broker.get(id);
  return terminalStates.has(job.state) && job;
});
const input = (query = 'fixture query', extras = {}) => ({ provider: 'telegram', operation: 'search', input: { query, ...extras } });
const provider = run => ({ status: async () => ({ state: 'ready', operations: RESEARCH_OPERATIONS }), run });
async function fixture(t, providers = {}) {
  const directory = path.join(fixtureRoot, randomUUID());
  const roots = { stateRoot: path.join(directory, 'state'), outputRoot: path.join(directory, 'outputs') };
  const broker = await createResearchBroker({ ...roots, providers });
  t.after(() => broker.close());
  return { ...roots, broker, directory };
}
const rejectsCode = (action, code) => assert.rejects(action, error => error.code === code);

test('provider status without explicit operations never advertises every platform operation', async t => {
  for (const state of ['ready', 'unavailable', 'auth_required']) {
    let runs = 0;
    const { broker } = await fixture(t, { telegram: { status: async () => ({ state }), run: async () => { runs++; return { count: 0 }; } } });
    const capability = (await broker.capabilities()).providers.find(item => item.provider === 'telegram');
    assert.equal(capability.state, state);
    assert.deepEqual(capability.operations, []);
    const job = await broker.submit(input());
    const result = await waitJob(broker, job.id);
    assert.equal(result.error.code, state === 'auth_required' ? 'AUTH_REQUIRED' : state === 'ready' ? 'UNSUPPORTED' : 'PROVIDER_UNAVAILABLE');
    assert.equal(runs, 0);
  }
});

test('selected X conversations accept both native-owned routes while rejecting inbox roots and nonnumeric targets', async t => {
  const seen = [];
  const { broker } = await fixture(t, { x: provider(async ({ input: requested }) => { seen.push(requested.url); return { count: 0 }; }) });
  for (const route of ['messages/123-456', 'i/chat/123-456']) {
    const job = await broker.submit({ provider: 'x', operation: 'read_thread', input: { url: 'https://x.com/' + route } });
    assert.equal((await waitJob(broker, job.id)).state, 'completed');
  }
  for (const route of ['messages', 'i/chat', 'i/chat/private', 'messages/123-456-789', 'messages/' + '1'.repeat(65)]) {
    await rejectsCode(() => broker.submit({ provider: 'x', operation: 'read_thread', input: { url: 'https://x.com/' + route } }), 'INVALID_REQUEST');
  }
  assert.equal(seen.length, 2);
});

test('queued account-owned requests cannot silently execute after an account switch', async t => {
  const gate = deferred(); let accountEpoch = 'A'; let starts = 0;
  const { broker } = await fixture(t, { telegram: { requiresAccountBinding: true,
    status: async () => ({ state: 'ready', operations: ['search'], accountRef: 'fixture-account', accountEpoch }),
    run: async ({ accountScope }) => { starts++; assert.equal(accountScope.accountEpoch, 'A'); await gate.promise; return { count: 1 }; } } });
  const first = await broker.submit(input('first'));
  await waitFor(() => starts === 1);
  const queued = await broker.submit(input('queued'));
  accountEpoch = 'B'; gate.resolve();
  assert.equal((await waitJob(broker, first.id)).state, 'completed');
  const denied = await waitJob(broker, queued.id);
  assert.equal(denied.state, 'failed'); assert.equal(denied.error.code, 'STALE_ACCOUNT'); assert.equal(starts, 1);
  assert.equal(JSON.stringify(await broker.capabilities()).includes('fixture-account'), false);
});

test('sent selected membership account drift remains uncertain in durable public job metadata', async t => {
  const { broker } = await fixture(t, { telegram: provider(async () => { throw Object.assign(new Error('synthetic-private-reason'), { code: 'STALE_ACCOUNT', completionUncertain: true }); }) });
  const submitted = await broker.submit({ provider: 'telegram', operation: 'join_chat', input: { channel: '@fixture', confirmedJoin: true } });
  const job = await waitJob(broker, submitted.id);
  assert.equal(job.error.code, 'STALE_ACCOUNT'); assert.equal(job.error.completionUncertain, true);
  assert.equal(JSON.stringify(job).includes('synthetic-private-reason'), false);
});

test('broker recovers only an expired empty boot lock and preserves a fresh peer', async () => {
  const directory = path.join(fixtureRoot, randomUUID());
  const stateRoot = path.join(directory, 'state'); const outputRoot = path.join(directory, 'outputs');
  await assertSafeDirectory(stateRoot, { create: true }); await assertSafeDirectory(outputRoot, { create: true });
  const lock = path.join(stateRoot, 'broker.lock'); await fs.writeFile(lock, '');
  await assert.rejects(createResearchBroker({ stateRoot, outputRoot }), { code: 'STATE_BUSY' });
  assert.equal((await fs.stat(lock)).size, 0);
  const expired = new Date(Date.now() - 70000); await fs.utimes(lock, expired, expired);
  const recovered = await createResearchBroker({ stateRoot, outputRoot });
  assert.ok((await fs.stat(lock)).size > 0); await recovered.close();
});

test('provider lease settlement waits only through read-only status and never retries operations', async t => {
  let busy = true; let attempts = 0; let probes = 0;
  const { broker } = await fixture(t, { telegram: { requiresAccountBinding: true,
    status: async () => { probes++; return { state: busy ? 'unavailable' : 'ready', reason: busy ? 'provider_busy' : undefined, accountRef: 'fixture-account', accountEpoch: 'A', operations: ['search'] }; },
    run: async () => { attempts++; return { count: 1 }; } } });
  const job = await broker.submit(input());
  await waitFor(() => probes >= 3); assert.equal(attempts, 0); assert.equal((await broker.get(job.id)).state, 'queued');
  busy = false; assert.equal((await waitJob(broker, job.id)).state, 'completed'); assert.equal(attempts, 1);
});

test('three provider queues run independently while each provider remains FIFO and serial', async t => {
  const gates = new Map();
  const starts = [];
  const active = { telegram: 0, x: 0, instagram: 0 };
  const maxima = { ...active };
  const providers = Object.fromEntries(Object.keys(active).map(name => [name, provider(async ({ jobId }) => {
    active[name]++;
    maxima[name] = Math.max(maxima[name], active[name]);
    starts.push({ name, jobId });
    const gate = deferred();
    gates.set(jobId, gate);
    await gate.promise;
    active[name]--;
    return { count: 1 };
  })]));
  const { broker } = await fixture(t, providers);
  const first = [];
  const second = [];
  for (const name of Object.keys(active)) first.push(await broker.submit({ ...input(), provider: name }));
  for (const name of Object.keys(active)) second.push(await broker.submit({ ...input('second'), provider: name }));
  await waitFor(() => starts.length === 3);
  assert.deepEqual(new Set(starts.map(item => item.name)), new Set(Object.keys(active)));
  for (const job of second) assert.equal((await broker.get(job.id)).state, 'queued');
  gates.get(first[1].id).resolve();
  await waitFor(() => gates.has(second[1].id));
  assert.equal((await broker.get(first[0].id)).state, 'running');
  assert.equal((await broker.get(second[0].id)).state, 'queued');
  for (const job of first) gates.get(job.id).resolve();
  await waitFor(() => second.every(job => gates.has(job.id)));
  for (const job of second) gates.get(job.id).resolve();
  for (const job of [...first, ...second]) assert.equal((await waitJob(broker, job.id)).state, 'completed');
  assert.deepEqual(maxima, { telegram: 1, x: 1, instagram: 1 });
  const status = await waitFor(async () => {
    const value = await broker.status();
    return value.queues.every(queue => queue.running === null && queue.queued === 0) && value;
  });
  assert.equal(status.counts.completed, 6);
  assert.equal(status.queues.every(queue => queue.running === null && queue.queued === 0), true);
});

test('idempotent concurrent submissions execute once, omit raw inputs, and survive reopening', async t => {
  let runs = 0;
  const { broker, stateRoot, outputRoot } = await fixture(t, { telegram: provider(async () => { runs++; return { count: 1 }; }) });
  const request = { ...input('PRIVATE_FIXTURE_QUERY'), idempotencyKey: 'PRIVATE_FIXTURE_IDEMPOTENCY' };
  const jobs = await Promise.all(Array.from({ length: 8 }, () => broker.submit(request)));
  assert.equal(new Set(jobs.map(job => job.id)).size, 1);
  await waitJob(broker, jobs[0].id);
  assert.equal(runs, 1);
  await rejectsCode(() => broker.submit({ ...request, input: { query: 'changed' } }), 'IDEMPOTENCY_CONFLICT');
  const saved = await fs.readFile(path.join(stateRoot, 'jobs', jobs[0].id + '.json'), 'utf8');
  assert.equal(saved.includes('PRIVATE_FIXTURE'), false);
  assert.equal(Object.hasOwn(jobs[0], 'requestHash'), false);
  assert.equal(Object.hasOwn(jobs[0], 'idempotencyHash'), false);
  await broker.close();
  const reopened = await createResearchBroker({ stateRoot, outputRoot, providers: { telegram: provider(async () => { runs++; return { count: 1 }; }) } });
  t.after(() => reopened.close());
  assert.equal((await reopened.submit(request)).id, jobs[0].id);
  assert.equal(runs, 1);
  assert.equal((await reopened.get(jobs[0].id)).state, 'completed');
});

test('a real owned child-process loss interrupts persisted running and queued jobs without replay', async t => {
  const directory = path.join(fixtureRoot, randomUUID());
  await fs.mkdir(directory);
  const stateRoot = path.join(directory, 'state');
  const outputRoot = path.join(directory, 'outputs');
  const ready = path.join(directory, 'child-ready.json');
  const brokerURL = new URL('./broker.mjs', import.meta.url).href;
  const childCode = `import { createResearchBroker } from ${JSON.stringify(brokerURL)};
import * as fs from 'node:fs/promises';
const broker = await createResearchBroker({stateRoot:${JSON.stringify(stateRoot)},outputRoot:${JSON.stringify(outputRoot)},providers:{telegram:{status:async()=>({state:'ready',operations:['search']}),run:async()=>new Promise(()=>{})}}});
const a = await broker.submit({provider:'telegram',operation:'search',input:{query:'SYNTHETIC_LOST_RUNNING'},idempotencyKey:'lost-running'});
const b = await broker.submit({provider:'telegram',operation:'search',input:{query:'SYNTHETIC_LOST_QUEUED'}});
while ((await broker.get(a.id)).state !== 'running') await new Promise(resolve=>setTimeout(resolve,10));
await fs.writeFile(${JSON.stringify(ready)},JSON.stringify([a.id,b.id]));
setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await waitFor(async () => { try { return await fs.stat(ready); } catch { return false; } });
  assert.equal(stderr, '');
  const ids = JSON.parse(await fs.readFile(ready, 'utf8'));
  const exit = once(child, 'exit');
  child.kill();
  await exit;
  let runs = 0;
  const broker = await createResearchBroker({ stateRoot, outputRoot, providers: { telegram: provider(async () => { runs++; return { count: 1 }; }) } });
  t.after(() => broker.close());
  for (const id of ids) {
    const job = await broker.get(id);
    assert.equal(job.state, 'interrupted');
    assert.equal(job.error.code, 'PROCESS_INTERRUPTED');
  }
  assert.equal(runs, 0);
  assert.equal((await broker.submit({ ...input('SYNTHETIC_LOST_RUNNING'), idempotencyKey: 'lost-running' })).id, ids[0]);
  assert.equal(runs, 0);
});

test('running cancellation retains checkpoints, queued cancellation never invokes its provider', async t => {
  const started = deferred();
  let calls = 0;
  let aborted = false;
  const { broker } = await fixture(t, { telegram: provider(async ({ signal, outputDirectory, onCheckpoint }) => {
    calls++;
    await fs.writeFile(path.join(outputDirectory, 'fixture.txt'), 'SYNTHETIC_CONTENT');
    await onCheckpoint({ count: 1, files: ['fixture.txt'], nextCursor: 'fixture:2' });
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return { count: 2 };
  }) });
  const running = await broker.submit(input());
  const queued = await broker.submit(input('cancel queued'));
  await started.promise;
  assert.equal((await broker.cancel(queued.id)).state, 'cancelled');
  const cancelled = await broker.cancel(running.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.result.count, 1);
  assert.equal(cancelled.result.nextCursor, 'fixture:2');
  assert.deepEqual(cancelled.result.files, ['fixture.txt']);
  await waitFor(async () => (await broker.status()).queues[0].running === null);
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.equal((await broker.cancel(running.id)).state, 'cancelled');
});

test('a deadline aborts once; an adapter ignoring abort continues to occupy its provider slot', async t => {
  const gate = deferred();
  let calls = 0;
  let observedAbort = false;
  const { broker } = await fixture(t, { telegram: provider(async ({ signal }) => {
    calls++;
    signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
    if (calls === 1) await gate.promise;
    return { count: 1 };
  }) });
  const first = await broker.submit(input('deadline', { deadlineMs: 1000 }));
  const next = await broker.submit(input('after deadline'));
  const stopped = await waitJob(broker, first.id);
  assert.equal(stopped.state, 'interrupted');
  assert.equal(stopped.error.code, 'DEADLINE_EXCEEDED');
  assert.equal(observedAbort, true);
  assert.equal(calls, 1);
  assert.equal((await broker.get(next.id)).state, 'queued');
  assert.equal((await broker.status()).queues[0].running, first.id);
  gate.resolve();
  assert.equal((await waitJob(broker, next.id)).state, 'completed');
  assert.equal((await broker.get(first.id)).state, 'interrupted');
  assert.equal(calls, 2);
});

test('readiness and provider errors are explicit, compact, and never automatically retried', async t => {
  for (const [code, state] of [['AUTH_REQUIRED', 'auth_required'], ['CHALLENGE_REQUIRED', 'auth_required'], ['RATE_LIMITED', 'rate_limited'], ['UNSUPPORTED', 'failed'], ['PROVIDER_UNAVAILABLE', 'failed'], ['UNKNOWN_FIXTURE_ERROR', 'failed']]) {
    let calls = 0;
    const { broker, stateRoot } = await fixture(t, { telegram: provider(async () => {
      calls++;
      throw Object.assign(new Error('PRIVATE_FIXTURE_ERROR Cookie=never-store'), { code, retryAfterMs: 60000 });
    }) });
    const submitted = await broker.submit(input());
    const job = await waitJob(broker, submitted.id);
    assert.equal(job.state, state);
    assert.equal(job.error.code, code === 'UNKNOWN_FIXTURE_ERROR' ? 'ADAPTER_FAILED' : code);
    assert.equal(job.error.message.includes('PRIVATE_FIXTURE'), false);
    assert.equal(job.error.retryAfterMs, code === 'RATE_LIMITED' ? 60000 : undefined);
    assert.equal((await fs.readFile(path.join(stateRoot, 'jobs', job.id + '.json'), 'utf8')).includes('PRIVATE_FIXTURE_ERROR'), false);
    await pause(25);
    assert.equal(calls, 1);
  }
  for (const state of ['auth_required', 'challenge_required', 'unavailable', 'unsupported']) {
    let called = false;
    const { broker } = await fixture(t, { telegram: { status: async () => ({ state, operations: ['search'] }), run: async () => { called = true; return { count: 0 }; } } });
    const job = await waitJob(broker, (await broker.submit(input())).id);
    assert.equal(called, false);
    assert.equal(['auth_required', 'failed'].includes(job.state), true);
    assert.equal(job.error !== undefined, true);
  }
});

test('a provider failure preserves accepted partial evidence and files', async t => {
  const { broker } = await fixture(t, { telegram: provider(async ({ onCheckpoint, outputDirectory }) => {
    await fs.writeFile(path.join(outputDirectory, 'page.json'), '{"synthetic":true}');
    await onCheckpoint({ count: 3, files: ['page.json'], nextCursor: 'fixture:3', evidence: [{ url: 'https://t.me/fixture/3?single#ignored', kind: 'post', id: '3' }], coverage: 'channel' });
    throw new Error('PRIVATE_FIXTURE_ADAPTER_FAILURE');
  }) });
  const job = await waitJob(broker, (await broker.submit(input())).id);
  assert.equal(job.state, 'partial');
  assert.equal(job.result.outcome, 'partial');
  assert.equal(job.result.count, 3);
  assert.deepEqual(job.result.files, ['page.json']);
  assert.equal(job.result.evidence[0].url, 'https://t.me/fixture/3');
  assert.equal(job.error.code, 'ADAPTER_FAILED');
});

test('compact result count cannot silently regress after an accepted checkpoint', async t => {
  const { broker } = await fixture(t, { telegram: provider(async ({ onCheckpoint }) => {
    await onCheckpoint({ count: 3 });
    return { count: 1 };
  }) });
  const job = await waitJob(broker, (await broker.submit(input())).id);
  assert.equal(job.state, 'partial');
  assert.equal(job.result.count, 3);
  assert.equal(job.error.code, 'INVALID_RESULT');
});

test('provider output has bounded metadata and validates evidence, flags, counts, names and fields', async t => {
  const badResults = [
    { count: -1 }, { count: 101 }, { count: 1.5 }, { count: 0, body: 'do not persist' },
    { count: 0, state: 'auth_required' }, { count: 0, truncated: 'true' }, { count: 0, coverage: 'everything' },
    { count: 0, nextCursor: 'secret=value' }, { count: 0, evidence: [{ url: 'https://example.com/post' }] },
    { count: 0, evidence: [{ url: 'https://t.me/fixture/1', text: 'PRIVATE_FIXTURE_TEXT' }] },
    { count: 0, evidence: [...Array.from({ length: 50 }, (_, i) => ({ url: `https://t.me/fixture/${i + 1}` })), { url: 'https://example.com/hidden-invalid-evidence' }] },
    { count: 0, files: ['../outside.txt'] }, { count: 0, files: ['NUL.txt'] }, { count: 0, files: ['missing.txt'] },
  ];
  for (const result of badResults) {
    const { broker } = await fixture(t, { telegram: provider(async () => result) });
    const job = await waitJob(broker, (await broker.submit(input())).id);
    assert.equal(job.state, 'failed');
    assert.equal(['INVALID_RESULT', 'UNSAFE_PATH'].includes(job.error.code), true);
  }
  const { broker, stateRoot } = await fixture(t, { telegram: provider(async () => ({
    count: 60, state: 'partial', nextCursor: 'fixture:60', truncated: true,
    evidence: Array.from({ length: 60 }, (_, i) => ({ url: `https://t.me/fixture/${i + 1}?single#fragment`, id: String(i + 1) })),
  })) });
  const job = await waitJob(broker, (await broker.submit(input())).id);
  assert.equal(job.result.evidence.length, 50);
  assert.equal(job.result.evidenceTruncated, true);
  assert.equal(job.result.evidence.every(item => !item.url.includes('?') && !item.url.includes('#')), true);
  assert.equal((await fs.stat(path.join(stateRoot, 'jobs', job.id + '.json'))).size < 16384, true);
});

test('invalid requests fail before creating output jobs and normalized limits stay finite', async t => {
  let received;
  const { broker, outputRoot } = await fixture(t, { telegram: provider(async ({ input: value }) => { received = value; return { count: 0 }; }) });
  const invalid = [
    { ...input(), provider: 'unknown' }, { ...input(), operation: 'send' }, { ...input(), token: 'not allowed' },
    input(' '), input('x', { limit: 1001 }), input('x', { pageSize: 101 }), input('x', { deadlineMs: 999 }),
    input('x', { cursor: 'Cookie=value' }), input('x', { accountSession: 'not allowed' }),
    { provider: 'x', operation: 'read', input: { url: 'https://instagram.com/p/fixture/' } },
    { provider: 'telegram', operation: 'read', input: { url: 'http://t.me/fixture/1' } },
    { provider: 'telegram', operation: 'read', input: { url: 'https://user:pass@telegram.example.invalid/fixture/1' } },
    { provider: 'telegram', operation: 'read', input: { url: 'https://t.me/fixture/1?token=secret' } },
    { provider: 'telegram', operation: 'download', input: { url: 'https://t.me/fixture/1', urls: ['https://t.me/fixture/1'] } },
  ];
  for (const request of invalid) await rejectsCode(() => broker.submit(request), 'INVALID_REQUEST');
  assert.deepEqual(await fs.readdir(outputRoot), []);
  const job = await broker.submit(input('  normalized  ', { limit: 3, pageSize: 100 }));
  await waitJob(broker, job.id);
  assert.deepEqual({ ...received, deadlineMs: 120000 }, { query: 'normalized', limit: 3, pageSize: 3, deadlineMs: 120000 });
  assert.ok(received.deadlineMs > 0 && received.deadlineMs <= 120000);
  assert.equal(job.limits.deadlineMs, 120000);
});

test('queue capacity rejects the sixty-fifth active job without starting parallel work', async t => {
  const gate = deferred();
  const { broker } = await fixture(t, { telegram: provider(async () => { await gate.promise; return { count: 0 }; }) });
  const jobs = [];
  for (let index = 0; index < 64; index++) jobs.push(await broker.submit(input('capacity ' + index)));
  await rejectsCode(() => broker.submit(input('over capacity')), 'QUEUE_LIMIT');
  for (const job of jobs) await broker.cancel(job.id);
  gate.resolve();
  await waitFor(async () => (await broker.status()).queues[0].running === null);
  assert.equal((await broker.status()).counts.cancelled, 64);
});

test('Instagram channel history accepts Unicode hashtags without admitting them to other providers', async t => {
  let received;
  const { broker } = await fixture(t, { instagram: provider(async ({ input: value }) => { received = value.channel; return { count: 0 }; }) });
  const request = { provider: 'instagram', operation: 'channel_history', input: { channel: '#современный_UI123' } };
  const job = await waitJob(broker, (await broker.submit(request)).id);
  assert.equal(job.state, 'completed');
  assert.equal(received, '#современный_UI123');
  for (const name of ['telegram', 'x']) await rejectsCode(() => broker.submit({ ...request, provider: name }), 'INVALID_REQUEST');
  for (const tag of ['#', '#' + 'a'.repeat(101), '#bad-tag', '#tag/other', '#emoji🎨']) {
    await rejectsCode(() => broker.submit({ ...request, input: { channel: tag } }), 'INVALID_REQUEST');
  }
});

test('a capability probe and concurrent submit share one readiness check without caching fake ready', async t => {
  const gate = deferred();
  let probing = false;
  let probes = 0;
  let runs = 0;
  const { broker } = await fixture(t, { x: {
    status: async () => {
      probes++;
      if (probing) return { state: 'unavailable', operations: [] };
      probing = true;
      await gate.promise;
      probing = false;
      return { state: 'ready', operations: ['search'] };
    },
    run: async () => { runs++; return { count: 1 }; },
  } });
  const capability = broker.capabilities();
  await waitFor(() => probing);
  const submitted = await broker.submit({ ...input('concurrent capability'), provider: 'x' });
  await pause(30);
  assert.equal((await broker.get(submitted.id)).state, 'queued');
  assert.equal(probes, 1);
  gate.resolve();
  assert.equal((await capability).providers.find(item => item.provider === 'x').state, 'ready');
  assert.equal((await waitJob(broker, submitted.id)).state, 'completed');
  assert.equal(runs, 1);
  await waitFor(async () => (await broker.capabilities()).providers.find(item => item.provider === 'x').state === 'ready');
  assert.equal(probes, 2);
});

test('capability requests do not queue provider status probes behind an active job', async t => {
  const gate = deferred();
  let probes = 0;
  const { broker } = await fixture(t, { telegram: {
    status: async () => { probes++; return { state: 'ready', operations: ['search'] }; },
    run: async () => { await gate.promise; return { count: 1 }; },
  } });
  const job = await broker.submit(input('busy provider capability'));
  await waitFor(async () => (await broker.get(job.id)).state === 'running');
  const during = await broker.capabilities();
  assert.equal(probes, 1);
  assert.equal(during.providers.find(item => item.provider === 'telegram').state, 'unavailable');
  gate.resolve();
  await waitJob(broker, job.id);
  await waitFor(async () => (await broker.status()).queues[0].running === null);
  assert.equal((await broker.capabilities()).providers.find(item => item.provider === 'telegram').state, 'ready');
  assert.equal(probes > 1, true);
});

test('storage rejects overlapping roots, a second live owner, malformed metadata and unrecognized locks', async t => {
  const { broker, stateRoot, outputRoot, directory } = await fixture(t);
  await rejectsCode(() => createResearchBroker({ stateRoot, outputRoot: path.join(stateRoot, 'outputs') }), 'UNSAFE_PATH');
  await rejectsCode(() => createResearchBroker({ stateRoot, outputRoot }), 'STATE_BUSY');
  await broker.close();
  const id = randomUUID();
  await fs.writeFile(path.join(stateRoot, 'jobs', id + '.json'), '{"invalid":"metadata"}');
  await rejectsCode(() => createResearchBroker({ stateRoot, outputRoot }), 'INVALID_STATE');
  const unknownRoot = path.join(directory, 'unknown-owner');
  await fs.mkdir(unknownRoot);
  const lock = path.join(unknownRoot, 'broker.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'unrecognized' }));
  await rejectsCode(() => createResearchBroker({ stateRoot: unknownRoot, outputRoot }), 'STATE_BUSY');
  assert.equal((await fs.readFile(lock, 'utf8')).includes('unrecognized'), true);
});

test('a junction in storage or reported output, and a hard-linked file, are refused', async t => {
  const { broker, directory, stateRoot } = await fixture(t);
  await broker.close();
  const actual = path.join(directory, 'actual');
  const junction = path.join(directory, 'junction');
  await fs.mkdir(actual);
  await fs.symlink(actual, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await rejectsCode(() => createResearchBroker({ stateRoot: junction, outputRoot: path.join(directory, 'other-output') }), 'UNSAFE_PATH');
  await rejectsCode(() => createResearchBroker({ stateRoot, outputRoot: junction }), 'UNSAFE_PATH');
  const original = path.join(actual, 'original.txt');
  const alias = path.join(actual, 'alias.txt');
  await fs.writeFile(original, 'SYNTHETIC_FILE');
  await fs.link(original, alias);
  await rejectsCode(() => inspectOutputFiles(actual, ['alias.txt']), 'UNSAFE_PATH');
  const outputFixture = await fixture(t, { telegram: provider(async ({ outputDirectory }) => {
    await fs.symlink(actual, path.join(outputDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    return { count: 1, files: ['linked'] };
  }) });
  assert.equal((await waitJob(outputFixture.broker, (await outputFixture.broker.submit(input())).id)).error.code, 'UNSAFE_PATH');
  for (const bad of ['../file', 'file/name', 'C:\\file', 'NUL', 'con.txt', 'file.', '', '.hidden']) assert.equal(safeOutputName(bad), false);
});

test('replacing the owned output directory during a job fails its original identity check', async t => {
  const { broker } = await fixture(t, { telegram: provider(async ({ outputDirectory }) => {
    await fs.rename(outputDirectory, outputDirectory + '-moved-fixture');
    await fs.mkdir(outputDirectory);
    await fs.writeFile(path.join(outputDirectory, 'replaced.txt'), 'SYNTHETIC_REPLACEMENT');
    return { count: 1, files: ['replaced.txt'] };
  }) });
  const job = await waitJob(broker, (await broker.submit(input())).id);
  assert.equal(job.state, 'failed');
  assert.equal(job.error.code, 'UNSAFE_PATH');
});

test('persisted invalid normalized limits are rejected on reopening', async t => {
  const { broker, stateRoot, outputRoot } = await fixture(t, { telegram: provider(async () => ({ count: 0 })) });
  const job = await waitJob(broker, (await broker.submit(input('metadata', { limit: 1, pageSize: 1 }))).id);
  await broker.close();
  const location = path.join(stateRoot, 'jobs', job.id + '.json');
  const metadata = JSON.parse(await fs.readFile(location, 'utf8'));
  metadata.limits.pageSize = 2;
  await fs.writeFile(location, JSON.stringify(metadata));
  await rejectsCode(() => createResearchBroker({ stateRoot, outputRoot }), 'INVALID_STATE');
});

test('close interrupts its running job and cancels queued work while preserving output data', async t => {
  const started = deferred();
  let runs = 0;
  const { broker } = await fixture(t, { telegram: provider(async ({ signal, outputDirectory, onCheckpoint }) => {
    runs++;
    await fs.writeFile(path.join(outputDirectory, 'kept.txt'), 'SYNTHETIC_KEPT_OUTPUT');
    await onCheckpoint({ count: 1, files: ['kept.txt'] });
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { count: 1 };
  }) });
  const first = await broker.submit(input());
  const second = await broker.submit(input('close queued'));
  await started.promise;
  const closed = await broker.close();
  assert.deepEqual(closed, { closed: true, pendingProviders: [] });
  assert.equal((await broker.get(first.id)).state, 'interrupted');
  assert.equal((await broker.get(second.id)).state, 'cancelled');
  assert.equal((await fs.readFile(path.join(first.outputDirectory, 'kept.txt'), 'utf8')), 'SYNTHETIC_KEPT_OUTPUT');
  assert.equal(runs, 1);
  await rejectsCode(() => broker.submit(input()), 'BROKER_CLOSED');
});
