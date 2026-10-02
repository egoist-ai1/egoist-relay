import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { initializeAuditBrowser } from './relay-ui-audit.server.mjs';
import { startPaymentServer } from './relay-payment-modal.server.fixture.mjs';

const output = process.env.RELAY_PAYMENT_OUTPUT;
const evidence = process.env.RELAY_PAYMENT_EVIDENCE;
const executable = process.env.RELAY_UI_AUDIT_BROWSER;
if (!output || !evidence || !executable) throw new Error('Own runtime, new project evidence and existing headless executable required');
const label = process.env.RELAY_PAYMENT_LABEL || 'before';
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });
const sourceFiles = ['src/components/payment/PaymentModal.tsx', 'src/components/payment/PasswordConfirm.tsx',
  'src/components/modals/stars/StarsPaymentModal.tsx', 'src/components/ui/Button.tsx', 'src/components/ui/Modal.tsx',
  'src/util/captureKeyboardListeners.ts', 'src/components/common/PasswordForm.tsx',
  'scripts/relay-payment-modal.fixture.tsx', 'scripts/relay-payment-modal.server.fixture.mjs', 'scripts/relay-payment-modal.test.mjs'];
const report = { schemaVersion: 1, artifactId: 'relay-payment-modal-callback-proof', generatedAt: new Date().toISOString(), label,
  environment: 'Actual App/Main/ModalContainer payment bodies and real shared Button/Modal; fresh MockClient browser, native IPC mocked; payment/password/actions captured locally before opening; every non-local request aborted',
  cases: [], errors: [], unhandled: [], blockedRequests: [], localRequests: 0, externalRequestsSucceeded: 0,
  sourceHashes: {}, realAccountMutations: 0, limitations: ['No live password, payment, server/API acceptance or network/account session.', 'Source hashes link published files; no runtime-bundle cryptographic attestation.', 'Only exact focused targets and checked branches establish behavior.'] };
