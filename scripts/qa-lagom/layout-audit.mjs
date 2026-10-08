// Аудит раскладки: наложения, обрезания, схлопнутые контейнеры, выход за окно.
// Запуск: OUT=<папка> [THEMES=lagom-dark,lagom-light] [SIZES=640x448,800x560,1920x1080] [ONLY=chat,settings] [SHOTS=all] node scripts/qa-lagom/layout-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './common.mjs';

const out = process.env.OUT || path.join(process.env.TEMP, 'relay-layout-audit');
fs.mkdirSync(out, { recursive: true });
const themes = (process.env.THEMES || 'lagom-dark,lagom-light').split(',');
const sizes = (process.env.SIZES || '640x448,800x560,1920x1080').split(',').map((s) => s.split('x').map(Number));
const only = process.env.ONLY?.split(',');
const fontSize = Number(process.env.FONT || 16); // 32 = 200 % текста
const ops = [{ id: 'd8406c70-1c56-4313-81c5-b8d0ca4e0111', attempt: 1, revision: 1, kind: 'save', service: 'instagram',
  sourceUrl: 'https://www.instagram.com/p/RELAYAUDIT/', fileName: 'Набережная.jpg', stage: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
  files: [{ path: 'C:/RelayAuditDownloads/Набережная.jpg', fileName: 'Набережная.jpg', mimeType: 'image/jpeg', size: 3156224, width: 3000, height: 2000 }] }];
const shareRequest = { requestId: 'qa-layout-0000000001', service: 'x', url: 'https://x.com/egoist/status/1234567890',
  text: 'Текст публикации для проверки.', media: [{ url: 'https://pbs.twimg.com/media/a.jpg', type: 'photo' }] };

