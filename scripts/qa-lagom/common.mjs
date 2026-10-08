import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
// Общая обвязка проверок Lagom на изолированном UI (MockClient). Браузер: Playwright chromium из %LOCALAPPDATA%\ms-playwright.
import { fileURLToPath } from 'node:url';
export const project = process.env.RELAY_PROJECT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(project, 'package.json'));
export const { chromium } = req('@playwright/test');
export const Color = req('colorjs.io').default ?? req('colorjs.io');
const srv = await import(pathToFileURL(path.join(project, 'scripts', 'relay-ui-audit.server.mjs')).href);
export async function boot({ port, width = 1280, height = 800, theme = 'lagom-dark', rootFontSize }) {
  const { server, url } = await srv.startAuditServer(path.join(process.env.TEMP, `relay-qa-cache-${port}`), port);
  const browser = await chromium.launch({ headless: true,
    executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1243", "chrome-win64", "chrome.exe"), args: ['--disable-background-networking'] });
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', locale: 'ru-RU' });
  await context.addInitScript(srv.initializeAuditBrowser);
  // Размер шрифта корня задаётся до старта приложения: список чатов позиционируется при первом рендере
  if (rootFontSize) await context.addInitScript((v) => { const apply = () => { if (document.documentElement) { document.documentElement.style.fontSize = v + 'px'; return true; } return false; };
    if (!apply()) { const mo = new MutationObserver(() => { if (apply()) mo.disconnect(); }); mo.observe(document, { childList: true }); } }, rootFontSize);
  await context.route('**/*', (r) => new URL(r.request().url()).origin === new URL(url).origin ? r.continue() : r.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { timeout: 150000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1', undefined, { timeout: 120000 });
  await page.evaluate(() => { window.__relayAudit.loadChats(); window.__relayAudit.simulateConnected(); });
  await page.waitForFunction(() => window.__relayAudit.state().chatIds.includes('101'), undefined, { timeout: 60000 });
  const settle = async (ms = 400) => { await page.waitForTimeout(ms); await page.evaluate(() => document.fonts.ready); };
  const reset = async (w, h, t = theme, size = 16) => {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(([t, size]) => { document.documentElement.style.fontSize = `${size}px`; window.__relayAudit.applyTheme(t); window.__relayAudit.setMessageSize(16); window.__relayAudit.openChat('101'); }, [t, size]);
    await settle();
  };
  const resetFresh = async (w, h, t = theme, size = 16) => {
    await page.evaluate((v) => window.localStorage.setItem('qa_font', String(v)), size);
    await page.setViewportSize({ width: w, height: h });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 150000 });
    await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1', undefined, { timeout: 120000 });
    await page.evaluate(() => { window.__relayAudit.loadChats(); window.__relayAudit.simulateConnected(); });
    await page.waitForFunction(() => window.__relayAudit.state().chatIds.includes('101'), undefined, { timeout: 60000 });
    await reset(w, h, t, size);
  };
  return { server, browser, page, errors, settle, reset, resetFresh, url, close: async () => { await browser.close(); await server.close(); } };
}
