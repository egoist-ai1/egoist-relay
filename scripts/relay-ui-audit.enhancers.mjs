import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { project } from './relay-ui-audit.server.mjs';

const output=process.env.RELAY_UI_AUDIT_EVIDENCE || process.env.RELAY_UI_AUDIT_OUTPUT;
if(!output || !process.env.RELAY_UI_AUDIT_BROWSER)throw new Error('Set RELAY_UI_AUDIT_OUTPUT/EVIDENCE and RELAY_UI_AUDIT_BROWSER.');
await mkdir(path.join(output,'ui-visuals'),{recursive:true});
const results={schemaVersion:1,generatedAt:new Date().toISOString(),evidence:'Actual enhancer source, fully local HTML and synthetic video state; no first-party network/account or native share effects',cases:[]};
const browser=await chromium.launch({headless:true,executablePath:process.env.RELAY_UI_AUDIT_BROWSER});
async function fixture(url,html){
  const page=await browser.newPage({viewport:{width:1920,height:1080},locale:'ru-RU'});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  await page.goto(url);return page;
}
async function record(id,sources,run){try{const detail=await run();results.cases.push({id,sources,status:'pass',detail});console.log('PASS '+id);}catch(error){results.cases.push({id,sources,status:'fail',error:String(error)});console.log('FAIL '+id+' '+String(error));}}
try{
 await record('instagram-story-wheel-guards',['scripts/instagram-enhancer.js'],async()=>{
  const page=await fixture('https://www.instagram.com/stories/fixture/123456',`<html><body style="margin:0;background:#101012;color:white"><main style="height:1080px"><div id="storyTarget" style="margin:100px;width:800px;height:600px">Fixture Stories</div><button id="hidden" aria-label="Next" style="visibility:hidden">Next</button><button id="disabled" aria-label="Next" disabled>Next</button><button id="next" aria-label="Next story">Next story</button><input id="comment" placeholder="Комментарий"><div id="comments" style="height:100px;overflow-y:auto"><div style="height:400px">Comments</div></div></main></body></html>`);
  await page.evaluate(()=>{window.fixtureClicks=[];document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>window.fixtureClicks.push(button.id)));});
  await page.addScriptTag({content:await readFile(path.join(project,'scripts/instagram-enhancer.js'),'utf8')});
  await page.evaluate(()=>window.__egoistRelaySetActive(true));
  await page.evaluate(()=>document.getElementById('storyTarget').dispatchEvent(new window.WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true})));
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),['next']);
  await page.waitForTimeout(500);
  for(const id of ['comment','comments']) await page.evaluate(id=>document.getElementById(id).dispatchEvent(new window.WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true})),id);
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),['next']);
  await page.evaluate(()=>{window.__egoistRelaySetActive(false);document.getElementById('storyTarget').dispatchEvent(new window.WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true}));});
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),['next']);
  const shot='ui-visuals/instagram-stories-enhancer-fullhd.png';await page.screenshot({path:path.join(output,shot)});await page.close();return {syntheticWheel:true,screenshot:shot};
 });
 for(const service of ['instagram','x'])await record(`${service}-video-visibility-intent`,[`scripts/${service}-enhancer.js`],async()=>{
  const page=await fixture(service==='x'?'https://x.com/home':'https://www.instagram.com/',`<html><body><div id="first"><video id="playing" preload="auto" style="width:600px;height:400px"></video><video id="paused" preload="metadata" style="width:600px;height:400px"></video></div><div id="second"></div></body></html>`);
  await page.evaluate(()=>{window.fixtureVideos={};for(const video of document.querySelectorAll('video')){
   const state=window.fixtureVideos[video.id]={paused:video.id==='paused',plays:0,pauses:0};
   Object.defineProperty(video,'paused',{get:()=>state.paused});Object.defineProperty(video,'ended',{get:()=>false});
   video.pause=()=>{state.paused=true;state.pauses++;};video.play=()=>{state.paused=false;state.plays++;return Promise.resolve();};
  }});
  await page.addScriptTag({content:await readFile(path.join(project,`scripts/${service}-enhancer.js`),'utf8')});
  await page.evaluate(()=>window.__egoistRelaySetActive(true));await page.waitForTimeout(80);
  await page.evaluate(()=>window.__egoistRelaySetActive(false));
  assert.equal(await page.evaluate(()=>window.fixtureVideos.playing.paused),true);
  await page.evaluate(()=>document.getElementById('second').appendChild(document.getElementById('playing')));await page.waitForTimeout(80);
  await page.evaluate(()=>window.__egoistRelaySetActive(true));
  const state=await page.evaluate(()=>window.fixtureVideos);
  assert.equal(state.playing.paused,false);assert.equal(state.paused.plays,0);
  await page.close();return {state,playback:'mocked property and play/pause callbacks; no real decoder/network'};
 });
 await record('instagram-reels-fit',['scripts/instagram-enhancer.js'],async()=>{
  const items=Array.from({length:3},(_,i)=>'<div class="item"><div class="unit"><div class="row"><div class="card"><video id="v'+i+'" style="width:100%;height:100%"></video></div><div class="actions"><svg width="24" height="24"><rect width="24" height="24"/></svg><span class="label">Отметки "Нравится"</span><svg width="24" height="24"><rect width="24" height="24"/></svg></div></div></div></div>').join('');
  const page=await fixture('https://www.instagram.com/reels/AbCdE12345/','<html><body style="margin:0;background:#101012;color:white"><style>.scroll{height:100vh;width:100vw;overflow-y:auto;scroll-snap-type:y mandatory;padding-top:32px;box-sizing:border-box}.item{display:flex;justify-content:center;padding:0 32px;scroll-snap-align:start}.unit{padding:16px 0}.row{display:flex}.card{width:392px;height:697px;background:#335}.actions{width:60px;margin-left:12px;display:flex;flex-direction:column;align-items:center}.label{width:max-content}.bar{position:fixed;left:0;bottom:0;width:100%;height:50px;background:#000}</style><div class="scroll">'+items+'</div><div class="bar"></div></body></html>');
  await page.setViewportSize({width:536,height:988});
  await page.addScriptTag({content:await readFile(path.join(project,'scripts/instagram-enhancer.js'),'utf8')});
  await page.evaluate(()=>window.__egoistRelaySetActive(true));await page.waitForTimeout(150);
  const state=await page.evaluate(()=>{
   const rect=(element)=>{const bounds=element.getBoundingClientRect();return {left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom};};
   const items=[...document.querySelectorAll('.item')];
   const label=document.querySelector('.label');
   return {pageHeight:items[0].getBoundingClientRect().height,nextTop:items[1].getBoundingClientRect().top,card:rect(document.querySelector('.card')),icons:Math.max(...[...document.querySelectorAll('.actions svg')].map(icon=>icon.getBoundingClientRect().right)),labelDisplay:getComputedStyle(label).display,width:window.innerWidth};
  });
  assert.equal(state.labelDisplay,'none');
  assert.equal(state.pageHeight,938);
  assert.ok(state.nextTop>=938,'the next reel must stay under the bottom bar');
  assert.ok(state.card.left>=0&&state.icons<=state.width,'the reel and its buttons fit the width');
  assert.ok(state.card.right-state.card.left>392,'the reel is scaled up');
  assert.ok(Math.abs(state.card.left-(state.width-state.icons))<=12,'left and right margins are balanced');
  await page.evaluate(()=>{window.history.pushState({},'','/direct/inbox/');});await page.waitForTimeout(150);
  await page.evaluate(()=>document.body.append(document.createElement('i')));await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-egoist-reel-item]').length),0);
  await page.close();return state;
 });
 // Широкое окно, лента выше экрана и unit ниже ролика (вёрстка, где unit.offsetHeight не равна высоте карточки): ролик не должен выходить за страницу
 await record('instagram-reels-fit-landscape',['scripts/instagram-enhancer.js'],async()=>{
  const items=Array.from({length:3},(_,i)=>'<div class="item"><div class="unit"><div class="row"><div class="card"><video id="v'+i+'" style="width:100%;height:100%"></video></div><div class="actions"><svg width="24" height="24"><rect width="24" height="24"/></svg><svg width="24" height="24"><rect width="24" height="24"/></svg></div></div></div></div>').join('');
  const page=await fixture('https://www.instagram.com/reels/AbCdE12345/','<html><body style="margin:0;background:#101012;color:white"><style>.scroll{height:3600px;width:100vw;overflow-y:auto;scroll-snap-type:y mandatory}.item{display:flex;justify-content:center;scroll-snap-align:start}.unit{height:120px;overflow:visible}.row{display:flex}.card{width:392px;height:697px;background:#335}.actions{width:60px;margin-left:12px;display:flex;flex-direction:column;align-items:center}</style><div class="scroll">'+items+'</div></body></html>');
  await page.setViewportSize({width:1650,height:1100});
  await page.addScriptTag({content:await readFile(path.join(project,'scripts/instagram-enhancer.js'),'utf8')});
  await page.evaluate(()=>window.__egoistRelaySetActive(true));await page.waitForTimeout(150);
  const state=await page.evaluate(()=>{
   const cards=[...document.querySelectorAll('.card')].map((card)=>{const bounds=card.getBoundingClientRect();return {top:bounds.top,bottom:bounds.bottom,left:bounds.left,right:bounds.right};});
   return {cards,pageHeight:document.querySelector('.item').getBoundingClientRect().height,innerHeight:window.innerHeight,innerWidth:window.innerWidth};
  });
  assert.ok(state.pageHeight<=state.innerHeight,'one reel page is not taller than the window');
  assert.ok(state.cards[0].bottom-state.cards[0].top<=state.innerHeight,'the reel is not taller than the window');
  assert.ok(state.cards[0].bottom<=state.cards[1].top,'neighbouring reels do not overlap');
  assert.ok(state.cards[0].left>=0&&state.cards[0].right<=state.innerWidth,'the reel fits the width');
  await page.close();return state;
 });
 // Живая геометрия Instagram (25.10.2026): в одной ленте портретные (9:16) и широкие (4:3) ролики, слева колонка навигации 72 px.
 // Масштаб считается по каждой странице отдельно, иначе портретные ролики, подогнанные по широкому, выходят за страницу и налезают друг на друга.
 await record('instagram-reels-fit-mixed',['scripts/instagram-enhancer.js'],async()=>{
  const sizes=[{w:610,h:1088},{w:951,h:536},{w:610,h:1088}];
  const icons='<svg width="24" height="24"><rect width="24" height="24"/></svg><svg width="24" height="24"><rect width="24" height="24"/></svg>';
  const items=sizes.map((size,i)=>'<div class="item"><div class="unit"><div class="row"><div class="card" style="width:'+size.w+'px;height:'+size.h+'px"><video id="v'+i+'" style="width:100%;height:100%"></video></div><div class="actions">'+icons+'</div></div></div></div>').join('');
  const nav='<div class="nav">'+icons+icons+icons+icons+icons+'</div>';
  const page=await fixture('https://www.instagram.com/reels/AbCdE12345/','<html><body style="margin:0;background:#101012;color:white"><style>.scroll{height:100vh;width:100vw;overflow-y:auto;scroll-snap-type:y mandatory}.item{display:flex;justify-content:center;align-items:center;height:100vh;scroll-snap-align:start}.unit{padding:0 0}.row{display:flex}.card{background:#335}.actions{width:60px;margin-left:12px;display:flex;flex-direction:column;align-items:center}.nav{position:absolute;left:0;top:0;width:72px;height:100vh;z-index:1}</style>'+nav+'<div class="scroll">'+items+'</div></body></html>');
  await page.setViewportSize({width:1596,height:1120});
  await page.addScriptTag({content:await readFile(path.join(project,'scripts/instagram-enhancer.js'),'utf8')});
  await page.evaluate(()=>{document.querySelector('.scroll').scrollTop=window.innerHeight;});await page.waitForTimeout(100);
  await page.evaluate(()=>window.__egoistRelaySetActive(true));await page.waitForTimeout(200);
  const state=await page.evaluate(()=>{
   const cards=[...document.querySelectorAll('.card')].map((card)=>{const bounds=card.getBoundingClientRect();return {top:Math.round(bounds.top),bottom:Math.round(bounds.bottom),left:Math.round(bounds.left),right:Math.round(bounds.right)};});
   const items=[...document.querySelectorAll('.item')].map((item)=>{const bounds=item.getBoundingClientRect();return {top:Math.round(bounds.top),bottom:Math.round(bounds.bottom)};});
   const icons=Math.max(...[...document.querySelectorAll('.actions svg')].map((icon)=>icon.getBoundingClientRect().right));
   return {cards,items,icons,innerHeight:window.innerHeight,innerWidth:window.innerWidth};
  });
  state.cards.forEach((card,i)=>{
   assert.ok(card.top>=state.items[i].top&&card.bottom<=state.items[i].bottom,'reel '+i+' stays inside its own page');
   assert.ok(card.left>=72,'reel '+i+' does not go under the navigation column');
  });
  assert.ok(state.icons<=state.innerWidth,'the buttons fit the width');
  assert.ok(state.cards[1].right-state.cards[1].left>951,'the wide reel is scaled up');
  await page.close();return state;
 });
 const photoCases=[
  {id:'x-photo-original',service:'x',current:'https://pbs.twimg.com/media/FIXTURE?format=jpg&name=small',srcset:'',expected:'https://pbs.twimg.com/media/FIXTURE?format=jpg&name=orig'},
 ];
 for(const item of photoCases)await record(item.id,['scripts/social-share-enhancer.js'],async()=>{
  const page=await fixture(item.service==='x'?'https://x.com/home':'https://www.instagram.com/', '<html><body style="background:#101012;color:white"></body></html>');
  await page.evaluate(item=>{
   const post=document.createElement('article');if(item.service==='x')post.dataset.testid='tweet';post.style.cssText='width:700px;margin:60px auto;padding:24px;border:1px solid #454550';
   // Caption cross-link precedes timestamp link; enhancer must select the actual selected post permalink.
   const caption=document.createElement('a');caption.href='/p/WrongCrossLink/';caption.textContent='Caption cross-link';post.append(caption);
   const link=document.createElement('a');link.href=item.service==='x'?'/fixture/status/1234567890123456789':'/p/AbCdE12345/';link.innerHTML='<time>2 октября</time>';post.append(link);
   const photos=document.createElement('div');if(item.service==='x')photos.dataset.testid='tweetPhoto';
   const image=document.createElement('img');image.src=item.current;image.width=600;image.height=400;if(item.srcset)image.srcset=item.srcset;photos.append(image);post.append(photos);
   const actions=document.createElement(item.service==='x'?'div':'section');if(item.service==='x')actions.setAttribute('role','group');post.append(actions);document.body.append(post);
  },item);
  const script=(await readFile(path.join(project,'scripts/social-share-enhancer.js'),'utf8'))
   .replaceAll('__EGOIST_RELAY_SHARE_SERVICE__',item.service).replaceAll('__EGOIST_RELAY_SHARE_TOKEN__','fixture-only-token')
   .replaceAll('__EGOIST_RELAY_SHARE_LABEL__','"Передать в Telegram"')
   .replace('window.location.href = `egoist-relay-share://request','window.__fixtureShareNavigation = `egoist-relay-share://request');
  await page.addScriptTag({content:script});await page.locator('button[data-relay-share]').click();
  const payload=await page.evaluate(()=>JSON.parse(new URL(window.__fixtureShareNavigation).searchParams.get('payload')));
  const expected=item.expected||await page.evaluate(()=>document.querySelector('img').currentSrc||document.querySelector('img').src);
  assert.equal(payload.media[0]?.url,expected);
  assert(payload.url.endsWith(item.service==='x'?'/fixture/status/1234567890123456789':'/p/AbCdE12345/'));
  const button=await page.locator('button[data-relay-share]').evaluate(element=>({label:element.getAttribute('aria-label'),width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height}));
  assert(button.label);assert(button.width>=24 && button.height>=24);
  const shot=`ui-visuals/enhancer-${item.id}-fullhd.png`;await page.screenshot({path:path.join(output,shot)});await page.close();return {originalSelected:true,postTimestampPreferred:true,button,screenshot:shot};
 });
}finally{await browser.close();await writeFile(path.join(output,'ui-enhancer-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify({total:results.cases.length,pass:results.cases.filter(item=>item.status==='pass').length,fail:results.cases.filter(item=>item.status==='fail').length}));if(results.cases.some(item=>item.status==='fail'))process.exitCode=1;}
