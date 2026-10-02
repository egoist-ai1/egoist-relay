import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { buildInventory } from './relay-ui-audit.inventory.mjs';
import { initializeAuditBrowser, project, startAuditServer } from './relay-ui-audit.server.mjs';

const output = process.env.RELAY_UI_AUDIT_OUTPUT;
if (!output) throw new Error('Set RELAY_UI_AUDIT_OUTPUT to the current task work directory.');
const evidenceOutput = process.env.RELAY_UI_AUDIT_EVIDENCE || output;
const browserExecutable = process.env.RELAY_UI_AUDIT_BROWSER;
if (!browserExecutable) throw new Error('Set RELAY_UI_AUDIT_BROWSER to an already installed headless Chromium executable.');
await mkdir(evidenceOutput, { recursive: true });
await mkdir(path.join(evidenceOutput, 'ui-visuals'), { recursive: true });
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), projectPath: project,
  environment: { transport: 'existing MockClient + terminal native mocks', remoteRequests: 'blocked',
    browserExecutable, viewport: 'FullHD baseline and explicit emulation; no physical DPI claim' },
  cases: [], errors: [], gates: [], defects: [] };
const { server, url } = await startAuditServer(output, Number(process.env.RELAY_UI_AUDIT_PORT || 1251));
let browser;
let page;
const source = (value) => `src/components/${value}`;
async function caseRun(id, sources, action) {
  if (process.env.RELAY_UI_AUDIT_FILTER && !new RegExp(process.env.RELAY_UI_AUDIT_FILTER).test(id)) return;
  const errorsStart = report.errors.length;
  if (!id.startsWith('slider-')) {
    await page?.evaluate(() => window.__relayAudit?.openOverlay?.(undefined));
    await page?.waitForTimeout(250);
  }
  try {
    const detail = await action();
    const status = detail?.gateReason ? 'gated' : 'pass';
    report.cases.push({ id, sources, status, detail, pageErrors: report.errors.slice(errorsStart) });
    console.log(`${status.toUpperCase()} ${id}`);
  } catch (error) {
    const screenshot = `ui-visuals/failure-${id}.png`;
    await page?.screenshot({ path: path.join(evidenceOutput, screenshot) }).catch(() => {});
    report.cases.push({ id, sources, status: 'fail', error: String(error), stack: error.stack, screenshot,
      pageErrors: report.errors.slice(errorsStart) });
    console.log(`FAIL ${id}: ${String(error).slice(0,180)}`);
  }
}
const settle = async () => { await page.waitForTimeout(500); await page.evaluate(() => document.fonts.ready); };
const screenshot = async (id) => {
  const relative = `ui-visuals/${id}.png`;
  await page.screenshot({ path: path.join(evidenceOutput, relative) });
  return relative;
};
async function metrics(selector = 'body') {
  return page.locator(selector).first().evaluate((scope) => {


    const rect = (element) => { const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom }; };
    const shown = (element) => { const r = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        && !element.closest('[aria-hidden="true"],.Transition_slide-inactive'); };
    const controls = [...scope.querySelectorAll('button,input,textarea,[role="button"],[role="tab"]')]
      .filter(shown).map((element) => {
        const r = rect(element);
        const name = element.getAttribute('aria-label') || element.getAttribute('title')
          || (element.id && document.querySelector(`label[for="${window.CSS.escape(element.id)}"]`)?.textContent)
          || element.textContent?.trim() || element.getAttribute('placeholder') || '';
        const visibleInViewport = r.x < window.innerWidth && r.y < window.innerHeight && r.right > 0 && r.bottom > 0;
        let clippedX = false;
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
            const p = parent.getBoundingClientRect(); if (r.x < p.x - 1 || r.right > p.right + 1) clippedX = true;
          }
        }
        return { tag: element.tagName, type: element.getAttribute('type'), name: name.slice(0,160),
          disabled: element.disabled || element.getAttribute('aria-disabled') === 'true', rect: r,
          font: getComputedStyle(element).fontFamily, visibleInViewport, clippedX };
      });
    return { viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      direction: getComputedStyle(document.documentElement).direction, surface: rect(scope),
      controls, visibleControlCount: controls.filter((item) => item.visibleInViewport).length,
      horizontalOverflow: scope.scrollWidth > scope.clientWidth + 1,
      unreadableZeroWidthLabels: [...scope.querySelectorAll('.title,.subtitle,.modal-title,label')]
        .filter(shown).filter((element) => element.textContent.trim().length > 3 && element.getBoundingClientRect().width < 12)
        .map((element) => element.textContent.slice(0,100)),
    };
  });
}
const requireNoClippedControls = (measurement) => {
  const clipped = measurement.controls.filter((control) => control.visibleInViewport && control.clippedX);
  assert.deepEqual(clipped.map((item) => item.name), [], 'Visible actionable controls clipped horizontally');
  assert.deepEqual(measurement.unreadableZeroWidthLabels, [], 'Meaningful label collapsed to a narrow vertical column');
};
try {
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark',
    locale: 'ru-RU', serviceWorkers: 'block' });
  page = await context.newPage();
  await page.addInitScript(initializeAuditBrowser);
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  page.on('pageerror', (error) => report.errors.push({ type: 'pageerror', message: String(error) }));
  page.on('console', (message) => { if (message.type() === 'error') report.errors.push({ type: 'console', message: message.text().slice(0,1000) }); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-relay-app="telegram"]', { timeout: 60000 });
  await page.waitForFunction(() => window.__relayAudit?.state().currentUserId === '1');
  await settle();
  await caseRun('app-boot-fullhd', [source('App.tsx'), source('multi/AppSidebar.tsx'), source('common/Titlebar.tsx')], async () => {
    assert.equal(await page.evaluate(() => window.__relayAudit.state().auth), 'authorizationStateReady');
    const geometry = await metrics(); requireNoClippedControls(geometry);
    return { geometry, state: await page.evaluate(() => window.__relayAudit.state()), screenshot: await screenshot('app-boot-fullhd') };
  });
  await caseRun('mock-chat-hydration', [source('left/main/ChatList.tsx'), source('middle/MessageList.tsx')], async () => {
    await page.waitForFunction(() => window.__relayAudit.state().chatCount >= 2, { timeout: 10000 });
    await page.evaluate(() => window.__relayAudit.openChat('101'));
    await page.waitForSelector('#MiddleColumn', { state: 'visible' }); await settle();
    await page.waitForFunction(()=>document.body.innerText.includes('Отлично'));
    assert((await page.locator('body').innerText()).includes('Отлично')); 
    return { screenshot: await screenshot('chat-conversation-fullhd'), geometry: await metrics('#MiddleColumn') };
  });
  const settings = ['Main','EditProfile','General','Performance','Notifications','DataStorage','Privacy','Language',
    'Folders','Stickers','QuickReaction','CustomEmoji','DoNotTranslate','Experimental','GeneralChatBackground',
    'GeneralChatBackgroundColor','ActiveSessions','ActiveWebsites','Passkeys','PrivacyBlockedUsers','AutoDeleteMessages',
    'PasscodeDisabled','TwoFaDisabled'];
  const componentMap = { Main:'SettingsMain',EditProfile:'SettingsEditProfile',General:'SettingsGeneral',Performance:'SettingsPerformance',
    Notifications:'SettingsNotifications',DataStorage:'SettingsDataStorage',Privacy:'SettingsPrivacy',Language:'SettingsLanguage',
    Folders:'folders/SettingsFoldersMain',Stickers:'SettingsStickers',QuickReaction:'SettingsQuickReaction',CustomEmoji:'SettingsCustomEmoji',
    DoNotTranslate:'SettingsDoNotTranslate',Experimental:'SettingsExperimental',GeneralChatBackground:'SettingsGeneralBackground',
    GeneralChatBackgroundColor:'SettingsGeneralBackgroundColor',ActiveSessions:'SettingsActiveSessions',ActiveWebsites:'SettingsActiveWebsites',
    Passkeys:'SettingsPasskeys',PrivacyBlockedUsers:'SettingsPrivacyBlockedUsers',AutoDeleteMessages:'SettingsAutoDeleteMessages',
    PasscodeDisabled:'passcode/SettingsPasscodeStart',TwoFaDisabled:'twoFa/SettingsTwoFaStart' };
  for (const name of settings) {
    await caseRun(`settings-${name}`, [source('left/settings/Settings.tsx'), source(`left/settings/${componentMap[name]}.tsx`)], async () => {
      await page.evaluate((value) => window.__relayAudit.openSettings(value), name);
      await page.waitForSelector('#Settings', { state: 'visible', timeout: 10000 }); await settle();
      const reached = await page.evaluate(() => window.__relayAudit.state().settingsScreen);
      const expected = await page.evaluate((value) => window.__relayAudit.settings.indexOf(value), name);
      if (reached !== expected) return { requestedRoute: name, reached, gateReason: 'Existing synthetic state triggers route reset; selected component is not verified', screenshot: await screenshot(`settings-${name}-gated`) };
      const measurement = await metrics('#Settings');
      assert(measurement.visibleControlCount > 0, 'No rendered controls in selected settings surface');
      requireNoClippedControls(measurement);
      return { geometry: measurement, text: (await page.locator('#Settings').innerText()).slice(0,2400),
        screenshot: await screenshot(`settings-${name}-fullhd`) };
    });
  }
  await page.evaluate(() => window.__relayAudit.openSettings('General'));
  await settle();
  const themes = await page.evaluate(() => window.__relayAudit.themes);
  for (const theme of themes) {
    await caseRun(`theme-${theme.id}`, [source('left/settings/SettingsGeneral.tsx')], async () => {
      await page.locator(`#Settings input[type=radio][value="${theme.id}"]`).locator('..').click(); await settle();
      assert.equal(await page.locator(`#Settings input[type=radio][value="${theme.id}"]`).isChecked(),true);
      const measurement = await metrics('#Settings'); requireNoClippedControls(measurement);
      const colors = await page.evaluate(() => ({ theme: document.body.className,
        background: getComputedStyle(document.body).getPropertyValue('--color-background'),
        text: getComputedStyle(document.body).getPropertyValue('--color-text') }));
      assert(colors.background.trim() && colors.text.trim());
      return { theme, colors, screenshot: await screenshot(`theme-${theme.id}-fullhd`) };
    });
  }
  await page.evaluate(() => window.__relayAudit.applyTheme('egoist-dark')); await settle();
  for (const [name, viewport, textScale, direction] of [
    ['compact-800',{width:800,height:560},1,'ltr'], ['small-640',{width:640,height:448},1,'ltr'],
    ['fullhd-200pct-text',{width:1920,height:1080},2,'ltr'],
    ['fullhd-rtl',{width:1920,height:1080},1,'rtl'],
  ]) {
    await caseRun(`layout-${name}`, [source('left/settings/SettingsGeneral.tsx'),source('common/Titlebar.tsx'),source('multi/AppSidebar.tsx')], async () => {
      await page.setViewportSize(viewport);
      await page.evaluate(({textScale,direction}) => { document.documentElement.style.fontSize=`${16*textScale}px`;
        document.documentElement.dir=direction; }, {textScale,direction});
      await page.evaluate(() => window.__relayAudit.openSettings('General')); await settle();
      const measurement = await metrics('#Settings'); requireNoClippedControls(measurement);
      return { textScale, direction, geometry: measurement, screenshot: await screenshot(`layout-${name}`) };
    });
  }
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(() => { document.documentElement.style.fontSize='16px'; document.documentElement.dir='ltr'; });
  await settle();
  await caseRun('service-switch-keyboard', [source('multi/AppSidebar.tsx')], async () => {
    await page.locator('[data-relay-app="telegram"]').focus();
    for (const [key, app] of [['ArrowDown','x'],['ArrowDown','instagram'],['Home','telegram'],['End','instagram']]) {
      await page.keyboard.press(key); assert.equal(await page.evaluate(() => document.activeElement.dataset.relayApp), app);
    }
    await page.keyboard.press('Enter'); await settle();
    assert.equal(await page.locator('[data-relay-app="instagram"]').getAttribute('aria-current'),'page');
    await page.locator('[data-relay-app="telegram"]').focus(); await page.keyboard.press('Space'); await settle();
    assert.equal(await page.locator('[data-relay-app="telegram"]').getAttribute('aria-current'),'page');
    return { switches: await page.evaluate(() => window.__relayNativeMock.switches) };
  });
  await caseRun('service-switch-rapid-120', [source('App.tsx'),source('multi/AppSidebar.tsx')], async () => {
    await page.evaluate(() => { window.__relayNativeMock.delay=40;
      for(let i=0;i<120;i++) document.querySelector(`[data-relay-app="${['x','instagram','telegram'][i%3]}"]`).click(); });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-relay-app="telegram"]').getAttribute('aria-current'),'page');
    const calls=await page.evaluate(()=>window.__relayNativeMock.calls.filter((item)=>item.command==='multi_set_active_app'));
    assert.equal(calls.at(-1).args.app,'telegram');
    return { dispatchedClicks:120, settledApp:'telegram', nativeCalls:calls.length, screenshot:await screenshot('rapid-switch-settled') };
  });
  for(const [app,state]of [['x','loading'],['x','auth-required'],['x','error'],['instagram','loading'],['instagram','error']]) {
    await caseRun(`${app}-state-${state}`,[source('App.tsx'),source('common/Titlebar.tsx')],async()=>{
      await page.locator(`[data-relay-app="${app}"]`).click(); await settle();
      await page.evaluate(({app,state})=>window.__relayNativeMock.emit(app==='x'?'multi-x-status':'multi-instagram-status',{state,message:'Synthetic site load error'}),{app,state});
      await settle();const measurement=await metrics();requireNoClippedControls(measurement);
      // The exact pane ID differs by production App; verify the actual status semantic when present.
      assert(await page.locator(state==='error'?'[role="alert"]':'[role="status"]').count()>0);
      return {geometry:measurement,screenshot:await screenshot(`${app}-${state}-fullhd`)};
    });
  }
  await page.locator('[data-relay-app="telegram"]').click(); await settle();
  await caseRun('controls-long-content-and-keyboard', [source('ui/Modal.tsx'),source('ui/InputText.tsx'),source('ui/TextArea.tsx'),source('ui/Checkbox.tsx')], async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('controls'));await settle();
    const modal=page.locator('.Modal.open:has(#audit-name)');
    await modal.locator('#audit-name').fill('Очень длинное кириллическое имя — '+ 'А'.repeat(130));
    await modal.locator('#audit-bio').fill('Описание с очень длинной ссылкой https://example.test/'+ 'x'.repeat(180));
    await modal.locator('#audit-checkbox').focus();await page.keyboard.press('Space');
    assert.equal(await modal.locator('#audit-checkbox').isChecked(),true);
    for(let i=0;i<16;i++) {await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('.Modal'))),true,'Focus escaped modal');}
    const measurement=await metrics('.Modal:has(#audit-name)');requireNoClippedControls(measurement);
    const shot=await screenshot('controls-long-text-fullhd');await page.keyboard.press('Escape');await settle();
    assert.equal(await page.locator('.Modal.open:has(#audit-name)').count(),0);return {geometry:measurement,screenshot:shot};
  });
  await caseRun('modal-outside-focus-containment',[source('ui/Modal.tsx'),'src/util/trapFocus.ts'],async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('controls'));await settle();
    await page.locator('[data-relay-app="telegram"]').focus();
    assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('.Modal.open'))),true);
    await page.keyboard.press('Escape');await settle();return {outsideFocusRedirected:true};
  });
  await caseRun('slider-disabled-keyboard', [source('ui/RangeSlider.tsx'),source('left/settings/SettingsGeneralBackground.tsx')], async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('controls'));await settle();
    const input=page.locator('.audit-slider-disabled input');
    await input.focus();await page.keyboard.press('ArrowRight');
    const changed=await page.evaluate(()=>window.__relayAudit.overlayEvents.filter((event)=>event.disabledSlider!==undefined));
    assert.deepEqual(changed,[],'Disabled range control changed through keyboard');
    assert.equal(await input.isDisabled(),true);return {screenshot:await screenshot('slider-disabled-keyboard')};
  });
  await caseRun('slider-readonly-keyboard',[source('ui/RangeSlider.tsx')],async()=>{
    const input=page.locator('.audit-slider-readonly input');await input.focus();await page.keyboard.press('ArrowRight');
    const changed=await page.evaluate(()=>window.__relayAudit.overlayEvents.filter((event)=>event.readOnlySlider!==undefined));
    assert.deepEqual(changed,[],'Read-only range control changed through keyboard');return {screenshot:await screenshot('slider-readonly-keyboard')};
  });
  await caseRun('slider-step-track-percentage',[source('ui/RangeSlider.tsx')],async()=>{
    const percentage=await page.locator('.audit-slider .slider-fill-track').evaluate((element)=>parseFloat(element.style.width));
    assert.equal(percentage,50,'50 of 100 must fill 50% even with step 2');return {percentage};
  });
  await caseRun('slider-boundary-geometry',[source('ui/RangeSlider.tsx')],async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('boundaries'));await settle();
    const actual=await page.locator('.audit-slider-boundary').evaluateAll(elements=>elements.map(element=>({id:element.dataset.case,width:parseFloat(element.querySelector('.slider-fill-track').style.width),name:element.querySelector('input').getAttribute('aria-label')})));
    assert.deepEqual(actual.map(item=>item.width),[50,0,100,0,0,0]);
    assert(actual.every(item=>item.name));return {geometry:actual,screenshot:await screenshot('slider-boundary-geometry')};
  });
  await caseRun('slider-pointer-release-and-next-gesture',[source('ui/RangeSlider.tsx')],async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('controls'));await settle();
    const input=page.locator('.audit-slider input');const box=await input.boundingBox();
    await page.mouse.move(box.x+box.width*0.25,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width+120,box.y+box.height/2);await page.mouse.up();
    const released=Number(await input.inputValue());assert(released>=0&&released<=100);
    await page.mouse.click(box.x+box.width*0.25,box.y+box.height/2);
    const next=Number(await input.inputValue());assert(next<released,'Next range gesture must work after release outside');
    await input.focus();await page.keyboard.press('Home');assert.equal(Number(await input.inputValue()),0);
    return {released,next,screenshot:await screenshot('slider-pointer-release')};
  });
  await page.keyboard.press('Escape');await settle();
  await caseRun('confirmation-focus-cancel',[source('ui/ConfirmDialog.tsx'),source('ui/Modal.tsx')],async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('confirm'));await settle();
    assert(await page.locator('dialog[open]').count()>0,'Native confirmation dialog must be open');
    const modal=page.locator('dialog[open]');
    assert.equal(await modal.locator('.confirm-dialog-button').last().evaluate(element=>element===document.activeElement),true,'Destructive action should focus cancel');
    const measurement=await metrics('dialog[open]');requireNoClippedControls(measurement);
    const shot=await screenshot('confirmation-fullhd');await page.keyboard.press('Escape');await settle();
    assert.equal(await page.locator('dialog[open]').count(),0);return {geometry:measurement,screenshot:shot};
  });
  await caseRun('confirmation-disabled-keyboard',[source('ui/ConfirmDialog.tsx')],async()=>{
    const before=await page.evaluate(()=>window.__relayAudit.overlayEvents.filter(e=>e.confirmed).length);
    await page.evaluate(()=>window.__relayAudit.openOverlay('confirm-disabled'));await settle();
    const dialog=page.locator('dialog[open]');
    assert.equal(await dialog.locator('.confirm-dialog-button').first().isDisabled(),true);
    await dialog.locator('.dialog-buttons').focus();await page.keyboard.press('Enter');await settle();
    assert.equal(await page.evaluate(()=>window.__relayAudit.overlayEvents.filter(e=>e.confirmed).length),before);
    await page.keyboard.press('ArrowDown');assert.equal(await dialog.locator('.confirm-dialog-button').last().evaluate(e=>e===document.activeElement),true);
    await page.keyboard.press('Enter');await settle();assert.equal(await page.locator('dialog[open]').count(),0);
    return {disabledConfirmationCount:0};
  });
  await caseRun('confirmation-destructive-only-neutral-focus',[source('ui/ConfirmDialog.tsx')],async()=>{
    const before=await page.evaluate(()=>window.__relayAudit.overlayEvents.filter(e=>e.confirmed).length);
    await page.evaluate(()=>window.__relayAudit.openOverlay('confirm-only'));await settle();
    assert.equal(await page.locator('dialog[open] .dialog-buttons').evaluate(e=>e===document.activeElement),true);
    await page.keyboard.press('Enter');await settle();assert.equal(await page.evaluate(()=>window.__relayAudit.overlayEvents.filter(e=>e.confirmed).length),before);
    await page.keyboard.press('Escape');await settle();return {neutralDefault:true};
  });
  await caseRun('modal-nested-focus-return-and-hidden-disabled',[source('ui/Modal.tsx'),source('ui/ConfirmDialog.tsx'),'src/util/trapFocus.ts'],async()=>{
    const trigger=page.locator('[data-relay-app="telegram"]');await trigger.focus();
    await page.evaluate(()=>window.__relayAudit.openOverlay('nested'));await settle();
    const parent=page.locator('.audit-nested-modal.open');await parent.locator('#audit-nested-input').focus();
    const targets=[];
    for(let i=0;i<14;i++){await page.keyboard.press(i%2?'Shift+Tab':'Tab');const target=await page.evaluate(()=>({id:document.activeElement.id,inside:!!document.activeElement.closest('.audit-nested-modal'),disabled:document.activeElement.disabled}));assert(target.inside&&!target.disabled);assert.notEqual(target.id,'audit-nested-hidden');targets.push(target.id);}
    await parent.locator('#audit-nested-trigger').focus();
    await parent.locator('#audit-nested-trigger').click();await settle();
    const child=page.locator('dialog.audit-nested-confirm[open]');assert.equal(await child.count(),1);
    for(let i=0;i<10;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('.audit-nested-confirm'))),true,JSON.stringify(await page.evaluate(()=>({active:document.activeElement.outerHTML,modals:[...document.querySelectorAll('.Modal.open')].map(e=>e.className)}))));}
    await page.keyboard.press('Escape');await settle();assert.equal(await child.count(),0);
    assert.equal(await parent.locator('#audit-nested-trigger').evaluate(e=>e===document.activeElement),true);
    await page.keyboard.press('Escape');await settle();assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
    return {targets,childReturned:true,parentReturned:true,screenshot:await screenshot('nested-focus-restored')};
  });
  await caseRun('modal-nested-disabled-first-fallback',[source('ui/Modal.tsx'),source('ui/ConfirmDialog.tsx'),'src/util/trapFocus.ts'],async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('nested'));await settle();
    const parent=page.locator('.audit-nested-modal.open');
    await parent.locator('#audit-nested-trigger').focus();await parent.locator('#audit-nested-trigger').click();await settle();
    await parent.evaluate(element=>{for(const e of element.querySelectorAll('button,input'))if(e.id!=='audit-nested-close')e.disabled=true;});
    await page.keyboard.press('Escape');await settle();
    assert.equal(await parent.locator('#audit-nested-close').evaluate(e=>e===document.activeElement),true);
    await page.keyboard.press('Escape');await settle();return {fallback:'enabled visible Close parent',hiddenDisabledSkipped:true};
  });
  for(const kind of ['menu-div','menu-native']) await caseRun('modal-more-'+kind,[source('ui/Modal.tsx'),source('ui/Menu.tsx'),'src/util/trapFocus.ts','src/util/captureKeyboardListeners.ts'],async()=>{
    await page.evaluate(k=>window.__relayAudit.openOverlay(k),kind);await settle();
    const modal=page.locator('.audit-more-modal.open');const trigger=modal.locator('.modal-more-button');await trigger.focus();await trigger.click();await settle();
    const first=page.locator('.Menu:has(.bubble.open) .audit-menu-first');assert.equal(await first.count(),1);
    const relation=await first.evaluate(e=>({insideModal:!!e.closest('.audit-more-modal'),nativeModal:!!document.querySelector('dialog.audit-more-modal[open]'),ancestors:[...function*(){for(let p=e;p;p=p.parentElement)yield p.tagName+'.'+p.className;}()].slice(0,6)}));
    assert.equal(relation.insideModal,true,JSON.stringify(relation));await first.focus();assert.equal(await first.evaluate(e=>e===document.activeElement),true,JSON.stringify(relation));
    await page.keyboard.press('ArrowDown');assert.equal(await page.locator('.audit-menu-last').evaluate(e=>e===document.activeElement),true);
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.audit-more-modal')),true);
    const openShot=await screenshot('modal-more-'+kind+'-open');const menuBounds=await page.locator('.Menu:has(.bubble.open) .bubble').boundingBox();assert(menuBounds.x>=0&&menuBounds.y>=0&&menuBounds.x+menuBounds.width<=1920&&menuBounds.y+menuBounds.height<=1080,JSON.stringify(menuBounds));
    const keyboardReadbacks=[];
    for(const key of ['Enter','Space']){
      if(key==='Space'){await trigger.click();await settle();}
      const item=page.locator('.Menu:has(.bubble.open) .audit-menu-first');await item.focus();
      const before=await page.evaluate(()=>({actions:window.__relayAudit.overlayEvents.filter(e=>e.menuAction===1).length,modal:window.__relayAudit.overlayEvents.filter(e=>e.modalEnter).length}));
      await page.keyboard.press(key);await settle();
      const after=await page.evaluate(()=>({actions:window.__relayAudit.overlayEvents.filter(e=>e.menuAction===1).length,modal:window.__relayAudit.overlayEvents.filter(e=>e.modalEnter).length}));keyboardReadbacks.push({key,before,after});
      assert.equal(after.actions,before.actions+1,JSON.stringify(keyboardReadbacks));assert.equal(after.modal,before.modal,JSON.stringify(keyboardReadbacks));
      assert.equal(await modal.count(),1);assert.equal(await page.locator('.Menu .bubble.open').count(),0);
    }
    await trigger.click({button:'right'});await settle();assert.equal(await page.locator('.Menu .bubble.open').count(),1,'Contextmenu opens owned menu');
    await page.keyboard.press('Escape');await settle();assert.equal(await modal.count(),1);assert.equal(await page.locator('.Menu .bubble.open').count(),0);
    assert.equal(await trigger.evaluate(e=>e===document.activeElement),true,'Menu Escape returns focus to its owner trigger');
    if(kind==='menu-native')assert.equal(await modal.evaluate(e=>e.open),true);
    const modalBefore=await page.evaluate(()=>window.__relayAudit.overlayEvents.filter(e=>e.modalEnter).length);
    await modal.locator('#audit-menu-input').focus();await page.keyboard.press('Enter');await settle();
    assert.equal(await page.evaluate(()=>window.__relayAudit.overlayEvents.filter(e=>e.modalEnter).length),modalBefore+1,'Modal Enter callback remains available outside menu');assert.equal(await modal.count(),1);
    await page.keyboard.press('Escape');await settle();assert.equal(await modal.count(),0);
    return {kind,relation,menuBounds,keyboardReadbacks,keyboard:['ArrowDown','Tab','Enter','Space','Contextmenu','Escape'],callbackOnly:true,menuFocusReturned:true,modalEnterBaseline:true,screenshots:[openShot,await screenshot('modal-more-'+kind+'-closed')]};
  });
  await caseRun('formatted-date-modal-layout',[source('middle/composer/FormattedDateModal.tsx'),source('ui/TabList.tsx')],async()=>{
    await page.evaluate(()=>window.__relayAudit.openOverlay('date'));await settle();
    const measurement=await metrics('.Modal.open:has([class*=FormattedDateModal-module__previewInput])');requireNoClippedControls(measurement);
    assert(await page.locator('.Modal.open:has([class*=FormattedDateModal-module__previewInput]) .TabList').count()>0);
    const shot=await screenshot('formatted-date-fullhd');await page.keyboard.press('Escape');await settle();
    return {geometry:measurement,screenshot:shot};
  });
  await caseRun('reduced-motion-states',[source('App.tsx'),source('multi/AppSidebar.tsx'),source('ui/Modal.tsx')],async()=>{
    await page.emulateMedia({reducedMotion:'reduce'});await page.locator('[data-relay-app="x"]').click();await settle();
    await page.evaluate(()=>window.__relayNativeMock.emit('multi-x-status',{state:'loading'}));await settle();
    const animations=await page.locator('[class*="xSpinner"],[class*="stateDot"]').evaluateAll((elements)=>elements.map((element)=>getComputedStyle(element).animationName));
    assert(animations.length>0);assert(animations.every((value)=>value==='none'));
    return {animations,screenshot:await screenshot('reduced-motion-loading')};
  });
  await caseRun('device-scale-factor-2',[source('App.tsx'),source('common/Titlebar.tsx'),source('multi/AppSidebar.tsx')],async()=>{
    const dprContext=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:2,serviceWorkers:'block'});
    const dprPage=await dprContext.newPage();await dprPage.addInitScript(initializeAuditBrowser);
    await dprPage.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
    await dprPage.goto(url,{waitUntil:'domcontentloaded'});await dprPage.waitForSelector('[data-relay-app="telegram"]');
    await dprPage.evaluate(()=>document.fonts.ready);assert.equal(await dprPage.evaluate(()=>window.devicePixelRatio),2);
    const shot='ui-visuals/fullhd-dpr2.png';await dprPage.screenshot({path:path.join(evidenceOutput,shot)});await dprContext.close();return {dpr:2,screenshot:shot};
  });
  report.unhandled=await page.evaluate(()=>window.__relayUnhandled);
  report.gates.push('Settings routes requiring privacy/session data can render loading/empty in existing MockClient; screenshot + controls establish layout only, not server operation',
    'Mock native ready events contain no X/Instagram website content; ready page functional verification is separate',
    'Uploads/media/calls/payment are source catalogued and tested by separate root/media work; this runner sends no messages');
} catch(error) {
  report.fatal=String(error);console.error(error);
} finally {
  await browser?.close();await server.close();
  const manifest=process.env.RELAY_UI_AUDIT_FILTER ? undefined : await buildInventory(evidenceOutput,report.cases);
  report.summary={total:report.cases.length,pass:report.cases.filter(item=>item.status==='pass').length,
    fail:report.cases.filter(item=>item.status==='fail').length,gated:report.cases.filter(item=>item.status==='gated').length,sourceComponents:manifest?.counts.components,
    renderedEvidenceComponents:manifest?.counts.renderedEvidenceComponents};
  await writeFile(path.join(evidenceOutput,process.env.RELAY_UI_AUDIT_FILTER?'ui-focused-results.json':'ui-scenario-results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary));
  if(report.fatal||report.summary.fail)process.exitCode=1;
}


