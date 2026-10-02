import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.RELAY_DISPLAY_SCALE_OUTPUT; if (!output) throw new Error('Own task work directory is required');
const evidence = process.env.RELAY_DISPLAY_SCALE_EVIDENCE; if (!evidence) throw new Error('Project evidence directory is required');
const { chromium } = await import(pathToFileURL(path.join(project, 'node_modules/@playwright/test/index.mjs')));
const { initializeAuditBrowser } = await import(pathToFileURL(path.join(project, 'scripts/relay-ui-audit.server.mjs')));
const { startAdditionalServer } = await import(pathToFileURL(path.join(project, 'scripts/relay-ui-additional-modals.server.fixture.mjs')));
const executable = process.env.RELAY_UI_AUDIT_BROWSER; if (!executable) throw new Error('Existing headless browser executable is required');
await mkdir(output, { recursive: true });
const label = process.env.DISPLAY_SCALE_LABEL || 'source-acceptance';
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), label, scope: 'Actual App/body components with MockClient and isolated native mocks; physical pixel model FullHD1920x1080 at DPR1/CSS1920x1080 and DPR2/CSS960x540', limits: ['Controlled headless DPR and responsive viewport, not native Windows WebView DPI or browser text-only zoom', 'No real account operations, uploads, external network, payments or product source edits', 'AttachmentModalItem is preview child only; full composer covered independently'], cases: [], pageErrors: [], blockedRequests: 0, sourceHashesBefore: {}, sourceHashesAfter: {} };
const allKinds = ['contact', 'contact-edit', 'report-options', 'report-comment', 'country', 'password', 'formatting', 'safe-link', 'browser-close', 'mute', 'pin', 'delete-chat', 'attachment-photo', 'attachment-file', 'document', 'chat-language', 'delete-message'];
const kinds = process.env.DISPLAY_SCALE_KINDS ? process.env.DISPLAY_SCALE_KINDS.split(',') : allKinds;
const sources = {
  contact: 'src/components/main/NewContactModal.tsx', 'contact-edit': 'src/components/main/NewContactModal.tsx',
  'report-options': 'src/components/modals/reportModal/ReportModal.tsx', 'report-comment': 'src/components/modals/reportModal/ReportModal.tsx',
  country: 'src/components/common/CountryPickerModal.tsx', ['password']: 'src/components/common/PasswordConfirmModal.tsx',
  formatting: 'src/components/common/RemoveFormattingModal.tsx', 'safe-link': 'src/components/main/SafeLinkModal.tsx',
  'browser-close': 'src/components/main/BrowserCloseConfirmationModal.tsx', mute: 'src/components/left/MuteChatModal.tsx',
  pin: 'src/components/common/PinMessageModal.tsx', 'delete-chat': 'src/components/common/DeleteChatModal.tsx',
  'attachment-photo': 'src/components/middle/composer/AttachmentModalItem.tsx', 'attachment-file': 'src/components/middle/composer/AttachmentModalItem.tsx',
  document: 'src/components/common/DocumentReaderModal.tsx', 'chat-language': 'src/components/middle/ChatLanguageModal.tsx',
  'delete-message': 'src/components/common/DeleteMessageModal.tsx'
};
const files = [...new Set([...Object.values(sources), 'src/components/ui/Modal.scss', 'src/components/ui/Modal.tsx', 'src/components/common/Titlebar.module.scss', 'src/components/App.module.scss', 'scripts/relay-ui-audit.server.mjs', 'scripts/relay-ui-additional-modals.fixture.tsx', 'scripts/relay-ui-additional-modals.server.fixture.mjs'])];
async function hashSources(target) { for (const name of files) target[name] = createHash('sha256').update(await readFile(path.join(project, name))).digest('hex'); }
await hashSources(report.sourceHashesBefore);
const { server, url } = await startAdditionalServer(output, 1268);
let browser; let context;
try {
  browser = await chromium.launch({ headless: true, executablePath: executable });
  for (const dpr of [1, 2]) {
    context = await browser.newContext({ viewport: { width: 1920 / dpr, height: 1080 / dpr }, deviceScaleFactor: dpr, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.addInitScript(initializeAuditBrowser);
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
      report.blockedRequests++; return route.abort();
    });
    page.on('pageerror', (error) => report.pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') { report.consoleErrors ||= []; report.consoleErrors.push(message.text().slice(0, 1200)); } });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__relayAdditional?.open && window.__relayAudit.state().chatCount >= 2, null, { timeout: 60000 });
    await page.evaluate(async () => {
      const { getGlobal, setGlobal } = await import('/src/global/index.ts');
      window.__rootDisplayGlobal = getGlobal;
      const global = getGlobal();
      // Fixture state is explicit when the isolated boot chooses the default mock
      // scenario. This is never a profile/account fetch or a product source edit.
      if (!global.chats.byId['101']) {
        const user = { id: '101', isMin: false, type: 'userTypeRegular', firstName: 'Марина', lastName: 'Волкова', phoneNumber: '0' };
        const chat = { id: '101', type: 'chatTypePrivate', title: 'Марина Волкова' };
        const message = { id: 1, chatId: '101', senderId: '101', date: 1790909356, isOutgoing: false, content: { text: { text: 'Synthetic display-scale message' } } };
        setGlobal({ ...global,
          users: { ...global.users, byId: { ...global.users.byId, [user.id]: user } },
          chats: { ...global.chats, byId: { ...global.chats.byId, [chat.id]: chat } },
          messages: { ...global.messages, byChatId: { ...global.messages.byChatId, '101': { byId: { 1: message }, threadsById: { 0: { listedIds: [1], viewportIds: [1] } } } } },
        });
        window.__rootDisplaySeeded = true;
      }
    });
    await page.waitForFunction(() => Boolean(window.__rootDisplayGlobal().chats.byId['101']), null, { timeout: 30000 });
    report.bootstrap ||= [];
    report.bootstrap.push(await page.evaluate(() => ({ url: window.location.href, state: window.__relayAudit.state(), chatIds: Object.keys(window.__rootDisplayGlobal().chats.byId), explicitSyntheticSeed: Boolean(window.__rootDisplaySeeded) })));
    await page.evaluate(() => window.__relayAudit.openChat('101'));
    await page.waitForFunction(() => Object.keys(window.__rootDisplayGlobal().messages.byChatId['101']?.byId || {}).length > 0, null, { timeout: 30000 });
    report.fixturePreconditions ||= [];
    report.fixturePreconditions.push(await page.evaluate(() => ({ dpr: window.devicePixelRatio, chat101: Boolean(window.__rootDisplayGlobal().chats.byId['101']), message101Count: Object.keys(window.__rootDisplayGlobal().messages.byChatId['101']?.byId || {}).length })));
    if (process.env.DISPLAY_SCALE_CSS_PROOF === '1') await page.addStyleTag({ content: '.Modal:not(.GameModal) .modal-dialog:not(.browser-modal-dialog):not(.premium-main-modal-dialog){top:calc(var(--relay-shell-caption-height,2.5rem) / 2);max-height:calc(100vh - 4rem);max-height:calc(100dvh - 4rem)}.Modal:not(.GameModal) .modal-dialog:not(.browser-modal-dialog):not(.premium-main-modal-dialog) .modal-content{min-height:0}' });
    await page.waitForTimeout(400);
    for (const base of ['light', 'dark']) {
      const theme = await page.evaluate((value) => window.__relayAudit.themes.find((item) => item.base === value), base);
      assert(theme, 'Actual theme required: ' + base);
      await page.evaluate((id) => window.__relayAudit.applyTheme(id), theme.id); await page.waitForTimeout(200);
      for (const kind of kinds) {
        const id = label + '-' + kind + '-dpr' + dpr + '-' + base;
        const row = { id, kind, dpr, themeId: theme.id, source: sources[kind] };
        try {
          await page.evaluate(() => window.__relayAdditional.close()); await page.waitForTimeout(250);
          await page.evaluate((value) => {
            if (value === 'document') window.__relayAdditional.openDocument('txt');
            else if (value === 'chat-language') window.__relayAdditional.openChatLanguage();
            else if (value === 'delete-message') window.__relayAdditional.openDeleteMessage();
            else window.__relayAdditional.open(value);
          }, kind);
          await page.waitForTimeout(400);
          const modal = page.locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last();
          await modal.waitFor({ state: 'visible', timeout: 5000 });
          if (kind === 'document') await modal.locator('[class*="textLines"]').waitFor({ state: 'visible', timeout: 5000 });
          row.platformCssProbe = await modal.evaluate((element) => {
            const original = document.body.className;
            const result = { applicable: element.classList.contains('modal-dialog'), actualBodyClasses: original, actualTop: getComputedStyle(element).top }; if (!result.applicable) return result;
            document.body.classList.remove('is-tauri');
            result.nonTauriTop = getComputedStyle(element).top;
            document.body.className = original;
            document.body.classList.remove('is-windows');
            document.body.classList.add('is-macos', 'is-tauri');
            result.macBodyClassTop = getComputedStyle(element).top;
            document.body.className = original;
            return result;
          });
          assert(row.platformCssProbe.actualBodyClasses.includes('is-windows') && row.platformCssProbe.actualBodyClasses.includes('is-tauri'), 'Actual Windows/Tauri mock root precondition');
          if (row.platformCssProbe.applicable) assert(['auto', '0px'].includes(row.platformCssProbe.nonTauriTop), 'No caption offset without native Tauri body class');
          if (row.platformCssProbe.applicable) assert(['auto', '0px'].includes(row.platformCssProbe.macBodyClassTop), 'No Windows caption offset for Mac body class');
          row.openingSample = await modal.evaluate((element) => {
            const bar = document.querySelector('[class*="Titlebar"][class*="titlebar"]')?.getBoundingClientRect();
            const title = element.querySelector('.modal-title')?.getBoundingClientRect();
            const buttons = Array.from(element.querySelectorAll('.modal-header button')).filter((node) => node.getClientRects().length);
            return { panel: element.getBoundingClientRect().toJSON(), titlebarBottom: bar?.bottom, title: title?.toJSON(), buttons: buttons.map((node) => {
              const rect = node.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
              return { enabled: !node.disabled, rect: rect.toJSON(), hitWithin: Boolean(hit && (hit === node || node.contains(hit))) };
            }) };
          });
          const settleStart = Date.now();
          await modal.evaluate(async (element) => {
            await Promise.allSettled(element.getAnimations().filter((animation) => animation.playState !== 'finished').map((animation) => animation.finished));
            await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
          });
          row.settleWaitMs = Date.now() - settleStart;
          row.geometry = await modal.evaluate((element) => {
            const rect = element.getBoundingClientRect(); const epsilon = 1.1;
            const nodes = Array.from(element.querySelectorAll('button,input,textarea,[role=button]')).filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
            const outside = nodes.filter((node) => {
              const r = node.getBoundingClientRect();
              if (r.left >= -epsilon && r.right <= window.innerWidth + epsilon && r.top >= -epsilon && r.bottom <= window.innerHeight + epsilon) return false;
              for (let p = node.parentElement; p && p !== element; p = p.parentElement) {
                const s = getComputedStyle(p), b = p.getBoundingClientRect();
                if (/auto|scroll/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1 && b.left >= -epsilon && b.right <= window.innerWidth + epsilon && b.top >= -epsilon && b.bottom <= window.innerHeight + epsilon) return false;
              }
              return true;
            }).map((node) => ({ tag: node.tagName, text: node.textContent?.trim().slice(0, 80), box: node.getBoundingClientRect().toJSON() }));
            return { viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, physicalWidth: window.innerWidth * window.devicePixelRatio, physicalHeight: window.innerHeight * window.devicePixelRatio }, modal: rect.toJSON(), content: element.querySelector('.modal-content')?.getBoundingClientRect().toJSON(), header: element.querySelector('.modal-header')?.getBoundingClientRect().toJSON(), titlebar: document.querySelector('[class*="Titlebar"][class*="titlebar"]')?.getBoundingClientRect().toJSON(), controls: nodes.length, outside, text: element.textContent.trim().slice(0, 100), samples: Array.from(element.querySelectorAll('p,h1,h2,h3,button,label,input,textarea')).slice(0, 12).map((node) => {
              const s = getComputedStyle(node); return { tag: node.tagName, fontSizeCss: s.fontSize, fontSizePhysical: parseFloat(s.fontSize) * window.devicePixelRatio, lineHeightCss: s.lineHeight, text: node.textContent?.trim().slice(0, 50) };
            }) };
          });
          assert.equal(row.geometry.viewport.physicalWidth, 1920); assert.equal(row.geometry.viewport.physicalHeight, 1080);
          assert(row.geometry.controls > 0 && row.geometry.text.length > 5);
          const r = row.geometry.modal;
          assert(r.left >= -1.1 && r.right <= 1920 / dpr + 1.1 && r.top >= -1.1 && r.bottom <= 1080 / dpr + 1.1, 'Modal bounds outside controlled viewport');
          assert.equal(row.geometry.outside.length, 0, 'Controls outside viewport without in-bounds scroll parent');
          if (row.geometry.content) {
            const c = row.geometry.content;
            assert(c.top >= r.top - 1 && c.bottom <= r.bottom + 1, 'Actual modal content must fit outer panel');
          }
          if (row.geometry.header && row.geometry.titlebar) {
            assert(row.geometry.header.top >= row.geometry.titlebar.bottom - 1, 'Actual header must be below Relay titlebar');
            const headerButtons = modal.locator('.modal-header button');
            for (let index = 0; index < await headerButtons.count(); index++) {
              if (await headerButtons.nth(index).isVisible()) await headerButtons.nth(index).click({ trial: true, timeout: 3000 });
            }
          }
          if (process.env.DISPLAY_SCALE_REACHABILITY === '1') {
            row.scrollBefore = await modal.evaluate((el) => {
              const body = el.querySelector('.modal-content');
              return body ? { top: body.scrollTop, height: body.clientHeight, scrollHeight: body.scrollHeight, rect: body.getBoundingClientRect().toJSON() } : null;
            });
            const targets = modal.locator('.dialog-buttons button, .confirm-dialog-button');
            row.footerReachability = [];
            for (let index = 0; index < await targets.count(); index++) {
              const button = targets.nth(index); if (!await button.isVisible()) continue;
              await button.scrollIntoViewIfNeeded();
              const detail = await button.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return { text: el.textContent?.trim(), rect: rect.toJSON(), hitWithin: Boolean(hit && (hit === el || el.contains(hit))), hitTag: hit?.tagName, hitClass: hit?.className };
              });
              detail.enabled = await button.isEnabled(); assert(detail.rect.top >= -1 && detail.rect.bottom <= 1080 / dpr + 1 && (!detail.enabled || detail.hitWithin), 'Actual enabled footer scroll and hit-test reachability');
              if (detail.enabled) await button.click({ trial: true, timeout: 3000 });
              row.footerReachability.push(detail);
            }
            if (kind === 'contact-edit') assert.equal(row.footerReachability.length, 2, 'Actual Done and Cancel required');
            if (kind === 'chat-language') {
              const item = modal.locator('.modal-content .ListItem').last();
              assert(await item.count(), 'Actual language list required');
              await item.scrollIntoViewIfNeeded();
              row.lastLanguage = await item.evaluate((el) => ({ rect: el.getBoundingClientRect().toJSON(), text: el.textContent?.trim().slice(0, 120) }));
              assert(row.lastLanguage.rect.top >= -1 && row.lastLanguage.rect.bottom <= 1080 / dpr + 1);
              const input = modal.locator('input').first(); await input.scrollIntoViewIfNeeded(); await input.focus();
              assert(await input.evaluate((el) => document.activeElement === el));
            }
            row.scrollAfter = await modal.evaluate((el) => {
              const body = el.querySelector('.modal-content');
              return body ? { top: body.scrollTop, height: body.clientHeight, scrollHeight: body.scrollHeight, rect: body.getBoundingClientRect().toJSON() } : null;
            });
          }
          if (['country', 'password', 'document', 'contact-edit', 'chat-language'].includes(kind)) { row.screenshot = 'display-scale-' + id + '.png'; await page.screenshot({ path: path.join(evidence, row.screenshot) }); }
          row.status = 'pass';
        } catch (error) {
          row.status = 'fail'; row.error = String(error); row.screenshot = 'display-scale-' + id + '-failure.png';
          await page.screenshot({ path: path.join(evidence, row.screenshot) }).catch(() => {});
        }
        report.cases.push(row); console.log(row.status.toUpperCase() + ' ' + id);
      }
    }
    await context.close(); context = null;
  }
} catch (error) { report.fatal = String(error); }
finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await server.close();
  await hashSources(report.sourceHashesAfter);
  report.sourceHashesUnchanged = JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
  report.summary = { total: report.cases.length, passed: report.cases.filter((item) => item.status === 'pass').length, failed: report.cases.filter((item) => item.status === 'fail').length, pageErrors: report.pageErrors.length, consoleErrors: report.consoleErrors?.length || 0, sourceHashesUnchanged: report.sourceHashesUnchanged };
  await writeFile(path.join(evidence, 'display-scale-audit-' + label + '.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(evidence, 'display-scale-audit-' + label + '.md'), '# Проверка масштаба дисплея\n\n' + report.summary.passed + '/' + report.summary.total + ' actual-component cases passed; failures ' + report.summary.failed + '; pageErrors ' + report.summary.pageErrors + '. Источники неизменны: ' + report.sourceHashesUnchanged + '.\n\nМодель физических 1920×1080: DPR1 с CSS1920×1080 и DPR2 с CSS960×540; две настоящие темы. Это контролируемая headless-проверка responsive layout, а не native Windows DPI или browser text-only zoom.\n\n' + report.cases.filter((item) => item.status === 'fail').map((item) => '- ' + item.id + ': ' + item.error).join('\n') + '\n');
  console.log(JSON.stringify(report.summary));
}
if (report.fatal || report.summary.failed || !report.sourceHashesUnchanged || report.summary.pageErrors) process.exitCode = 1;







