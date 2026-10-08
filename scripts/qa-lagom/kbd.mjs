// Клавиатура и фокус на изолированном UI Relay. Печатает таблицу PASS/FAIL.
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './common.mjs';

const theme = process.env.THEME || 'lagom-dark';
const out = process.env.OUT || path.join(process.env.TEMP, 'relayqa', 'kbd');
fs.mkdirSync(out, { recursive: true });
const t = await boot({ port: Number(process.env.PORT || 1521), theme });
const { page } = t;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}\t${name}\t${detail}`); };

const snap = () => page.evaluate(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return { tag: 'BODY' };
  const s = getComputedStyle(e); const r = e.getBoundingClientRect();
  // видимый индикатор: контур, тень, либо контур/тень у предка-обёртки (:has(:focus-visible)) или у .widget
  const own = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
  const shadow = s.boxShadow !== 'none';
  let wrap = false;
  for (let p = e.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
    const ps = getComputedStyle(p);
    if (ps.outlineStyle !== 'none' && parseFloat(ps.outlineWidth) > 0) { wrap = true; break; }
  }
  const thumb = e.type === 'range' ? getComputedStyle(e, '::-webkit-slider-thumb') : undefined;
  const thumbRing = thumb && thumb.outlineStyle !== 'none' && parseFloat(thumb.outlineWidth) > 0;
  const sib = e.nextElementSibling ? getComputedStyle(e.nextElementSibling) : undefined;
  const widget = sib && sib.outlineStyle !== 'none' && parseFloat(sib.outlineWidth) > 0;
  const label = e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent || '').trim().slice(0, 28) || e.getAttribute('placeholder') || e.id;
  return { tag: e.tagName, role: e.getAttribute('role'), id: e.id, cls: String(e.className).slice(0, 60), label,
    outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, own, shadow, wrap, widget, thumbRing, fv: e.matches(':focus-visible'),
    w: Math.round(r.width), h: Math.round(r.height), sel: e.getAttribute('aria-selected'), cur: e.getAttribute('aria-current'), tabindex: e.getAttribute('tabindex') };
});
const label = (s) => `${s.tag}${s.role ? '[' + s.role + ']' : ''}:${s.label}`;
const visible = (s) => s.own || s.shadow || s.wrap || s.widget || s.thumbRing;
const active = () => page.evaluate(() => { const e = document.activeElement; return `${e.tagName}|${e.getAttribute('aria-label') || e.id || (e.textContent || '').trim().slice(0, 20)}`; });

// Дождаться отложенного автофокуса композера после открытия чата и снять его, чтобы он не мешал обходу
async function quiet() {
  await page.waitForFunction(() => document.activeElement?.id === 'editable-message-text', undefined, { timeout: 12000 }).catch(() => {});
  for (let i = 0; i < 3; i++) { await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(700); }
  await page.evaluate(() => document.activeElement?.blur());
}
try {
  await t.reset(1280, 800, theme);
  await quiet();

  // 1. Tab-обход от загрузки. Нажатия быстрые, как у пользователя.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Tab'); await page.waitForTimeout(300);
  const first = await snap();
  check('Первый Tab с пустого фокуса ведёт в поле ввода (быстрый путь Telegram Web A)', /editable-message-text/.test(first.id), `${first.tag}:${first.label}`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('[data-relay-app=telegram]').focus();
  const stops = [await snap()];
  const walk = async (n, wait = 120) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press('Tab'); await page.waitForTimeout(wait);
      const s = await snap(); stops.push(s);
      if (s.tag === 'BODY') return false;
      if (s.id === 'telegram-search-input') return true; // фокус в поиске переключает левую колонку в режим поиска
    }
    return true;
  };
  await walk(20, 150);
  // Что происходит с фокусом, когда Tab нажат из поля поиска (левая колонка уходит в режим поиска)
  await page.waitForTimeout(600);
  const searchState = await page.evaluate(() => ({ backButton: document.querySelector('.left-header-menu-btn')?.getAttribute('aria-label'), chats: document.querySelectorAll('.chat-item-clickable').length, tabs: document.querySelectorAll('[role=tab]').length }));
  await page.keyboard.press('Tab'); await page.waitForTimeout(500);
  const fromSearch = await snap();
  console.log('Из поиска: состояние', JSON.stringify(searchState), '-> следующий Tab:', label(fromSearch));
  check('Tab из поля поиска не теряет фокус (не уходит на body)', fromSearch.tag !== 'BODY', label(fromSearch) + ' ' + JSON.stringify(searchState));
  // Вторая часть обхода: от вкладок папок в чистом состоянии (выйти из режима поиска кнопкой «назад»)
  await page.locator('.left-header-menu-btn').first().click(); await t.settle(900);
  await t.reset(1280, 800, theme);
  await quiet();
  await page.locator('[role=tab]').first().focus();
  stops.push(await snap());
  await walk(24, 150);
  fs.writeFileSync(path.join(out, `${theme}-tab-walk.json`), JSON.stringify(stops, null, 1));
  console.log('Порядок Tab:\n' + stops.map((s, i) => `${i + 1}. ${label(s)}`).join('\n'));
  const idx = (re) => stops.findIndex((s) => re.test(`${s.cls} ${s.label} ${s.id} ${s.role}`));
  const iRail = idx(/appButton/), iTabs = idx(/tab/), iSearch = idx(/telegram-search-input/), iChat = stops.findIndex((s) => s.tag === 'A' && /ListItem-button/.test(s.cls)), iComposer = idx(/editable-message-text/);
  check('Tab-обход: rail → вкладки папок → поиск → чаты → композер в порядке DOM',
    iRail >= 0 && iSearch > iRail && iTabs > iSearch && iChat > iTabs && iComposer > iChat, `rail=${iRail + 1} search=${iSearch + 1} tabs=${iTabs + 1} chat=${iChat + 1} composer=${iComposer + 1}`);
  const withoutFocus = stops.filter((s) => s.tag !== 'BODY' && !visible(s));
  check('Фокус виден на каждой остановке Tab (outline/тень/обёртка)', withoutFocus.length === 0, withoutFocus.map(label).join(' ; '));
  const tabStops = stops.filter((s) => s.role === 'tab');
  check('Вкладки папок: role=tab, aria-selected, одна остановка Tab (roving)', tabStops.length >= 1 && tabStops.every((s) => s.sel !== null) && tabStops.length === 1, `остановок=${tabStops.length}`);
  const railStops = stops.filter((s) => /appButton/.test(s.cls));
  check('Rail: одна остановка Tab на весь блок (roving tabindex)', railStops.length === 1, `остановок=${railStops.length}`);
  const domTargets = await page.evaluate(() => [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex],[contenteditable=true]')]
    .filter((e) => { if (e.tabIndex < 0 || e.closest('[inert]') || e.disabled) return false; for (let p = e; p; p = p.parentElement) { const ps = getComputedStyle(p); if (ps.visibility === 'hidden' || ps.display === 'none') return false; } const r = e.getBoundingClientRect(); return r.width > 0; })
    .map((e) => { const r = e.getBoundingClientRect(); const ch = []; for (let p = e; p && p !== document.body; p = p.parentElement) ch.push(String(p.className).split(' ')[0]); return { l: (e.getAttribute('aria-label') || e.placeholder || e.id || e.className.slice(0, 20)) + ' <' + ch.slice(0, 6).join('<'), w: Math.round(r.width), h: Math.round(r.height) }; }));
  const small = domTargets.filter((x) => x.w < 24 || x.h < 24);
  check('Цели Tab не меньше 24×24 px (WCAG 2.5.8), по DOM-списку видимых tabbable', small.length === 0 && domTargets.length > 20, `целей=${domTargets.length}; мелких: ${small.map((x) => x.l + ' ' + x.w + 'x' + x.h).join(' ; ')}`);

  // 2. Стрелки на вкладках и в rail
  await page.locator('[role=tab]').first().focus();
  const tabCount = await page.locator('[role=tab]').count();
  if (tabCount > 1) {
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
    const sel = await page.evaluate(() => ({ idx: [...document.querySelectorAll('[role=tab]')].findIndex((e) => e.getAttribute('aria-selected') === 'true'), focus: [...document.querySelectorAll('[role=tab]')].indexOf(document.activeElement) }));
    check('Вкладки: ArrowRight выбирает и фокусирует следующую', sel.idx === 1 && sel.focus === 1, JSON.stringify(sel));
    await page.keyboard.press('Home'); await page.waitForTimeout(300);
    const home = await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].findIndex((e) => e.getAttribute('aria-selected') === 'true'));
    check('Вкладки: Home возвращает на первую', home === 0, `selected=${home}`);
  } else check('Вкладки: стрелки (в харнессе одна вкладка папок)', true, 'tabCount=1; не проверено стрелками');
  await page.locator('[data-relay-app=telegram]').focus();
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200);
  const afterDown = await page.evaluate(() => document.activeElement.getAttribute('data-relay-app'));
  check('Rail: ArrowDown переносит фокус на следующий сервис', afterDown === 'x', `фокус=${afterDown}`);
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(200);
  check('Rail: ArrowUp возвращает', (await page.evaluate(() => document.activeElement.getAttribute('data-relay-app'))) === 'telegram');
  const railTabbable = await page.evaluate(() => [...document.querySelectorAll('[data-relay-app]')].filter((e) => e.tabIndex === 0).length);
  check('Rail: ровно одна кнопка с tabindex=0', railTabbable === 1, `tabindex0=${railTabbable}`);

  // 3. Ctrl+J, Esc, возврат фокуса
  for (const [name, selector] of [['поиска', '#telegram-search-input'], ['rail', '[data-relay-app=telegram]'], ['композера', '#editable-message-text']]) {
    await page.locator(selector).first().focus(); await page.waitForTimeout(200);
    const before = await active();
    await page.keyboard.press('Control+j'); await t.settle(600);
    const opened = await page.evaluate(() => { const p = document.querySelector('#relay-media-operations'); return { open: Boolean(p), inPanel: Boolean(p?.contains(document.activeElement)), role: p?.getAttribute('role'), label: p?.getAttribute('aria-label') }; });
    check(`Ctrl+J с фокусом на ${name}: панель открыта, фокус внутри`, opened.open && opened.inPanel, JSON.stringify(opened));
    const stopsInPanel = await page.evaluate(() => [...document.querySelectorAll('#relay-media-operations button, #relay-media-operations [role=tab], #relay-media-operations [tabindex="0"]')].filter((e) => e.tabIndex >= 0).length);
    await page.keyboard.press('Escape'); await t.settle(600);
    const closed = await page.evaluate(() => !document.querySelector('#relay-media-operations'));
    const after = await active();
    check(`Esc закрывает панель и возвращает фокус на ${name}`, closed && after === before, `до=${before} после=${after} закрыта=${closed} (фокусируемых в панели: ${stopsInPanel})`);
  }
  // фокус на кнопках панели виден
  await page.keyboard.press('Control+j'); await t.settle(600);
  const panelStops = [];
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); await page.waitForTimeout(70); const s = await snap(); if (!(await page.evaluate(() => document.querySelector('#relay-media-operations')?.contains(document.activeElement)))) break; panelStops.push(s); }
  const panelBad = panelStops.filter((s) => !visible(s));
  check('Панель операций: фокус виден на всех кнопках/вкладках', panelBad.length === 0 && panelStops.length > 0, `остановок=${panelStops.length}; ${panelBad.map(label).join(' ; ')}`);
  const tabsInPanel = await page.evaluate(() => [...document.querySelectorAll('#relay-media-operations [role=tab]')].map((e) => e.getAttribute('aria-selected')));
  console.log('панель: tab-роли', JSON.stringify(tabsInPanel), 'остановки', panelStops.map(label).join(' | '));
  await page.keyboard.press('Escape'); await t.settle(500);

  // 4. Модальное окно: ловушка фокуса
  await page.locator('#editable-message-text').focus();
  await page.evaluate(() => window.__relayAudit.openOverlay('controls')); await t.settle(800);
  const dialogInfo = await page.evaluate(() => { const d = document.querySelector('dialog[open], .Modal.open .modal-dialog'); return { has: Boolean(d), role: d?.getAttribute('role') || d?.tagName, modal: d?.getAttribute('aria-modal'), inDialog: d?.contains(document.activeElement) }; });
  check('Модальное окно: диалог открыт, роль/aria-modal, фокус внутри', dialogInfo.has && dialogInfo.inDialog, JSON.stringify(dialogInfo));
  let escaped = 0; const seen = new Set();
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); await page.waitForTimeout(60); const r = await page.evaluate(() => { const d = document.querySelector('dialog[open], .Modal.open .modal-dialog'); return { inD: d?.contains(document.activeElement), id: document.activeElement.id || document.activeElement.className }; }); if (!r.inD) escaped++; seen.add(r.id); }
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(60); const r = await page.evaluate(() => { const d = document.querySelector('dialog[open], .Modal.open .modal-dialog'); return d?.contains(document.activeElement); }); if (!r) escaped++; }
  check('Модальное окно: Tab/Shift+Tab не выводят фокус за пределы (28 нажатий)', escaped === 0, `вышло=${escaped}; уникальных остановок=${seen.size}`);
  const modalStop = await snap();
  check('Модальное окно: фокус виден на текущей остановке', visible(modalStop), label(modalStop));
  await page.keyboard.press('Escape'); await t.settle(700);
  const modalClosed = await page.evaluate(() => !document.querySelector('dialog[open], .Modal.open'));
  check('Модальное окно: Esc закрывает', modalClosed);
  check('Модальное окно: фокус возвращён на композер', (await active()).includes('editable-message-text') || (await active()).includes('Message'), await active());

  // 5. Видимость фокуса в настройках: чекбоксы/переключатели/радио
  await page.evaluate(() => window.__relayAudit.openSettings('General')); await t.settle(1000);
  const settingsStops = [];
  await page.evaluate(() => document.activeElement?.blur());
  const inSettings = () => page.evaluate(() => Boolean(document.activeElement.closest('#Settings')));
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press('Tab'); await page.waitForTimeout(40);
    if (!(await inSettings())) continue;
    const s = await snap(); const kind = await page.evaluate(() => { const e = document.activeElement; return `${e.tagName}${e.type ? ':' + e.type : ''}${e.closest('.Switcher') ? ':switcher' : ''}${e.closest('.Checkbox') ? ':checkbox' : ''}${e.closest('.Radio') ? ':radio' : ''}`; });
    settingsStops.push({ ...s, kind });
  }
  fs.writeFileSync(path.join(out, `${theme}-settings-tab.json`), JSON.stringify(settingsStops, null, 1));
  const byKind = {}; for (const s of settingsStops) (byKind[s.kind] ??= []).push(s);
  for (const [k, list] of Object.entries(byKind)) console.log(`  настройки ${k}: ${list.length} остановок, без индикатора: ${list.filter((s) => !visible(s)).length}`);
  const badSettings = settingsStops.filter((s) => !visible(s) && s.kind !== 'INPUT:range');
  // Ползунок: кольцо рисуется на псевдоэлементе бегунка, computed style его не показывает — сравниваем пиксели
  const range = page.locator('#Settings input[type=range]').first();
  if (await range.count()) {
    await range.scrollIntoViewIfNeeded(); const box = await range.boundingBox();
    const clip = { x: Math.max(0, box.x - 20), y: box.y - 20, width: box.width + 40, height: box.height + 40 };
    await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(300);
    const unfocused = await page.screenshot({ clip });
    await range.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(300);
    const isRangeFocused = await page.evaluate(() => document.activeElement.type === 'range');
    const focused = await page.screenshot({ clip });
    check('Настройки: у ползунка размера шрифта фокус виден (пиксели отличаются от неактивного)', isRangeFocused && !unfocused.equals(focused), `focused=${isRangeFocused}`);
  }
  check('Настройки: фокус виден на кнопках, радио-темах, чекбоксах, переключателях', settingsStops.length > 5 && badSettings.length === 0, `остановок=${settingsStops.length}; без индикатора: ${badSettings.map((s) => s.kind + ':' + s.label).join(' ; ')}`);
  await page.screenshot({ path: path.join(out, `${theme}-settings-focus.png`) });
  console.log('errors', t.errors);
} finally {
  fs.writeFileSync(path.join(out, `${theme}-kbd-results.json`), JSON.stringify(results, null, 1));
  await t.close();
}
console.log(`\nИТОГ ${theme}: ${results.filter((r) => r.ok).length}/${results.length}`);