for (const file of sourceFiles) report.sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
const { server, url } = await startPaymentServer(output, 1254);
let browser; let page;
const events = () => page.evaluate(() => window.__relayPaymentAudit.events);
const count = async name => (await events()).filter(event => event.name === name).length;
async function close() { await page.evaluate(() => window.__relayPaymentAudit.close()); await page.waitForTimeout(550); }
async function open(kind) {
  await close();
  await page.evaluate(value => window.__relayPaymentAudit.open(value), kind);
  await page.waitForTimeout(650);
  const modal = kind === 'regular' ? page.locator('.PaymentModal.open') : page.locator('.Modal.open:has([class*="paymentButton"])');
  await modal.locator('.modal-dialog').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await modal.count(), 1, 'Actual own modal must be unique');
  return modal;
}
async function focus(locator) {
  await locator.focus();
  const readback = await locator.evaluate(element => ({ focused: element === document.activeElement, target: element.outerHTML.slice(0, 900), owned: Boolean(element.closest('.Modal.open')), disabled: element.disabled }));
  assert(readback.focused && readback.owned && !readback.disabled, JSON.stringify(readback));
  return readback;
}
async function regular() {
  const modal = await open('regular');
  const input = modal.locator('.password-input input:not([tabindex="-1"])').first();
  await input.fill('fixture-only');
  await page.waitForTimeout(100);
  return { modal, input };
}
async function run(id, action, check) {
  let detail;
  try {
    detail = await action();
    assert(check(detail), 'Expected safety contract; actual: ' + JSON.stringify(detail));
    report.cases.push({ id, status: 'pass', detail });
  } catch (error) {
    const screenshot = 'ui-payment-modal-' + label + '-' + id + '.png';
    await page.screenshot({ path: path.join(evidence, screenshot) }).catch(() => undefined);
    report.cases.push({ id, status: detail ? 'fail' : 'prerequisite-gate', detail, error: String(error),
      screenshot, activeTarget: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 900)).catch(() => undefined) });
  }
}
try {
  browser = await chromium.launch({ headless: true, executablePath: executable });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' });
  page = await context.newPage();
  await page.addInitScript(initializeAuditBrowser);
  await page.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname === '127.0.0.1') { report.localRequests++; return route.continue(); }
    report.blockedRequests.push({ protocol: requestUrl.protocol, host: requestUrl.hostname, method: route.request().method() });
    return route.abort();
  });
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__relayAudit?.state().chatCount >= 2 && window.__relayPaymentAudit);
  await page.waitForTimeout(500);

  await run('regular-input-loading-enter', async () => {
    const { modal, input } = await regular();
    const target = await focus(input);
    const before = await count('validatePassword');
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    const afterFirst = (await count('validatePassword')) - before;
    const disabledAfterFirst = await modal.locator('.footer .Button').evaluate(element => element.disabled);
    const secondTarget = await focus(input);
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    return { target, secondTarget, afterFirst, afterSecond: (await count('validatePassword')) - before, disabledAfterFirst };
  }, detail => detail.afterFirst === 1 && detail.afterSecond === 1 && detail.disabledAfterFirst);

  await run('regular-pointer-loading-input-enter', async () => {
    const { modal, input } = await regular();
    const button = modal.locator('.footer .Button'); const before = await count('validatePassword');
    await button.click(); await page.waitForTimeout(200);
    const afterFirst = (await count('validatePassword')) - before;
    const disabledAfterFirst = await button.evaluate(element => element.disabled);
    const target = await focus(input);
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    return { target, afterFirst, afterKeyboard: (await count('validatePassword')) - before, disabledAfterFirst };
  }, detail => detail.afterFirst === 1 && detail.afterKeyboard === 1 && detail.disabledAfterFirst);
  await run('regular-header-back-enter', async () => {
    const { modal } = await regular(); const button = modal.locator('.header .close-button');
    const target = await focus(button); const before = await count('validatePassword');
    const beforeState = await page.evaluate(() => window.__relayPaymentAudit.state());
    await page.keyboard.press('Enter'); await page.waitForTimeout(250);
    return { target, validationDelta: (await count('validatePassword')) - before, beforeState, afterState: await page.evaluate(() => window.__relayPaymentAudit.state()) };
  }, detail => detail.validationDelta === 0 && detail.afterState.paymentStep !== detail.beforeState.paymentStep);

  await run('regular-footer-confirm-enter-once', async () => {
    const { modal } = await regular(); const target = await focus(modal.locator('.footer .Button'));
    const before = await count('validatePassword');
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    return { target, validationDelta: (await count('validatePassword')) - before };
  }, detail => detail.validationDelta === 1);

  await run('regular-footer-confirm-space-once', async () => {
    const { modal } = await regular(); const target = await focus(modal.locator('.footer .Button'));
    const before = await count('validatePassword');
    await page.keyboard.press('Space'); await page.waitForTimeout(200);
    return { target, validationDelta: (await count('validatePassword')) - before };
  }, detail => detail.validationDelta === 1);

  await run('regular-header-back-space', async () => {
    const { modal } = await regular(); const target = await focus(modal.locator('.header .close-button'));
    const before = await count('validatePassword'); const beforeState = await page.evaluate(() => window.__relayPaymentAudit.state());
    await page.keyboard.press('Space'); await page.waitForTimeout(250);
    return { target, validationDelta: (await count('validatePassword')) - before, beforeState, afterState: await page.evaluate(() => window.__relayPaymentAudit.state()) };
  }, detail => detail.validationDelta === 0 && detail.afterState.paymentStep !== detail.beforeState.paymentStep);

  for (const key of ['Enter', 'Space']) await run('stars-loading-' + key.toLowerCase(), async () => {
    const modal = await open('stars'); const button = modal.locator('[class*="paymentButton"]');
    const before = await count('starsPay'); await button.click(); await page.waitForTimeout(250);
    const target = await focus(button); const firstDelta = (await count('starsPay')) - before;
    const loading = await button.evaluate(element => ({ className: element.className, disabled: element.disabled, pointerEvents: getComputedStyle(element).pointerEvents }));
    await page.keyboard.press(key); await page.waitForTimeout(200);
    return { key, target, loading, firstDelta, afterKeyboard: (await count('starsPay')) - before };
  }, detail => detail.firstDelta === 1 && detail.afterKeyboard === 1);

  for (const kind of ['regular', 'stars']) await run(kind + '-rapid-native-clicks', async () => {
    const modal = kind === 'regular' ? (await regular()).modal : await open('stars');
    const button = modal.locator(kind === 'regular' ? '.footer .Button' : '[class*="paymentButton"]');
    const target = await focus(button); const eventName = kind === 'regular' ? 'validatePassword' : 'starsPay';
    const before = await count(eventName);
    const sameTask = await button.evaluate(element => {
      const readCount = () => window.__relayPaymentAudit.events.filter(event => event.name === (element.closest('.PaymentModal') ? 'validatePassword' : 'starsPay')).length;
      const beforeCount = readCount(); element.click(); const afterFirst = readCount(); element.click();
      return { beforeCount, afterFirst, afterSecond: readCount(), disabledSameTask: element.disabled };
    });
    await page.waitForTimeout(250);
    return { kind, target, eventDelivery: 'Two synthetic untrusted native HTMLElement.click activations in one task before RAF; actual shared Button handlers, not direct callback calls', sameTask, callbackDelta: (await count(eventName)) - before };
  }, detail => detail.callbackDelta === 1);
  await run('stars-close-enter-safe', async () => {
    const modal = await open('stars'); const button = modal.locator('.modal-absolute-close-button');
    const target = await focus(button); const before = await count('starsPay'); const beforeClose = await count('closeStars');
    await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    return { target, paymentDelta: (await count('starsPay')) - before, closeDelta: (await count('closeStars')) - beforeClose };
  }, detail => detail.paymentDelta === 0 && detail.closeDelta === 1);

  report.unhandled = await page.evaluate(() => window.__relayUnhandled || []);
  report.nativeMockCalls = await page.evaluate(() => window.__relayNativeMock.calls.map(call => call.command));
  report.capturedEvents = await events();
} catch (error) {
  report.errors.push(String(error)); report.bootstrapGate = String(error);
} finally {
  await browser?.close(); await server.close();
  report.summary = { total: report.cases.length, pass: report.cases.filter(c => c.status === 'pass').length,
    fail: report.cases.filter(c => c.status === 'fail').length, prerequisiteGates: report.cases.filter(c => c.status === 'prerequisite-gate').length,
    errors: report.errors.length, unhandled: report.unhandled.length, externalRequestsSucceeded: 0, realAccountMutations: 0 };
  await writeFile(path.join(evidence, 'ui-payment-modal-' + label + '.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(evidence, 'ui-payment-modal-' + label + '.md'), '# Relay actual payment modal callback proof\n\n'
    + 'Synthetic actual App/Main/ModalContainer; local captured actions only; all external requests aborted. No real payment/account operations.\n\n'
    + '| Case | Status | Readback |\n|---|---|---|\n'
    + report.cases.map(c => '| ' + c.id + ' | ' + c.status + ' | ' + JSON.stringify(c.detail || c.error).replaceAll('|', '\\|') + ' |').join('\n')
    + '\n\nSummary: ' + JSON.stringify(report.summary) + '\n');
  console.log(JSON.stringify({ summary: report.summary, cases: report.cases.map(c => ({ id: c.id, status: c.status, detail: c.detail, error: c.error })) }, null, 2));
}
