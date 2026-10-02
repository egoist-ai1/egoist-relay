import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listenResearchDaemon, callResearchDaemon } from './ipc.mjs';

const token = 'a'.repeat(64);
async function fixture(t, broker, onShutdown) {
  if (process.platform !== 'win32' && !process.env.EGOIST_RESEARCH_TEST_WORK) throw new Error('Owned test work is required.');
  const pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\EgoistResearchFixture-' + randomUUID() : join(process.env.EGOIST_RESEARCH_TEST_WORK, 'ipc-' + randomUUID() + '.sock');
  const listener = await listenResearchDaemon({ broker, pipePath, token, sourceHash: 'fixture-hash', onShutdown });
  t.after(() => listener.close());
  return { pipePath, invoke: (method, params = {}) => callResearchDaemon({ pipePath, token, method, params, timeoutMs: 2000 }) };
}
const idle = () => ({ counts: { queued: 0, running: 0 }, queues: [{ provider: 'x', queued: 0, running: null }] });
const broker = (extra = {}) => ({ status: async () => idle(), capabilities: async () => ({ providers: [] }), submit: async params => params, get: async jobId => ({ id: jobId }), cancel: async jobId => ({ id: jobId, state: 'cancelled' }), ...extra });

test('named-pipe routes strict requests and rejects unknown parameters', async t => {
  const { invoke } = await fixture(t, broker());
  const status = await invoke('status');
  assert.equal(status.daemon.relay_process_dependency, true);
  assert.equal(status.daemon.accountSource, 'relay_owned_bridge');
  assert.deepEqual(await invoke('get', { jobId: 'fixture-id' }), { id: 'fixture-id' });
  await assert.rejects(invoke('get', { jobId: 'fixture-id', token: 'unknown' }), { code: 'INVALID_INPUT' });
  await assert.rejects(invoke('status', { arbitrary: true }), { code: 'INVALID_INPUT' });
});

test('malformed Unicode and wrong tokens cannot crash the authenticated daemon', async t => {
  const { pipePath, invoke } = await fixture(t, broker());
  for (const bad of ['é'.repeat(64), 'b'.repeat(64)]) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      socket.once('error', reject);
      socket.once('connect', () => socket.end(JSON.stringify({ id: 'fixture', token: bad, method: 'status' }) + '\n'));
      socket.on('data', () => reject(new Error('Unauthorized request returned data.')));
      socket.once('close', resolve);
    });
  }
  assert.ok((await invoke('status')).broker);
});

test('shutdown rejects terminal jobs whose adapter still holds the platform queue', async t => {
  let active = true;
  let stopped = false;
  const { invoke } = await fixture(t, broker({ status: async () => ({ counts: { queued: 0, running: 0 }, queues: [{ provider: 'x', queued: 0, running: active ? 'fixture-active' : null }] }) }), () => { stopped = true; });
  await assert.rejects(invoke('shutdown'), { code: 'BUSY' });
  assert.equal(stopped, false);
  active = false;
  assert.equal((await invoke('shutdown')).relay_left_running, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);
  await assert.rejects(invoke('submit', {}), { code: 'BUSY' });
});

test('shutdown cannot race an in-flight durable submission', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { invoke } = await fixture(t, broker({ submit: async () => { await pending; return { id: 'fixture-job' }; } }));
  const submitted = invoke('submit', {});
  await new Promise(resolve => setTimeout(resolve, 40));
  await assert.rejects(invoke('shutdown'), { code: 'BUSY' });
  release();
  assert.equal((await submitted).id, 'fixture-job');
});

test('oversized response becomes a typed error and raw adapter errors are omitted', async t => {
  const { invoke } = await fixture(t, broker({ capabilities: async () => ({ data: 'x'.repeat(262144) }), get: async () => { throw Object.assign(new Error('fixture-sensitive'), { code: 'UNKNOWN_RAW' }); } }));
  await assert.rejects(invoke('capabilities'), { code: 'RESEARCH_FRAME_TOO_LARGE' });
  await assert.rejects(invoke('get', { jobId: 'fixture' }), error => error.code === 'RESEARCH_OPERATION_FAILED' && !error.message.includes('fixture-sensitive'));
});

test('group membership is available only through the separate exact-target route', async t => {
  const { invoke } = await fixture(t, broker());
  await assert.rejects(invoke('submit', { provider: 'telegram', operation: 'join_chat', input: { channel: '@synthetic' } }), { code: 'INVALID_INPUT' });
  const result = await invoke('submit_join', { channel: '@synthetic', idempotencyKey: 'one-selected-group' });
  assert.deepEqual(result, { provider: 'telegram', operation: 'join_chat', input: { channel: '@synthetic', confirmedJoin: true, limit: 1, pageSize: 1, deadlineMs: 120000 }, idempotencyKey: 'one-selected-group' });
  await assert.rejects(invoke('submit_join', { channel: '@synthetic', discoverAndJoinAll: true }), { code: 'INVALID_INPUT' });
});

test('a daemon pipe squatter receives only a challenge, never the token or private input', async t => {
  const pipePath = '\\\\.\\pipe\\EgoistSocialSquatterFixture-' + randomUUID();
  const seen = [];
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', chunk => {
      const request = JSON.parse(chunk.toString()); seen.push(request);
      socket.end(JSON.stringify({ id: request.id, hello: { nonce: 'c'.repeat(64), pid: 1, sourceHash: 'fake', proof: 'd'.repeat(64) } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(pipePath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(callResearchDaemon({ pipePath, token, method: 'submit', params: { privateSynthetic: 'selected-source' } }), { code: 'DAEMON_SERVER_UNCONFIRMED' });
  assert.equal(seen.length, 1); assert.equal(seen[0].method, 'hello');
  assert.equal(JSON.stringify(seen).includes(token), false);
  assert.equal(JSON.stringify(seen).includes('selected-source'), false);
});
