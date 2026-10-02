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
 const photoCases=[
  {id:'ig-srcset-signed-original',service:'instagram',current:'https://scontent.cdninstagram.com/small.jpg?sig=small',srcset:'https://scontent.cdninstagram.com/small.jpg?sig=small 640w, https://scontent.cdninstagram.com/large.jpg?sig=ABC%2Fdef%3D&opaque=Keep 2048w, https://evil.example/escape.jpg 8192w',expected:'https://scontent.cdninstagram.com/large.jpg?sig=ABC%2Fdef%3D&opaque=Keep'},
  {id:'ig-srcset-malformed-fallback',service:'instagram',current:'https://scontent.cdninstagram.com/small.jpg?sig=small',srcset:'bad, https://evil.example/image.jpg 4000w, https://scontent.cdninstagram.com/large.jpg 3.5w',expected:'https://scontent.cdninstagram.com/small.jpg?sig=small'},
  {id:'ig-srcset-mixed-descriptor',service:'instagram',current:'https://scontent.cdninstagram.com/small.jpg?sig=small',srcset:'https://scontent.cdninstagram.com/large.jpg 2048w, https://scontent.cdninstagram.com/two.jpg 2x'},
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
