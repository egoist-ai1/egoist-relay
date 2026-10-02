import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRelayBridgeProvider } from './bridge-provider.mjs';
import { assertSafeDirectory } from './job-store.mjs';
const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !isAbsolute(work)) throw new Error('Owned task work is required');
const accountScope = { accountRef: 'synthetic-account', accountEpoch: 'epoch-1' };
const scope = { kind: 'scope', ...accountScope };
const record = { kind: 'records', coverage: 'post', records: [{ id: '1', text: '<script>synthetic</script>', sourceUrl: 'https://x.com/fixture/status/1' }] };
const done = { kind: 'done', outcome: 'results', count: 1, coverage: 'post' };
async function fixture(events, options = {}) {
  const outputDirectory = join(work, 'social-writer-fixture-' + randomUUID());
  await assertSafeDirectory(outputDirectory, { create: true });
  const checkpoints = []; const controller = new AbortController();
  const bridge = { status: async () => ({ providers: [{ provider: 'x', state: 'ready', operations: ['read'], ...accountScope }] }),
    call: async (method, params, { onEvent }) => {
      assert.equal(method, 'run'); assert.deepEqual(params.expectedAccount, accountScope);
      let last;
      for (const event of events) { if (typeof event === 'function') await event({ controller, outputDirectory }); else { await onEvent(event); last = event; } }
      return last;
    } };
  const provider = createRelayBridgeProvider({ provider: 'x', bridge }, { diskFree: async () => 10 * 1024 ** 3, ...options });
  const run = (overrides = {}) => provider.run({ operation: 'read', input: { url: 'https://x.com/fixture/status/1', limit: 20, pageSize: 10, deadlineMs: 1000, exportFormats: ['jsonl', 'html'] }, accountScope, jobId: randomUUID(), outputDirectory, signal: controller.signal, onCheckpoint: async value => checkpoints.push(value), ...overrides });
  return { run, provider, outputDirectory, checkpoints };
}
test('source exports preserve observed fields, escape HTML and record bound provenance', async () => {
  const f = await fixture([scope, record, done]); const result = await f.run();
  assert.equal(result.count, 1);
  const rows = (await fs.readFile(join(f.outputDirectory, 'records.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].text, '<script>synthetic</script>');
  const html = await fs.readFile(join(f.outputDirectory, 'export.html'), 'utf8');
  assert.ok(html.includes('&lt;script&gt;')); assert.equal(html.includes('<script>synthetic'), false);
  const manifest = JSON.parse(await fs.readFile(join(f.outputDirectory, 'export-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.provenance.accountScope, accountScope); assert.equal(manifest.provenance.sources[0], 'https://x.com/fixture/status/1');
});

test('owner-shaped social source locator remains in exports and becomes validated job evidence', async () => {
  const social = { kind: 'records', records: [{ id: '1', source: 'https://x.com/fixture/status/1?s=52', text: 'observed source' }] };
  const f = await fixture([scope, social, done]); const result = await f.run();
  const row = JSON.parse(await fs.readFile(join(f.outputDirectory, 'records.jsonl'), 'utf8'));
  assert.equal(row.source, social.records[0].source); assert.equal(row.sourceUrl, row.source);
  assert.deepEqual(result.evidence, [{ url: 'https://x.com/fixture/status/1', kind: 'post' }]);
  const denied = await fixture([scope, { ...social, records: [{ ...social.records[0], source: 'https://unrelated.invalid/source' }] }, done]);
  assert.deepEqual((await denied.run()).evidence, []);
});
test('long Unicode parts reconstruct exactly once without losing source bytes', async () => {
  const text = 'Русский🙂'.repeat(20000);
  const f = await fixture([scope, { kind: 'records', records: [{ id: '1', textPart: { index: 0, text: text.slice(0, 90000), final: false } }] },
    { kind: 'records', records: [{ id: '1', textPart: { index: 1, text: text.slice(90000), final: true } }] }, done]);
  assert.equal((await f.run()).count, 1);
  assert.equal(JSON.parse(await fs.readFile(join(f.outputDirectory, 'records.jsonl'), 'utf8')).text, text);
  assert.equal((await fs.readFile(join(f.outputDirectory, 'record-parts.jsonl'), 'utf8')).trim().split('\n').length, 2);
});
test('ordered media validates hash and ignores unsafe filename suggestions', async () => {
  const bytes = Buffer.from('synthetic-media');
  const f = await fixture([scope, record, { kind: 'media_open', mediaId: 'asset', fileName: '..\\CON:secret', mimeType: 'image/png', declaredBytes: bytes.length, sourceUrl: 'https://pbs.twimg.com/synthetic.png' },
    { kind: 'media_chunk', mediaId: 'asset', sequence: 0, base64: bytes.toString('base64') }, { kind: 'media_close', mediaId: 'asset', totalBytes: bytes.length }, done]);
  await f.run();
  const manifest = JSON.parse(await fs.readFile(join(f.outputDirectory, 'media-manifest.json'), 'utf8'));
  assert.match(manifest.files[0].file, /^media-001-[a-f0-9]{16}\.png$/);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await fs.readFile(join(f.outputDirectory, manifest.files[0].file)), bytes);
});
test('media sequence gap retains source and incomplete bytes as partial', async () => {
  const f = await fixture([scope, record, { kind: 'media_open', mediaId: 'asset', mimeType: 'video/mp4', declaredBytes: 6, sourceUrl: 'https://video.twimg.com/synthetic.mp4' },
    { kind: 'media_chunk', mediaId: 'asset', sequence: 0, base64: 'YWJj' }, { kind: 'media_chunk', mediaId: 'asset', sequence: 2, base64: 'ZGVm' }]);
  await assert.rejects(f.run(), { code: 'INVALID_RESULT' });
  const manifest = JSON.parse(await fs.readFile(join(f.outputDirectory, 'partial-manifest.json'), 'utf8'));
  assert.equal(manifest.count, 1); assert.equal(manifest.incompleteMedia[0].bytes, 3);
  assert.equal((await fs.readFile(join(f.outputDirectory, manifest.incompleteMedia[0].file))).toString(), 'abc');
});
test('lost stream and cancellation preserve accepted records and final partial checkpoint', async () => {
  for (const code of ['BRIDGE_REPLY_LOST', 'CANCELLED']) {
    const f = await fixture([scope, record, async ({ controller }) => { if (code === 'CANCELLED') controller.abort(Object.assign(new Error(), { code })); throw Object.assign(new Error(), { code }); }]);
    await assert.rejects(f.run(), { code });
    assert.equal(JSON.parse(await fs.readFile(join(f.outputDirectory, 'partial-manifest.json'), 'utf8')).count, 1);
    assert.equal(f.checkpoints.at(-1).state, 'partial');
    assert.ok(f.checkpoints.at(-1).files.includes('partial-manifest.json'));
  }
});

test('sent account-drift uncertainty and rate delay survive writer partial settlement', async () => {
  for (const details of [{ code: 'STALE_ACCOUNT', completionUncertain: true }, { code: 'RATE_LIMITED', retryAfterMs: 12345 }]) {
    const f = await fixture([scope, async () => { throw Object.assign(new Error('synthetic-private-reason'), details); }]);
    await assert.rejects(f.run(), error => error.code === details.code && (details.completionUncertain ? error.completionUncertain === true : error.retryAfterMs === details.retryAfterMs));
    const manifest = JSON.parse(await fs.readFile(join(f.outputDirectory, 'partial-manifest.json'), 'utf8'));
    assert.equal(manifest.failure.completionUncertain, details.completionUncertain === true);
    assert.equal(JSON.stringify(manifest).includes('synthetic-private-reason'), false);
  }
});
test('missing or changed account cannot write source records', async () => {
  for (const events of [[record, done], [{ ...scope, accountEpoch: 'different' }, record, done]]) {
    const f = await fixture(events); await assert.rejects(f.run(), { code: 'STALE_ACCOUNT' });
    assert.equal((await fs.readdir(f.outputDirectory)).includes('records.jsonl'), false);
  }
});
test('near-full disk stops both records and text fragments before stream writes', async () => {
  for (const event of [record, { kind: 'records', records: [{ id: '1', textPart: { index: 0, text: 'part', final: false } }] }]) {
    const f = await fixture([scope, event], { diskFree: async () => 1024 ** 3 });
    await assert.rejects(f.run(), { code: 'DISK_RESERVE' });
    for (const name of await fs.readdir(f.outputDirectory)) assert.equal((await fs.stat(join(f.outputDirectory, name))).size, 0);
  }
});
test('directory replacement during remote wait cannot receive new source bytes', async () => {
  const f = await fixture([scope, async ({ outputDirectory }) => { await fs.rename(outputDirectory, outputDirectory + '-original'); await fs.mkdir(outputDirectory); }, record]);
  await assert.rejects(f.run(), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(f.outputDirectory), []);
});
test('unconfirmed completion count and unfinished text are explicit failures', async () => {
  for (const events of [[scope, record, { ...done, count: 2 }], [scope, { kind: 'records', records: [{ id: '1', textPart: { index: 0, text: 'unfinished', final: false } }] }, { kind: 'done', outcome: 'empty', count: 0 }]]) {
    const f = await fixture(events); await assert.rejects(f.run(), { code: 'INVALID_RESULT' });
    assert.ok((await fs.readdir(f.outputDirectory)).includes('partial-manifest.json'));
  }
});

test('transcription checkpoint counts remain source post counts and retain transcript files', async () => {
  const bytes = Buffer.from('synthetic-media'); let invoked = 0;
  const f = await fixture([scope, record, { kind: 'media_open', mediaId: 'asset', mimeType: 'video/mp4', declaredBytes: bytes.length, sourceUrl: 'https://video.twimg.com/synthetic.mp4' },
    { kind: 'media_chunk', mediaId: 'asset', sequence: 0, base64: bytes.toString('base64') }, { kind: 'media_close', mediaId: 'asset', totalBytes: bytes.length }, done],
  { transcribeMedia: async ({ outputDirectory, media, deadlineMs, onCheckpoint }) => {
    invoked++; assert.equal(media.length, 1); assert.ok(deadlineMs > 0 && deadlineMs <= 1000);
    await fs.writeFile(join(outputDirectory, 'transcripts.jsonl'), '{"synthetic":true}\n');
    await onCheckpoint({ state: 'completed', count: 99, files: ['transcripts.jsonl'] });
    return { state: 'completed', count: 99, files: ['transcripts.jsonl'], items: [] };
  } });
  const result = await f.run({ operation: 'transcribe' });
  assert.equal(invoked, 1); assert.equal(result.count, 1); assert.ok(result.files.includes('transcripts.jsonl'));
  assert.ok(f.checkpoints.every(value => value.count === 1));
});

test('selected source without observed supported audio/video stays explicit partial', async () => {
  const f = await fixture([scope, record, done]);
  const result = await f.run({ operation: 'transcribe' }); assert.equal(result.state, 'partial');
  const manifest = JSON.parse(await fs.readFile(join(f.outputDirectory, 'export-manifest.json'), 'utf8'));
  assert.equal(manifest.transcription.reason, 'no_supported_audio_video'); assert.equal(manifest.count, 1);
});

test('native audio/video MIME types keep local transcription-compatible generated extensions', async () => {
  for (const [mimeType, extension] of [['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/flac', 'flac'], ['audio/aac', 'aac'], ['audio/webm', 'webm'], ['video/quicktime', 'mov']]) {
    const bytes = Buffer.from('synthetic-media'); let accepted = false;
    const f = await fixture([scope, record, { kind: 'media_open', mediaId: 'audio', mimeType, declaredBytes: bytes.length, sourceUrl: 'https://video.twimg.com/synthetic' },
      { kind: 'media_chunk', mediaId: 'audio', sequence: 0, base64: bytes.toString('base64') }, { kind: 'media_close', mediaId: 'audio', totalBytes: bytes.length }, done],
    { transcribeMedia: async ({ media, outputDirectory }) => {
      assert.equal(media.length, 1); assert.equal(media[0].mimeType, mimeType); assert.ok(media[0].file.endsWith('.' + extension));
      assert.deepEqual(await fs.readFile(join(outputDirectory, media[0].file)), bytes); accepted = true;
      return { state: 'completed', count: 1, files: [], items: [] };
    } });
    assert.equal((await f.run({ operation: 'transcribe' })).state, 'completed'); assert.equal(accepted, true);
  }
});

test('rich native coverage remains in the artifact while broker metadata stays compact', async () => {
  const coverage = { scope: 'post', accessible: true, extraction: 'visible_dom', completeness: 'partial', sourcesRead: 1 };
  const f = await fixture([scope, { ...record, coverage }, { ...done, coverage, partial: true }]);
  const result = await f.run(); assert.equal(result.coverage, 'post'); assert.equal(result.state, 'partial');
  const manifest = JSON.parse(await fs.readFile(join(f.outputDirectory, 'export-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.sourceCoverage, coverage);
});
