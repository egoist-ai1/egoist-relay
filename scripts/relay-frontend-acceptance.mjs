import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { project, initializeAuditBrowser, startAuditServer } from './relay-ui-audit.server.mjs';
const output = process.env.RELAY_UI_AUDIT_OUTPUT;
const evidence = process.env.RELAY_UI_AUDIT_EVIDENCE;
const executablePath = process.env.RELAY_UI_AUDIT_BROWSER;
if (!output || !evidence || !executablePath) throw new Error('Set audit output/evidence/browser paths.');
await mkdir(evidence, { recursive: true });
const sources = ['src/styles/index.scss', 'src/util/antigravityThemes.ts', 'src/util/applyMessageTextSize.ts',
  'src/components/main/Main.scss', 'src/components/middle/MiddleHeader.scss', 'src/components/middle/MiddleColumn.scss',
  'src/components/multi/MediaOperationsPanel.module.scss', 'src/components/common/Avatar.scss',
  'src/components/common/profile/ProfilePhoto.scss', 'src/components/multi/MediaOperationsPanel.tsx',
  'src/global/actions/ui/initial.ts', 'scripts/relay-frontend-acceptance.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async (name) => [name,
  createHash('sha256').update(await readFile(path.join(project, name))).digest('hex')])));
const report = { generatedAt: new Date().toISOString(), sources: await hashes(), transport: 'Actual App with existing MockClient and terminal native mocks',
  limitations: ['No live Telegram/network/file effects', 'Headless Edge, not native WebView2/DPI/GPU'], cases: [], errors: [] };
const { server, url } = await startAuditServer(output, Number(process.env.RELAY_UI_AUDIT_PORT || 1284));
let browser, page;
const settle = async () => { await page.waitForTimeout(350); await page.evaluate(() => document.fonts.ready); };
async function closePanel() { if (await page.locator('#relay-media-operations').count()) { await page.locator('#relay-media-operations header button').click(); await settle(); } }
async function reset(width = 1920, height = 1080, size = 16) {
  await closePanel(); await page.setViewportSize({ width, height });
  await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; document.documentElement.dir = 'ltr';
    window.__relayAudit.applyTheme('egoist-dark'); window.__relayAudit.setMessageSize(16); window.__relayAudit.openChat('101'); }, size);
  await settle();
}
async function dimensions() {
  return page.evaluate(() => {
    const rect = (selector) => { const e = document.querySelector(selector); if (!e) return undefined;
      const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { x: r.x, y: r.y, width: r.width, height: r.height,
        bottom: r.bottom, bg: s.backgroundColor, image: s.backgroundImage, color: s.color, font: s.fontFamily, size: s.fontSize, overflow: s.overflow }; };
    return { body: rect('body'), root: rect('.App-module__multiRoot'), header: rect('.MiddleHeader'),
      left: rect('#LeftColumn'), middle: rect('#MiddleColumn'), composer: rect('.Composer'), background: rect('.messages-layout'), input: rect('#message-input-text'),
      placeholder: rect('#message-input-text .placeholder-text'), message: rect('.Message .text-content'),
      panel: rect('#relay-media-operations'), list: rect('#relay-operations-list'), footer: rect('#relay-media-operations footer'),
      layers: document.elementsFromPoint(1000, 300).slice(0, 5).map((e) => ({ className: e.className,
        bg: getComputedStyle(e).backgroundColor, image: getComputedStyle(e).backgroundImage })),
      nominalSize: document.documentElement.dataset.messageTextSize };
  });
}
async function run(id, action) {
  if(process.env.RELAY_UI_AUDIT_FILTER && !new RegExp(process.env.RELAY_UI_AUDIT_FILTER).test(id))return;
  try { const detail = await action(); await page.screenshot({ path: path.join(evidence, `${id}.png`) });
    report.cases.push({ id, status: 'pass', detail }); console.log(`PASS ${id}`);
  } catch (error) { const detail = await dimensions().catch(() => undefined);
    await page.screenshot({ path: path.join(evidence, `failure-${id}.png`) }).catch(() => undefined);
    report.cases.push({ id, status: 'fail', error: String(error), detail }); console.log(`FAIL ${id}: ${error}`); }
}
const items = [{ id: 'd8406c70-1c56-4313-81c5-b8d0ca4e0111', attempt: 1, revision: 1, kind: 'save', service: 'instagram',
  sourceUrl: 'https://www.instagram.com/p/RELAYAUDIT/', fileName: 'Набережная.jpg', stage: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
  files: [{ path: 'C:/RelayAuditDownloads/Набережная.jpg', fileName: 'Набережная.jpg', mimeType: 'image/jpeg', size: 3156224, width: 3000, height: 2000 }] }];
