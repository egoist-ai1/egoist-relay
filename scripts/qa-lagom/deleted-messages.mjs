// Снимки строки «Сообщение удалено» (свёрнута/раскрыта) и блока настроек: lagom-dark и lagom-light. Порт и выход — из env.
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './common.mjs';

const out = process.env.OUT;
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const report = [];

for (const theme of themes) {
  const t = await boot({ port: Number(process.env.PORT || 1541) });
  const { page } = t;
  try {
    await t.reset(1280, 800, theme);
    const ids = await page.evaluate(async () => {
      const { getGlobal, getActions } = await import('/src/global/index.ts');
      const global = getGlobal();
      const byId = global.messages.byChatId['101'].byId;
      const ids = Object.keys(byId).map(Number).filter((id) => byId[id].content.text?.text && !byId[id].content.action).slice(-3);
      // Удаление приходит так же, как от Telegram: общим обновлением без chatId
      getActions().apiUpdate({ '@type': 'deleteMessages', ids: [ids[0]] });
      return ids;
    });
    await page.waitForSelector('.DeletedMessage button', { timeout: 15000 });
    await t.settle(600);
    // Строка без сохранённого содержимого: честная пометка без раскрытия
    await page.evaluate(async ([id]) => {
      const { getGlobal, setGlobal } = await import('/src/global/index.ts');
      const global = getGlobal();
      const byId = global.messages.byChatId['101'].byId;
      setGlobal({ ...global, messages: { ...global.messages, byChatId: { ...global.messages.byChatId,
        '101': { ...global.messages.byChatId['101'], byId: { ...byId, [id]: { ...byId[id], content: {}, deletedAt: Math.floor(Date.now() / 1000), hasNoDeletedCopy: true } } } } } });
    }, [ids[1]]);
    await t.settle(600);
    const shot = async (name) => { await t.settle(500); await page.screenshot({ path: path.join(out, `${theme}-${name}.png`) }); };
    await shot('collapsed');
    const button = page.locator('.DeletedMessage button').first();
    const before = await button.getAttribute('aria-expanded');
    await button.focus();
    await page.keyboard.press('Enter');
    await t.settle(400);
    const afterEnter = await button.getAttribute('aria-expanded');
    await shot('expanded');
    await page.keyboard.press('Space');
    await t.settle(400);
    const afterSpace = await button.getAttribute('aria-expanded');
    const outline = await button.evaluate((e) => getComputedStyle(e).outlineStyle + ' ' + getComputedStyle(e).outlineWidth);
    const placeholderButtons = await page.locator('.DeletedMessage:not(:has(button))').count();
    report.push({ theme, before, afterEnter, afterSpace, outline, placeholderRowsWithoutButton: placeholderButtons });
    console.log(JSON.stringify(report.at(-1)));

    await t.reset(1280, 800, theme);
    await page.evaluate(() => window.__relayAudit.openSettings('Privacy'));
    await page.waitForTimeout(1500);
    await page.locator('text=Удалённые сообщения').first().scrollIntoViewIfNeeded();
    await shot('settings');
    console.log('errors', JSON.stringify(t.errors));
  } finally { await t.close(); }
}
fs.writeFileSync(path.join(out, 'deleted-messages.json'), JSON.stringify(report, null, 1));
