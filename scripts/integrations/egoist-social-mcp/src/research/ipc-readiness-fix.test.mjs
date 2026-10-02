import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createResearchBroker } from './broker.mjs';
import { JobStore, assertSafeDirectory } from './job-store.mjs';
import { listenResearchDaemon, callResearchDaemon } from './ipc.mjs';

const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work) || path.basename(path.resolve(work)).toLowerCase() !== 'work') throw Error('Explicit own task work required');
const token = 'a'.repeat(64), sourceHash = 'synthetic-readiness-source';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = { state: 'ready', operations: ['search', 'join_chat'], accountRef: 'synthetic-account', accountEpoch: 'synthetic-epoch' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const request = query => ({ provider: 'x', operation: 'search', input: { query, deadlineMs: 3000 } });
async function waitFor(check, milliseconds = 3000) { const end = Date.now() + milliseconds; while (Date.now() < end) { const value = await check(); if (value) return value; await pause(5); } throw Error('Bounded IPC fixture deadline'); }
async function fixture(t, status, run = async () => ({ count: 1, coverage: 'platform_search' })) {
  const directory = path.join(work, 'ipc-readiness-fix-' + randomUUID()); await assertSafeDirectory(directory, { create: true });
  const stateRoot = path.join(directory, 'state'), outputRoot = path.join(directory, 'outputs');
  const provider = { requiresAccountBinding: true, status, run };
  const broker = await createResearchBroker({ stateRoot, outputRoot, providers: { x: provider, telegram: provider } });
  const pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\EgoistReadinessFixture-' + randomUUID() : path.join(directory, 'ipc.sock');
  const listener = await listenResearchDaemon({ broker, pipePath, token, sourceHash });
  let disconnected = 0; listener.server.on('connection', socket => socket.once('close', () => { disconnected++; }));
  t.after(async () => { await listener.close(); await broker.close(); });
  return { broker, provider, directory, stateRoot, outputRoot, listener, pipePath, disconnected: () => disconnected,
    invoke: (method, params = {}, timeoutMs = 2000) => callResearchDaemon({ pipePath, token, method, params, timeoutMs }),
    stored: async () => (await fs.readdir(path.join(stateRoot, 'jobs'))).filter(name => name.endsWith('.json')) };
}

test('authenticated client timeout while proof waits leaves zero job, output and source runs after late ready', async t => {
  const gate = deferred(); let calls = 0, runs = 0;
  const f = await fixture(t, async () => { calls++; return gate.promise; }, async () => { runs++; return { count: 1 }; });
  await assert.rejects(f.invoke('submit', request('disconnect proof'), 80), { code: 'DAEMON_TIMEOUT' });
  assert.ok(calls > 0); await waitFor(() => f.disconnected() === 1); gate.resolve(ready); await pause(100);
  assert.deepEqual(await f.stored(), []); assert.deepEqual(await fs.readdir(f.outputRoot), []); assert.equal(runs, 0);
});

test('disconnected serialized tail cannot create a late ID while the prior authenticated caller succeeds', async t => {
  const gate = deferred(); let calls = 0, runs = 0;
  const f = await fixture(t, async () => { calls++; return gate.promise; }, async () => { runs++; return { count: 1, coverage: 'platform_search' }; });
  const first = f.invoke('submit', { ...request('first selected source'), idempotencyKey: 'first-synthetic-submit' });
  await waitFor(() => calls > 0);
  await assert.rejects(f.invoke('submit', request('abandoned second source'), 50), { code: 'DAEMON_TIMEOUT' });
  await pause(30); gate.resolve(ready); const job = await first;
  await waitFor(async () => (await f.broker.get(job.id)).state === 'completed');
  assert.equal((await f.stored()).length, 1); assert.equal(runs, 1);
});

test('disconnect during irreversible save remains durable and exact idempotency readback prevents duplicate source', async t => {
  const entered = deferred(), release = deferred(); let runs = 0;
  const f = await fixture(t, async () => ready, async () => { runs++; return { count: 1, coverage: 'platform_search' }; });
  const original = JobStore.prototype.save; let held = false;
  JobStore.prototype.save = async function (job) {
    if (this.stateRoot === f.stateRoot && !held && job.state === 'queued') { held = true; entered.resolve(); await release.promise; }
    return original.call(this, job);
  };
  t.after(() => { JobStore.prototype.save = original; release.resolve(); });
  const selected = { ...request('durable selected source'), idempotencyKey: 'durable-synthetic-readiness' };
  const checked = assert.rejects(f.invoke('submit', selected, 80), { code: 'DAEMON_TIMEOUT' });
  await entered.promise; await checked; release.resolve();
  await waitFor(async () => (await f.stored()).length === 1);
  const readback = await f.invoke('submit', selected);
  await waitFor(async () => (await f.broker.get(readback.id)).state === 'completed');
  assert.equal((await f.stored()).length, 1); assert.equal(runs, 1);
});

test('authenticated submit_join forwards pre-commit disconnect without changing exact human-selected mutation route', async t => {
  const gate = deferred(); let runs = 0;
  const f = await fixture(t, async () => gate.promise, async () => { runs++; return { count: 1 }; });
  await assert.rejects(f.invoke('submit_join', { channel: '@synthetic_selected', deadlineMs: 3000 }, 50), { code: 'DAEMON_TIMEOUT' });
  await waitFor(() => f.disconnected() === 1); gate.resolve(ready); await pause(100); assert.deepEqual(await f.stored(), []); assert.equal(runs, 0);
});

test('invalid authenticated MAC and unauthenticated disconnect cannot call submit or cancel another accepted job', async t => {
  let runs = 0;
  const f = await fixture(t, async () => ready, async () => { runs++; return { count: 1, coverage: 'platform_search' }; });
  const accepted = await f.invoke('submit', request('authenticated source'));
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(f.pipePath); socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ id: 'synthetic-mac', challenge: 'b'.repeat(64), method: 'hello' }) + '\n'));
    socket.once('data', chunk => {
      const hello = JSON.parse(chunk.toString()).hello;
      const params = request('forged selected source');
      const wrong = createHmac('sha256', 'c'.repeat(64)).update(`synthetic-mac\n${'b'.repeat(64)}\n${hello.nonce}\nsubmit\n${JSON.stringify(params)}`).digest('hex');
      socket.end(JSON.stringify({ id: 'synthetic-mac', challenge: 'b'.repeat(64), method: 'submit', params, mac: wrong }) + '\n');
    });
    socket.once('close', resolve);
  });
  await waitFor(async () => (await f.broker.get(accepted.id)).state === 'completed');
  assert.equal((await f.stored()).length, 1); assert.equal(runs, 1);
});
