import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { initializeAuditBrowser } from './relay-ui-audit.server.mjs';
import { startRemainingServer } from './relay-ui-remaining-modals.server.fixture.mjs';
const output = process.env.RELAY_UI_REMAINING_OUTPUT;
const evidence = process.env.RELAY_UI_REMAINING_EVIDENCE;
const executable = process.env.RELAY_UI_AUDIT_BROWSER;
if (!output || !evidence || !executable) throw new Error('Task-owned runtime, project evidence and existing browser are required');
const label = process.env.RELAY_UI_REMAINING_LABEL || 'first';
const sources = {
  block: 'src/components/left/settings/BlockUserModal.tsx', 'block-empty': 'src/components/left/settings/BlockUserModal.tsx',
  'privacy-read': 'src/components/common/PrivacySettingsNoticeModal.tsx', 'privacy-last': 'src/components/common/PrivacySettingsNoticeModal.tsx',
  sensitive: 'src/components/common/SensitiveContentConfirmModal.tsx', 'report-avatar': 'src/components/common/ReportAvatarModal.tsx',
  unpin: 'src/components/common/UnpinAllMessagesModal.tsx', folder: 'src/components/main/DeleteFolderDialog.tsx', 'folder-shared': 'src/components/main/DeleteFolderDialog.tsx',
  'bot-trust': 'src/components/main/BotTrustModal.tsx', 'remove-user': 'src/components/right/management/RemoveGroupUserModal.tsx',
  'auto-delete': 'src/components/modals/autoDeleteTimer/AutoDeleteTimerModal.tsx', birthday: 'src/components/modals/birthday/BirthdaySetupModal.tsx', 'birthday-empty': 'src/components/modals/birthday/BirthdaySetupModal.tsx',
  prompt: 'src/components/modals/prompt/PromptDialog.tsx', rank: 'src/components/modals/rank/EditRankModal.tsx', 'rank-disabled': 'src/components/modals/rank/EditRankModal.tsx',
};
const renderers = { 'privacy-read': 'Real App MiddleColumn async body via openPrivacySettingsNoticeModal', 'privacy-last': 'Real App MiddleColumn async body via openPrivacySettingsNoticeModal', 'auto-delete': 'Real App ModalContainer wrapped body via openAutoDeleteTimerModal', birthday: 'Real App ModalContainer legacy body via openBirthdaySetupModal', 'birthday-empty': 'Real App ModalContainer legacy body via openBirthdaySetupModal', rank: 'Real App ModalContainer legacy body via openEditRankModal', 'rank-disabled': 'Real App ModalContainer legacy body via openEditRankModal' };
const protectedNames = ['blockUser', 'deleteChatMember', 'reportProfilePhoto', 'deleteChatFolder', 'openDeleteChatFolderModal', 'markBotTrusted', 'updateGlobalPrivacySettings', 'setPrivacyVisibility', 'setChatHistoryTtl', 'updateBirthday', 'suggestBirthday', 'editChatParticipantRank', 'unpin', 'sensitiveConfirm', 'promptSubmit'];
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), label, scope: '12 exact imported production body paths, 17 synthetic branches; actual App and existing MockClient, no production edits', cases: [], errors: [], blockedRequests: 0, sourceHashes: {}, limits: ['Every server action is intercepted locally; no backend acceptance or real account permission claim', 'RTL/reduced motion/root32 emulations are layout evidence, not certification of all locales/device DPI/uniform 200% typography', 'No gallery, complete application or remaining roster certification'] };
await mkdir(output, { recursive: true }); await mkdir(evidence, { recursive: true });
for (const source of [...new Set(Object.values(sources)), 'src/components/modals/ModalContainer.tsx']) report.sourceHashes[source] = createHash('sha256').update(await readFile(source)).digest('hex');
const { server, url } = await startRemainingServer(output); let browser; let page;
const events = () => page.evaluate(() => window.__relayRemaining.events);
const count = async (name) => (await events()).filter((event) => event.name === name).length;
async function close() { await page.evaluate(() => window.__relayRemaining.close()); await page.waitForTimeout(300); }
async function open(kind) {
  await close(); await page.evaluate((value) => window.__relayRemaining.open(value), kind); await page.waitForTimeout(300);
  const modal = page.locator('dialog[open], .Modal.open:not(dialog) .modal-dialog').last(); await modal.waitFor({ state: 'visible', timeout: 6000 }); return modal;
}
async function press(control, key) {
  await control.focus(); const actual = await control.evaluate((element) => ({ focused: element === window.document.activeElement, tag: element.tagName, role: element.getAttribute('role'), text: element.textContent?.trim().slice(0, 100), markup: element.outerHTML.slice(0, 500) })); assert(actual.focused, 'Actual target must be document.activeElement');
  report.interactionTarget = actual; await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))); await page.keyboard.press(key); await page.waitForTimeout(160); return actual;
}
async function run(id, kind, action) {
  if (process.env.RELAY_UI_REMAINING_FILTER && !new RegExp(process.env.RELAY_UI_REMAINING_FILTER).test(id)) return;
  delete report.interactionTarget; delete report.lastGeometry; const errorStart = report.errors.length; const eventStart = (await events()).length;
  try { const detail = await action(); report.cases.push({ id, source: sources[kind], renderer: renderers[kind] || 'Actual imported body in task-owned Teact root beside real App', status: detail?.isGate ? 'gate' : 'pass', detail, interactionTarget: report.interactionTarget, newErrors: report.errors.slice(errorStart) }); console.log('PASS ' + id); }
  catch (error) { const screenshot = `ui-remaining-modal-${label}-${id}.png`; await page.screenshot({ path: path.join(evidence, screenshot) }).catch(() => {}); report.cases.push({ id, source: sources[kind], renderer: renderers[kind] || 'Actual imported body', status: 'fail', error: String(error), screenshot, interactionTarget: report.interactionTarget, protectedEvents: (await events()).slice(eventStart), geometry: report.lastGeometry, active: await page.evaluate(() => window.document.activeElement?.outerHTML.slice(0, 400)), newErrors: report.errors.slice(errorStart) }); console.log('FAIL ' + id + ' ' + String(error).slice(0, 220)); }
  finally { await page.keyboard.up('Enter'); await page.keyboard.up('Space'); }
}
async function geometry(modal) {
  return modal.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const visible = Array.from(element.querySelectorAll('button,input,textarea,[role=button]')).filter((control) => control.getClientRects().length && window.getComputedStyle(control).visibility !== 'hidden');
    const outside = visible.filter((control) => { const box = control.getBoundingClientRect(); if (box.left >= -1 && box.right <= window.innerWidth + 1 && box.top >= -1 && box.bottom <= window.innerHeight + 1) return false; let parent = control.parentElement; while (parent && parent !== element) { const style = window.getComputedStyle(parent); const bound = parent.getBoundingClientRect(); if (/auto|scroll/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1 && bound.top >= -1 && bound.bottom <= window.innerHeight + 1 && bound.left >= -1 && bound.right <= window.innerWidth + 1) return false; parent = parent.parentElement; } return true; }).map((control) => ({ text: control.textContent?.trim().slice(0, 60), tag: control.tagName, box: control.getBoundingClientRect().toJSON() }));
    return { box: rectangle.toJSON(), bodyText: element.textContent?.trim().slice(0, 350), controls: visible.length, outsideViewport: outside, headers: Array.from(element.querySelectorAll('.modal-header,.modal-title')).map((node) => ({ className: node.className, text: node.textContent?.trim(), box: node.getBoundingClientRect().toJSON() })), scrollSurfaces: [element, ...element.querySelectorAll('[class*=modal-content]')].map((node) => ({ className: node.className, box: node.getBoundingClientRect().toJSON(), clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, overflow: window.getComputedStyle(node).overflowY })), direction: window.getComputedStyle(element).direction, rootFont: window.getComputedStyle(window.document.documentElement).fontSize, bodyFont: window.getComputedStyle(element).fontSize, themeClass: window.document.body.className, rootClass: window.document.documentElement.className, themeState: window.__relayRemaining.state().themeBase, prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches, background: window.getComputedStyle(element).backgroundColor, foreground: window.getComputedStyle(element).color, typography: Array.from(element.querySelectorAll('p,h2,h3,button,label,input')).slice(0, 10).map((node) => ({ tag: node.tagName, text: node.textContent?.trim().slice(0, 45), fontSize: window.getComputedStyle(node).fontSize, lineHeight: window.getComputedStyle(node).lineHeight })) };
  });
}
try {
  browser = await chromium.launchPersistentContext(path.join(output, 'profile-' + label + '-' + Date.now()), { headless: true, executablePath: executable, viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
  page = await browser.newPage(); await page.addInitScript(initializeAuditBrowser);
  await page.route('**/*', (route) => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); report.blockedRequests += 1; return route.abort(); });
  page.on('pageerror', (error) => report.errors.push({ phase: 'pageerror', error: String(error) }));
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__relayRemaining?.open && window.__relayAudit.state().chatCount >= 2, { timeout: 30000 });
  await page.evaluate(() => window.__relayAudit.openChat('101')); await page.waitForFunction(() => window.__relayAudit.state().currentChatId === '101'); await page.waitForTimeout(500);
  const modes = [
    { id: 'dark-fullhd', width: 1920, height: 1080, font: '16px', dir: 'ltr', motion: 'no-preference', theme: 'lagom-dark' },
    { id: 'light-fullhd', width: 1920, height: 1080, font: '16px', dir: 'ltr', motion: 'no-preference', theme: 'lagom-light' },
    { id: 'legacy-light-fullhd', width: 1920, height: 1080, font: '16px', dir: 'ltr', motion: 'no-preference', theme: 'light-modern' },
    { id: 'narrow', width: 640, height: 900, font: '16px', dir: 'ltr', motion: 'no-preference', theme: 'lagom-dark' },
    { id: 'root32', width: 1920, height: 1080, font: '32px', dir: 'ltr', motion: 'no-preference', theme: 'lagom-dark' },
    { id: 'rtl-reduced', width: 1920, height: 1080, font: '16px', dir: 'rtl', motion: 'reduce', theme: 'lagom-dark' },
  ];
  for (const mode of modes) {
    await close(); await page.setViewportSize({ width: mode.width, height: mode.height }); await page.emulateMedia({ reducedMotion: mode.motion });
    await page.evaluate((current) => { window.document.documentElement.style.fontSize = current.font; window.document.documentElement.dir = current.dir; window.__relayAudit.applyTheme(current.theme); }, mode); await page.waitForTimeout(150);
    for (const kind of Object.keys(sources)) await run(kind + '-' + mode.id + '-body', kind, async () => {
      const modal = await open(kind); const result = await geometry(modal); report.lastGeometry = result; assert(result.rootClass.includes('theme-variant-' + mode.theme)); assert.equal(result.themeState, ['lagom-light', 'light-modern'].includes(mode.theme) ? 'light' : 'dark'); assert.equal(result.prefersReducedMotion, mode.motion === 'reduce'); assert(result.controls > 0); assert(result.bodyText.length > 8, 'Concrete body text required');
      const screenshot = `ui-remaining-modal-${label}-${kind}-${mode.id}.png`; await page.screenshot({ path: path.join(evidence, screenshot) }); assert.equal(result.outsideViewport.length, 0, JSON.stringify(result.outsideViewport));
      return { mode, ...result, screenshot, exactBody: true };
    });
  }
  await close(); await page.setViewportSize({ width: 1920, height: 1080 }); await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.evaluate(() => { window.document.documentElement.style.fontSize = '16px'; window.document.documentElement.dir = 'ltr'; window.__relayAudit.applyTheme('dark-modern'); });
  for (const kind of ['sensitive', 'report-avatar', 'unpin', 'folder', 'folder-shared', 'bot-trust', 'auto-delete', 'prompt']) for (const key of ['Enter', 'Space']) await run(kind + '-cancel-' + key.toLowerCase(), kind, async () => {
    const modal = await open(kind); const before = (await events()).length; const cancel = modal.locator('button').filter({ hasText: /Cancel|Отмена/i }).last(); await press(cancel, key);
    const delta = (await events()).slice(before); assert.equal(delta.filter((event) => protectedNames.includes(event.name)).length, 0, JSON.stringify(delta)); await modal.waitFor({ state: 'hidden', timeout: 1500 }); assert.equal(await modal.count(), 0, 'Actual Cancel closes body after declared transition'); return { protectedDelta: 0, events: delta };
  });
  for (const kind of ['privacy-read', 'privacy-last', 'birthday', 'rank', 'block', 'remove-user']) await run(kind + '-escape-zero', kind, async () => { const modal = await open(kind); const before = (await events()).length; const input = modal.locator('input:not([disabled])').first(); if (await input.count()) await input.focus(); else await modal.locator('button').first().focus(); await page.keyboard.press('Escape'); await page.waitForTimeout(250); const delta = (await events()).slice(before); assert.equal(delta.filter((event) => protectedNames.includes(event.name)).length, 0); assert.equal(await modal.count(), 0); return { escapeClosed: true, protectedDelta: 0, events: delta }; });
  await run('sensitive-checkbox-space-confirm-once', 'sensitive', async () => { const modal = await open('sensitive'); const checkbox = modal.locator('input[type=checkbox]'); const before = await count('sensitiveConfirm'); await press(checkbox, 'Space'); assert(await checkbox.isChecked()); assert.equal(await count('sensitiveConfirm'), before); await press(modal.locator('.confirm-dialog-button').first(), 'Enter'); assert.equal(await count('sensitiveConfirm'), before + 1); return { checkboxSelected: true, callbackDelta: 1 }; });
  await run('report-avatar-reason-description-once', 'report-avatar', async () => { const modal = await open('report-avatar'); const other = modal.locator('input[type=radio]').last(); await modal.locator('label.Radio').last().click(); await page.waitForTimeout(120); assert(await other.isChecked()); await modal.locator('input[type=text]').fill('Synthetic local description'); const before = await count('reportProfilePhoto'); await press(modal.locator('.confirm-dialog-button').first(), 'Enter'); assert.equal(await count('reportProfilePhoto'), before + 1); const detail = (await events()).filter((event) => event.name === 'reportProfilePhoto').at(-1).detail; assert.equal(detail.reason, 'other'); assert.equal(detail.descriptionLength, 27); return { callbackDelta: 1, detail }; });
  await run('unpin-pointer-once', 'unpin', async () => { const modal = await open('unpin'); const before = await count('unpin'); await modal.locator('.confirm-dialog-button').first().click(); assert.equal(await count('unpin'), before + 1); return { callbackDelta: 1 }; });
  for (const kind of ['folder', 'folder-shared']) await run(kind + '-confirm-once', kind, async () => { const modal = await open(kind); const name = kind === 'folder' ? 'deleteChatFolder' : 'openDeleteChatFolderModal'; const before = await count(name); await press(modal.locator('.confirm-dialog-button').first(), 'Enter'); assert.equal(await count(name), before + 1); const detail = (await events()).filter((event) => event.name === name).at(-1).detail; if (kind === 'folder-shared') assert.equal(detail.isConfirmedForChatlist, true); return { action: name, callbackDelta: 1, detail }; });
  await run('bot-trust-write-checkbox-once', 'bot-trust', async () => { const modal = await open('bot-trust'); const checkbox = modal.locator('input[type=checkbox]'); assert(await checkbox.isChecked()); await press(checkbox, 'Space'); assert.equal(await checkbox.isChecked(), false); const before = await count('markBotTrusted'); await press(modal.locator('.confirm-dialog-button').first(), 'Enter'); assert.equal(await count('markBotTrusted'), before + 1); assert.equal((await events()).filter((event) => event.name === 'markBotTrusted').at(-1).detail.isWriteAllowed, false); return { allowWrite: false, callbackDelta: 1 }; });
  for (const kind of ['block', 'remove-user']) await run(kind + '-picker-space-once', kind, async () => { const modal = await open(kind); const rows = modal.locator('.ChatOrUserPicker-item'); assert.equal(await rows.count(), 1, 'Admin/self/blocked excluded'); const before = await count(kind === 'block' ? 'blockUser' : 'deleteChatMember'); await press(rows.first(), 'Space'); assert.equal(await count(kind === 'block' ? 'blockUser' : 'deleteChatMember'), before + 1); return { eligibleRows: 1, callbackDelta: 1 }; });
  for (const kind of ['privacy-read', 'privacy-last']) await run(kind + '-primary-once', kind, async () => { const modal = await open(kind); const action = kind === 'privacy-read' ? 'updateGlobalPrivacySettings' : 'setPrivacyVisibility'; const before = await count(action); await press(modal.locator('button').nth(1), 'Enter'); assert.equal(await count(action), before + 1); return { action, callbackDelta: 1 }; });
  await run('auto-delete-unchanged-no-dispatch', 'auto-delete', async () => { const modal = await open('auto-delete'); const before = await count('setChatHistoryTtl'); await press(modal.locator('button').filter({ hasText: /Save|Сохранить/i }), 'Enter'); assert.equal(await count('setChatHistoryTtl'), before); return { callbackDelta: 0 }; });
  await run('auto-delete-radio-save-once', 'auto-delete', async () => { const modal = await open('auto-delete'); const radios = modal.locator('input[type=radio]'); const value = await radios.nth(1).getAttribute('value'); await press(radios.nth(1), 'Space'); assert(await radios.nth(1).isChecked()); const before = await count('setChatHistoryTtl'); await press(modal.locator('button').filter({ hasText: /Save|Сохранить/i }), 'Space'); assert.equal(await count('setChatHistoryTtl'), before + 1); assert.equal((await events()).filter((event) => event.name === 'setChatHistoryTtl').at(-1).detail.period, Number(value)); return { selectedPeriod: Number(value), callbackDelta: 1 }; });
  await run('birthday-empty-disabled', 'birthday-empty', async () => { const modal = await open('birthday-empty'); const save = modal.locator('button').last(); assert(await save.isDisabled()); const before = await count('updateBirthday'); await save.click({ force: true }); assert.equal(await count('updateBirthday'), before); return { disabled: true, callbackDelta: 0 }; });
  await run('birthday-month-menu-clamps-day-save-once', 'birthday', async () => { const modal = await open('birthday'); const inputs = modal.locator('input'); await inputs.nth(1).click(); const february = modal.locator('.MenuItem').nth(1); await february.waitFor({ state: 'visible' }); await press(february, 'Enter'); assert.equal(await inputs.nth(0).inputValue(), '29'); const before = await count('updateBirthday'); await press(modal.locator('button').last(), 'Space'); assert.equal(await count('updateBirthday'), before + 1); assert.deepEqual((await events()).filter((event) => event.name === 'updateBirthday').at(-1).detail.birthday, { day: 29, month: 2, year: 2000 }); return { leapDayClamped: true, callbackDelta: 1 }; });
  await run('prompt-maxlength-save-once', 'prompt', async () => { const modal = await open('prompt'); const input = modal.locator('input'); await input.fill(''); await page.waitForTimeout(120); await input.pressSequentially('abcdefghijklmnopq', { delay: 30 }); await page.waitForTimeout(120); assert.equal((await input.inputValue()).length, 16); const before = await count('promptSubmit'); await press(modal.locator('button').first(), 'Enter'); assert.equal(await count('promptSubmit'), before + 1); return { boundedLength: 16, callbackDelta: 1 }; });
  await run('rank-unchanged-disabled', 'rank', async () => { const modal = await open('rank'); const save = modal.locator('button').last(); assert(await save.isDisabled()); const before = await count('editChatParticipantRank'); await save.click({ force: true }); assert.equal(await count('editChatParticipantRank'), before); return { unchangedDisabled: true, callbackDelta: 0 }; });
  await run('rank-edited-enter-once', 'rank', async () => { const modal = await open('rank'); const input = modal.locator('#edit-rank'); await input.fill('Synthetic editor'); const before = await count('editChatParticipantRank'); await press(input, 'Enter'); assert.equal(await count('editChatParticipantRank'), before + 1); assert.equal((await events()).filter((event) => event.name === 'editChatParticipantRank').at(-1).detail.rank, 'Synthetic editor'); return { callbackDelta: 1 }; });
  await run('rank-denied-input-disabled', 'rank-disabled', async () => { const modal = await open('rank-disabled'); assert(await modal.locator('#edit-rank').isDisabled()); assert(await modal.locator('button').last().isDisabled()); return { deniedInputDisabled: true }; });
  await run('report-avatar-root32-scroll-boundary', 'report-avatar', async () => {
    await page.evaluate(() => { window.document.documentElement.style.fontSize = '32px'; });
    const modal = await open('report-avatar'); const before = await geometry(modal); const cancel = modal.locator('.confirm-dialog-button').last();
    await cancel.scrollIntoViewIfNeeded(); await cancel.focus(); await modal.locator('.modal-content').hover(); await page.mouse.wheel(0, 900); await page.waitForTimeout(180); const after = await geometry(modal);
    const screenshot = `ui-remaining-modal-${label}-report-avatar-root32-after-scroll.png`; await page.screenshot({ path: path.join(evidence, screenshot) });
    report.lastGeometry = { before, after, screenshot }; assert.equal(after.outsideViewport.length, 0, 'Footer reachable after actual scroll/focus');
    return { before, after, screenshot, actualScrollReachable: true };
  });
  await run('report-avatar-root32-scoped-css-proof', 'report-avatar', async () => {
    await page.evaluate(() => { window.document.documentElement.style.fontSize = '32px'; });
    const style = await page.addStyleTag({ content: '.Modal:has(input[name="report-message"]) .modal-dialog{max-height:calc(100vh - 4rem);max-height:calc(100dvh - 4rem)} .Modal:has(input[name="report-message"]) .modal-content{min-height:0}' });
    try {
      const modal = await open('report-avatar'); const initial = await geometry(modal);
      assert(initial.box.top >= 0 && initial.box.bottom <= 1080, 'Scoped height keeps complete dialog inside viewport');
      assert(initial.headers.every((item) => item.box.top >= 0 && item.box.bottom <= 1080), 'Actual header stays inside viewport');
      await modal.locator('.modal-content').hover(); await page.mouse.wheel(0, 900); await page.waitForTimeout(160);
      const settled = await geometry(modal); assert.equal(settled.outsideViewport.length, 0, 'Both footer controls reachable after real scroll');
      const screenshot = `ui-remaining-modal-${label}-report-avatar-root32-css-proof.png`; await page.screenshot({ path: path.join(evidence, screenshot) });
      const before = await count('reportProfilePhoto'); await press(modal.locator('.confirm-dialog-button').last(), 'Enter'); assert.equal(await count('reportProfilePhoto'), before); await modal.waitFor({ state: 'hidden' });
      const reopened = await open('report-avatar'); await reopened.locator('.modal-content').hover(); await page.mouse.wheel(0, 900); await page.waitForTimeout(120); await reopened.locator('.confirm-dialog-button').first().click(); assert.equal(await count('reportProfilePhoto'), before + 1);
      return { injectionOnly: true, selector: 'Exact test-owned ReportAvatar body via input[name=report-message]', initial, settled, screenshot, cancelProtectedDelta: 0, confirmMockDelta: 1, noProductionEdit: true };
    } finally { await style.evaluate((element) => element.remove()); }
  });
  report.unhandled = await page.evaluate(() => window.__relayUnhandled);
} catch (error) { report.fatal = String(error); console.error(error); }
finally {
  await browser?.close(); await server.close();
  report.sourceUnchanged = true; for (const [source, hash] of Object.entries(report.sourceHashes)) if (createHash('sha256').update(await readFile(source)).digest('hex') !== hash) report.sourceUnchanged = false;
  report.summary = { total: report.cases.length, pass: report.cases.filter((item) => item.status === 'pass').length, fail: report.cases.filter((item) => item.status === 'fail').length, gate: report.cases.filter((item) => item.status === 'gate').length, pageErrors: report.errors.length, sourceUnchanged: report.sourceUnchanged };
  await writeFile(path.join(evidence, `ui-remaining-modal-${label}.json`), JSON.stringify(report, undefined, 2) + '\n'); console.log(JSON.stringify(report.summary)); if (report.fatal || report.summary.fail || report.errors.length || report.unhandled?.length || !report.sourceUnchanged) process.exitCode = 1;
}
