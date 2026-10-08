// Контраст в рендере: ключевые элементы + скан всего видимого текста в нескольких состояниях UI.
import fs from 'node:fs';
import path from 'node:path';
import { boot, Color } from './common.mjs';

const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const out = process.env.OUT || path.join(process.env.TEMP, 'relayqa', 'contrast');
fs.mkdirSync(out, { recursive: true });
let t, page;

const KEY = [
  ['Название чата', '.chat-item-clickable:not(.selected) .fullName'],
  ['Превью чата', '.chat-item-clickable:not(.selected) .last-message-summary'],
  ['Время в списке чатов', '.chat-item-clickable:not(.selected) .LastMessageMeta .time'],
  ['Активный чат: название', '.chat-item-clickable.selected .fullName'],
  ['Активный чат: превью', '.chat-item-clickable.selected .last-message-summary'],
  ['Активный чат: время', '.chat-item-clickable.selected .LastMessageMeta .time'],
  ['Шапка чата: название', '.MiddleHeader .ChatInfo .fullName'],
  ['Шапка чата: статус', '.MiddleHeader .ChatInfo .status'],
  ['Пузырь чужой: текст', '.Message:not(.own) .text-content'],
  ['Пузырь чужой: время', '.Message:not(.own) .message-time'],
  ['Пузырь свой: текст', '.Message.own .text-content'],
  ['Пузырь свой: время', '.Message.own .message-time'],
  ['Реакции (счётчик)', '[class*="ReactionButton"] [class*="counter"], [class*="ReactionButton"]'],
  ['Кнопка primary (Telegram)', '.Button.primary'],
  ['Поле поиска: текст', '#telegram-search-input'],
  ['Поле поиска: плейсхолдер', '#telegram-search-input::placeholder'],
  ['Подпись rail', '[class*="AppSidebar"][class*="appLabel"]'],
  ['Подпись rail (активная)', '[class*="AppSidebar"][class*="activeLabel"]'],
  ['Вкладка папок (выбрана)', '[role=tab][aria-selected=true]'],
  ['Вкладка папок (прочие)', '[role=tab][aria-selected=false]'],
  ['Композер: плейсхолдер', '.Composer .placeholder-text'],
  ['Модальное окно: заголовок', '.modal-title'],
  ['Подпись в карточке (secondary)', '.modal-content .subtitle, .modal-content [class*="subtitle"]'],
];

const chainSrc = `
  function chain(el) {
    const layers = []; let opacity = 1; let unknown = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= Number(cs.opacity);
      if (cs.backgroundImage !== 'none') unknown = true;
      layers.push(cs.backgroundColor);
      if (/^rgb\\(/.test(cs.backgroundColor)) break;
    }
    return { layers, opacity, unknown };
  }`;

const collect = (specs) => page.evaluate(new Function('specs', `${chainSrc}
  const res = [];
  for (const [name, sel] of specs) {
    const isPh = sel.endsWith('::placeholder');
    const q = isPh ? sel.replace('::placeholder', '') : sel;
    const els = [...document.querySelectorAll(q)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[inert]'); }).slice(0, 2);
    if (!els.length) { res.push({ name, sel, missing: true }); continue; }
    for (const e of els) {
      const cs = getComputedStyle(e, isPh ? '::placeholder' : null);
      const c = chain(e);
      res.push({ name, sel, text: (e.textContent || e.placeholder || '').trim().slice(0, 28), fg: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, ...c });
    }
  }
  return res;`), specs);

const scan = () => page.evaluate(new Function(`${chainSrc}
  const seen = new Set(); const res = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const txt = n.textContent.trim(); if (!txt) continue;
    const e = n.parentElement; if (!e || seen.has(e)) continue;
    if (e.closest('script,style,[inert],[hidden],svg')) continue;
    const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    seen.add(e);
    const path = []; for (let p = e, i = 0; p && i < 3 && p !== document.body; p = p.parentElement, i++) path.push(p.tagName.toLowerCase() + (p.className && typeof p.className === 'string' ? '.' + p.className.split(/\\s+/)[0] : ''));
    res.push({ path: path.join('<'), text: txt.slice(0, 24), fg: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, ...chain(e) });
  }
  return res;`));

