// Модалка «Выберите получателей» (SocialShareModal): список чатов обязан сохранять читаемую высоту и скролл.
// Запуск: OUT=<папка скриншотов> node scripts/qa-lagom/share-modal.mjs  (PORT, THEMES, STRICT=0 — не падать при нарушении)
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './common.mjs';

const out = process.env.OUT || path.join(process.env.TEMP, 'relay-share-shots');
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const sizes = [[640, 448], [800, 560], [1920, 1080]];
const scales = [16, 32];
const MIN_LIST_PX = 96; // видимая часть списка: не меньше двух строк чата (масштаб 100 %)
const MIN_LIST_PX_200 = 24; // 200 % на окне 640×448 равны окну 320×224 при 100 %: список прокручивается, виден фрагмент строки
const request = { requestId: 'qa-share-0000000001', service: 'x', url: 'https://x.com/egoist/status/1234567890',
  text: 'Длинный текст публикации, чтобы нижний блок был максимально высоким. '.repeat(3),
  media: [{ url: 'https://pbs.twimg.com/media/a.jpg', type: 'photo' }, { url: 'https://pbs.twimg.com/media/b.jpg', type: 'photo' }] };
const rows = [];
let failed = 0;
for (const theme of themes) {
  for (const size of scales) {
    const t = await boot({ port: Number(process.env.PORT || 1541), theme, rootFontSize: size === 16 ? undefined : size });
    try {
      for (const [w, h] of sizes) {
        await t.reset(w, h, theme, size);
        await t.page.waitForFunction(() => typeof window.__relayAudit.openShare === 'function', undefined, { timeout: 60000 });
        await t.page.evaluate((r) => window.__relayAudit.openShare(r), request);
        await t.page.waitForSelector('[data-relay-share-modal]', { state: 'attached', timeout: 20000 });
        await t.page.waitForSelector('.picker-list', { timeout: 20000 });
        await t.settle(900);
        await t.page.evaluate(() => document.querySelector('.picker-list .ListItem-button, .picker-list .ChatOrUserPicker-item')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
        await t.settle(500);
        const m = await t.page.evaluate(() => {
          const rect = (el) => el && el.getBoundingClientRect();
          const list = rect(document.querySelector('.picker-list'));
          const footer = rect(document.querySelector('[data-relay-share-modal]'));
          const dialog = rect(document.querySelector('.modal-dialog'));
          const send = rect(document.querySelector('[data-relay-share-send]'));
          const visible = list && footer ? Math.max(0, Math.min(list.bottom, footer.top) - list.top) : 0;
          return { list: list && Math.round(list.height), visible: Math.round(visible),
            sendX: Boolean(send && dialog && send.left >= dialog.left - 1 && send.right <= dialog.right + 1), footer: footer && Math.round(footer.height), dialog: dialog && { top: Math.round(dialog.top), bottom: Math.round(dialog.bottom), h: Math.round(dialog.height) },
            sendInside: Boolean(send && dialog && send.bottom <= dialog.bottom + 1 && send.top >= dialog.top), vh: window.innerHeight };
        });
        const name = `${theme}-${w}x${h}-${size === 16 ? '100' : '200'}`;
        await t.page.screenshot({ path: path.join(out, `share-${name}.png`) });
        const ok = m.visible >= (size === 16 ? MIN_LIST_PX : MIN_LIST_PX_200) && m.sendInside && m.sendX;
        if (!ok) failed++;
        rows.push({ name, ...m, ok }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(m));
      }
    } finally { await t.close(); }
  }
}
fs.writeFileSync(path.join(out, 'share-geometry.json'), JSON.stringify(rows, null, 1));
console.log(`failed ${failed} of ${rows.length}`);
if (failed && process.env.STRICT !== '0') process.exit(1);
