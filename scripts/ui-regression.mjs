import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.RELAY_UI_TEST_OUTPUT;
if (!output) throw new Error('Set RELAY_UI_TEST_OUTPUT to this task work directory.');
await mkdir(output, { recursive: true });
await mkdir(path.join(output, 'matrix'), { recursive: true });
const strings = {};
const fallback = await readFile(path.join(project, 'src/assets/localization/fallback.strings'), 'utf8');
for (const match of fallback.matchAll(/^"([^"\n]+)"\s*=\s*("(?:[^"\\]|\\.)*");/gm)) {
  try { strings[match[1]] = JSON.parse(match[2]); } catch { /* Unused non-JSON Telegram entries */ }
}

const virtualLang = '\0relay-ui-language';
const virtualIcon = '\0relay-ui-icon';
const virtualWindow = '\0relay-ui-window';
const server = await createServer({
  root: project,
  configFile: false,
  cacheDir: path.join(output, 'vite-cache'),
  envPrefix: ['TG_'],
  define: { APP_VERSION: JSON.stringify('ui-test'), 'import.meta.env.TG_APP_ENV': JSON.stringify('test') },
  oxc: { jsx: { runtime: 'automatic', importSource: '@teact' } },
  optimizeDeps: { noDiscovery: true, entries: [] },
  resolve: { alias: { '@teact': path.join(project, 'src/lib/teact') } },
  css: { modules: { localsConvention: 'camelCase', generateScopedName: '[name]__[local]' } },
  server: { host: '127.0.0.1', port: Number(process.env.RELAY_UI_TEST_PORT || 1247), strictPort: true, watch: null },
  plugins: [{
    name: 'relay-ui-synthetic-fixture',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@tauri-apps/api/window') return virtualWindow;
      if (importer && /\/src\//.test(importer.replaceAll('\\', '/'))) {
        if (source.endsWith('/useLang')) return virtualLang;
        if (source.endsWith('/icons/Icon')) return virtualIcon;
      }
      if (importer?.endsWith('ui-regression.fixture.tsx') && source.endsWith('/useLang')) return virtualLang;
      return undefined;
    },
    load(id) {
      if (id === virtualLang) return `const strings=${JSON.stringify(strings)};
        const lang=(key,vars={})=>(strings[key]||key).replace(/\\{(\\w+)\\}/g,(_,name)=>String(vars[name]??name));
        lang.number=(value)=>new Intl.NumberFormat('ru').format(value); export default ()=>lang;`;
      if (id === virtualIcon) return `import Teact from '/src/lib/teact/teact.ts';
        export default ({name,className})=>Teact.createElement('i',{className:'icon icon-'+name+' '+(className||''),'aria-hidden':true});`;
      if (id === virtualWindow) return `export function getCurrentWindow(){ return window.__relayWindowMock; }`;
      return undefined;
    },
    configureServer(instance) {
      instance.middlewares.use('/ui-regression', (_request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body class="is-tauri theme-dark"><div id="root" style="height:100%"></div><script type="module" src="/scripts/ui-regression.fixture.tsx"></script></body></html>');
      });
    },
  }],
});