function over(top, bottom) {
  const a = top.alpha ?? 1;
  const m = (i) => (top.coords[i] ?? 0) * a + (bottom.coords[i] ?? 0) * (1 - a);
  return new Color('srgb', [m(0), m(1), m(2)]);
}
function ratio(item, canvas) {
  if (item.unknown) return { unknown: true };
  let bg = canvas;
  for (const l of [...item.layers].reverse()) {
    const p = new Color(l).to('srgb');
    if ((p.alpha ?? 1) > 0) bg = over(p, bg);
  }
  const fg0 = new Color(item.fg).to('srgb');
  const fg = over(new Color('srgb', fg0.coords, (fg0.alpha ?? 1) * item.opacity), bg);
  return { ratio: Color.contrastWCAG21(fg, bg), fgHex: fg.toString({ format: 'hex' }), bgHex: bg.toString({ format: 'hex' }) };
}
const isLarge = (it) => { const px = parseFloat(it.fontSize); return px >= 24 || (Number(it.fontWeight) >= 700 && px >= 18.66); };

const ops = [{ id: 'd8406c70-1c56-4313-81c5-b8d0ca4e0111', attempt: 1, revision: 1, kind: 'save', service: 'instagram',
  sourceUrl: 'https://www.instagram.com/p/RELAYAUDIT/', fileName: 'Набережная.jpg', stage: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
  files: [{ path: 'C:/RelayAuditDownloads/Набережная.jpg', fileName: 'Набережная.jpg', mimeType: 'image/jpeg', size: 3156224, width: 3000, height: 2000 }] },
{ id: 'd8406c70-1c56-4313-81c5-b8d0ca4e0112', attempt: 1, revision: 1, kind: 'save', service: 'x', sourceUrl: 'https://x.com/a/status/1',
  fileName: 'clip.mp4', stage: 'failed', error: 'Не удалось скачать', createdAt: Date.now(), updatedAt: Date.now(), files: [] }];

const states = {
  chat: async () => {
    // Автофокус композера приходит с задержкой и скрывает плейсхолдер: дождаться и снять
    await page.waitForFunction(() => document.activeElement?.id === 'editable-message-text', undefined, { timeout: 12000 }).catch(() => {});
    for (let i = 0; i < 3; i++) { await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(700); }
    await page.evaluate(() => document.activeElement?.blur());
  },
  ops: async () => {
    await page.evaluate((o) => window.__relayNativeMock.media.seed(o, false), ops);
    await page.keyboard.press('Control+j'); await page.waitForSelector('#relay-media-operations'); await t.settle(700);
  },
  controls: async () => { await page.evaluate(() => window.__relayAudit.openOverlay('controls')); await t.settle(700); },
  confirm: async () => { await page.evaluate(() => window.__relayAudit.openOverlay('confirm')); await t.settle(700); },
  menu: async () => { await page.evaluate(() => window.__relayAudit.openOverlay('menu-div')); await t.settle(500);
    await page.locator('.modal-header .Button, .modal-header button').last().click().catch(() => {}); await t.settle(500); },
  settings: async () => { await page.evaluate(() => window.__relayAudit.openSettings('Main')); await t.settle(900); },
};

