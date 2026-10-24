// Рамка «Тихая рамка+»: плашки сети и памяти, сон на иконках rail, пустые состояния X/Instagram при недоступной сети.
// Запуск: OUT=<папка> PORT=1541 node scripts/qa-lagom/shell-states.mjs (изолированный UI, MockClient, нативный слой подменён).
import fs from 'node:fs';
import path from 'node:path';
import { boot, Color } from './common.mjs';

const out = process.env.OUT;
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const sizes = [[1280, 800], [640, 448]];
const baseStatus = { state: 'tunnel', source: 'embedded', vpnKind: 'subscription', nodeLabel: 'NL-1', nodeCount: 3,
  dohState: 'private', hasMtproxy: true, services: { telegram: 'tunnel', x: 'tunnel', instagram: 'direct' } };
const report = [];

for (const theme of themes) {
  const t = await boot({ port: Number(process.env.PORT || 1541) });
  const { page } = t;
  try {
    await page.evaluate(() => {
      const native = window.__relayNativeMock;
      const original = native.invoke.bind(native);
      native.invoke = async (command, args) => (command === 'relay_memory_usage'
        ? { bytes: 1536 * 1024 * 1024, processes: 14 } : original(command, args));
    });
    const emitNetwork = (status) => page.evaluate((s) => window.__relayNativeMock.emit('relay-network-status', s), status);
    const refreshMemory = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const shot = async (name) => {
      await t.settle(500);
      await page.screenshot({ path: path.join(out, `${theme}-${name}.png`) });
      const geometry = await page.evaluate(() => {
        const bar = document.querySelector('[class*="Titlebar-module__titlebar"]');
        const plates = bar?.querySelector('[class*="StatusPlates-module__plates"]');
        const rect = plates?.getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, iw: window.innerWidth,
          plates: plates ? { w: Math.round(rect.width), left: Math.round(rect.left), right: Math.round(rect.right) } : null,
          labels: [...(plates?.querySelectorAll('[class*="label"]') ?? [])].map((e) => e.textContent) };
      });
      report.push({ theme, name, ...geometry });
      console.log('shot', theme, name, JSON.stringify(geometry));
    };
    const contrast = async () => {
      const pairs = await page.evaluate(() => [...document.querySelectorAll('[class*="StatusPlates-module__plate"]')].map((e) => {
        const style = getComputedStyle(e);
        return { color: style.color, background: style.backgroundColor, text: e.textContent };
      }));
      return pairs.map((pair) => ({ text: pair.text, ratio: Number(new Color(pair.color).contrast(new Color(pair.background), 'WCAG21').toFixed(2)) }));
    };
    for (const [w, h] of sizes) {
      await t.reset(w, h, theme);
      await emitNetwork(baseStatus);
      await refreshMemory();
      await page.waitForSelector('[class*="StatusPlates-module__memory"]', { state: 'attached', timeout: 5000 });
      await shot(`${w}x${h}-tunnel`);
      if (w === 1280) { const ratios = await contrast(); console.log('contrast', theme, JSON.stringify(ratios)); report.push({ theme, name: 'contrast', ratios }); }
      await emitNetwork({ ...baseStatus, state: 'dnsOnly' });
      await shot(`${w}x${h}-dns-only`);
      await emitNetwork({ ...baseStatus, state: 'down', services: { telegram: 'unavailable', x: 'unavailable', instagram: 'unavailable' } });
      await shot(`${w}x${h}-down`);
      await emitNetwork(baseStatus);
    }

    await t.reset(1280, 800, theme);
    await emitNetwork(baseStatus);
    await page.evaluate(() => window.__relayNativeMock.emit('multi-service-sleep', { service: 'x', sleeping: true }));
    await page.evaluate(() => window.__relayNativeMock.emit('multi-service-sleep', { service: 'instagram', sleeping: true }));
    await t.settle(300);
    const tips = await page.evaluate(() => [...document.querySelectorAll('[data-relay-app]')].map((b) => ({ app: b.dataset.relayApp, title: b.title, indicator: b.dataset.relayIndicator })));
    console.log('rail', theme, JSON.stringify(tips));
    report.push({ theme, name: 'rail-titles', tips });
    await page.locator('[data-relay-app="telegram"]').hover();
    await shot('1280x800-rail-sleep');

    // Пустое состояние X при недоступной сети: причина и кнопка «Настройки сети»
    await emitNetwork({ ...baseStatus, state: 'down', services: { telegram: 'tunnel', x: 'unavailable', instagram: 'direct' } });
    await page.locator('[data-relay-app="x"]').click();
    await t.settle(300);
    await page.evaluate(() => window.__relayNativeMock.emit('multi-x-status', { state: 'error' }));
    await page.waitForSelector('#relay-x-pane [role="alert"]', { timeout: 5000 });
    await shot('1280x800-x-unreachable');
    const xPane = await page.evaluate(() => ({ text: document.querySelector('#relay-x-pane [role="alert"]').innerText }));
    console.log('x pane', JSON.stringify(xPane));
    report.push({ theme, name: 'x-pane', ...xPane });

    // Отклик: нажатие на плашку сети до появления окна настроек
    const started = Date.now();
    await page.locator('#relay-x-pane button', { hasText: 'Настройки сети' }).click();
    await page.waitForSelector('.RelayAppSettingsModal-module__modal.open', { state: 'attached', timeout: 5000 });
    const latency = Date.now() - started;
    console.log('open settings from empty state ms', latency);
    report.push({ theme, name: 'settings-latency-ms', latency });
    await shot('1280x800-settings-opened');
    console.log('errors', JSON.stringify(t.errors));
  } finally { await t.close(); }
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
