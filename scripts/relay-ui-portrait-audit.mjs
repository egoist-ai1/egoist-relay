// Изолированная проверка интерфейса в портретном окне 1440x2560 (монитор владельца).
// Настоящий App на существующем MockClient и заглушках Tauri; удалённые запросы заблокированы.
// RELAY_UI_AUDIT_OUTPUT — рабочая папка, RELAY_UI_AUDIT_BROWSER — установленный Chromium/Edge.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { initializeAuditBrowser, startAuditServer } from './relay-ui-audit.server.mjs';

const output = process.env.RELAY_UI_AUDIT_OUTPUT;
const browserExecutable = process.env.RELAY_UI_AUDIT_BROWSER;
if (!output || !browserExecutable) throw new Error('Set RELAY_UI_AUDIT_OUTPUT and RELAY_UI_AUDIT_BROWSER.');
await mkdir(path.join(output, 'portrait'), { recursive: true });
const sizes = (process.env.RELAY_UI_PORTRAIT_SIZES || '1440x2560,1368x2519,1080x1920,900x1600')
  .split(',').map((value) => value.split('x').map(Number));
const { server, url } = await startAuditServer(output, Number(process.env.RELAY_UI_AUDIT_PORT || 1262));
const results = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  for (const [width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark', locale: 'ru-RU', serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.addInitScript(initializeAuditBrowser);
    await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-relay-app="telegram"]', { timeout: 60000 });
    await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1');
    if (process.env.RELAY_UI_PORTRAIT_CSS) await page.addStyleTag({ content: process.env.RELAY_UI_PORTRAIT_CSS });
    await page.waitForTimeout(600);
    const measure = () => page.evaluate(() => {
      const rect = (element) => { const { x, y, width, height, right, bottom } = element.getBoundingClientRect(); return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), right: Math.round(right), bottom: Math.round(bottom) }; };
      const shown = (element) => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !element.closest('[aria-hidden="true"],.Transition_slide-inactive'); };
      const controls = [...document.querySelectorAll('button,input,textarea,[role="button"],[role="tab"]')].filter(shown);
      const outside = controls.filter((e) => { const r = e.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1 || r.x < -1 || r.y < -1; })
        .map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40));
      const small = controls.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).length;
      const layout = ['#LeftColumn', '#MiddleColumn', '#RightColumn', 'nav', '[class*="Titlebar-module__titlebar"]'].map((selector) => {
        const element = document.querySelector(selector); return element && shown(element) ? [selector, rect(element)] : [selector, null]; });
      return { viewport: [window.innerWidth, window.innerHeight], fontSize: getComputedStyle(document.documentElement).fontSize, outside, small, controls: controls.length,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1, layout };
    });
    const shot = async (name) => { const file = `portrait/${width}x${height}-${name}.png`; await page.screenshot({ path: path.join(output, file) }); return file; };
    const entry = { size: `${width}x${height}`, steps: [], errors };
    entry.steps.push({ step: 'boot', ...(await measure()), screenshot: await shot('boot') });
    await page.waitForFunction(() => window.__relayAudit.state().chatCount >= 2, { timeout: 10000 });
    await page.evaluate(() => window.__relayAudit.openChat('101'));
    await page.waitForSelector('#MiddleColumn', { state: 'visible' }); await page.waitForTimeout(700);
    entry.steps.push({ step: 'chat', ...(await measure()), screenshot: await shot('chat') });
    await page.evaluate(() => window.__relayAudit.openSettings('General')); await page.waitForTimeout(700);
    entry.steps.push({ step: 'settings-general', ...(await measure()), screenshot: await shot('settings-general') });
    await page.evaluate(() => window.__relayAudit.openOverlay?.('controls')); await page.waitForTimeout(500);
    entry.steps.push({ step: 'overlay-controls', ...(await measure()), screenshot: await shot('overlay-controls') });
    await page.evaluate(() => window.__relayAudit.openOverlay?.(undefined));
    results.push(entry);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
await writeFile(path.join(output, 'portrait', 'results.json'), JSON.stringify(results, null, 2));
for (const entry of results) {
  for (const step of entry.steps) {
    console.log(entry.size, step.step, `controls=${step.controls} small=${step.small} outside=${JSON.stringify(step.outside)} overflowX=${step.overflowX} font=${step.fontSize}`);
  }
  if (entry.errors.length) console.log(entry.size, 'pageerrors', entry.errors.slice(0, 3));
}
assert.ok(results.length > 0);
