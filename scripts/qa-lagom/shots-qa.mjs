// Скриншоты QA: lagom-dark/light × размеры окна × 200% текста. Порт — из env.
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './common.mjs';

const out = process.env.OUT;
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const sizes = [[640, 448], [800, 560], [1280, 800], [1920, 1080]];
const ops = [{ id: 'd8406c70-1c56-4313-81c5-b8d0ca4e0111', attempt: 1, revision: 1, kind: 'save', service: 'instagram',
  sourceUrl: 'https://www.instagram.com/p/RELAYAUDIT/', fileName: 'Набережная.jpg', stage: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
  files: [{ path: 'C:/RelayAuditDownloads/Набережная.jpg', fileName: 'Набережная.jpg', mimeType: 'image/jpeg', size: 3156224, width: 3000, height: 2000 }] }];
const report = [];
for (const theme of themes) {
  const t = await boot({ port: Number(process.env.PORT || 1531) });
  const { page } = t;
  try {
    const shot = async (name) => { await t.settle(600); await page.screenshot({ path: path.join(out, `${theme}-${name}.png`) });
      // геометрия: горизонтальная прокрутка страницы и элементы, вылезающие за окно
      const g = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight, ih: window.innerHeight,
        clippedText: [...document.querySelectorAll('.chat-item-clickable .fullName, .MiddleHeader .fullName, [class*="appLabel"]')].filter((e) => e.scrollWidth > e.clientWidth + 1).length }));
      report.push({ theme, name, ...g }); console.log('shot', theme, name, JSON.stringify(g)); };
    for (const [w, h] of sizes) { await t.reset(w, h, theme); await shot(`${w}x${h}`); }
        await t.reset(1280, 800, theme); await page.evaluate((o) => window.__relayNativeMock.media.seed(o, false), ops);
    await page.keyboard.press('Control+j'); await page.waitForSelector('#relay-media-operations'); await shot('1280x800-operations');
    await page.keyboard.press('Escape'); await t.settle(400);
    await t.reset(1280, 800, theme); await page.evaluate(() => window.__relayAudit.openSettings('General')); await page.waitForTimeout(2500); await shot('1280x800-settings');
    await t.reset(1280, 800, theme); await page.evaluate(() => window.__relayAudit.openOverlay('confirm')); await shot('1280x800-confirm');
    console.log('errors', JSON.stringify(t.errors));
  } finally { await t.close(); }
  // 200% текста: корневой размер 32px задан до старта приложения (список чатов позиционируется при первом рендере)
  for (const [w, h] of [[1920, 1080], [1280, 800], [800, 560], [640, 448]]) {
    const t2 = await boot({ port: Number(process.env.PORT || 1531), theme, rootFontSize: 32 });
    try {
      const p = t2.page;
      await t2.reset(w, h, theme, 32);
      const name = `${w}x${h}-200pct`;
      const shot2 = async (n) => { await t2.settle(600); await p.screenshot({ path: path.join(out, `${theme}-${n}.png`) });
        const g = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, rows: [...document.querySelectorAll('.Chat')].map((e) => Math.round(e.getBoundingClientRect().top)) }));
        report.push({ theme, name: n, ...g }); console.log('shot', theme, n, JSON.stringify(g)); };
      await shot2(name);
      if (w === 640) { await p.keyboard.press('Control+j'); await p.waitForSelector('#relay-media-operations'); await shot2('640x448-200pct-operations'); }
    } finally { await t2.close(); }
  }
}
fs.writeFileSync(path.join(out, 'geometry.json'), JSON.stringify(report, null, 1));
