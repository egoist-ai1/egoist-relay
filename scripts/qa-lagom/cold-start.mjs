/* global localStorage, PerformanceObserver */
// Холодный старт веб-части: статический сервер поверх dist (DIST=путь), headless Chromium без кэша.
// Выводит JSON: число и вес запросов, FCP, LCP, long tasks, время до первого экрана входа. Сеть вне origin обрывается.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium, project } from './common.mjs';

const dist = path.resolve(process.env.DIST || path.join(project, 'dist'));
const runs = Number(process.env.RUNS || 3);
const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.tgs': 'application/octet-stream' };
const delayJs = Number(process.env.DELAY_JS || 0);
const server = http.createServer(async (req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(dist, rel);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  const ext = path.extname(file);
  let body = fs.readFileSync(file);
  const headers = { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
  // Как в Tauri-ресурсах: без сжатия; GZIP=1 имитирует gzip, чтобы сравнивать передаваемый вес
  if (process.env.GZIP && /\.(js|mjs|css|json|html|svg|wasm)$/.test(ext)) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
  // DELAY_JS=мс задерживает входной чанк: видно, чем окно закрашено до выполнения JS (вспышка при старте)
  if (delayJs && /\/assets\/index-[\w-]+\.js$/.test(rel)) await new Promise((r) => setTimeout(r, delayJs));
  res.writeHead(200, headers); res.end(body);
});
await new Promise((r) => server.listen(Number(process.env.PORT || 1561), '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe') });
const results = [];
for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', locale: 'ru-RU', colorScheme: process.env.SCHEME || 'dark' });
  // THEME=lagom-light: профиль со светлой темой (ключ, который читает getActiveThemeVariantId)
  if (process.env.THEME) await context.addInitScript((v) => { try { localStorage.setItem('egoist_theme_variant', v); } catch { /* ignored */ } }, process.env.THEME);
  await context.addInitScript(() => {
    window.__perf = { lcp: 0, fcp: 0, longTasks: [], cls: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  const page = await context.newPage();
  const reqs = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', async (r) => { try { const b = await r.body(); reqs.push({ url: r.url().replace(origin, ''), size: b.length, enc: r.headers()['content-encoding'] || '' }); } catch { /* ignored */ } });
  await context.route('**/*', (r) => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const t0 = Date.now();
  await page.goto(origin + '/', { waitUntil: delayJs ? 'commit' : 'domcontentloaded' });
  if (delayJs) {
    await page.waitForTimeout(Math.min(800, delayJs / 2));
    const boot = await page.evaluate(() => ({ html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
    console.log('BEFORE-JS', JSON.stringify(boot));
    if (process.env.FLASH_SHOT) await page.screenshot({ path: process.env.FLASH_SHOT.replace('.png', `-${i}.png`) });
  }
  const sel = process.env.READY || '#auth-phone-number-form, #auth-qr-form, .Auth, #Auth, #Main, .Main';
  await page.waitForSelector(sel, { timeout: 60000 }).catch(() => errors.push('ready selector timeout'));
  const ready = Date.now() - t0;
  await page.waitForTimeout(1500);
  const perf = await page.evaluate(() => ({ ...window.__perf, fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight) }));
  const total = reqs.reduce((s, r) => s + r.size, 0);
  const by = (re) => reqs.filter((r) => re.test(r.url));
  const sum = (a) => a.reduce((s, r) => s + r.size, 0);
  results.push({ run: i, ready, fcp: Math.round(perf.fcp), lcp: Math.round(perf.lcp), cls: +perf.cls.toFixed(4), longTasks: perf.longTasks.length, longTaskMs: perf.longTasks.reduce((s, t) => s + t[1], 0),
    requests: reqs.length, totalKB: Math.round(total / 1024), jsKB: Math.round(sum(by(/\.m?js$/)) / 1024), cssKB: Math.round(sum(by(/\.css$/)) / 1024),
    fontKB: Math.round(sum(by(/\.woff2$/)) / 1024), imgKB: Math.round(sum(by(/\.(png|webp|svg|jpg)$/)) / 1024), wasmKB: Math.round(sum(by(/\.wasm$/)) / 1024),
    emoji: by(/img-apple/).length, errors });
  if (i === 0) { fs.writeFileSync(path.join(process.env.TEMP, 'cold-start-requests.json'), JSON.stringify(reqs.sort((a, b) => b.size - a.size), null, 1)); if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }); }
  await context.close();
}
await browser.close(); server.close();
const med = (k) => { const v = results.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(JSON.stringify({ dist, size: `${width}x${height}`, median: Object.fromEntries(['ready', 'fcp', 'lcp', 'cls', 'longTasks', 'longTaskMs', 'requests', 'totalKB', 'jsKB', 'cssKB', 'fontKB', 'imgKB', 'wasmKB', 'emoji'].map((k) => [k, med(k)])), results }, null, 1));
