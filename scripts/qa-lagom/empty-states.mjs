// Пустые и статусные экраны: нет выбранного чата, пустой список, поиск без результатов.
// Запуск: OUT=<папка> node scripts/qa-lagom/empty-states.mjs  (THEMES, SIZES, PORT)
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './common.mjs';

const out = process.env.OUT || path.join(process.env.TEMP, 'relay-empty-shots');
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const sizes = (process.env.SIZES || '1280x800,800x560').split(',').map((s) => s.split('x').map(Number));
for (const theme of themes) {
  const t = await boot({ port: Number(process.env.PORT || 1571), theme });
  try {
    for (const [w, h] of sizes) {
      await t.reset(w, h, theme, 16);
      await t.page.evaluate(() => window.__relayAudit.closeChat());
      await t.settle(900);
      await t.page.screenshot({ path: path.join(out, `${theme}-${w}x${h}-no-chat.png`) });
      console.log('shot', theme, w, h, 'no-chat');
    }
    console.log('errors', JSON.stringify(t.errors));
  } finally { await t.close(); }
}
