import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { RESEARCH_TOOLS, createResearchDispatcher, runResearchStdio, validateResearchArguments } from './mcp.mjs';
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (name, args = {}, id = 3) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('discovery negotiates without launching providers and requires initialization', async () => {
  let connections = 0;
  const dispatch = createResearchDispatcher({ connect: async () => { connections++; throw new Error(); } });
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).error.code, -32002);
  assert.equal((await dispatch(init)).result.protocolVersion, '2025-11-25');
  assert.equal(await dispatch(initialized), undefined);
  const listed = (await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
  assert.equal(listed.length, 8);
  assert.ok(listed.every(tool => !Object.hasOwn(tool, 'method')));
  assert.equal(connections, 0);
  assert.equal((await dispatch(init)).error.code, -32600);
});

test('nested schema rejects unknown credential fields and contradictory source forms', () => {
  const schema = RESEARCH_TOOLS.find(tool => tool.name === 'social_submit').inputSchema;
  const valid = { provider: 'x', operation: 'read', input: { url: 'https://x.com/example/status/1' } };
  assert.equal(validateResearchArguments(schema, valid), true);
  assert.equal(validateResearchArguments(schema, { ...valid, token: 'fixture' }), false);
  assert.equal(validateResearchArguments(schema, { ...valid, input: { ...valid.input, password: 'fixture' } }), false);
  assert.equal(validateResearchArguments(schema, { ...valid, input: { ...valid.input, urls: [valid.input.url] } }), false);
  assert.equal(validateResearchArguments(schema, { ...valid, input: { ...valid.input, deadlineMs: 300001 } }), false);
  assert.equal(validateResearchArguments(schema, { ...valid, input: { urls: [] } }), false);
});

test('operation contracts distinguish platform modes, exact conversations and membership', () => {
  const schema = RESEARCH_TOOLS.find(tool => tool.name === 'social_submit').inputSchema;
  assert.equal(validateResearchArguments(schema, { provider: 'x', operation: 'article', input: { url: 'https://x.com/fixture/status/1' } }), true);
  assert.equal(validateResearchArguments(schema, { provider: 'telegram', operation: 'article', input: { url: 'https://t.me/fixture/1' } }), false);
  assert.equal(validateResearchArguments(schema, { provider: 'instagram', operation: 'profile', input: { channel: '@fixture' } }), true);
  assert.equal(validateResearchArguments(schema, { provider: 'telegram', operation: 'profile', input: { channel: '@fixture' } }), false);
  assert.equal(validateResearchArguments(schema, { provider: 'telegram', operation: 'join_chat', input: { channel: '@fixture' } }), false);
  assert.equal(validateResearchArguments(schema, { provider: 'x', operation: 'read_thread', input: { urls: ['https://x.com/messages/1-2'] } }), false);
  assert.equal(validateResearchArguments(schema, { provider: 'telegram', operation: 'transcribe', input: { url: 'https://t.me/fixture/1', language: 'ru', limit: 20 } }), true);
  assert.equal(validateResearchArguments(schema, { provider: 'telegram', operation: 'transcribe', input: { url: 'https://t.me/fixture/1', language: 'ru', limit: 21 } }), false);
  for (const includeReplies of [false, true]) {
    assert.equal(validateResearchArguments(schema, { provider: 'telegram', operation: 'read', input: { url: 'https://t.me/fixture/1', includeReplies } }), false);
    assert.equal(validateResearchArguments(schema, { provider: 'x', operation: 'read', input: { url: 'https://x.com/fixture/status/1', includeReplies } }), true);
  }
});

test('invalid request identities are null in errors and initialization validates client contract', async () => {
  const dispatch = createResearchDispatcher();
  assert.equal((await dispatch({ jsonrpc: '2.0', id: { fixture: true }, method: 'ping' })).id, null);
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).error.code, -32602);
  assert.equal((await dispatch(init)).result.serverInfo.name, 'egoist-social');
});

test('submission returns an exact async job, get/cancel are routed by stable identity', async () => {
  const seen = [];
  const jobId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dispatch = createResearchDispatcher({ connect: async () => ({ call: async (method, args) => { seen.push({ method, args }); return { id: jobId, state: method === 'cancel' ? 'cancelled' : 'queued' }; } }) });
  await dispatch(init); await dispatch(initialized);
  const request = { provider: 'telegram', operation: 'search', input: { query: 'fixture', limit: 10 }, idempotencyKey: 'fixture-key' };
  const submitted = (await dispatch(call('social_submit', request))).result;
  assert.equal(submitted.isError, false);
  assert.deepEqual(JSON.parse(submitted.content[0].text), submitted.structuredContent);
  assert.equal(submitted.structuredContent.state, 'queued');
  await dispatch(call('social_job', { jobId }, 4));
  await dispatch(call('social_cancel', { jobId }, 5));
  assert.deepEqual(seen.map(item => item.method), ['submit', 'get', 'cancel']);
  assert.deepEqual(seen[1].args, { jobId });
});

test('provider denial stays a tool error with no raw secret-like failure text', async () => {
  const dispatch = createResearchDispatcher({ connect: async () => ({ call: async () => { throw Object.assign(new Error('fixture-private-error-content'), { code: 'AUTH_REQUIRED' }); } }) });
  await dispatch(init); await dispatch(initialized);
  const result = (await dispatch(call('social_capabilities'))).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'AUTH_REQUIRED');
  assert.equal(JSON.stringify(result).includes('fixture-private-error-content'), false);
  assert.equal((await dispatch(call('unknown'))).error.code, -32602);
});

test('stdio emits protocol only, tolerates bad JSON and does not close shared daemon on EOF', async () => {
  let output = '';
  let daemonCalls = 0;
  const dispatch = createResearchDispatcher({ connect: async () => ({ call: async () => { daemonCalls++; return { providers: [] }; } }) });
  const lines = ['{invalid', JSON.stringify(init), JSON.stringify(initialized), JSON.stringify(call('social_capabilities'))].join('\n') + '\n';
  await runResearchStdio({ input: Readable.from([lines.slice(0, 30), lines.slice(30)]), output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }), dispatch });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[2].result.isError, false);
  assert.equal(daemonCalls, 1);
});

test('oversized unframed input terminates at the aggregate bound', async () => {
  let output = '';
  await runResearchStdio({ input: Readable.from([Buffer.alloc(262145, 120)]), output: new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } }) });
  assert.equal(JSON.parse(output).error.code, -32600);
});