try {
  const only = process.env.STATES ? process.env.STATES.split(',') : Object.keys(states);
  for (const theme of themes) {
    t = await boot({ port: Number(process.env.PORT || 1515) }); page = t.page;
    for (const state of only) {
      await t.reset(1280, 800, theme);
      await page.waitForTimeout(500);
      await states[state]();
      await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(600);
      await page.waitForTimeout(900);
      const bodyBg = new Color(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).to('srgb');
      const key = state === 'chat' ? (await collect(KEY)).map((it) => (it.missing ? it : { ...it, ...ratio(it, bodyBg) })) : [];
      const all = (await scan()).map((it) => ({ ...it, ...ratio(it, bodyBg) }));
      const bad = all.filter((it) => !it.unknown && it.ratio < (isLarge(it) ? 3 : 4.5));
      fs.writeFileSync(path.join(out, `${theme}-${state}.json`), JSON.stringify({ key, all, bad }, null, 1));
      await page.screenshot({ path: path.join(out, `${theme}-${state}.png`) });
      console.log(`\n### ${theme} / ${state}: scanned ${all.length}, unknown ${all.filter((i) => i.unknown).length}, bad ${bad.length}`);
      for (const k of key) {
        console.log(k.missing ? `-- ${k.name}: НЕТ ЭЛЕМЕНТА (${k.sel})`
          : `${k.unknown ? '??' : k.ratio.toFixed(2)}\t${k.name}\t"${k.text}"\t${k.fgHex ?? k.fg} / ${k.bgHex ?? ''}\t${k.fontSize}`);
      }
      const grouped = {};
      for (const b of bad) (grouped[b.path] ??= []).push(b);
      for (const [g, list] of Object.entries(grouped)) {
        console.log(`BAD ${list[0].ratio.toFixed(2)}\t${g}\t"${list[0].text}"\t${list[0].fgHex} on ${list[0].bgHex}\tx${list.length}`);
      }
      for (const u of all.filter((i) => i.unknown)) console.log(`UNKNOWN(image bg)\t${u.path}\t"${u.text}"\t${u.fg}`);
    }
    // Пары ролей: то, чего нет в харнессе (бейдж, ссылки, ошибки, границы полей, значки)
    await t.reset(1280, 800, theme); await page.waitForTimeout(500);
    const vars = await page.evaluate(() => {
      const names = ['--color-background', '--color-background-secondary', '--color-background-secondary-accent', '--color-background-own', '--color-background-selected',
        '--color-text', '--color-text-secondary', '--color-primary', '--color-primary-text', '--color-active', '--color-links', '--color-error', '--color-success',
        '--color-borders-input', '--color-borders', '--color-icon-secondary', '--color-text-meta'];
      const probe = document.createElement('div'); document.body.append(probe);
      const res = {};
      for (const n of names) { probe.style.color = 'var(' + n + ')'; res[n] = getComputedStyle(probe).color; }
      probe.remove(); return res;
    });
    const C = (n) => new Color(vars[n]).to('srgb');
    const bgOf = (n) => { const c = C(n); return (c.alpha ?? 1) < 1 ? over(c, C('--color-background')) : c; };
    const pairs = [
      ['текст кнопки primary / фон primary', '--color-primary-text', '--color-primary', 4.5],
      ['бейдж непрочитанного: текст / --color-active', '--color-primary-text', '--color-active', 4.5],
      ['вторичный текст / фон', '--color-text-secondary', '--color-background', 4.5],
      ['вторичный текст / поверхность 1 (поле, пузырь чужой)', '--color-text-secondary', '--color-background-secondary', 4.5],
      ['вторичный текст / поверхность 2', '--color-text-secondary', '--color-background-secondary-accent', 4.5],
      ['вторичный текст / поверхность 3 (пузырь свой)', '--color-text-secondary', '--color-background-own', 4.5],
      ['основной текст / выбранный чат', '--color-text', '--color-background-selected', 4.5],
      ['ссылки / фон', '--color-links', '--color-background', 4.5],
      ['ссылки / пузырь свой', '--color-links', '--color-background-own', 4.5],
      ['ошибка / фон', '--color-error', '--color-background', 4.5],
      ['успех / фон', '--color-success', '--color-background', 4.5],
      ['граница поля ввода / поверхность 1 (UI 3:1)', '--color-borders-input', '--color-background-secondary', 3],
      ['граница поля ввода / фон (UI 3:1)', '--color-borders-input', '--color-background', 3],
      ['значки secondary / фон (UI 3:1)', '--color-icon-secondary', '--color-background', 3],
      ['значки secondary / поверхность 1 (UI 3:1)', '--color-icon-secondary', '--color-background-secondary', 3],
      ['кольцо фокуса (--color-text) / фон (UI 3:1)', '--color-text', '--color-background', 3],
      ['кольцо фокуса / поверхность 3 (UI 3:1)', '--color-text', '--color-background-own', 3],
      ['индикатор активного (--color-primary) / фон (UI 3:1)', '--color-primary', '--color-background', 3],
      ['--color-text-meta / фон', '--color-text-meta', '--color-background', 4.5],
    ];
    console.log(`### ${theme} / роли`);
    const rolesOut = [];
    for (const [name, fgN, bgN, min] of pairs) {
      const bg = bgOf(bgN); const fg = over(C(fgN), bg); const r = Color.contrastWCAG21(fg, bg);
      rolesOut.push({ name, fg: fg.toString({ format: 'hex' }), bg: bg.toString({ format: 'hex' }), ratio: r, min, ok: r >= min });
      console.log(`${r >= min ? 'ok ' : 'LOW'} ${r.toFixed(2)}\t${name}\t${fg.toString({ format: 'hex' })} / ${bg.toString({ format: 'hex' })}\t(порог ${min})`);
    }
    fs.writeFileSync(path.join(out, `${theme}-roles.json`), JSON.stringify(rolesOut, null, 1));
    await t.close();
  }
} finally { await t?.close().catch(() => {}); }

