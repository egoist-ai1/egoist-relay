import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { initializeAuditBrowser, project, startAuditServer } from './relay-ui-audit.server.mjs';

const output = process.env.RELAY_UI_AUDIT_OUTPUT;
const evidenceOutput = process.env.RELAY_UI_AUDIT_EVIDENCE;
const browserExecutable = process.env.RELAY_UI_AUDIT_BROWSER;
if (!output || !evidenceOutput || !browserExecutable) {
  throw new Error('Set RELAY_UI_AUDIT_OUTPUT (own work), RELAY_UI_AUDIT_EVIDENCE (project release docs), and RELAY_UI_AUDIT_BROWSER (installed Chromium).');
}
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const visualDirectory = `ui-visuals/operations-${runId}`;
await mkdir(path.join(evidenceOutput, visualDirectory), { recursive: true });
const sources = ['src/components/App.tsx', 'src/components/App.module.scss',
  'src/components/multi/MediaOperationsPanel.tsx', 'src/components/multi/MediaOperationsPanel.module.scss',
  'src/components/multi/mediaOperations.ts', 'src/components/multi/mediaOperations.types.ts',
  'scripts/relay-ui-audit.server.mjs', 'scripts/relay-operations-ui-audit.mjs'];
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sources.map(async (source) => [source,
    createHash('sha256').update(await readFile(path.join(project, source))).digest('hex')])));
}
const report = { schemaVersion: 1, artifactId: 'relay-1.5.0-operations-ui-acceptance', runId,
  generatedAt: new Date().toISOString(), projectPath: project, sourceHashes: await sourceHashes(),
  environment: { browserExecutable, transport: 'Real App/Panel + existing MockClient + terminal native journal mocks',
    remoteRequests: 'blocked', account: 'Synthetic fixture user 1, chat 101', physicalDpi: 'Not tested',
    limitations: ['WebView2 COM transport, actual disk files and live Telegram delivery are outside this browser audit'] },
  cases: [], errors: [], blockedRequests: [] };