let browser;
const evidence = { timestamp: new Date().toISOString(), cases: [], checks: [], errors: [] };
try {
  await server.listen();
  console.log('UI fixture server ready');
  browser = await chromium.launch({ channel: process.env.RELAY_UI_BROWSER || 'msedge', headless: true });
  console.log('Synthetic browser ready');
  const context = await browser.newContext({ viewport: { width: 800, height: 560 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const initializeWindowMock = () => {
    window.isTauri = true;
    window.__relayWindowCalls = [];
    window.__relayResizeCallbacks = [];
    window.__relayRejectResize = false;
    window.__relayIsMaximized = false;
    window.__relayWindowMock = {
      isMaximized: async () => {
        if (window.__relayRejectResize) throw new Error('Synthetic resize query failure');
        return window.__relayIsMaximized;
      },
      minimize: async () => window.__relayWindowCalls.push('minimize'),
      toggleMaximize: async () => {
        window.__relayWindowCalls.push('toggleMaximize');
        window.__relayIsMaximized = !window.__relayIsMaximized;
      },
      close: async () => window.__relayWindowCalls.push('close'),
      onResized: async (callback) => {
        window.__relayResizeCallbacks.push(callback);
        return () => { window.__relayResizeCallbacks = window.__relayResizeCallbacks.filter((item) => item !== callback); };
      },
    };
    window.__relayUnhandled = [];
    window.addEventListener('unhandledrejection', (event) => window.__relayUnhandled.push(String(event.reason)));
  };
  await page.addInitScript(initializeWindowMock);
  page.on('pageerror', (error) => { evidence.errors.push(String(error)); console.error(error); });
  const url = `http://127.0.0.1:${server.config.server.port}/ui-regression`;
  await page.goto(url, { waitUntil: 'networkidle' });
  console.log('UI fixture loaded');
  await page.waitForSelector('[data-relay-app="telegram"]');
  await page.evaluate(() => document.fonts.ready);

  const setModel = async (patch) => {
    await page.evaluate((value) => window.__relayUiHarness.setModel(value), patch);
    await page.waitForTimeout(80);
  };
  const measure = async () => page.evaluate(() => {
    const rect = (element) => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const titlebar = document.querySelector('[class*="Titlebar-module__titlebar"]');
    const sidebar = document.querySelector('nav');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio },
      sidebar: rect(sidebar), titlebar: rect(titlebar),
      titlebarScrollWidth: titlebar.scrollWidth,
      titlebarClientWidth: titlebar.clientWidth,
      buttons: Array.from(document.querySelectorAll('button')).filter((element) => element.getClientRects().length)
        .map((element) => ({ label: element.getAttribute('aria-label') || element.textContent, disabled: element.disabled,
          rect: rect(element), font: getComputedStyle(element).fontFamily })),
      panes: Array.from(document.querySelectorAll('[id$="-pane"]')).map((element) => ({
        id: element.id, visible: element.getClientRects().length > 0, rect: rect(element),
      })),
      content: Array.from(document.querySelectorAll('[class*="App-module__xContentArea"]'))
        .filter((element) => element.getClientRects().length)
        .map((element) => ({ rect: rect(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight, clientHeight: element.clientHeight })),
      status: Array.from(document.querySelectorAll('[class*="App-module__xStatus"]')).filter((element) => element.getClientRects().length)
        .map((element) => ({ text: element.textContent, rect: rect(element) })),
    };
  });

  const scenarios = [
    { name: 'telegram', activeApp: 'telegram', xAppState: 'idle', instagramAppState: 'idle' },
    { name: 'x-loading', activeApp: 'x', xAppState: 'loading', instagramAppState: 'idle' },
    { name: 'x-auth-notice', activeApp: 'x', xAppState: 'auth-required', notice: strings.RelayAppSwitchError },
    { name: 'x-ready', activeApp: 'x', xAppState: 'ready', notice: undefined },
    { name: 'x-error', activeApp: 'x', xAppState: 'error' },
    { name: 'instagram-loading', activeApp: 'instagram', instagramAppState: 'loading' },
    { name: 'instagram-ready', activeApp: 'instagram', instagramAppState: 'ready' },
    { name: 'instagram-error', activeApp: 'instagram', instagramAppState: 'error' },
    { name: 'long-operation-notice', activeApp: 'x', xAppState: 'auth-required',
      notice: `${strings.RelayDownloadFailed} ${strings.RelayAppSwitchError}` },
  ];
  for (const viewport of [{ width: 800, height: 560 }, { width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 640, height: 448 }, { width: 533, height: 373 }]) {
    await page.setViewportSize(viewport);
    for (const scenario of scenarios) {
      await setModel({ ...scenario, notice: scenario.notice });
      const geometry = await measure();
      const issues = [];
      if (geometry.titlebarScrollWidth > geometry.titlebarClientWidth + 1) issues.push('titlebar-overflow');
      for (const button of geometry.buttons) {
        if (button.rect.x < -0.1 || button.rect.y < -0.1 || button.rect.right > viewport.width + 0.1 || button.rect.bottom > viewport.height + 0.1) issues.push(`button-outside:${button.label}`);
        if (button.rect.width < 24 || button.rect.height < 24) issues.push(`small-target:${button.label}`);
      }
      for (const content of geometry.content) {
        if (content.scrollWidth > content.clientWidth + 1) issues.push('status-horizontal-overflow');
      }
      const titlebarButtons = geometry.buttons.filter((button) => button.rect.y < 40 && button.rect.x >= 72);
      for (let index = 1; index < titlebarButtons.length; index++) {
        if (titlebarButtons[index].rect.x < titlebarButtons[index - 1].rect.right - 0.5) issues.push('titlebar-button-overlap');
      }
      evidence.cases.push({ name: scenario.name, ...geometry, issues });
      await page.evaluate(async () => Promise.all(document.getAnimations()
        .filter((animation) => animation instanceof window.CSSTransition)
        .map((animation) => animation.finished.catch(() => {}))));
      await page.screenshot({ path: path.join(output, 'matrix', `${viewport.width}-${viewport.height}-${scenario.name}.png`) });
      if (viewport.width === 800 && ['telegram', 'x-auth-notice', 'long-operation-notice'].includes(scenario.name)) {
        await page.screenshot({ path: path.join(output, `${viewport.width}-${scenario.name}.png`) });
      }
    }
  }

  await page.setViewportSize({ width: 800, height: 560 });
  await setModel({ activeApp: 'telegram', xAppState: 'ready', instagramAppState: 'ready', notice: undefined });
  const telegram = page.locator('[data-relay-app="telegram"]');
  await telegram.focus();
  for (const [key, app] of [['ArrowDown', 'x'], ['ArrowDown', 'instagram'], ['ArrowDown', 'telegram'], ['ArrowUp', 'instagram'], ['Home', 'telegram'], ['End', 'instagram']]) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.relayApp), app);
  }
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-relay-app="instagram"]').getAttribute('aria-current') === 'page');
  assert.equal(await page.locator('[data-relay-app="instagram"]').getAttribute('aria-current'), 'page');
  evidence.checks.push('sidebar-arrow-home-end-enter');
  await telegram.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-relay-app="telegram"]').getAttribute('aria-current') === 'page');
  assert.equal(await telegram.getAttribute('aria-current'), 'page');
  evidence.checks.push('sidebar-space-activation');
  assert.equal(await telegram.evaluate((element) => getComputedStyle(element).outlineStyle), 'solid');
  assert.equal(await page.locator('#relay-x-pane').isVisible(), false);
  assert.equal(await page.locator('#relay-instagram-pane').isVisible(), false);
  evidence.checks.push('inactive-panes-display-none');

  await setModel({ activeApp: 'x', xAppState: 'ready' });
  for (const [label, action] of [['RelayNavBack', 'back'], ['RelayNavForward', 'forward'], ['RelayNavHome', 'home'], ['RelayNavReload', 'reload']]) {
    await page.getByRole('button', { name: strings[label], exact: true }).click();
    assert.equal(await page.evaluate(() => window.__relayUiHarness.actions.at(-1)), `navigate:${action}`);
  }
  assert.equal(await page.locator('[class*="Titlebar-module__network"]').count(), 0);
  evidence.checks.push('titlebar-social-navigation-without-network-controls');
  await setModel({ isNavigating: true });
  for (const label of ['RelayNavBack', 'RelayNavForward', 'RelayNavHome', 'RelayNavReload']) {
    assert.equal(await page.getByRole('button', { name: strings[label], exact: true }).isDisabled(), true);
  }
  evidence.checks.push('busy-actions-disabled');

  await setModel({ xAppState: 'error', instagramAppState: 'loading', isNavigating: false,
    notice: strings.RelayDownloadFailed });
  assert((await page.locator('[data-relay-app="x"]').getAttribute('aria-label')).includes(strings.RelayXErrorTitle));
  assert((await page.locator('[data-relay-app="instagram"]').getAttribute('aria-label')).includes(strings.RelayInstagramLoadingTitle));
  assert.equal(await page.locator('[class*="Titlebar-module__notice"]').getAttribute('title'), strings.RelayDownloadFailed);
  await setModel({ xAppState: 'auth-required' });
  assert.equal(await page.locator('[class*="Titlebar-module__loginButton"]').getAttribute('title'), strings.RelayXDirectLogin);
  evidence.checks.push('service-state-accessible-labels-full-tooltips');
  assert.equal(await page.locator('[class*="Titlebar-module__network"]').count(), 0);
  assert.equal(await page.locator('button[aria-label*="Перезапустить"]').count(), 0);
  evidence.checks.push('no-network-status-dns-vpn-reconnect-ui');

  await page.getByRole('button', { name: strings.RelayMinimize, exact: true }).click();
  await page.getByRole('button', { name: strings.RelayMaximize, exact: true }).click();
  await page.getByRole('button', { name: strings.RelayRestore, exact: true }).click();
  await page.locator('[class*="Titlebar-module__controls"] button').last().click();
  await page.waitForFunction(() => window.__relayWindowCalls.length === 4);
  assert.deepEqual(await page.evaluate(() => window.__relayWindowCalls), ['minimize', 'toggleMaximize', 'toggleMaximize', 'close']);
  evidence.checks.push('window-controls-native-command-mock');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setModel({ xAppState: 'loading', isNavigating: false });
  const animations = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="stateDot"], [class*="xSpinner"]')).map((element) => getComputedStyle(element).animationName));
  assert(animations.every((value) => value === 'none'));
  evidence.checks.push('reduced-motion-spinners');

  await page.evaluate(() => {
    window.__relayRejectResize = true;
    for (const callback of window.__relayResizeCallbacks) void callback();
  });
  await page.waitForTimeout(100);
  evidence.resizeUnhandled = await page.evaluate(() => window.__relayUnhandled);
  await page.evaluate(() => window.__relayUiHarness.unmount());
  await page.waitForTimeout(80);
  evidence.resizeListenersAfterUnmount = await page.evaluate(() => window.__relayResizeCallbacks.length);
  assert.equal(evidence.resizeListenersAfterUnmount, 0);
  evidence.checks.push('window-resize-listener-disposal');
  await context.close();
  evidence.scaling = [];
  for (const scale of [1.25, 1.5, 2]) {
    const scaledContext = await browser.newContext({
      viewport: { width: 800, height: 560 }, deviceScaleFactor: scale, colorScheme: 'dark',
    });
    const scaledPage = await scaledContext.newPage();
    await scaledPage.addInitScript(initializeWindowMock);
    await scaledPage.goto(url, { waitUntil: 'networkidle' });
    await scaledPage.waitForSelector('[data-relay-app="telegram"]');
    await scaledPage.evaluate(() => window.__relayUiHarness.setModel({
      activeApp: 'x', xAppState: 'auth-required', notice: 'Не удалось сохранить файл',
    }));
    await scaledPage.waitForFunction(() => document.querySelector('[data-relay-app="x"]').getAttribute('aria-current') === 'page');
    await scaledPage.evaluate(() => document.fonts.ready);
    const geometry = await scaledPage.evaluate(() => ({
      scale: window.devicePixelRatio,
      buttons: Array.from(document.querySelectorAll('button')).filter((element) => element.getClientRects().length)
        .map((element) => { const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
          return { x, y, width, height, right, bottom }; }),
    }));
    assert.equal(geometry.scale, scale);
    assert(geometry.buttons.every(({ x, y, width, height, right, bottom }) =>
      x >= 0 && y >= 0 && width >= 24 && height >= 24 && right <= 800 && bottom <= 560));
    evidence.scaling.push(geometry);
    await scaledPage.evaluate(async () => Promise.all(document.getAnimations()
      .filter((animation) => animation instanceof window.CSSTransition)
      .map((animation) => animation.finished.catch(() => {}))));
    await scaledPage.screenshot({ path: path.join(output, `dpi-${scale}-x-auth.png`) });
    await scaledContext.close();
  }
  evidence.checks.push('raster-scale-125-150-200-percent');
} finally {
  await browser?.close();
  await server.close();
  await writeFile(path.join(output, 'ui-evidence.json'), JSON.stringify(evidence, undefined, 2));
}

const failures = evidence.cases.filter((item) => item.issues.length);
console.log(JSON.stringify({ cases: evidence.cases.length, checks: evidence.checks, failures: failures.map(({ name, viewport, issues }) => ({ name, viewport, issues })), resizeUnhandled: evidence.resizeUnhandled, errors: evidence.errors }, undefined, 2));
if (process.env.RELAY_UI_BASELINE !== '1') {
  assert.equal(failures.length, 0, 'UI geometry regressions');
  assert.deepEqual(evidence.resizeUnhandled, [], 'Unhandled native resize rejection');
  assert.deepEqual(evidence.errors, [], 'Browser errors');
}
