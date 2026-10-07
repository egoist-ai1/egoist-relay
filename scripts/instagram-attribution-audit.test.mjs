import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from '../node_modules/playwright/index.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work) || path.basename(work).toLowerCase() !== 'work') throw new Error('Owned active task work required.');
const reportDirectory = path.join(project, 'docs/app-quality-audit-2026-10-02');
const receiptFile = path.join(reportDirectory, 'instagram-attribution-test-receipt-v3.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const currentPath = path.join(project, 'runtime/research/social-read.js');
const installedPath = 'C:/Users/Egoist/AppData/Local/Egoist Relay/runtime/research/social-read.js';
const sources = [];
for (const [label, file] of [['installed-1.4.2', installedPath], ['candidate-1.4.4', currentPath]]) {
  const bytes = await fs.readFile(file);
  sources.push({ label, file, bytes: bytes.length, sha256: hash(bytes), source: bytes.toString('utf8') });
}
const corpusFile = path.join(project, 'docs/app-quality-audit-2026-10-02/public-operation-pilots.json');
const corpusBytes = await fs.readFile(corpusFile);
const pilot = JSON.parse(corpusBytes.toString('utf8'));
const corpus = [];
for (const entry of pilot.operations.filter(item => item.request.provider === 'instagram')) {
  const outputDirectory = path.resolve(entry.final.outputDirectory);
  const expectedRoot = path.resolve('C:/Users/Egoist/Desktop/Проекты/Материалы/Социальные исследования', entry.jobId);
  assert.equal(outputDirectory, expectedRoot);
  const files = [];
  for (const name of ['records.jsonl', 'export-manifest.json']) {
    const file = path.join(outputDirectory, name), bytes = await fs.readFile(file);
    const expected = entry.artifacts.find(value => value.name === name);
    assert.ok(expected);
    assert.equal(hash(bytes), expected.sha256, 'Selected public output changed before attribution audit.');
    files.push({ name, file, bytes: bytes.length, sha256: hash(bytes) });
  }
  corpus.push({ jobId: entry.jobId, request: entry.request.input, state: entry.final.state, count: entry.final.result.count, files });
}
const observations = [];
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Egoist/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe' });
const profileDescription = 'Synthetic OpenAI profile biography. This is not an individual reel caption.';
const postDescription = 'Synthetic caption for the exact selected reel.';
const navigation = '<nav><a aria-label="Profile" href="/fixture_account/">Profile</a><a href="/direct/inbox/">Messages</a></nav>';
function markup(body, description = profileDescription) {
  return '<!doctype html><html><head><meta property="og:description" content="' + description + '"></head><body>' + navigation + '<main>' + body + '</main></body></html>';
}
async function scenario(source, name, { pagePath = '/openai/', targetPath = '/openai/', operation = 'channel_history', body, description = profileDescription }) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let documentsFulfilled = 0, requestsAborted = 0;
  await context.route('**/*', route => {
    if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
      documentsFulfilled++; return route.fulfill({ status: 200, contentType: 'text/html', body: markup(body, description) });
    }
    requestsAborted++; return route.abort();
  });
  const page = await context.newPage();
  await page.goto('https://www.instagram.com' + pagePath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__attributionEvents = []; window.__TAURI_INTERNALS__ = { invoke: async (command, payload) => { if (command !== 'relay_research_social_reply') throw new Error('Unexpected fixture transport command'); window.__attributionEvents.push(JSON.parse(JSON.stringify(payload.event))); } }; });
  await page.addScriptTag({ content: source.source });
  await page.evaluate(async request => { await window.__egoistSocialResearch.start(request); }, {
    requestId: 'synthetic-' + randomUUID(), nonce: 'synthetic-owned-nonce', provider: 'instagram', operation, target: 'https://www.instagram.com' + targetPath,
    scope: 'posts', sourceKey: 'synthetic-profile-source', accountEpoch: 'synthetic-epoch', documentEpoch: 1, targetIndex: 0, limit: 1, deadlineMs: 2500,
    input: { pageSize: 1, includeMedia: false },
  });
  const events = await page.evaluate(() => window.__attributionEvents);
  await context.close();
  const record = events.flatMap(event => event.records ?? [])[0];
  const observation = {
    helper: source.label, scenario: name, synthetic: true, documentUrl: 'https://www.instagram.com' + pagePath, requestedTarget: 'https://www.instagram.com' + targetPath,
    eventKinds: events.map(event => event.kind), errorCode: events.find(event => event.kind === 'error')?.code,
    sourceUrl: record?.source, author: record?.author, caption: record?.text, description: record?.description, timestamp: record?.timestamp,
    fieldEvidence: record?.fieldEvidence, unresolvedFields: record?.unresolvedFields, pageDone: events.find(event => event.kind === 'page_done') && { count: events.find(event => event.kind === 'page_done').count, partial: events.find(event => event.kind === 'page_done').partial },
    records: record ? 1 : 0, fixtureNetwork: { outgoingRequests: 0, documentsFulfilled, requestsAborted },
  };
  observations.push(observation);
  return { record, events, observation };
}
for (const source of sources) {
  test(source.label + ': a profile grid may expose a different handle-shaped reel locator without inventing its publisher', async () => {
    const result = await scenario(source, 'profile-grid-different-handle', { body: '<header>OpenAI profile</header><a href="/chatgpt/reel/COLLAB01"><img alt="Synthetic grid preview">Grid reel</a>' });
    assert.equal(result.record.source, 'https://www.instagram.com/chatgpt/reel/COLLAB01');
    assert.deepEqual(result.record.author, {});
    assert.equal(result.record.text, undefined); assert.equal(result.record.timestamp, undefined);
    assert.ok(result.record.unresolvedFields.includes('caption_not_observed')); assert.ok(result.record.unresolvedFields.includes('timestamp_not_observed'));
    assert.equal(result.observation.pageDone.count, 1);
  });
  test(source.label + ': metadata attached to a grid record must explicitly identify its profile-page provenance', async () => {
    const result = await scenario(source, 'profile-metadata-provenance-contract', { body: '<a href="/chatgpt/reel/COLLAB01">Grid reel</a>' });
    assert.equal(result.record.description, profileDescription, 'The reproducible metadata comes from the selected profile page.');
    assert.ok(result.record.fieldEvidence?.description && result.record.sourceContext?.pageUrl, 'Profile description is copied into a reel record without explicit field-level page provenance.');
  });
  test(source.label + ': a matching handle prefix still cannot substitute for observed publisher evidence', async () => {
    const result = await scenario(source, 'same-handle-not-publisher-proof', { body: '<a href="/openai/reel/SAMEHANDLE">Grid reel</a>' });
    assert.equal(result.record.source, 'https://www.instagram.com/openai/reel/SAMEHANDLE');
    assert.deepEqual(result.record.author, {}); assert.equal(result.record.publisher, undefined);
  });
  test(source.label + ': exact detail DOM supplies observed header text, caption and time without claiming structured collaborator identity', async () => {
    const result = await scenario(source, 'detail-observed-fields', { pagePath: '/chatgpt/reel/COLLAB01/', targetPath: '/reel/COLLAB01/', operation: 'read',
      body: '<article><header><a href="/chatgpt/">chatgpt</a> · <a href="/openai/">openai</a></header><a href="/chatgpt/reel/COLLAB01/">Link</a><h1>Exact article caption</h1><time datetime="2026-09-01T12:00:00Z">September</time></article>', description: postDescription });
    assert.equal(result.record.text, 'Exact article caption'); assert.equal(result.record.timestamp, '2026-09-01T12:00:00Z');
    assert.ok(result.record.author.observedText.includes('chatgpt')); assert.ok(result.record.author.observedText.includes('openai'));
    assert.equal(result.record.publisher, undefined); assert.equal(result.record.collaborators, undefined);
  });
  test(source.label + ': accepted same-shortcode detail aliases must retain page-specific OG caption', async () => {
    const result = await scenario(source, 'same-shortcode-alias-caption-contract', { pagePath: '/reel/COLLAB01/', targetPath: '/reel/COLLAB01/', operation: 'read',
      body: '<article><a href="/chatgpt/reel/COLLAB01/">Selected reel</a></article>', description: postDescription });
    assert.equal(result.observation.errorCode, undefined); assert.equal(result.record.description, postDescription);
    assert.equal(result.record.text, postDescription, 'Same-post navigation is accepted, but the caption fallback still compares unequal owner-shaped URLs.');
  });
  test(source.label + ': a different profile or shortcode is rejected before records despite the same signed-in fixture account', async () => {
    for (const [pagePath, targetPath, operation] of [['/chatgpt/', '/openai/', 'channel_history'], ['/reel/OTHER/', '/reel/EXPECTED/', 'read']]) {
      const result = await scenario(source, 'wrong-source-guard', { pagePath, targetPath, operation, body: '<article><a href="/chatgpt/reel/OTHER/">Other record</a></article>' });
      assert.equal(result.observation.errorCode, 'SOURCE_CHANGED'); assert.equal(result.observation.records, 0);
    }
  });
}
after(async () => {
  await browser.close();
  for (const entry of corpus) for (const file of entry.files) assert.equal(hash(await fs.readFile(file.file)), file.sha256, 'Original public output changed during fixture test.');
  const nativeFile = path.join(project, 'tauri/src/research_social.rs');
  const nativeBytes = await fs.readFile(nativeFile);
  const result = {
    schemaVersion: 1, artifactId: 'egoist-instagram-attribution-fixtures', version: '1', createdAt: new Date().toISOString(),
    sources: sources.map(entry => { const rest = { ...entry }; delete rest.source; return rest; }), native: { file: nativeFile, bytes: nativeBytes.length, sha256: hash(nativeBytes), executionVerifiedHere: false },
    publicPilot: { file: corpusFile, bytes: corpusBytes.length, sha256: hash(corpusBytes), selectedCorpus: corpus, originalsUnchanged: true },
    observations, expectedContractFailures: ['profile-metadata-provenance-contract', 'same-shortcode-alias-caption-contract'],
    liveInstagramAccess: false, relayAccess: false, mcpCalls: 0, productionEdits: 0,
    fixtureBoundary: 'Separate owned browser; every synthetic HTTPS document fulfilled locally and all other requests aborted. Auth and Tauri transport are synthetic fixture seams, never a real user session.',
  };
  await fs.writeFile(receiptFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Attribution fixture receipt: ' + receiptFile);
});