const { server, url } = await startAuditServer(output, Number(process.env.RELAY_UI_AUDIT_PORT || 1267));
let browser;
let page;
const panel = () => page.locator('#relay-media-operations');
const row = (id) => page.locator(`[data-operation-id="${id}"]`);
const settle = async () => { await page.waitForTimeout(180); await page.evaluate(() => document.fonts.ready); };
function operation(patch = {}) {
  const now = Date.now();
  return { id: randomUUID(), attempt: 1, revision: 1, kind: 'download', service: 'telegram',
    fileName: 'Локальная проверка.mp4', stage: 'downloading', createdAt: now, updatedAt: now,
    files: [], ...patch };
}
function savedFile(patch = {}) {
  return { path: `C:/RelayAuditDownloads/${randomUUID()}/video.mp4`, fileName: 'Аудит.mp4',
    mimeType: 'video/mp4', size: 1572864, width: 1280, height: 720, ...patch };
}
async function seed(operations, isLocked = false) {
  await page.evaluate(({ operations, isLocked }) => window.__relayNativeMock.media.seed(operations, isLocked),
    { operations, isLocked });
  await settle();
}
async function openPanel() {
  if (!await panel().count()) await page.keyboard.press('Control+j');
  await panel().waitFor({ state: 'visible' }); await settle();
}
async function closePanel() {
  if (!await panel().count()) return;
  await panel().locator('header button').click(); await panel().waitFor({ state: 'hidden' }); await settle();
}
async function selectApp(app) {
  await page.locator(`[data-relay-app="${app}"]`).click();
  await page.waitForFunction((value) => document.querySelector(`[data-relay-app="${value}"]`)
    ?.getAttribute('aria-current') === 'page', app);
  await settle();
}
async function boot() {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-relay-app="telegram"]', { timeout: 60000 });
  await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1', undefined, { timeout: 60000 });
  await page.waitForFunction(() => !window.__relayNativeMock.media.isLocked, undefined, { timeout: 15000 });
  await settle();
}
async function reset() {
  await closePanel();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; document.documentElement.dir = 'ltr'; });
  await settle(); await selectApp('telegram'); await seed([]);
}
async function capture(id) {
  const relative = `${visualDirectory}/${id}.png`;
  await page.screenshot({ path: path.join(evidenceOutput, relative) }); return relative;
}
async function diagnostic() {
  return page.evaluate(() => ({ state: window.__relayAudit?.state(), native: {
    contentVisible: window.__relayNativeMock.contentVisible, currentApp: window.__relayNativeMock.currentApp,
    calls: window.__relayNativeMock.calls.slice(-24), snapshot: window.__relayNativeMock.media.snapshot(),
  }, panel: document.querySelector('#relay-media-operations')?.innerText,
  activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id,
    label: document.activeElement?.getAttribute('aria-label') }, unhandled: window.__relayUnhandled }));
}
async function metrics() {
  return panel().evaluate((scope) => {
    const rect = (element) => { const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom }; };
    const content = scope.querySelector('#relay-operations-list');
    const controls = [...scope.querySelectorAll('button')].map((element) => {
      const box = rect(element); let clippedX = false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (['hidden', 'auto', 'scroll', 'clip'].includes(getComputedStyle(parent).overflowX)) {
          const bounds = rect(parent); if (box.x < bounds.x - 1 || box.right > bounds.right + 1) clippedX = true;
        }
      }
      return { name: element.getAttribute('aria-label') || element.textContent.trim(), rect: box, clippedX,
        visible: box.width > 0 && box.height > 0 && box.right > 0 && box.x < window.innerWidth
          && box.bottom > 0 && box.y < window.innerHeight };
    });
    return { viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }, surface: rect(scope),
      workspace: rect(scope.parentElement), rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      direction: getComputedStyle(scope).direction, animation: getComputedStyle(scope).animationName,
      horizontalOverflow: scope.scrollWidth > scope.clientWidth + 1, controls,
      content: { rect: rect(content), scrollHeight: content.scrollHeight, clientHeight: content.clientHeight },
      header: rect(scope.querySelector('header')), footer: rect(scope.querySelector('footer')) };
  });
}
function requireGeometry(geometry) {
  assert.equal(geometry.horizontalOverflow, false, 'Panel has horizontal overflow');
  assert.deepEqual(geometry.controls.filter((control) => control.visible && control.clippedX).map((value) => value.name),
    [], 'Visible controls are clipped horizontally');
  assert(geometry.header.y >= 0 && geometry.header.bottom <= geometry.viewport.height + 1, 'Header outside viewport');
  assert(geometry.footer.y >= 0 && geometry.footer.bottom <= geometry.viewport.height + 1, 'Footer outside viewport');
  assert(geometry.content.clientHeight > 0, 'Content has no scrollable height');
}
async function caseRun(id, action) {
  if (process.env.RELAY_UI_AUDIT_FILTER && !new RegExp(process.env.RELAY_UI_AUDIT_FILTER).test(id)) return;
  const errorsStart = report.errors.length;
  try {
    await reset();
    const detail = await action();
    report.cases.push({ id, status: 'pass', detail, screenshot: await capture(id),
      pageErrors: report.errors.slice(errorsStart) });
    console.log(`PASS ${id}`);
  } catch (error) {
    const detail = await diagnostic().catch(() => undefined);
    const screenshot = await capture(`failure-${id}`).catch(() => undefined);
    report.cases.push({ id, status: 'fail', error: String(error), stack: error.stack, detail, screenshot,
      pageErrors: report.errors.slice(errorsStart) });
    console.log(`FAIL ${id}: ${String(error).slice(0, 220)}`);
  }
}
try {
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark',
    locale: 'ru-RU', serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(8000);
  await page.addInitScript(initializeAuditBrowser);
  await context.route('**/*', (route) => {
    const requested = route.request().url();
    if (new URL(requested).origin === new URL(url).origin) return route.continue();
    report.blockedRequests.push(requested); return route.abort();
  });
  page.on('pageerror', (error) => report.errors.push({ type: 'pageerror', message: String(error) }));
  page.on('console', (message) => { if (message.type() === 'error') report.errors.push({ type: 'console',
    message: message.text().slice(0, 1000) }); });
  await boot();
  await caseRun('ctrl-j-close-focus-native-toggle', async () => {
    await page.locator('[data-relay-app="telegram"]').focus(); await openPanel();
    assert.equal(await page.locator('#relay-operations-history').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#relay-media-operations header button')), true);
    assert.match(await panel().innerText(), /Здесь появятся|appear here/i);
    await page.keyboard.press('Escape'); await panel().waitFor({ state: 'hidden' }); await settle();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.relayApp), 'telegram');
    await page.keyboard.press('Control+j'); await panel().waitFor({ state: 'visible' }); await settle();
    await page.keyboard.press('Control+j'); await panel().waitFor({ state: 'hidden' });
    await page.evaluate(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', ctrlKey: true, repeat: true, bubbles: true })));
    await page.keyboard.press('Control+Shift+j'); assert.equal(await panel().count(), 0);
    await page.evaluate(() => window.__relayNativeMock.emit('relay-media-toggle'));
    await panel().waitFor({ state: 'visible' });
    return { geometry: await metrics() };
  });
  await caseRun('empty-current-explicit-selection', async () => {
    await openPanel(); await page.locator('#relay-operations-current').click(); await settle();
    assert.equal(await page.locator('#relay-operations-current').getAttribute('aria-selected'), 'true',
      'Explicit Current selection must expose the empty-current state');
    assert.match(await panel().innerText(), /нет активных операций|no active/i);
    return { geometry: await metrics() };
  });
  await caseRun('last-active-auto-history', async () => {
    const current = operation(); await seed([current]); await openPanel();
    assert.equal(await page.locator('#relay-operations-current').getAttribute('aria-selected'), 'true');
    await page.evaluate((id) => window.__relayNativeMock.media.patch(id, { stage: 'completed' }), current.id);
    await page.waitForFunction(() => document.querySelector('#relay-operations-history')?.getAttribute('aria-selected') === 'true');
    assert.equal(await row(current.id).getAttribute('data-operation-stage'), 'completed');
    return { operationId: current.id, geometry: await metrics() };
  });
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 800, height: 560 }, { width: 640, height: 448 }]) {
    await caseRun(`adaptive-${viewport.width}x${viewport.height}`, async () => {
      const current = operation({ progress: { loaded: 45, total: 100 } });
      const previous = operation({ stage: 'completed', files: [savedFile()] });
      await page.setViewportSize(viewport); await settle(); await seed([current, previous]); await openPanel();
      const geometry = await metrics(); requireGeometry(geometry);
      const shouldFull = geometry.workspace.width < 64 * geometry.rem;
      assert(Math.abs(geometry.surface.width - (shouldFull ? geometry.workspace.width : 24 * geometry.rem)) < 1.5,
        'Adaptive panel width does not match full workspace or 24rem');
      assert.equal(await page.evaluate(() => window.__relayNativeMock.contentVisible), !shouldFull);
      assert.equal(await page.locator('[data-relay-app="telegram"]').isVisible(), true);
      await page.locator('#relay-operations-history').click(); await settle();
      requireGeometry(await metrics());
      return { shouldFull, geometry, historyGeometry: await metrics() };
    });
  }
  await caseRun('known-percent-unknown-stage', async () => {
    const known = operation({ progress: { loaded: 45, total: 100, index: 0, count: 2 } });
    const unknown = operation({ stage: 'resolving', progress: { loaded: 1245 } });
    await seed([known, unknown]); await openPanel();
    assert.equal(await row(known.id).locator('progress').getAttribute('value'), '45');
    assert.match(await row(known.id).innerText(), /45%/);
    assert.equal(await row(unknown.id).locator('progress').count(), 0);
    assert.equal((await row(unknown.id).innerText()).includes('%'), false);
    assert.match(await row(unknown.id).innerText(), /Определяем источник|Resolving/i);
    return { known: known.id, unknown: unknown.id, geometry: await metrics() };
  });
  await caseRun('saved-visible-format-size-dimensions', async () => {
    const completed = operation({ stage: 'completed', files: [savedFile({ fileName: 'Видео без расширения' })] });
    await seed([completed]); await openPanel(); const text = await row(completed.id).innerText();
    assert.match(text, /1\.5 MiB/); assert.match(text, /1280\s*×\s*720/);
    assert.match(text, /MP4|video\/mp4/i, 'Saved media format must be visible even for a file without an extension');
    return { operationId: completed.id, text, geometry: await metrics() };
  });
  await caseRun('prepared-send-metadata-without-url-or-path', async () => {
    const prepared = operation({ kind: 'send', service: 'instagram', stage: 'preparing', mode: 'media',
      sourceUrl: 'https://www.instagram.com/p/RelayAudit/',
      send: { accountId: '1', peerId: '101', recipientName: 'Локальный тестовый чат', confirmed: 0, total: 2 },
      media: [{ fileName: 'Подготовленное видео', mimeType: 'video/mp4', size: 1572864, width: 1280, height: 720 }] });
    await seed([prepared]); await openPanel(); const text = await row(prepared.id).innerText();
    assert.match(text, /Готовим вложения|Preparing/i); assert.match(text, /1\.5 MiB/);
    assert.match(text, /video\/mp4/); assert.match(text, /1280\s*×\s*720/);
    assert.match(text, /Подтверждено\s*0\s*\/\s*2|Confirmed/i);
    assert.equal(await row(prepared.id).locator('progress').count(), 0);
    assert.equal(await row(prepared.id).getByRole('button', { name: /Открыть файл|Open file/i }).count(), 0);
    assert.equal('path' in prepared.media[0] || 'url' in prepared.media[0], false);
    return { operationId: prepared.id, text, geometry: await metrics() };
  });
  await caseRun('file-actions-known-id-missing-file', async () => {
    const completed = operation({ stage: 'completed', files: [savedFile()] });
    await seed([completed]); await openPanel();
    await row(completed.id).getByRole('button', { name: /Открыть файл|Open file/i }).click(); await settle();
    await row(completed.id).getByRole('button', { name: /Показать в папке|Show in folder/i }).click(); await settle();
    const actions = await page.evaluate(() => window.__relayNativeMock.media.fileActions.slice(-2));
    assert.deepEqual(actions.map(({ type, id, index }) => ({ type, id, index })),
      [{ type: 'open', id: completed.id, index: 0 }, { type: 'reveal', id: completed.id, index: 0 }]);
    const calls = await page.evaluate(() => window.__relayNativeMock.calls.filter((value) =>
      value.command === 'relay_media_operation_action' && ['open', 'reveal'].includes(value.args.action.type)).slice(-2));
    assert(calls.every((value) => !('path' in value.args.action)), 'Frontend supplies IDs, not untrusted file paths');
    await page.evaluate((filePath) => window.__relayNativeMock.media.missingFiles.add(filePath), completed.files[0].path);
    await row(completed.id).getByRole('button', { name: /Открыть файл|Open file/i }).click(); await settle();
    assert.match(await row(completed.id).getByRole('alert').innerText(), /перемещён|удалён|не найден|недоступ|missing|unavailable/i);
    assert.equal(await page.evaluate(() => window.__relayNativeMock.media.fileActions.length), actions.length);
    return { operationId: completed.id, actions };
  });
  for (const [service, sourceUrl] of [['x', 'https://x.com/relay_audit/status/1234567890'],
    ['instagram', 'https://www.instagram.com/p/RelayAudit/']]) {
  await caseRun(`canonical-source-${service}-known-id-full-close`, async () => {
    const previous = operation({ kind: 'save', service, sourceUrl, stage: 'completed' });
    await page.setViewportSize({ width: 800, height: 560 }); await settle(); await seed([previous]); await openPanel();
    await row(previous.id).getByRole('button', { name: /К источнику|Source/i }).click();
    await page.waitForFunction((id) => window.__relayNativeMock.media.sourceActions.some((value) => value.id === id), previous.id);
    assert.equal(await panel().count(), 0); assert.equal(await page.evaluate(() => window.__relayNativeMock.currentApp), service);
    const call = await page.evaluate(() => window.__relayNativeMock.calls.filter((value) => value.command === 'relay_media_operation_source').at(-1));
    assert.deepEqual(call.args, { id: previous.id }); assert.equal(call.contentVisible, true);
    return { operationId: previous.id, call, sourceActions: await page.evaluate(() => window.__relayNativeMock.media.sourceActions) };
  });
  }
  await caseRun('late-epoch-revision-lock-unlock', async () => {
    const current = operation({ revision: 3, fileName: 'PRIVATE-CURRENT.mp4', progress: { loaded: 80, total: 100 } });
    await seed([current]); await openPanel();
    await page.evaluate((current) => {
      const media = window.__relayNativeMock.media;
      media.emitSnapshot({ ...media.snapshot(), epoch: media.epoch - 1,
        operations: [{ ...current, revision: 4, fileName: 'STALE-EPOCH.mp4' }] });
      media.emitSnapshot({ ...media.snapshot(), operations: [{ ...current, revision: 2, fileName: 'STALE-REVISION.mp4' }] });
    }, current); await settle();
    assert.match(await row(current.id).innerText(), /PRIVATE-CURRENT/);
    assert.doesNotMatch(await panel().innerText(), /STALE-EPOCH|STALE-REVISION/);
    await page.evaluate(() => { const media = window.__relayNativeMock.media; media.isLocked = true; media.epoch += 1; media.publish(); });
    await settle(); assert.equal(await page.locator('[data-operation-id]').count(), 0);
    assert.doesNotMatch(await panel().innerText(), /PRIVATE-CURRENT/); assert.match(await panel().innerText(), /Разблокируйте|Unlock/i);
    await page.evaluate((current) => { const media = window.__relayNativeMock.media;
      media.emitSnapshot({ epoch: media.epoch - 1, operations: [current], isLocked: false }); }, current);
    await settle(); assert.equal(await page.locator('[data-operation-id]').count(), 0);
    await page.evaluate(() => { const media = window.__relayNativeMock.media; media.isLocked = false; media.epoch += 1; media.publish(); });
    await settle(); await page.locator('#relay-operations-current').click();
    assert.match(await row(current.id).innerText(), /PRIVATE-CURRENT/);
    return { operationId: current.id, geometry: await metrics() };
  });
  await caseRun('history-clear-keeps-files-no-late-resurrection', async () => {
    const current = operation(); const previous = operation({ stage: 'completed', files: [savedFile()] });
    await seed([current, previous]); await openPanel(); await page.locator('#relay-operations-history').click();
    await panel().getByRole('button', { name: /Очистить историю|Clear history/i }).click(); await settle();
    assert.equal(await row(previous.id).count(), 1); assert.match(await panel().innerText(), /файлы остаются|files remain/i);
    await panel().getByRole('button', { name: /Очистить записи|Clear records/i }).click(); await settle();
    assert.equal(await row(previous.id).count(), 0);
    assert.equal(await page.evaluate((filePath) => window.__relayNativeMock.media.savedFiles.has(filePath), previous.files[0].path), true);
    await page.evaluate((previous) => { const media = window.__relayNativeMock.media;
      media.epoch += 1; media.emitSnapshot({ ...media.snapshot(), operations: [...media.operations, previous] }); }, previous);
    await settle(); assert.equal(await row(previous.id).count(), 0);
    await page.locator('#relay-operations-current').click(); await row(current.id).waitFor({ state: 'visible' });
    assert.equal(await row(current.id).count(), 1);
    return { current: current.id, cleared: previous.id, retainedFile: previous.files[0].path };
  });
  await caseRun('navigation-operation-continues-panel-close', async () => {
    const current = operation({ progress: { loaded: 10, total: 100 } });
    await seed([current]); await openPanel(); await selectApp('x');
    assert.equal(await panel().isVisible(), true);
    await closePanel();
    await page.evaluate((id) => window.__relayNativeMock.media.patch(id, { progress: { loaded: 70, total: 100 } }), current.id);
    await selectApp('instagram'); await openPanel();
    assert.equal(await row(current.id).locator('progress').getAttribute('value'), '70');
    return { operationId: current.id, nativeApp: await page.evaluate(() => window.__relayNativeMock.currentApp), geometry: await metrics() };
  });
  await caseRun('full-panel-sidebar-switch-content-order', async () => {
    const current = operation(); await page.setViewportSize({ width: 800, height: 560 }); await settle();
    await seed([current]); await openPanel();
    assert.equal(await page.evaluate(() => window.__relayNativeMock.contentVisible), false);
    const start = await page.evaluate(() => window.__relayNativeMock.calls.length);
    await selectApp('x'); assert.equal(await panel().count(), 0);
    const calls = await page.evaluate((start) => window.__relayNativeMock.calls.slice(start), start);
    assert.equal(await page.evaluate(() => window.__relayNativeMock.currentApp), 'x', 'Sidebar selection must activate native service');
    assert.equal(calls.find((value) => value.command === 'multi_set_active_app')?.contentVisible, true,
      'Content visibility must be restored before native activation');
    return { operationId: current.id, calls };
  });
  await caseRun('full-panel-check-chat-content-order', async () => {
    await selectApp('x'); await page.setViewportSize({ width: 800, height: 560 }); await settle();
    const uncertain = operation({ kind: 'send', service: 'x', stage: 'uncertain', mode: 'media',
      sourceUrl: 'https://x.com/relay_audit/status/1234567890',
      send: { accountId: '1', peerId: '101', recipientName: 'Локальный тестовый чат', confirmed: 1, total: 2 } });
    await seed([uncertain]); await openPanel();
    assert.match(await row(uncertain.id).innerText(), /Исход неизвестен|unknown/i);
    assert.match(await row(uncertain.id).innerText(), /Подтверждено\s*1\s*\/\s*2|Confirmed/i);
    assert.equal(await row(uncertain.id).getByRole('button', { name: /Повторить|Retry/i }).count(), 0);
    const start = await page.evaluate(() => window.__relayNativeMock.calls.length);
    await row(uncertain.id).getByRole('button', { name: /Проверить чат|Check chat/i }).click(); await settle();
    assert.equal(await panel().count(), 0);
    assert.equal(await page.evaluate(() => window.__relayNativeMock.currentApp), 'telegram', 'Check chat must activate native Telegram');
    const calls = await page.evaluate((start) => window.__relayNativeMock.calls.slice(start), start);
    assert.equal(calls.find((value) => value.command === 'multi_set_active_app')?.contentVisible, true);
    await page.waitForFunction(() => window.__relayAudit.state().currentChatId === '101');
    return { operationId: uncertain.id, calls, state: await page.evaluate(() => window.__relayAudit.state()) };
  });
  await caseRun('cancel-confirmed-file-warning-recovery', async () => {
    const current = operation();
    const previous = operation({ stage: 'completed', files: [savedFile()], journalWarning: 'MEDIA_JOURNAL_UNAVAILABLE' });
    await seed([current, previous]); await openPanel();
    await row(current.id).getByRole('button', { name: /Отменить|Cancel/i }).click();
    await page.waitForFunction((id) => window.__relayNativeMock.media.get(id).stage === 'cancelled', current.id); await settle();
    await page.locator('#relay-operations-history').click();
    assert.equal(await row(current.id).getAttribute('data-operation-stage'), 'cancelled');
    assert.equal(await row(previous.id).getAttribute('data-operation-stage'), 'completed');
    assert.match(await row(previous.id).getByRole('alert').innerText(), /защищённую историю|журнал|journal/i);
    assert.equal(await row(previous.id).getByRole('button', { name: /Открыть файл|Open file/i }).isEnabled(), true);
    return { cancelled: current.id, warning: previous.id, geometry: await metrics() };
  });
  await caseRun('keyboard-tabs-rtl-long-text', async () => {
    const current = operation({ fileName: 'اسم الملف ' + 'Очень_длинное_имя_'.repeat(20) });
    const previous = operation({ stage: 'completed' }); await seed([current, previous]); await openPanel();
    await page.locator('#relay-operations-current').focus(); await page.keyboard.press('End'); await settle();
    assert.equal(await page.locator('#relay-operations-history').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'relay-operations-history');
    await page.keyboard.press('Home'); await settle(); assert.equal(await page.locator('#relay-operations-current').getAttribute('aria-selected'), 'true');
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; }); await settle();
    const geometry = await metrics(); requireGeometry(geometry); assert.equal(geometry.direction, 'rtl');
    assert.equal(await row(current.id).locator('h3').getAttribute('dir'), 'auto');
    await page.keyboard.press('ArrowLeft'); await settle(); assert.equal(await page.locator('#relay-operations-history').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Escape'); await panel().waitFor({ state: 'hidden' });
    await openPanel(); return { geometry, operationId: current.id };
  });
  await caseRun('text-200pct-reduced-motion-bounds', async () => {
    await selectApp('x');
    const current = operation({ progress: { loaded: 30, total: 100 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; }); await settle();
    await seed([current]); const start = await page.evaluate(() => window.__relayNativeMock.calls.length);
    await openPanel(); const geometry = await metrics(); requireGeometry(geometry);
    assert.equal(geometry.rem, 32); assert.equal(geometry.animation, 'none');
    assert(Math.abs(geometry.surface.width - geometry.workspace.width) < 1.5);
    await page.waitForTimeout(600);
    const calls = await page.evaluate((start) => window.__relayNativeMock.calls.slice(start), start);
    const bounds = calls.filter((value) => value.command === 'multi_update_x_bounds');
    assert(bounds.length >= 1, 'Social WebView bounds callback is exercised');
    assert(bounds.length <= 4, 'Native bounds must not update on every animation frame');
    return { geometry, nativeBoundsCalls: bounds.length, calls };
  });

  await caseRun('full-panel-hidden-profile-keyboard-restoration', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
      window.__relayAudit.loadChats();
      window.__relayAudit.simulateConnected();
    });
    await page.waitForFunction(() => window.__relayAudit.state().chatCount >= 2);
    await page.evaluate(() => window.__relayAudit.openChat('101'));
    await page.locator('#MiddleColumn').waitFor({ state: 'visible' });
    await page.evaluate(() => window.__relayAudit.groups.openRight('ChatInfo'));
    await settle(); await seed([operation()]); await openPanel();
    const geometry = await metrics(); requireGeometry(geometry);
    assert(Math.abs(geometry.surface.width - geometry.workspace.width) < 1.5);
    const hiddenFocus = [];
    for (const key of [...Array(25).fill('Tab'), ...Array(25).fill('Shift+Tab')]) {
      await page.keyboard.press(key);
      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        return element?.closest('#relay-telegram-pane') ? {
          tag: element.tagName, label: element.getAttribute('aria-label') || element.textContent.slice(0, 80),
        } : undefined;
      });
      if (focused) hiddenFocus.push(focused);
    }
    assert.deepEqual(hiddenFocus, [], 'Tab enters hidden Telegram/profile while full operations panel is open');
    assert.equal(await page.locator('#relay-telegram-pane').evaluate((element) => element.inert), true);
    assert.equal(await page.locator('#relay-telegram-pane').getAttribute('aria-hidden'), 'true');
    await closePanel();
    assert.equal(await page.locator('#relay-telegram-pane').evaluate((element) => element.inert), false);
    assert.equal(await page.locator('#relay-telegram-pane').getAttribute('aria-hidden'), 'false');
    const profileControl = page.locator('#RightColumn button').first();
    await profileControl.focus();
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('#relay-telegram-pane'))), true);
    await selectApp('x');
    assert.equal(await page.locator('#relay-telegram-pane').evaluate((element) => element.inert), true);
    await selectApp('telegram');
    assert.equal(await page.locator('#relay-telegram-pane').evaluate((element) => element.inert), false);
    return { geometry, hiddenFocus, preservedProfile: await page.locator('#RightColumn').count() };
  });

} catch (error) {
  report.fatal = { error: String(error), stack: error.stack, diagnostic: await diagnostic().catch(() => undefined) };
  if (page) report.fatal.screenshot = await capture('fatal').catch(() => undefined);
} finally {
  report.sourceHashesAfter = await sourceHashes();
  report.sourcesChangedDuringRun = sources.filter((source) => report.sourceHashes[source] !== report.sourceHashesAfter[source]);
  report.unhandled = await page?.evaluate(() => window.__relayUnhandled).catch(() => []);
  await browser?.close(); await server.close();
  report.summary = { passed: report.cases.filter((item) => item.status === 'pass').length,
    failed: report.cases.filter((item) => item.status === 'fail').length, total: report.cases.length };
  const reportName = `operations-ui-audit-${runId}.json`;
  await writeFile(path.join(evidenceOutput, reportName), `${JSON.stringify(report, undefined, 2)}\n`);
  const markdown = ['# Relay 1.5.0: browser operations acceptance', '',
    `Run: ${runId}. ${report.summary.passed}/${report.summary.total} passed; ${report.summary.failed} failed.`, '',
    'Real App/Panel, existing MockClient, terminal native mocks; all external requests blocked. Windows COM, physical DPI, live delivery and actual filesystem actions require separate native checks.', '',
    '| Case | Result | Evidence |', '| --- | --- | --- |',
    ...report.cases.map((item) => `| ${item.id} | ${item.status}${item.error ? `: ${item.error.replace(/\n/g, ' ').replace(/\|/g, '\\|')}` : ''} | [Screenshot](${item.screenshot}) |`), '',
    `Machine-readable details: [${reportName}](${reportName}). Source hashes and precise native call order are attached to every failure.`, '',
    'Review: parent release board aggregates these cases under relay-1.5.0-operations-ui-acceptance. An approval accepts this evidence for the browser scope; it does not authorize release or substitute for native acceptance.', ''];
  await writeFile(path.join(evidenceOutput, `operations-ui-audit-${runId}.md`), markdown.join('\n'));
  console.log(JSON.stringify({ report: path.join(evidenceOutput, reportName), ...report.summary, fatal: report.fatal?.error,
    sourcesChangedDuringRun: report.sourcesChangedDuringRun }));
  if (report.fatal || report.summary.failed) process.exitCode = 1;
}