// Проверки внутри страницы: список находок для видимого верхнего слоя
function scan() {
  const found = [];
  const vw = window.innerWidth; const vh = window.innerHeight;
  const isVisible = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none')) return false;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (Number(getComputedStyle(p).opacity) < 0.05) return false;
      if (p.getAttribute('aria-hidden') === 'true' || p.hasAttribute('inert')) return false;
    }
    return true;
  };
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}${txt ? ` «${txt}»` : ''}`;
  };
  const scrollAncestorClips = (el, r) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!/(auto|scroll|hidden)/.test(s.overflowY + s.overflowX)) continue;
      const pr = p.getBoundingClientRect();
      if (r.bottom > pr.bottom + 1 || r.top < pr.top - 1 || r.right > pr.right + 1 || r.left < pr.left - 1) return true;
    }
    return false;
  };
  // Открытая модалка или меню ограничивает проверку своим содержимым
  const center = document.elementFromPoint(vw / 2, vh / 2);
  const layer = center?.closest('dialog, .Modal, .Menu, #relay-media-operations');
  const root = layer || document.body;
  const selector = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], .ListItem-button, .MenuItem';
  for (const el of [...root.querySelectorAll(selector)].filter(isVisible)) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
      if (!scrollAncestorClips(el, r)) found.push({ kind: 'offscreen', el: describe(el), rect: [r.left, r.top, r.right, r.bottom].map(Math.round) });
      continue;
    }
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    const label = el.closest('label');
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !(label && label.contains(top)) && !scrollAncestorClips(el, r)) {
      found.push({ kind: 'overlap', el: describe(el), by: describe(top) });
    }
    if ((el.textContent || '').trim() && r.height < 10) found.push({ kind: 'collapsed-control', el: describe(el), h: Math.round(r.height) });
  }
  for (const el of root.querySelectorAll('*')) {
    if (el.children.length > 6 || !isVisible(el)) continue;
    const s = getComputedStyle(el);
    const hasText = (el.textContent || '').trim();
    if (hasText && s.whiteSpace === 'nowrap' && /(hidden|clip)/.test(s.overflowX) && s.textOverflow !== 'ellipsis'
      && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
      found.push({ kind: 'text-clipped', el: describe(el), sw: el.scrollWidth, cw: el.clientWidth });
    }
    if (/(auto|scroll)/.test(s.overflowY) && el.clientHeight < 40 && el.scrollHeight > el.clientHeight + 24 && el.clientWidth > 80) {
      found.push({ kind: 'collapsed-scroll', el: describe(el), ch: el.clientHeight, sh: el.scrollHeight });
    }
  }
  if (document.documentElement.scrollWidth > vw + 1) found.push({ kind: 'page-hscroll', sw: document.documentElement.scrollWidth, vw });
  return found;
}

const report = [];
const states = {
  chat: async () => {},
  operations: async (t) => {
    await t.page.evaluate((o) => window.__relayNativeMock.media.seed(o, false), ops);
    await t.page.keyboard.press('Control+j');
    await t.page.waitForSelector('#relay-media-operations');
  },
  share: async (t) => {
    await t.page.waitForFunction(() => typeof window.__relayAudit.openShare === 'function', undefined, { timeout: 60000 });
    await t.page.evaluate((r) => window.__relayAudit.openShare(r), shareRequest);
    await t.page.waitForSelector('[data-relay-share-modal]', { state: 'attached' });
  },
  toast: async (t) => {
    await t.page.evaluate(() => window.__relayAudit.notify('Ссылка скопирована. Длинный текст уведомления проверяет перенос строк и ширину.'));
    await t.page.waitForSelector('.Notification', { state: 'attached' });
  },
  'auth-phone': async (t) => { await t.page.evaluate(() => window.__relayAudit.setAuthState('authorizationStateWaitPhoneNumber')); await t.page.waitForSelector('#auth-phone-form, .Auth, #auth-phone-number-form', { state: 'attached' }); },
  'auth-code': async (t) => { await t.page.evaluate(() => window.__relayAudit.setAuthState('authorizationStateWaitCode')); await t.page.waitForTimeout(800); },
  'auth-password': async (t) => { await t.page.evaluate(() => window.__relayAudit.setAuthState('authorizationStateWaitPassword')); await t.page.waitForTimeout(800); },
  'auth-qr': async (t) => { await t.page.evaluate(() => window.__relayAudit.setAuthState('authorizationStateWaitQrCode')); await t.page.waitForTimeout(800); },
  menu: async (t) => { await t.page.evaluate(() => window.__relayAudit.openOverlay('menu-native')); },
  controls: async (t) => { await t.page.evaluate(() => window.__relayAudit.openOverlay('controls')); },
  confirm: async (t) => { await t.page.evaluate(() => window.__relayAudit.openOverlay('confirm')); },
  date: async (t) => { await t.page.evaluate(() => window.__relayAudit.openOverlay('date')); },
  nested: async (t) => {
    await t.page.evaluate(() => window.__relayAudit.openOverlay('nested'));
    await t.page.evaluate(() => document.getElementById('audit-nested-trigger')?.click());
  },
};
const settingsNames = [];
for (const theme of themes) {
  const t = await boot({ port: Number(process.env.PORT || 1551), theme, rootFontSize: fontSize === 16 ? undefined : fontSize });
  try {
    await t.page.waitForFunction(() => window.__relayAudit?.groups, undefined, { timeout: 60000 });
    await t.page.evaluate(() => window.__relayAudit.groups.seedSettings());
    if (!settingsNames.length) settingsNames.push(...await t.page.evaluate(() => window.__relayAudit.groups.settings));
    const list = [...Object.keys(states), ...settingsNames.map((n) => `settings:${n}`)]
      .filter((n) => !only || only.some((o) => n.startsWith(o)));
    for (const [w, h] of sizes) {
      for (const name of list) {
        await t.page.evaluate(() => { window.__relayAudit.openOverlay?.(undefined); window.__relayAudit.setAuthState('authorizationStateReady'); });
        if (await t.page.locator('#relay-media-operations').count()) { await t.page.keyboard.press('Control+j'); await t.page.waitForTimeout(300); }
        await t.reset(w, h, theme, fontSize);
        if (name.startsWith('settings:')) {
          // На узком окне левая колонка видна только без открытого чата
          if (w < 926) await t.page.evaluate(() => window.__relayAudit.closeChat());
          await t.page.evaluate((n) => window.__relayAudit.groups.openSettings(n), name.slice(9));
          await t.page.waitForTimeout(700);
        } else await states[name](t);
        await t.settle(700);
        const found = await t.page.evaluate(scan);
        const shot = `${theme}-${w}x${h}${fontSize === 16 ? '' : '-200pct'}-${name.replace(':', '_')}`;
        if (found.length || process.env.SHOTS === 'all') await t.page.screenshot({ path: path.join(out, `${shot}.png`) });
        report.push({ theme, w, h, name, found });
        console.log(found.length ? 'FOUND' : 'ok', shot, found.length ? JSON.stringify(found.slice(0, 6)) : '');
      }
    }
    console.log('errors', JSON.stringify(t.errors));
  } finally { await t.close(); }
}
fs.writeFileSync(path.join(out, 'layout-audit.json'), JSON.stringify(report, null, 1));
console.log('findings', report.filter((r) => r.found.length).length, 'of', report.length);
