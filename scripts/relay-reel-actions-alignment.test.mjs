import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { chromium } from '@playwright/test';
import { project } from './relay-ui-audit.server.mjs';
const work=process.env.REEL_ALIGN_WORK, helperFile=process.env.REEL_ALIGN_SOURCE || path.join(project, 'scripts/social-share-enhancer.js'), label=process.env.REEL_ALIGN_LABEL || 'current';
assert(work&&helperFile&&label&&process.env.RELAY_UI_AUDIT_BROWSER);
await fs.mkdir(work,{recursive:true});
const helper=await fs.readFile(helperFile,'utf8');
const transport='window.location.href = `egoist-relay-share://request?token=${encodeURIComponent(token)}&payload=${encodeURIComponent(JSON.stringify(payload))}`;';
assert.equal(helper.split(transport).length,2);
const injected=helper.replace(transport,'window.__requests.push(payload);').replaceAll('__EGOIST_RELAY_SHARE_SERVICE__','instagram').replaceAll('__EGOIST_RELAY_SHARE_TOKEN__','fixture-token').replaceAll('__EGOIST_RELAY_SHARE_LABEL__',JSON.stringify('Отправить в Telegram'));
const report={label,sourceSha256:createHash('sha256').update(helper).digest('hex'),cases:[],pageErrors:[],realMessages:0,network:'all blocked; synthetic documents only'};
const svg=label=>`<svg width="24" height="24" aria-label='${label}' viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const action=(id,label,text='')=>`<div class="nativeAction" id="${id}"><div role="button" tabindex="0">${svg(label)}</div>${text?`<span>${text}</span>`:''}</div>`;
const native=action('like','Нравится','Отметки "Нравится"')+action('comment','Комментировать','4')+action('repost','Репост','31')+action('share','Поделиться')+action('save','Сохранить')+action('more','Ещё');
const body=`<div class="reel"><video width="360" height="640" src="https://scontent.cdninstagram.com/fixture.mp4"></video><a hidden href="/reel/ReelA123/">Reel</a><div id="rail">${native}</div></div>`;
const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><style>body{margin:0;background:#101618;color:#fff;font:12px Arial}.reel{display:flex;width:460px;margin:32px;gap:16px}video{background:linear-gradient(150deg,#88644b,#434449)}#rail{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;width:72px}.nativeAction{display:flex;flex-direction:column;align-items:flex-start;gap:6px}.nativeAction span{white-space:nowrap}.nativeAction [role=button]{display:flex;cursor:pointer}svg{flex-shrink:0}</style>${body}</html>`;
const context=await chromium.launchPersistentContext(path.join(work,'reel-align-profile-'+label+'-'+Date.now()),{headless:true,executablePath:process.env.RELAY_UI_AUDIT_BROWSER,viewport:{width:960,height:800},serviceWorkers:'block'});
try{
 for(const mode of [{id:'feed',route:'/reels/',width:960,height:800,dir:'ltr',font:16},{id:'dm',route:'/direct/t/fixture/',width:960,height:800,dir:'ltr',font:16},{id:'narrow',route:'/reel/ReelA123/',width:640,height:800,dir:'ltr',font:16},{id:'rtl-scaled',route:'/reels/',width:960,height:920,dir:'rtl',font:20}]){
 const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(String(e)));
 const url='https://www.instagram.com'+mode.route;
 await page.route('**/*',route=>route.request().isNavigationRequest()&&route.request().url()===url?route.fulfill({contentType:'text/html; charset=utf-8',body:html.replace(body,mode.id==='dm'?`<div role="dialog">${body}</div>`:body)}):route.abort());
 await page.setViewportSize({width:mode.width,height:mode.height});await page.goto(url);await page.evaluate(({dir,font})=>{document.documentElement.dir=dir;document.documentElement.style.fontSize=font+'px';window.__requests=[];},mode);await page.addScriptTag({content:injected});await page.waitForTimeout(150);
 const geometry=await page.evaluate(()=>{const box=n=>n.getBoundingClientRect().toJSON();return{rail:box(document.querySelector('#rail')),telegram:box(document.querySelector('.egoistRelayShare')),parentId:document.querySelector('.egoistRelayShare').parentElement.id,icons:Array.from(document.querySelectorAll('#rail svg')).map(box),label:box(document.querySelector('#like span')),labelTitle:document.querySelector('#like span').title,labelText:document.querySelector('#like span').textContent,counts:Array.from(document.querySelectorAll('#comment span,#repost span')).map(n=>n.textContent)}});
 await page.screenshot({path:path.join(work,`reel-alignment-${label}-${mode.id}.png`)});
 let result='pass',error;
 try{assert.equal(geometry.parentId,'rail');const centers=geometry.icons.map(b=>b.x+b.width/2);assert(Math.max(...centers)-Math.min(...centers)<=1,'All action icons share one horizontal center');assert(geometry.label.left>=geometry.rail.left-1&&geometry.label.right<=geometry.rail.right+1,'Likes caption remains inside action rail');assert.deepEqual(geometry.counts,['4','31']);assert.equal(geometry.labelText,'Нравятся');await page.evaluate(()=>{document.querySelector('#like span').firstChild.data='Отметки "Нравится"';});await page.waitForTimeout(100);assert.equal(await page.locator('#like span').innerText(),'Нравятся');await page.locator('.egoistRelayShare').click();assert.equal(await page.evaluate(()=>window.__requests.length),1);assert.equal(await page.evaluate(()=>window.__requests[0].url),'https://www.instagram.com/reel/ReelA123/');await page.evaluate(()=>{document.querySelector('#like span').textContent='17';document.querySelector('video').remove();});await page.waitForTimeout(100);assert.equal(await page.locator('.egoistRelayShare,.egoistRelayReelActions,.egoistRelayReelAction,.egoistRelayReelLabel').count(),0);assert.equal(await page.locator('#like span').innerText(),'17');}catch(e){result='fail';error=String(e);}
 report.cases.push({id:mode.id,result,error,geometry});await page.close();
 }
}finally{await context.close();report.summary={pass:report.cases.filter(c=>c.result==='pass').length,fail:report.cases.filter(c=>c.result==='fail').length,pageErrors:report.pageErrors.length};await fs.writeFile(path.join(work,`reel-alignment-${label}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary));if(report.summary.fail||report.summary.pageErrors)process.exitCode=1;}
