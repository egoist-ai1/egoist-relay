import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {initializeAuditBrowser,startAuditServer} from './relay-ui-audit.server.mjs';
const output=process.env.RELAY_UI_AUDIT_OUTPUT,evidence=process.env.RELAY_UI_AUDIT_EVIDENCE||output;
if(!output||!process.env.RELAY_UI_AUDIT_BROWSER)throw new Error('Own task runtime and existing headless browser required');
await mkdir(path.join(evidence,'ui-visuals'),{recursive:true});
const {server,url}=await startAuditServer(output,1251);let browser,page;
const report={schemaVersion:1,generatedAt:new Date().toISOString(),environment:{viewport:'1920x1080',transport:'existing MockClient/task-only native mocks',network:'all remote requests blocked',timingScope:'Headless browser observations on a shared host; no physical GPU/DPI/60fps claim'},cases:[],errors:[]};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.RELAY_UI_AUDIT_BROWSER});
 const context=await browser.newContext({viewport:{width:1920,height:1080},serviceWorkers:'block'});page=await context.newPage();
 await page.addInitScript(initializeAuditBrowser);await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 page.on('pageerror',e=>report.errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__relayAudit?.state().chatCount>=2);await page.waitForTimeout(800);
 await page.evaluate(()=>{const state=window.__relayFrameAudit={frames:[],longTasks:[],running:true};let previous=performance.now();const tick=now=>{state.frames.push(now-previous);previous=now;if(state.running)window.requestAnimationFrame(tick);};window.requestAnimationFrame(tick);if(window.PerformanceObserver.supportedEntryTypes.includes('longtask')){state.observer=new window.PerformanceObserver(list=>state.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));state.observer.observe({type:'longtask',buffered:false});}});
 const started=Date.now();let switches=0;
 for(let i=0;i<48;i++){const app=['x','instagram','telegram'][i%3];await page.locator(`[data-relay-app="${app}"]`).click();await page.waitForFunction(id=>document.querySelector(`[data-relay-app="${id}"]`)?.getAttribute('aria-pressed')==='true',app);switches++;}
 report.cases.push({id:'fullhd-sequential-48-service-switches',status:'pass',sources:['src/components/App.tsx','src/components/multi/AppSidebar.tsx'],detail:{switches,elapsedMs:Date.now()-started,finalApp:await page.locator('[data-relay-app][aria-pressed="true"]').getAttribute('data-relay-app')}});
 let cycles=0;for(let i=0;i<24;i++){await page.evaluate(()=>window.__relayAudit.openOverlay('controls'));await page.waitForSelector('.Modal.open #audit-name');await page.waitForTimeout(210);await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.Modal.open:has(#audit-name)'));await page.waitForTimeout(210);cycles++;}
 assert.equal(await page.locator('.Modal.open').count(),0);await page.locator('[data-relay-app="telegram"]').focus();assert.equal(await page.locator('[data-relay-app="telegram"]').evaluate(e=>e===document.activeElement),true);
 report.cases.push({id:'fullhd-24-modal-lifecycle-cycles',status:'pass',sources:['src/components/ui/Modal.tsx','src/util/trapFocus.ts'],detail:{cycles,remainingOpenModals:0,outsideFocusAfterClose:true}});
 await page.emulateMedia({reducedMotion:'reduce'});await page.locator('[data-relay-app="x"]').click();await page.waitForTimeout(450);await page.evaluate(()=>window.__relayNativeMock.emit('multi-x-status',{state:'loading'}));await page.waitForTimeout(300);
 const animations=await page.locator('[class*="xSpinner"],[class*="stateDot"]').evaluateAll(els=>els.map(e=>getComputedStyle(e).animationName));assert(animations.length>0&&animations.every(name=>name==='none'),JSON.stringify({animations,state:await page.evaluate(()=>({calls:window.__relayNativeMock.calls.slice(-3),x:document.querySelector('[data-relay-app="x"]')?.outerHTML}))}));
 await page.locator('[data-relay-app="telegram"]').click();report.cases.push({id:'fullhd-reduced-motion-after-stress',status:'pass',sources:['src/components/App.tsx','src/components/multi/AppSidebar.tsx'],detail:{animations}});
 await page.waitForTimeout(350);
 report.telemetry=await page.evaluate(()=>{const state=window.__relayFrameAudit;state.running=false;state.observer?.disconnect();const frames=state.frames.slice(1).sort((a,b)=>a-b);return {frameCount:frames.length,frameIntervalMs:{median:frames[Math.floor(frames.length*.5)],p95:frames[Math.floor(frames.length*.95)],maximum:Math.max(...frames)},longTasks:state.longTasks,memory:performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:undefined,remainingModalDialogs:document.querySelectorAll('.Modal.open').length,portalChildCount:document.querySelector('#portals')?.childElementCount};});
 assert(report.telemetry.frameCount>30,'Actual animation frames must be observed');report.unhandled=await page.evaluate(()=>window.__relayUnhandled);assert.deepEqual(report.errors,[]);assert.deepEqual(report.unhandled,[]);
 const screenshot='ui-visuals/fullhd-stress-final.png';await page.screenshot({path:path.join(evidence,screenshot)});report.screenshot=screenshot;
}catch(error){report.fatal=String(error);process.exitCode=1;}finally{await browser?.close();await server.close();report.summary={total:report.cases.length,pass:report.cases.filter(c=>c.status==='pass').length,errors:report.errors.length};await writeFile(path.join(evidence,'ui-performance-results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({summary:report.summary,telemetry:report.telemetry,fatal:report.fatal}));}