const panel = async () => { await page.evaluate((items) => window.__relayNativeMock.media.seed(items, false), items);
  await page.keyboard.press('Control+j'); await page.waitForSelector('#relay-media-operations'); await settle(); };
try {
  browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-background-networking'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block', locale: 'ru-RU' });
  await context.addInitScript(initializeAuditBrowser);
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
  page = await context.newPage(); page.on('pageerror', (error) => report.errors.push(String(error)));
  await page.goto(url); await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1', undefined, { timeout: 60000 });
  await page.evaluate(() => { window.__relayAudit.loadChats(); window.__relayAudit.simulateConnected(); });
  await page.waitForFunction(() => window.__relayAudit.state().chatCount >= 2); await reset();
  await run('black-surfaces-aligned-header', async () => { const d = await dimensions();
    assert.equal(d.root.bg, 'rgb(0, 0, 0)'); assert.equal(d.header.bg, 'rgb(0, 0, 0)');
    assert(Math.abs(d.header.x - d.middle.x) < 1 && Math.abs(d.header.width - d.middle.width) < 1);
    assert(d.body.font.includes('Inter')); assert.equal(d.background.image, 'none'); return d; });
  await run('reading-width-1100-with-panel', async () => { await reset(1100, 800); await panel(); const d = await dimensions();
    assert.equal(d.panel.width, 384); assert(d.middle.width >= 320, `Reading column only ${d.middle.width}px`); return d; });
  await run('result-after-notification-duration', async () => { await page.waitForTimeout(6200);
    const result = await page.locator('[data-operation-id="d8406c70-1c56-4313-81c5-b8d0ca4e0111"]').innerText();
    assert(result.includes('Набережная.jpg') && result.includes('3000')); return { elapsedMs: 6200, result }; });
  await run('text-200-percent-and-configured-size', async () => { await reset(); const before = await dimensions(); await reset(1920, 1080, 32); const after = await dimensions();
    assert.equal(Number.parseFloat(after.body.size), Number.parseFloat(before.body.size) * 2);
    assert.equal(Number.parseFloat(after.message.size), Number.parseFloat(before.message.size) * 2);
    await page.evaluate(() => window.__relayAudit.setMessageSize(18)); await settle(); const changed = await dimensions();
    assert.equal(changed.nominalSize, '18'); assert.equal(Number.parseFloat(changed.message.size), 36); return { before, after, changed }; });
  await run('minimum-window-text-200-percent', async () => { await reset(640, 448, 32); await panel(); const d = await dimensions();
    assert(d.list.height >= 100, 'Operation content must show at least two enlarged text lines'); assert(d.footer.bottom <= 449, 'Footer outside window');
    assert(d.panel.width <= 640); await page.locator('#relay-media-operations footer button').focus(); await settle();
    const clear = await page.locator('#relay-media-operations footer button').boundingBox();
    assert(clear.y >= d.footer.y - 1 && clear.y + clear.height <= d.footer.bottom + 1, 'Focused clear action clipped'); return d; });
  await run('resize-full-panel-focus-restoration', async () => {
    await reset(1100, 800);
    const input = page.locator('.Composer [contenteditable=true]').first();
    await input.focus();
    await page.keyboard.press('Control+j'); await settle();
    await input.focus();
    await page.setViewportSize({ width: 800, height: 560 }); await settle();
    const focus = await page.evaluate(() => ({
      isInPanel: document.querySelector('#relay-media-operations').contains(document.activeElement),
      activeClass: document.activeElement.className,
      isMainInert: Boolean(document.querySelector('#Main').closest('[inert]')),
    }));
    assert(focus.isMainInert, 'Covered service remains interactive');
    assert(focus.isInPanel, 'Resize left keyboard focus outside the working panel');
    await page.keyboard.press('Escape'); await settle();
    const restored = await input.evaluate((e) => e === document.activeElement);
    assert(restored, 'Closing panel did not restore the retained composer');
    return { focus, restored }; });  await run('light-theme-retention-and-selected-text', async () => { await reset(); await page.evaluate(() => window.__relayAudit.applyTheme('light-modern')); await settle();
    const colors = await page.locator('.chat-item-clickable.selected').evaluate((e) => ({ color: getComputedStyle(e).color,
      primaryText: getComputedStyle(e.querySelector('.title') || e).color, bg: getComputedStyle(e).backgroundColor }));
    assert.notEqual(colors.primaryText, 'rgb(255, 255, 255)'); await page.reload();
    await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1', undefined, { timeout: 60000 }); await settle();
    const theme = await page.evaluate(() => window.localStorage.getItem('egoist_theme_variant'));
    assert.equal(theme, 'light-modern');
    const restored = await dimensions();
    const themeClass = await page.evaluate(() => document.documentElement.className);
    assert(themeClass.includes('theme-light') && !themeClass.includes('theme-dark'), 'Stored base theme replaced on boot');
    assert.equal(restored.root.bg, 'rgb(248, 248, 248)', 'Stored palette replaced on boot');
    return { colors, retainedTheme: theme, themeClass, layout: restored }; });
  await run('saved-messages-icon-contrast', async () => { await reset();
    await page.locator('[data-relay-app=instagram]').click(); await settle();
    await page.evaluate(() => window.__relayNativeMock.emit('multi-social-share', { requestId: 'frontend-icon-contrast-0001',
      service: 'instagram', url: 'https://www.instagram.com/p/RELAYAUDIT/', unavailableMedia: true }));
    await page.getByRole('dialog').waitFor({state:'visible'}); await settle();
    const icons = await page.getByRole('dialog').locator('.icon').evaluateAll((elements) => elements
      .filter((e) => e.className.includes('saved')).map((e) => ({className:e.className, color:getComputedStyle(e).color,
        parentClass:e.parentElement.className, parentColor:getComputedStyle(e.parentElement).color, avatarClass:e.closest('.Avatar').className, avatarColor:getComputedStyle(e.closest('.Avatar')).color, avatarPrimaryText:getComputedStyle(e.closest('.Avatar')).getPropertyValue('--color-primary-text'), rootPrimaryText:getComputedStyle(document.documentElement).getPropertyValue('--color-primary-text')})));
    const matches = await page.getByRole('dialog').locator('.Avatar.saved-messages').evaluate((avatar) => {
      const rules = []; const walk = (items, source) => { for (const rule of items) {
        if(rule.cssRules)walk(rule.cssRules, source);
        if(!rule.selectorText || !rule.style?.getPropertyValue('color'))continue;
        try {if(avatar.matches(rule.selectorText))rules.push({ source, selector:rule.selectorText,
          color:rule.style.getPropertyValue('color'), priority:rule.style.getPropertyPriority('color') });}catch { /* Ignore selectors unsupported by this browser */ }
      }};
      for(const sheet of document.styleSheets){try{walk(sheet.cssRules, sheet.ownerNode?.getAttribute('data-vite-dev-id'));}catch { /* Ignore unreadable stylesheet rules */ }}
      return {style:avatar.getAttribute('style'), rules};
    });
    report.contrastTrace = matches;
    assert.equal(icons.length, 1, `Exactly one saved icon required: ${JSON.stringify(icons)}`);
    assert.equal(icons[0].color, 'rgb(0, 0, 0)', `Primary foreground contrast: ${JSON.stringify(icons)}`); return { icons };
  });
} finally {
  report.sourcesAfter = await hashes(); report.sourcesChanged = Object.keys(report.sources).filter((name) => report.sources[name] !== report.sourcesAfter[name]);
  report.passed = report.cases.filter((c) => c.status === 'pass').length; report.failed = report.cases.filter((c) => c.status === 'fail').length;
  await writeFile(path.join(evidence, 'frontend-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, errors: report.errors, sourcesChanged: report.sourcesChanged }));
  await browser?.close(); await server.close(); if (report.failed || report.errors.length || report.sourcesChanged.length) process.exitCode = 1;
}