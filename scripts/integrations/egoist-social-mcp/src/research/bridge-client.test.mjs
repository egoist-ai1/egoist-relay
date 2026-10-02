import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRelayBridgeClient } from './bridge-client.mjs';
const token = 'a'.repeat(64);
const sign = value => createHmac('sha256', token).update(value).digest('hex');
async function fixture(t, respond, { badProof = false, metadataChanged = false } = {}) {
  const metadata = { runtimeId: randomUUID(), appPid: 42, helperPid: 43, pipePath: '\\\\.\\pipe\\EgoistSocialBridgeFixture-' + randomUUID() };
  const requests = [];
  const peers = new Set();
  const server = net.createServer(socket => {
    const nonce = randomBytes(32).toString('hex');
    peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
    let buffer = ''; let hello;
    const emit = event => socket.write(JSON.stringify({ id: hello.id, event }) + '\n');
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'); const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        requests.push(request);
        if (!hello) {
          hello = request;
          emit({ kind: 'hello', ...metadata, nonce, challenge: hello.challenge, proof: badProof ? 'b'.repeat(64) : sign(`${hello.id}\n${hello.challenge}\n${nonce}\n${metadata.runtimeId}\n42\n43`) });
        } else {
          assert.equal(request.mac, sign(`${hello.id}\n${hello.challenge}\n${nonce}\n${metadata.runtimeId}\n${request.method}\n${JSON.stringify(request.params)}`));
          void Promise.resolve(respond({ request, socket, emit, metadata })).catch(() => socket.destroy());
        }
      }
    });
  });
  await new Promise(resolve => server.listen(metadata.pipePath, resolve));
  let reads = 0; let verified = 0;
  const client = createRelayBridgeClient({}, { readMetadata: async () => ({ metadata: metadataChanged && ++reads > 1 ? { ...metadata, runtimeId: randomUUID() } : metadata, token }), verifyProcess: async () => { verified++; } });
  t.after(async () => { await client.close(); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, requests, verified: () => verified };
}
test('actual named pipe proves server before sending a MAC request; no bearer leaves client', async t => {
  const f = await fixture(t, ({ emit, metadata }) => emit({ kind: 'status', runtimeId: metadata.runtimeId, providers: [] }));
  const [a, b] = await Promise.all([f.client.status(), f.client.status()]);
  assert.deepEqual(a, b); assert.equal(f.verified(), 1); assert.deepEqual(f.requests.map(x => x.method), ['hello', 'status']);
  assert.equal(JSON.stringify(f.requests).includes(token), false);
});
test('unproved pipe cannot receive an operation or private request input', async t => {
  const f = await fixture(t, () => { throw new Error('Must not run'); }, { badProof: true });
  await assert.rejects(f.client.call('run', { input: { query: 'synthetic-private' } }), { code: 'BRIDGE_SERVER_UNCONFIRMED' });
  assert.equal(f.requests.length, 1); assert.equal(JSON.stringify(f.requests).includes('synthetic-private'), false);
});
test('accepted stream waits for artifact backpressure before terminal settlement', async t => {
  const f = await fixture(t, ({ emit }) => { emit({ kind: 'records', records: [{ id: '1' }] }); emit({ kind: 'done', outcome: 'results', count: 1 }); });
  const seen = [];
  await f.client.call('run', { input: { deadlineMs: 1000 } }, { onEvent: async event => { if (event.kind === 'records') await new Promise(resolve => setTimeout(resolve, 30)); seen.push(event.kind); } });
  assert.deepEqual(seen, ['records', 'done']);
});
test('changed app runtime rejects completion and retains accepted callback events', async t => {
  const f = await fixture(t, ({ emit }) => emit({ kind: 'done', outcome: 'empty', count: 0 }), { metadataChanged: true });
  let accepted = 0;
  await assert.rejects(f.client.call('run', {}, { onEvent: async () => { accepted++; } }), { code: 'BRIDGE_RUNTIME_CHANGED' });
  assert.equal(accepted, 1);
});
test('EOF after records is a failure; callbacks are completed before rejecting', async t => {
  const f = await fixture(t, ({ emit, socket }) => { emit({ kind: 'records', records: [{ id: '1' }] }); socket.end(); });
  let accepted = false;
  await assert.rejects(f.client.call('run', {}, { onEvent: async () => { await new Promise(resolve => setTimeout(resolve, 20)); accepted = true; } }), { code: 'BRIDGE_REPLY_LOST' });
  assert.equal(accepted, true);
});
test('invalid UTF-8 cannot become replacement-character source content', async t => {
  const f = await fixture(t, ({ socket, request }) => socket.write(Buffer.concat([Buffer.from(`{"id":"${request.id}","event":{"kind":"records","text":"`), Buffer.from([0xff]), Buffer.from('"}}\n')])));
  await assert.rejects(f.client.call('run', {}), { code: 'BRIDGE_PROTOCOL_INVALID' });
});

test('native run readiness binds the selected account without terminating the event stream', async t => {
  const expectedAccount = { accountRef: 'fixture-account', accountEpoch: 'A' };
  const f = await fixture(t, ({ emit, metadata }) => {
    emit({ kind: 'status', runtimeId: metadata.runtimeId, providers: [{ provider: 'telegram', state: 'ready', ...expectedAccount }] });
    emit({ kind: 'scope', ...expectedAccount }); emit({ kind: 'done', outcome: 'empty', count: 0 });
  });
  const seen = [];
  await f.client.call('run', { provider: 'telegram', expectedAccount }, { onEvent: async event => seen.push(event.kind) });
  assert.deepEqual(seen, ['status', 'scope', 'done']);
});
