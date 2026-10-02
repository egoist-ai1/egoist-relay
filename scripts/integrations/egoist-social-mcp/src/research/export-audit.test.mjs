import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRelayBridgeProvider } from './bridge-provider.mjs';
import { assertSafeDirectory } from './job-store.mjs';

const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work) || path.basename(work).toLowerCase() !== 'work') throw new Error('Use the active task work directory.');
const accountScope = { accountRef: 'synthetic-export-account', accountEpoch: 'epoch-1' };
const semanticRecords = {
  telegram: { type: 'telegram.message', id: 'fixture:1', peerId: 'fixture', messageId: 1, date: 1790901600, text: 'Telegram message Русский 🙂\nSecond line', sourceUrl: 'https://t.me/fixture/1', observedFields: { fromId: { userId: '1' } } },
  x: { type: 'post', id: 'x:1', text: 'X post Русский 🙂\nSecond line', author: { observedText: 'Fixture author @fixture' }, timestamp: '2026-10-02T03:00:00.000Z', source: 'https://x.com/fixture/status/1', descriptions: ['Alt text for image'], links: [{ url: 'https://example.invalid/fixture', text: 'Source link' }], media: [{ kind: 'photo', sourceUrl: 'https://pbs.twimg.com/fixture.jpg', description: 'Poster description' }] },
  instagram: { type: 'reel', id: 'instagram:abc', description: 'Instagram page description Русский 🙂', observedText: 'Visible reel text\nSecond line', author: { observedText: 'Fixture creator' }, sourceUrl: 'https://www.instagram.com/fixture/reel/abc/', unresolvedFields: ['caption_not_observed', 'timestamp_not_observed'], fieldEvidence: { media: 'img/video' }, media: [{ kind: 'photo', sourceUrl: 'https://cdninstagram.com/fixture.jpg', description: 'Reel poster' }] },
};
async function exportRecords(providerName, records, { partial = false, mediaEvents = [] } = {}) {
  const outputDirectory = path.join(work, 'export-audit-' + randomUUID());
  await assertSafeDirectory(outputDirectory, { create: true });
  const bridge = { status: async () => ({ providers: [] }), call: async (method, params, { onEvent }) => {
    assert.equal(method, 'run'); assert.deepEqual(params.expectedAccount, accountScope);
    await onEvent({ kind: 'scope', ...accountScope });
    await onEvent({ kind: 'records', records, coverage: 'channel', partial });
    for (const event of mediaEvents) await onEvent(event);
    const done = { kind: 'done', count: records.length, outcome: partial ? 'partial' : records.length ? 'results' : 'empty', partial };
    await onEvent(done); return done;
  } };
  const provider = createRelayBridgeProvider({ provider: providerName, bridge }, { diskFree: async () => 10 * 1024 ** 3 });
  const result = await provider.run({ operation: 'chat_export', input: { channel: 'fixture', limit: 100, pageSize: 100, deadlineMs: 10000, exportFormats: ['jsonl', 'markdown', 'html'] }, accountScope, jobId: randomUUID(), outputDirectory, signal: new AbortController().signal });
  const [md, html, bytes] = await Promise.all(['export.md', 'export.html', 'records.jsonl'].map(name => fs.readFile(path.join(outputDirectory, name))));
  return { result, outputDirectory, md: md.toString('utf8'), html: html.toString('utf8'), bytes, records: bytes.length ? bytes.toString('utf8').trim().split('\n').map(JSON.parse) : [] };
}

for (const [provider, record] of Object.entries(semanticRecords)) {
  test(provider + ' actual writer export preserves source attribution and every distinct observed body field', async () => {
    const f = await exportRecords(provider, [record]);
    assert.equal(f.result.state, 'completed'); assert.equal(f.result.count, 1);
    for (const key of ['text', 'caption', 'description', 'observedText']) if (record[key]) {
      for (const line of record[key].split('\n')) {
        assert.ok(f.md.includes(line), 'Markdown omitted ' + key);
        assert.ok(f.html.includes(line), 'HTML omitted ' + key);
      }
    }
    const source = record.sourceUrl ?? record.source;
    assert.ok(f.md.includes(source), 'Markdown omitted provenance');
    assert.ok(f.html.includes('href="' + source + '"'), 'HTML source is not a navigable link');
    assert.ok(f.md.includes('records.jsonl')); assert.ok(f.html.includes('href="records.jsonl"'));
    for (const [key, value] of Object.entries(record)) assert.deepEqual(f.records[0][key], value, 'JSONL changed source field ' + key);
  });
}

