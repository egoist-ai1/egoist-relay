// Палитра команд (Ctrl+K): открытие, поиск по чатам и сохранённому, клавиатура, ARIA, возврат фокуса, контраст.
// Запуск: OUT=<папка> PORT=1551 node scripts/qa-lagom/palette.mjs (изолированный UI, MockClient, нативный слой подменён).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, Color } from './common.mjs';

const out = process.env.OUT;
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const sizes = [[1280, 800], [640, 448]];
const report = [];
const failures = [];
const check = (name, ok, details) => {
  report.push({ name, ok, details });
  if (!ok) failures.push(name);
  console.log(ok ? 'ok  ' : 'FAIL', name, details ?? '');
};

const operation = (id, fileName, sourceUrl) => ({
  id, attempt: 1, revision: 1, kind: 'save', service: 'x', stage: 'completed', createdAt: 1, updatedAt: 2, completedAt: 3,
  sourceUrl, files: [{ path: `C:/RelayAuditDownloads/${id}/${fileName}`, fileName, mimeType: 'video/mp4', size: 1048576 }],
});

for (const theme of themes) {
  const t = await boot({ port: Number(process.env.PORT || 1551) });
  const { page } = t;
  try {
    await page.evaluate((operations) => window.__relayNativeMock.media.seed(operations, false), [
      operation('op-1', 'Закат над морем.mp4', 'https://x.com/someone/status/1?token=SECRET#frag'),
      operation('op-2', 'clip-final.mp4', 'https://www.instagram.com/reel/ABC/'),
    ]);
    for (const [w, h] of sizes) {
      const tag = `${theme} ${w}x${h}`;
      await t.reset(w, h, theme);
      const dialog = page.locator('[role="dialog"][aria-label="Палитра команд"] .modal-dialog');
      const input = page.locator('[role="combobox"]');
      const closed = () => dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false);

      // Ctrl+K с клавиатуры (в основном окне перехват в JS)
      await page.keyboard.press('Control+k');
      await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
      check(`${tag}: Ctrl+K открывает палитру`, await dialog.count() > 0);
      if (!await dialog.count()) continue;
      await t.settle(300);
      check(`${tag}: фокус в поле ввода`, await input.evaluate((el) => el === document.activeElement));
      check(`${tag}: у списка роль listbox и есть группы`, await page.locator('[role="listbox"] [role="group"]').count() >= 1);
      await page.screenshot({ path: path.join(out, `${theme}-${w}-empty.png`) });

      // Событие из Rust (из нативных окон X и Instagram) закрывает открытую палитру
      await page.evaluate(() => window.__relayNativeMock.emit('relay-palette-toggle'));
      check(`${tag}: relay-palette-toggle закрывает палитру`, await closed());
      await page.evaluate(() => window.__relayNativeMock.emit('relay-palette-toggle'));
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await t.settle(300);

      // Поиск по сохранённому
      await input.fill('закат');
      await t.settle(300);
      const savedOption = page.locator('[role="option"]').filter({ hasText: 'Закат над морем' });
      check(`${tag}: сохранённое находится по названию файла`, await savedOption.count() === 1);
      check(`${tag}: в подписи нет query и fragment`, !(await dialog.innerText()).includes('SECRET'));
      check(`${tag}: первый результат выбран`, (await page.locator('[role="option"][aria-selected="true"]').count()) === 1);
      await page.screenshot({ path: path.join(out, `${theme}-${w}-saved.png`) });

      // Действие «Искать в сообщениях» и счётчик результатов для скринридера
      await input.fill('привет');
      await t.settle(300);
      const searchOption = page.locator('[role="option"]').filter({ hasText: 'привет' }).first();
      check(`${tag}: есть пункт поиска по сообщениям Telegram`, await searchOption.count() === 1);
      check(`${tag}: aria-live объявляет число результатов`, (await dialog.locator('[role="status"]').innerText()).length > 0);

      // Нет совпадений
      await input.fill('qqzzxxnomatch');
      await t.settle(300);
      check(`${tag}: сообщение об отсутствии совпадений`, (await dialog.innerText()).toLowerCase().includes('ничего не найдено'));
      await page.screenshot({ path: path.join(out, `${theme}-${w}-nomatch.png`) });

      // Клавиатура: стрелки циклично, activedescendant следует за выбором
      await input.fill('');
      await t.settle(200);
      const total = await page.locator('[role="option"]').count();
      await page.keyboard.press('ArrowUp');
      await t.settle(100);
      const lastActive = await page.locator('[role="option"][aria-selected="true"]').getAttribute('id');
      const described = await input.getAttribute('aria-activedescendant');
      check(`${tag}: ArrowUp с первого пункта идёт на последний`, lastActive === `relay-palette-option-${total - 1}`, `${lastActive} из ${total}`);
      check(`${tag}: aria-activedescendant указывает на выбранный пункт`, described === lastActive);

      // Контраст выбранного пункта и подписи
      const pairs = await page.evaluate(() => {
        const rows = ['[role="option"][aria-selected="true"] [class*="title"]', '[role="option"] [class*="subtitle"]', '[class*="footer"]'];
        const opt = document.querySelector('[role="option"][aria-selected="true"]');
        const bg = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; n = n.parentElement; } return 'rgb(255,255,255)'; };
        return rows.map((selector) => {
          const el = document.querySelector(selector);
          return el ? { selector, color: getComputedStyle(el).color, background: bg(selector.includes('selected') ? opt : el) } : undefined;
        }).filter(Boolean);
      });
      for (const pair of pairs) {
        const ratio = Number(new Color(pair.color).contrast(new Color(pair.background), 'WCAG21').toFixed(2));
        check(`${tag}: контраст ${pair.selector}`, ratio >= 4.5, String(ratio));
      }

      // Переключение на X по Enter
      await input.fill('instagram');
      await t.settle(300);
      await page.keyboard.press('Enter');
      check(`${tag}: Enter выполняет действие и закрывает палитру`, await closed());

      // Esc закрывает и возвращает фокус
      await page.keyboard.press('Control+k');
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await t.settle(400);
      await page.keyboard.press('Escape');
      check(`${tag}: Esc закрывает палитру`, await closed());
      check(`${tag}: ошибок страницы нет`, t.errors.length === 0, t.errors.join(' | '));
    }
  } finally {
    await t.close();
  }
}

fs.writeFileSync(path.join(out, 'palette-report.json'), JSON.stringify(report, null, 2));
if (failures.length) {
  console.log(`\nНе пройдено: ${failures.length}`);
  process.exitCode = 1;
}
assert.ok(true);
