import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const script = await fs.readFile(new URL('../../../../Приложения/Egoist Relay/runtime/research/social-read.js', import.meta.url), 'utf8');
const mediaSelector = 'img,video,audio,source,track';
function fixture({ provider = 'x', media = [], timeline = [[1, 2, 3]], delayedProfile = 0, proofDelay = 0, ambiguous = false, contentProfile = false, sample = 'Public fixture', onScroll, locationUrl, targetUrl, storageInPause, cancelInPause }  = {}) {
  const url = new URL(locationUrl || (provider === 'x' ? 'https://x.com/OpenAI' : 'https://www.instagram.com/chatgpt'));
  const events = [], listeners = new Map(); let scrolls = 0, reads = 0, proofReads = 0, clock = Date.now();
  class FixtureDate extends Date { static now() { return clock; } }
  const leaf = value => ({ innerText: value, textContent: value, querySelector: () => undefined, querySelectorAll: () => [] });
  const link = (pathname, label = '', content = false) => ({ href: new URL(pathname, url).href, getAttribute: name => name === 'aria-label' ? label : undefined,
    innerText: label, textContent: label, closest: selector => content && selector.includes('main') ? {} : undefined, querySelector: () => undefined });
  const header = { ...leaf('Public fixture profile'), querySelectorAll: selector => selector === mediaSelector ? media : [] };
  const main = { ...leaf(sample), querySelector(selector) {
    if (selector === '[data-testid="UserName"]' || selector === 'header') return ++reads > delayedProfile ? header : undefined;
    if (selector === '[data-testid="UserDescription"]') return leaf('Public fixture description');
  }, querySelectorAll: () => [] };
  const accountLinks = [link('/direct/inbox/'), link('/fixtureaccount/', 'Profile', contentProfile)];
  if (ambiguous) accountLinks.push(link('/otherfixture/', 'Profile'));
  function tweet(id) {
    const source = link(`/OpenAI/status/${id}`), time = { dateTime: '2026-10-01T00:00:00Z', closest: () => source };
    return { ...leaf('Public fixture post'), querySelector(selector) {
      if (selector === 'time') return time;
      if (selector === '[data-testid="tweetText"]') return leaf('Post ' + id);
      if (selector === '[data-testid="User-Name"]') return leaf('OpenAI');
    }, querySelectorAll: selector => selector === mediaSelector ? media : [] };
  }
  function instagramPost() {
    return { ...leaf('Public selected reel'), matches: () => false, querySelector(selector) {
      if (selector === 'a[href*="/p/"],a[href*="/reel/"]') return link('/chatgpt/reel/Dc1ldDJyZDj');
      if (selector === 'h1') return leaf('Public caption fixture');
      if (selector === 'header') return leaf('chatgpt');
    }, querySelectorAll: selector => selector === mediaSelector ? media : [] };
  }
  const document = { querySelector(selector) {
    if (selector === '[data-testid="SideNav_AccountSwitcher_Button"]') return ++proofReads > proofDelay && provider === 'x' ? {} : undefined;
    if (selector === 'a[data-testid="AppTabBar_Profile_Link"]') return provider === 'x' ? link('/fixtureaccount') : undefined;
    if (selector === 'main,[role="main"]') return main;
  }, querySelectorAll(selector) {
    if (selector === 'a[href]' && provider === 'instagram') return accountLinks;
    if (provider === 'instagram' && /\/(p|reel|reels)\//.test(url.pathname) && selector === 'main article,[role="main"] article') return [instagramPost()];
    if (selector === 'article[data-testid="tweet"]') return timeline[Math.min(scrolls, timeline.length - 1)].map(tweet);
    return [];
  }, scrollingElement: { clientHeight: 800, scrollBy() { scrolls++; onScroll?.({ scrolls, emitStorage: event => listeners.get('storage')?.(event) }); } } };
  const window = { addEventListener(type, callback) { listeners.set(type, callback); }, __TAURI_INTERNALS__: { invoke: async (command, value) => {
    assert.equal(command, 'relay_research_social_reply'); events.push(value.event);
  } } }; window.top = window;
  vm.runInNewContext(script, { window, document, location: { href: url.href, hostname: url.hostname, pathname: url.pathname, protocol: url.protocol },
    URL, Date: FixtureDate, TextEncoder, AbortController, setTimeout(callback, ms) { return setTimeout(() => { if (ms < 1000) clock += ms;
      if (ms === 700 && storageInPause) listeners.get('storage')?.({key:storageInPause,oldValue:'A',newValue:'B'});
      if (ms === 700 && cancelInPause) window.__egoistSocialResearch.cancel('fixture-request','fixture-nonce'); callback(); }, ms < 1000 ? 0 : ms); }, clearTimeout });
  return { events, scrolls: () => scrolls, run(options = {}) { return window.__egoistSocialResearch.start({ requestId: 'fixture-request', nonce: 'fixture-nonce', jobId: 'fixture-job', provider,
    phase: 'read', operation: 'profile', deadlineMs: 30000, documentEpoch: 1, accountEpoch: 'fixture-epoch', targetIndex: 0,
    target: targetUrl || url.href, sourceKey: 'public-fixture', limit: 3, input: { pageSize: 3 }, ...options }); } };
}
function image(current, srcset = '', extra = {}) { return { tagName: 'IMG', currentSrc: current, src: current, srcset,
  naturalWidth: 320, naturalHeight: 180, getAttribute: name => name === 'srcset' ? srcset : undefined, ...extra }; }
async function descriptor(provider, item) { const f = fixture({provider, media: [item]}); await f.run(); return f.events.find(e => e.kind === 'records').records[0].media[0]; }

test('actual MCP extractor selects original X photo with exact media identity and observed dimensions', async () => {
 const item = await descriptor('x', image('https://pbs.twimg.com/media/FIXTURE?format=jpg&name=small'));
 assert.equal(item.sourceUrl, 'https://pbs.twimg.com/media/FIXTURE?format=jpg&name=orig');
 assert.deepEqual(JSON.parse(JSON.stringify(item.dimensions)), {width:320,height:180});
 assert.equal(item.observedSourceUrl, 'https://pbs.twimg.com/media/FIXTURE?format=jpg&name=small');
});
test('actual MCP extractor chooses highest validated IG srcset while preserving signed URL bytes', async () => {
 const selected = 'https://scontent.cdninstagram.com/large.jpg?sig=ABC%2Fdef%3D&opaque=Keep';
 const item = await descriptor('instagram', image('https://scontent.cdninstagram.com/small.jpg?sig=small',
  `https://scontent.cdninstagram.com/small.jpg?sig=small 640w, ${selected} 2048w, https://evil.example/image.jpg 8192w`));
 assert.equal(item.sourceUrl, selected); assert.equal(item.access, 'observed_cdn');
});
test('malformed and mixed srcset descriptors retain observed source; video URLs remain unchanged', async () => {
 const current = 'https://scontent.cdninstagram.com/small.jpg?sig=small';
 for (const srcset of ['bad, https://evil.example/image.jpg 4000w, https://scontent.cdninstagram.com/large.jpg 3.5w',
  'https://scontent.cdninstagram.com/large.jpg 2048w, https://scontent.cdninstagram.com/two.jpg 2x']) {
  assert.equal((await descriptor('instagram', image(current, srcset))).sourceUrl, current);
 }
 const video = await descriptor('x', {tagName:'VIDEO',currentSrc:'blob:fixture',src:'blob:fixture',srcset:'https://video.twimg.com/large.mp4 2048w'});
 assert.equal(video.sourceUrl,'blob:fixture'); assert.equal(video.access,'blob_unsupported');
});
test('first warmup and delayed source hydration wait for independent account and source evidence', async () => {
 const f=fixture({proofDelay:3,delayedProfile:3}); await f.run();
 assert.equal(f.events[0].kind,'auth'); assert.equal(f.events[0].state,'ready'); assert.equal(f.events.at(-1).kind,'page_done');
 assert.equal(f.events.filter(e=>e.kind==='records').length,1);
});
test('ambiguous and content-only IG links cannot prove own account', async () => {
 for(const config of [{ambiguous:true},{contentProfile:true}]) { const f=fixture({provider:'instagram',...config}); await f.run({phase:'probe'});
  assert.equal(f.events.at(-1).state,'unavailable'); assert.equal(f.events.some(e=>e.kind==='records'),false); }
});
test('rate limited source stays an explicit failure without empty or records', async () => {
 const f=fixture({sample:'Rate limit exceeded'}); await f.run(); assert.equal(f.events.at(-1).code,'RATE_LIMITED');
 assert.equal(f.events.some(e=>e.kind==='records'||e.kind==='page_done'),false);
});
test('exact cursor resumes after its anchor with no duplicates and monotonic offset', async () => {
 const f=fixture({timeline:[[1,2,3],[3,4,5],[5,6,7]]}); await f.run({operation:'chat_export',input:{pageSize:3,cursor:JSON.stringify({anchor:'https://x.com/OpenAI/status/3',offset:3})}});
 assert.deepEqual(f.events.filter(e=>e.kind==='records').flatMap(e=>e.records.map(r=>r.id)),['x:4','x:5','x:6']);
 assert.equal(JSON.parse(f.events.at(-1).nextCursor).offset,6);
});
test('cursor anchor missing fails closed without accepting unrelated records', async () => {
 const f=fixture(); await f.run({operation:'chat_export',input:{cursor:JSON.stringify({anchor:'https://x.com/OpenAI/status/99',offset:3})}});
 assert.equal(f.events.at(-1).code,'CURSOR_ANCHOR_NOT_FOUND'); assert.equal(f.events.some(e=>e.kind==='records'),false);
});
test('observed cursor anchor with temporarily stagnant timeline is partial, not empty', async () => {
 const f=fixture(); await f.run({operation:'chat_export',input:{cursor:JSON.stringify({anchor:'https://x.com/OpenAI/status/3',offset:3})}});
 const done=f.events.at(-1); assert.equal(done.kind,'page_done'); assert.equal(done.count,0); assert.equal(done.partial,true);
 assert.equal(done.emptyProof,false); assert.ok(f.scrolls()>0);
 const cursor=JSON.parse(done.nextCursor); assert.equal(cursor.anchor,'https://x.com/OpenAI/status/3'); assert.equal(cursor.offset,3);
 assert.ok(done.coverage.unresolved.includes('cursor_no_progress')); assert.equal(done.resumeProof.anchorReached,true); assert.ok(done.resumeProof.recordsObserved>0);
});
test('storage account invalidation aborts active collection while unrelated storage does not', async () => {
 for(const [key, expected] of [['account','STALE_ACCOUNT'],['sessionBackground','STALE_ACCOUNT'],['theme',undefined]]) {
  const f=fixture({timeline:[[1],[1,2]],onScroll:({scrolls,emitStorage})=>{if(scrolls===1)emitStorage({key,oldValue:'A',newValue:'B'});}});
  await f.run({operation:'chat_export',limit:2,input:{pageSize:2}});
  assert.equal(f.events.at(-1).code,expected); if(!expected)assert.equal(f.events.at(-1).kind,'page_done');
 }
});
test('actual IG selected observed username/reel route binds to same shortcode canonical target', async () => {
 const f=fixture({provider:'instagram',locationUrl:'https://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj',targetUrl:'https://www.instagram.com/reel/Dc1ldDJyZDj'});
 await f.run({operation:'read',limit:1,input:{pageSize:1}});
 assert.equal(f.events.at(-1).kind,'page_done');const record=f.events.find(e=>e.kind==='records').records[0];
 assert.equal(record.id,'instagram:Dc1ldDJyZDj');assert.equal(record.source,'https://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj');
 const changed=fixture({provider:'instagram',locationUrl:'https://www.instagram.com/chatgpt/reel/Dc1ldDJyZDj',targetUrl:'https://www.instagram.com/reel/Other'});
 await changed.run({operation:'read'});assert.equal(changed.events.at(-1).code,'SOURCE_CHANGED');assert.equal(changed.events.some(e=>e.kind==='records'),false);
});
test('account invalidation and explicit cancel while waiting retain distinct errors and stop later records', async () => {
 const f=fixture({timeline:[[1],[1,2]],storageInPause:'account'});await f.run({operation:'chat_export',limit:2,input:{pageSize:2}});
 assert.equal(f.events.at(-1).code,'STALE_ACCOUNT');assert.equal(f.events.filter(e=>e.kind==='records').length,1);
 const cancelled=fixture({timeline:[[1],[1,2]],cancelInPause:true});await cancelled.run({operation:'chat_export',limit:2,input:{pageSize:2}});
 assert.equal(cancelled.events.at(-1).code,'CANCELLED');assert.equal(cancelled.events.filter(e=>e.kind==='records').length,1);
});
test('bounded stale hydration returns retry cursor; later observed DOM resumes without duplication', async () => {
 const f=fixture({timeline:[[1,2,3],[1,2,3],[1,2,3],[1,2,3],[1,2,3],[3,4,5,6]]});
 await f.run({operation:'chat_export',input:{pageSize:3,cursor:JSON.stringify({anchor:'https://x.com/OpenAI/status/3',offset:3})}});
 const cursor=f.events.at(-1).nextCursor;assert.ok(cursor);assert.equal(f.events.at(-1).count,0);assert.ok(f.scrolls()<5);
 const retry=fixture({timeline:[[1,2,3,4,5,6]]});await retry.run({operation:'chat_export',input:{pageSize:3,cursor}});
 assert.deepEqual(retry.events.filter(e=>e.kind==='records').flatMap(e=>e.records.map(r=>r.id)),['x:4','x:5','x:6']);
 assert.equal(JSON.parse(retry.events.at(-1).nextCursor).offset,6);
});
test('selected X post read excludes neighboring posts unless replies are explicitly requested', async () => {
 const f=fixture({locationUrl:'https://x.com/OpenAI/status/2'});await f.run({operation:'read',limit:1,input:{pageSize:1}});
 assert.equal(f.events.at(-1).kind,'page_done');assert.deepEqual(f.events.filter(e=>e.kind==='records').flatMap(e=>e.records.map(r=>r.id)),['x:2']);
});