test('unsafe source HTML and Markdown remain literal text, unsafe schemes are never interactive', async () => {
  const unsafe = { type: 'post', id: 'unsafe', title: '<img src=x onerror=alert(1)> [title]', text: '<script>alert(1)</script>\n![tracking](https://unsafe.invalid/pixel)\n**bold**\n~~~', sourceUrl: 'javascript:alert(1)', links: [{ url: 'data:text/html,<script>x</script>', text: 'unsafe <tag>' }, { url: 'https://example.invalid/?a=1&b=2', text: '<safe link>' }], media: [{ kind: 'photo', sourceUrl: 'file:///C:/private', description: '<poster>' }] };
  const f = await exportRecords('x', [unsafe]);
  assert.equal(f.html.includes('<script>'), false); assert.equal(f.html.includes('<img '), false);
  assert.ok(f.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(f.md.includes('    <script>alert(1)</script>'));
  assert.equal(/href="(?:javascript|data|file):/i.test(f.html), false);
  assert.equal(/\]\((?:javascript|data|file):/i.test(f.md), false);
  assert.ok(f.html.includes('https://example.invalid/?a=1&amp;b=2'));
  assert.equal(f.html.includes('<iframe'), false); assert.equal(f.html.includes('<video'), false);
  assert.equal(f.html.includes('<img'), false);
});

test('duplicate source text is displayed once and supplemental fields are retained distinctly', async () => {
  const f = await exportRecords('instagram', [{ type: 'post', id: 'dedupe', text: 'UNIQUE_SOURCE_TEXT', caption: 'UNIQUE_SOURCE_TEXT', description: 'UNIQUE_SOURCE_TEXT', observedText: 'UNIQUE_OBSERVED_TEXT', descriptions: ['IMAGE_ALT_TEXT', 'IMAGE_ALT_TEXT'], sourceUrl: 'https://instagram.com/p/fixture/' }]);
  for (const format of [f.md, f.html]) {
    assert.equal(format.split('UNIQUE_SOURCE_TEXT').length - 1, 1);
    assert.equal(format.split('UNIQUE_OBSERVED_TEXT').length - 1, 1);
    assert.equal(format.split('IMAGE_ALT_TEXT').length - 1, 1);
  }
});

test('partial and zero-record exports preserve honest scope instead of claiming source completeness', async () => {
  for (const partial of [false, true]) {
    const f = await exportRecords('telegram', [], { partial });
    assert.equal(f.result.state, partial ? 'partial' : 'completed'); assert.equal(f.records.length, 0);
    for (const format of [f.md, f.html]) {
      assert.ok(format.includes(partial ? 'Частичный результат' : 'Выбранное задание завершено'));
      assert.match(format.replace(/<[^>]*>/g, ' '), /Записей\s*:?\s*0/);
      assert.ok(format.includes('Полнота источника не установлена'));
    }
  }
});

test('records without observed semantic text are visibly explicit and keep exact JSONL fields', async () => {
  const record = { type: 'telegram.message', id: 'fixture:2', text: '', observedFields: { action: { _: 'MessageActionChatCreate', title: 'Synthetic service message' } }, sourceLocator: 'telegram:fixture:2' };
  const f = await exportRecords('telegram', [record]);
  for (const format of [f.md, f.html]) assert.ok(format.includes('Текст в принятой записи не наблюдался'));
  assert.deepEqual(f.records[0].observedFields, record.observedFields);
  assert.ok(f.md.includes('fixture:2')); assert.ok(f.html.includes('fixture:2'));
});

test('downloaded originals are linked only using accepted local manifest filenames and exact byte hashes', async () => {
  const bytes = Buffer.from('original-synthetic-media');
  const record = semanticRecords.x;
  const f = await exportRecords('x', [record], { mediaEvents: [
    { kind: 'media_open', mediaId: 'fixture-photo', fileName: '../unsafe.jpg', mimeType: 'image/jpeg', declaredBytes: bytes.length, sourceUrl: record.media[0].sourceUrl },
    { kind: 'media_chunk', mediaId: 'fixture-photo', sequence: 0, base64: bytes.toString('base64') },
    { kind: 'media_close', mediaId: 'fixture-photo', totalBytes: bytes.length },
  ] });
  const name = f.result.files.find(file => /^media-.+\.jpg$/.test(file));
  assert.ok(name);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.ok(f.md.includes('](' + name + ')')); assert.ok(f.html.includes('href="' + name + '"'));
  assert.ok(f.md.includes(hash)); assert.ok(f.html.includes(hash));
  assert.deepEqual(await fs.readFile(path.join(f.outputDirectory, name)), bytes);
  assert.equal(f.md.includes('../unsafe.jpg'), false); assert.equal(f.html.includes('../unsafe.jpg'), false);
});
