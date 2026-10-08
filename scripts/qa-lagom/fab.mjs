// Кнопка создания (FAB «новый чат») и FloatingActionButton: строго круг, цвет Lagom, не перекрывает список.
// Запуск: OUT=<папка> node scripts/qa-lagom/fab.mjs  (PORT, THEMES, STRICT=0 — не падать при нарушении)
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './common.mjs';

const out = process.env.OUT || path.join(process.env.TEMP, 'relay-fab-shots');
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const sizes = [[640, 448], [800, 560], [1920, 1080]];
const scales = [16, 32];
const rows = [];
let failed = 0;
for (const theme of themes) {
  for (const size of scales) {
    const t = await boot({ port: Number(process.env.PORT || 1551), theme, rootFontSize: size === 16 ? undefined : size });
    try {
      for (const [w, h] of sizes) {
        await t.reset(w, h, theme, size);
        const column = await t.page.waitForSelector('#LeftColumn', { timeout: 20000 }); await t.page.evaluate(() => window.__relayAudit.closeChat()); await t.settle(500);
        const box = await column.boundingBox();
        await t.page.mouse.move(box.x + 20, box.y + box.height / 2); await t.page.mouse.move(box.x + 30, box.y + box.height / 2 + 10);
        await t.page.waitForSelector('.NewChatButton.revealed', { state: 'attached', timeout: 10000 });
        await t.settle(700);
        const measure = () => t.page.evaluate(() => {
          const btn = document.querySelector('.NewChatButton > .Button');
          const r = btn.getBoundingClientRect();
          const cs = getComputedStyle(btn);
          const icon = btn.querySelector('.icon-new-chat-filled, .icon-close');
          const ir = icon && icon.getBoundingClientRect();
          const rgb = (v) => (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
          const bg = rgb(cs.backgroundColor);
          const root = getComputedStyle(document.documentElement);
          const probe = document.createElement('i'); probe.style.color = root.getPropertyValue('--color-primary'); document.body.append(probe);
          const primary = rgb(getComputedStyle(probe).color); probe.remove();
          const hasBlue = bg[2] > bg[0] + 24 && bg[2] > bg[1] + 24;
          const column = document.querySelector('#LeftColumn').getBoundingClientRect();
          return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), radius: cs.borderRadius, bg: cs.backgroundColor, usesPrimary: bg.join() === primary.join(), hasBlue,
            iconDX: ir ? +((ir.left + ir.width / 2) - (r.left + r.width / 2)).toFixed(2) : null, iconDY: ir ? +((ir.top + ir.height / 2) - (r.top + r.height / 2)).toFixed(2) : null,
            insideColumn: r.left >= column.left && r.right <= column.right && r.bottom <= column.bottom && r.top >= column.top, rect: { x: Math.round(r.x), y: Math.round(r.y) } };
        });
        const m = await measure();
        const name = `${theme}-${w}x${h}-${size === 16 ? '100' : '200'}`;
        await t.page.screenshot({ path: path.join(out, `fab-${name}.png`) });
        // нажатие (active) и клавиатурный фокус
        await t.page.focus('.NewChatButton > .Button').catch(() => {});
        const focus = await t.page.evaluate(() => { const b = document.querySelector('.NewChatButton > .Button'); const cs = getComputedStyle(b); return { outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow !== 'none' }; });
        const ok = Math.abs(m.w - m.h) < 0.5 && m.usesPrimary && !m.hasBlue && Math.abs(m.iconDX ?? 0) <= 0.75 && Math.abs(m.iconDY ?? 0) <= 0.75 && m.insideColumn;
        if (!ok) failed++;
        rows.push({ name, ...m, focus, ok }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(m), JSON.stringify(focus));
      }
    } finally { await t.close(); }
  }
}
fs.writeFileSync(path.join(out, 'fab-geometry.json'), JSON.stringify(rows, null, 1));
console.log(`failed ${failed} of ${rows.length}`);
if (failed && process.env.STRICT !== '0') process.exit(1);
