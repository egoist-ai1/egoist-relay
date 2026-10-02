import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { setImmediate as yieldTurn } from 'node:timers/promises';
const { createResearchDispatcher, runResearchStdio } = await import(process.env.EGOIST_AUDIT_MCP_MODULE ?? './mcp.mjs');
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'independent-review', version: '1' } } };
const notice = { jsonrpc: '2.0', method: 'notifications/initialized' };
const selected = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const other = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ready = async dispatch => { await dispatch(init); await dispatch(notice); return dispatch; };
const call = args => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'social_index_jobs', arguments: args } });
const lines = count => Array.from({ length: count }, (_, i) => JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' })).join('\n') + '\n';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, max = 1000) { const end = Date.now() + max; while (!predicate()) { if (Date.now() >= end) throw new Error('Owned stream fixture did not reach expected state'); await pause(1); } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('mismatched accepted get reply cannot index an unselected job', async () => {
  let touched = 0;
  const dispatch = await ready(createResearchDispatcher({ connect: async () => ({ call: async () => ({ id: other, state: 'completed', result: { count: 1 } }) }), readConfig: async () => ({ stateRoot: 'C:/synthetic-state', outputRoot: 'C:/synthetic-output' }), createIndex: () => ({ indexJobs: async () => { touched++; return { state: 'indexed' }; } }) }));
  const reply = await dispatch(call({ jobIds: [selected] }));
  assert.equal(reply.result.isError, true); assert.equal(reply.result.structuredContent.code, 'INVALID_CORPUS'); assert.equal(touched, 0);
});

test('backpressure waits for the first write callback and drain before processing another input frame', async () => {
  const first = deferred(), release = deferred(); let dispatches = 0, writes = 0;
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { writes++; if (writes === 1) { first.resolve(); release.promise.then(() => callback()); } else callback(); } });
  const run = runResearchStdio({ input: Readable.from([lines(3)]), output, dispatch: async request => { dispatches++; return { jsonrpc: '2.0', id: request.id, result: { large: 'x'.repeat(4096) } }; }, outputDeadlineMs: 5000 });
  try { await first.promise; await pause(20); assert.equal(dispatches, 1); assert.equal(writes, 1); assert.ok(output.writableLength <= 8192); }
  finally { release.resolve(); await run; output.destroy(); }
  assert.equal(dispatches, 3); assert.equal(writes, 3);
  await yieldTurn(); for (const event of ['drain', 'error', 'close']) assert.equal(output.listenerCount(event), 0);
});

test('a successful write callback still waits for an independently required drain', async () => {
  // Minimal stream-shaped fixture covers callback/drain ordering without account access.
  const { EventEmitter } = await import('node:events');
  const output = new EventEmitter(); output.destroyed = false; output.writableEnded = false;
  let dispatches = 0, callbacks = 0, blocked;
  output.write = (frame, callback) => { callbacks++; callback(); if (callbacks === 1) { blocked = true; return false; } return true; };
  output.destroy = () => { output.destroyed = true; output.emit('close'); };
  const run = runResearchStdio({ input: Readable.from([lines(2)]), output, dispatch: async request => { dispatches++; return { id: request.id, result: {} }; }, outputDeadlineMs: 1000 });
  try { await until(() => blocked); await pause(15); assert.equal(dispatches, 1); }
  finally { output.emit('drain'); await run; }
  assert.equal(dispatches, 2); await yieldTurn(); for (const event of ['drain', 'error', 'close']) assert.equal(output.listenerCount(event), 0);
});

test('closed output stops finitely and never dispatches the next buffered request', async () => {
  const first = deferred(); let dispatches = 0;
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { first.resolve(); } });
  const run = runResearchStdio({ input: Readable.from([lines(2)]), output, dispatch: async request => { dispatches++; return { id: request.id, result: {} }; }, outputDeadlineMs: 1000 });
  const rejected = assert.rejects(run, { code: 'RESEARCH_OUTPUT_CLOSED' });
  await first.promise; output.destroy(); await rejected; assert.equal(dispatches, 1);
  await yieldTurn(); for (const event of ['drain', 'error', 'close']) assert.equal(output.listenerCount(event), 0);
});

test('write failure stays bounded, has no unhandled EPIPE, and removes callbacks/listeners', async () => {
  let dispatches = 0;
  const output = new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('synthetic EPIPE'), { code: 'EPIPE' })); } });
  await assert.rejects(runResearchStdio({ input: Readable.from([lines(2)]), output, dispatch: async request => { dispatches++; return { id: request.id, result: {} }; }, outputDeadlineMs: 1000 }), { code: 'RESEARCH_OUTPUT_FAILED' });
  assert.equal(dispatches, 1); await yieldTurn(); for (const event of ['drain', 'error', 'close']) assert.equal(output.listenerCount(event), 0);
});

test('blocked output deadline is finite, destroys only its transport, and ignores late write callback failure safely', async () => {
  let dispatches = 0, savedCallback;
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { savedCallback = callback; } });
  const start = Date.now();
  await assert.rejects(runResearchStdio({ input: Readable.from([lines(3)]), output, dispatch: async request => { dispatches++; return { id: request.id, result: {} }; }, outputDeadlineMs: 25 }), { code: 'RESEARCH_OUTPUT_DEADLINE' });
  assert.ok(Date.now() - start < 500); assert.equal(dispatches, 1); assert.equal(output.destroyed, true);
  await yieldTurn(); savedCallback(Object.assign(new Error('late synthetic EPIPE'), { code: 'EPIPE' })); await yieldTurn();
  for (const event of ['drain', 'error', 'close']) assert.equal(output.listenerCount(event), 0);
});

test('normal fragmented stdio preserves protocol errors and EOF never shuts down the daemon', async () => {
  let text = ''; const daemonCalls = [];
  const dispatch = createResearchDispatcher({ connect: async () => ({ call: async method => { daemonCalls.push(method); return { providers: [] }; } }) });
  const frames = ['{bad', JSON.stringify(init), JSON.stringify(notice), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'social_status', arguments: {} } })].join('\n') + '\n';
  const output = new Writable({ highWaterMark: 8, write(chunk, encoding, callback) { text += chunk.toString(); setImmediate(callback); } });
  await runResearchStdio({ input: Readable.from([frames.slice(0, 17), frames.slice(17)]), output, dispatch });
  const replies = text.trim().split('\n').map(JSON.parse); assert.equal(replies.length, 3); assert.equal(replies[0].error.code, -32700); assert.equal(replies[2].result.isError, false); assert.deepEqual(daemonCalls, ['status']);
  await yieldTurn(); for (const event of ['drain', 'error', 'close']) assert.equal(output.listenerCount(event), 0);
});
