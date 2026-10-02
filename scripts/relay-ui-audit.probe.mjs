import { chromium } from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {initializeAuditBrowser,startAuditServer} from './relay-ui-audit.server.mjs';
const output=process.env.RELAY_UI_AUDIT_OUTPUT, evidence=process.env.RELAY_UI_AUDIT_EVIDENCE;
const {server,url}=await startAuditServer(output,1251);
const browser=await chromium.launch({headless:true,executablePath:process.env.RELAY_UI_AUDIT_BROWSER});
const context=await browser.newContext({viewport:{width:1920,height:1080},serviceWorkers:'block',locale:'ru-RU'});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
await page.addInitScript(initializeAuditBrowser);await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
const report={errors,focus:[],themes:[]};
const capture=()=>page.evaluate(()=>{const e=document.activeElement;return {tag:e.tagName,id:e.id,classes:e.className,text:e.textContent?.slice(0,100),html:e.outerHTML?.slice(0,350),modals:[...document.querySelectorAll('.Modal.open')].map(m=>({tag:m.tagName,title:m.querySelector('.modal-title')?.textContent}))};});
try{
await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__relayAudit?.state().chatCount>=2);
await page.evaluate(()=>window.__relayAudit.openChat('101'));await page.waitForTimeout(800);
await page.evaluate(()=>window.__relayAudit.groups.seedReply());await page.waitForTimeout(500);
await page.evaluate(()=>window.__relayAudit.openSettings('General'));await page.waitForTimeout(800);
const themes=await page.evaluate(()=>window.__relayAudit.themes);
for(const theme of themes){
const input=page.locator(`#Settings .Transition_slide-active input[type=radio][value="${theme.id}"]`);
await input.locator('..').click();await page.waitForTimeout(650);
await page.evaluate(()=>window.__relayAudit.openOverlay('media'));await page.waitForTimeout(200);
const detail=await page.evaluate(()=>({rootClass:document.documentElement.className,bodyClass:document.body.className,selected:[...document.querySelectorAll('#Settings input[type=radio]:checked')].map(e=>e.value),bubbles:[...document.querySelectorAll('.Message .text-content')].map(e=>{let p=e;while(p&&getComputedStyle(p).backgroundColor==='rgba(0, 0, 0, 0)')p=p.parentElement;return {text:e.textContent?.slice(0,80),color:getComputedStyle(e).color,background:p?getComputedStyle(p).backgroundColor:'unknown'};}),contrastSamples:[...document.querySelectorAll('.Message .text-content,.Message .embedded-sender,.Message .message-time')].map(e=>{const parseColor=value=>{const values=value.match(/[\d.]+/g)?.map(Number);if(values&&value.startsWith('color(srgb '))for(let i=0;i<3;i++)values[i]*=255;return values;};let bg=[255,255,255];const ancestors=[];for(let p=e;p;p=p.parentElement)ancestors.unshift(p);for(const p of ancestors){const values=parseColor(getComputedStyle(p).backgroundColor);if(values&&values.length>=3){const alpha=values[3]??1;bg=values.slice(0,3).map((value,i)=>value*alpha+bg[i]*(1-alpha));}}const fg=parseColor(getComputedStyle(e).color);const color=fg.slice(0,3).map((value,i)=>value*(fg[3]??1)+bg[i]*(1-(fg[3]??1)));const luminance=rgb=>rgb.map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);const a=luminance(color),b=luminance(bg);return {selector:e.className,own:!!e.closest('.Message.own'),mediaOverlay:!!e.closest('#audit-media-overlays'),overlayVariant:e.closest('[data-overlay-variant]')?.getAttribute('data-overlay-variant'),text:e.textContent?.slice(0,80),foreground:color,background:bg,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};}),variant:window.localStorage.getItem('egoist_theme_variant')}));
const failures=detail.contrastSamples.filter(item=>item.ratio<4.5);const radioMatches=detail.selected.includes(theme.id)&&detail.rootClass.includes(`theme-variant-${theme.id}`);const overlays=detail.contrastSamples.filter(item=>item.mediaOverlay);const overlayCoverage=['media-no-footer','custom-shape','invoice-photo'].every(variant=>overlays.filter(item=>item.overlayVariant===variant).length===2);report.themes.push({theme,...detail,radioMatches,overlayCoverage,status:!radioMatches||!overlayCoverage||failures.length?'fail':'pass',contrastFailures:failures});await page.screenshot({path:path.join(evidence,`ui-visuals/after-radio-theme-${theme.id}.png`)});
}
await page.evaluate(()=>window.__relayAudit.openOverlay('controls'));await page.waitForTimeout(750);
await page.locator('#audit-name').fill('Long Cyrillic '+ 'А'.repeat(130));await page.locator('#audit-bio').fill('https://example.test/'+'x'.repeat(180));await page.locator('#audit-checkbox').focus();await page.keyboard.press('Space');
report.focus.push({stage:'checkbox',...(await capture())});
for(let i=0;i<16;i++){await page.keyboard.press('Tab');report.focus.push({stage:`tab-${i}`,...(await capture())});}
await page.evaluate(()=>window.__relayAudit.openOverlay(undefined));await page.waitForTimeout(700);
await page.evaluate(()=>window.__relayAudit.openOverlay('confirm'));await page.waitForTimeout(900);report.focus.push({stage:'confirm',...(await capture())});
await page.screenshot({path:path.join(evidence,'ui-visuals/focus-confirm-probe.png')});
}catch(error){report.fatal=String(error);}finally{report.unhandled=await page.evaluate(()=>window.__relayUnhandled).catch(()=>[]);report.summary={totalThemes:report.themes.length,pass:report.themes.filter(t=>t.status==='pass').length,fail:report.themes.filter(t=>t.status==='fail').length,overlaySamples:report.themes.reduce((n,t)=>n+t.contrastSamples.filter(s=>s.mediaOverlay).length,0),minimumContrast:Math.min(...report.themes.flatMap(t=>t.contrastSamples.map(s=>s.ratio)))};if(report.fatal||report.summary.fail||report.summary.totalThemes!==11||report.summary.overlaySamples!==66)process.exitCode=1;await writeFile(path.join(evidence,'ui-focus-theme-after-probe.json'),JSON.stringify(report,null,2)+'\n');await browser.close();await server.close();console.log(JSON.stringify({themes:report.themes.length,themeStatuses:report.themes.map(t=>({id:t.theme.id,status:t.status,minimum:Math.min(...t.contrastSamples.map(s=>s.ratio))})),focus:report.focus.map(x=>({stage:x.stage,tag:x.tag,id:x.id,classes:x.classes})),fatal:report.fatal,errors}));}
