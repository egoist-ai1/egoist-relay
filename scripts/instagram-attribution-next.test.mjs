import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '../node_modules/playwright/index.mjs';
const project = fileURLToPath(new URL('..', import.meta.url));
const mcp = path.resolve(project, '../../Инфраструктура/Egoist Social MCP');
const { createRelayBridgeProvider } = await import(pathToFileURL(path.join(mcp, 'src/research/bridge-provider.mjs')));
const { createLocalResearchIndex } = await import(pathToFileURL(path.join(mcp, 'src/research/local-index.mjs')));
const { restoreResearchTextFields, formatResearchHtml, formatResearchMarkdown } = await import(pathToFileURL(path.join(mcp, 'src/research/export-format.mjs')));
const work = process.env.EGOIST_RESEARCH_TEST_WORK;
if (!work || !path.isAbsolute(work) || path.basename(work).toLowerCase() !== 'work') throw new Error('Owned active work required.');
const root = path.join(work, 'attribution-next-' + randomUUID());
await fs.mkdir(root);
const sourceBytes = await fs.readFile(path.join(project, 'runtime/research/social-read.js'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const observations = [], nativeFixtures = [];
const accountScope = { accountRef: 'synthetic-attribution', accountEpoch: 'synthetic-epoch' };
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/Egoist/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe' });
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function helper(name, { pagePath = '/openai/', targetPath = '/openai', operation = 'channel_history', body = '<a href="/owner/reel/SAME"></a>', description = 'PAGEBIOGRAPHY', targetOrigin = 'https://www.instagram.com' } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let page, fulfilled = 0, aborted = 0;
  await context.route('**/*', route => {
    if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
      fulfilled++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><meta property="og:description" content="'+escape(description)+'"></head><body><nav><a aria-label="Profile" href="/fixture_account/">Profile</a><a href="/direct/inbox/">Messages</a></nav><main>'+body+'</main></body></html>' });
    }
    aborted++; return route.abort();
  });
  page = await context.newPage();
  await page.goto('https://www.instagram.com'+pagePath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__fixture = []; window.__TAURI_INTERNALS__ = { invoke: async (command, args) => { if(command !== 'relay_research_social_reply') throw Error('Unexpected transport'); window.__fixture.push(JSON.parse(JSON.stringify(args.event))); } }; });
  await page.addScriptTag({ content: sourceBytes.toString('utf8') });
  const request = { requestId: 'synthetic-' + randomUUID(), nonce: 'synthetic-nonce-0001', provider: 'instagram', operation, target: targetOrigin+targetPath, scope: 'posts', sourceKey:'synthetic-source', accountEpoch:'synthetic-epoch', documentEpoch:1, targetIndex:0, limit:1, deadlineMs:3000, input:{pageSize:1, includeMedia:false} };
  await page.evaluate(async request => window.__egoistSocialResearch.start(request), request);
  const events = await page.evaluate(() => window.__fixture);
  await context.close();
  const wire = events.flatMap(e => e.records ?? []);
  const error = events.find(e => e.kind === 'error')?.code;
  const done = events.find(e => e.kind === 'page_done');
  observations.push({ name, recordsFrames:wire.length, error, done:done && {count:done.count, partial:done.partial}, outgoingRequests:0, fulfilled, aborted });
  if (wire.length && !error) nativeFixtures.push({ name, request, events });
  return { wire, error, done, events, request };
}
async function consume(name, wire, { partial = true, before = [] } = {}) {
  const fixture = path.join(root, name + '-' + randomUUID());
  const stateRoot = path.join(fixture,'state'), outputRoot = path.join(fixture,'outputs');
  const jobId = randomUUID(), outputDirectory = path.join(outputRoot, jobId);
  await fs.mkdir(outputDirectory, {recursive:true}); await fs.mkdir(stateRoot);
  const bridge = { call: async (method, params, {onEvent}) => {
    assert.equal(method,'run'); assert.deepEqual(params.expectedAccount, accountScope);
    await onEvent({kind:'scope',...accountScope});
    for (const record of [...before,...wire]) await onEvent({kind:'records',records:[record],partial,coverage:'channel'});
    const done={kind:'done',count:before.length+1,outcome:partial?'partial':'results',partial}; await onEvent(done); return done;
  } };
  const provider = createRelayBridgeProvider({provider:'instagram',bridge}, {diskFree:async()=>100*1024**3});
  const result = await provider.run({operation:'chat_export',input:{channel:'openai',limit:100,pageSize:100,deadlineMs:30000,exportFormats:['jsonl','markdown','html']}, accountScope,jobId,outputDirectory,signal:new globalThis.AbortController().signal});
  const bytes = await fs.readFile(path.join(outputDirectory,'records.jsonl'));
  const records = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const html = await fs.readFile(path.join(outputDirectory,'export.html'),'utf8'), md=await fs.readFile(path.join(outputDirectory,'export.md'),'utf8');
  const job = {id:jobId,provider:'instagram',state:result.state,outputDirectory,result:{...result,outcome:partial?'partial':'results'}};
  const index = createLocalResearchIndex({stateRoot,outputRoot});
  const indexed = await index.indexJobs({jobs:[job]});
  return {fixture,stateRoot,outputRoot,jobId,outputDirectory,result,records,html,md,bytes,job,index,indexed};
}
async function metadata(name, description, extras={}) {
  const h=await helper(name,{description,...extras}); assert.equal(h.error,undefined);
  const f=await consume(name,h.wire);
  const r=f.records[0]; assert.equal(r.description,description); assert.equal(r.text,undefined);
  assert.equal(r.pageMetadata.descriptionField,'description'); assert.equal(r.sourceContext.pageUrl,'https://www.instagram.com/openai/');
  assert.equal(r.sourceContext.requestedSource,'https://www.instagram.com/openai');
  assert.ok(r.unresolvedFields.includes('caption_not_observed'));
  assert.equal(f.result.count,1); assert.equal(f.result.state,'partial');
  assert.equal(f.indexed.jobs[0].missingFields.contentText,1); assert.equal(f.indexed.jobs[0].missingFields.text,1);
  assert.equal((await f.index.search({jobIds:[f.jobId],query:'BIOGRAPHY_SENTINEL'})).totalMatches,0);
  assert.ok(f.html.includes('Текст в принятой записи не наблюдался'));
  assert.equal(f.html.includes('<h3>Текст</h3>'),false);
  assert.ok(f.html.includes('Метаданные наблюдаемой страницы')); assert.ok(f.md.includes(description));
  return {h,f};
}
for (const length of [80,9000,16000]) test('actual helper→bridge→FTS metadata-only UTF16 '+length,async()=>{
  const description=('BIOGRAPHY_SENTINEL '+ 'a'.repeat(length)).slice(0,length);
  const {h}=await metadata('metadata-'+length,description);
  if(length>=8000) assert.deepEqual(Object.keys(h.wire[0].textFields),['description']);
});
test('surrogate pair at12000 split is preserved byte-exactly in metadata, never body',async()=>{
  const description='BIOGRAPHY_SENTINEL '+ 'a'.repeat(11999-19)+ '🙂Русский终';
  const {h,f}=await metadata('surrogate',description);
  assert.equal(sha(Buffer.from(f.records[0].description)),sha(Buffer.from(description)));
  for(const part of h.wire) assert.equal(part.textPart.text.endsWith('\uD83D'),false);
});
test('multi-field caption and observed DOM keep roles and all original UTF8 bytes',async()=>{
  const caption='CAPTION_SENTINEL '+'🙂'.repeat(6500),description='BIOGRAPHY_SENTINEL '+'b'.repeat(17000);
  const h=await helper('multi',{description,body:'<article><a href="/owner/reel/SAME"></a><h1>'+caption+'</h1></article>'});
  assert.equal(h.error,undefined); assert.ok(h.wire.length>2);
  const f=await consume('multi',h.wire),r=f.records[0];
  assert.equal(r.text,caption); assert.equal(r.description,description); assert.equal(r.observedText,caption);
  assert.equal((await f.index.search({jobIds:[f.jobId],query:'CAPTION_SENTINEL'})).totalMatches,1);
  assert.equal((await f.index.search({jobIds:[f.jobId],query:'BIOGRAPHY_SENTINEL'})).totalMatches,0);
  assert.equal(f.indexed.jobs[0].missingFields.contentText,0);
});
for(const kind of ['reel','p']) test('strict '+kind+' alias shared by dispatch, record and OG fallback',async()=>{
  const caption='EXACTPOST_SENTINEL '+'c'.repeat(16000);
  const h=await helper('alias-'+kind,{pagePath:'/owner/'+kind+'/SAME/',targetPath:'/'+kind+'/SAME',operation:'read',description:caption,body:'<article><a href="/'+kind+'/SAME"></a></article>'});
  assert.equal(h.error,undefined); const f=await consume('alias-'+kind,h.wire),r=f.records[0];
  assert.equal(r.text,caption); assert.equal(r.description,caption); assert.equal(r.type,kind==='p'?'post':'reel');
  assert.deepEqual(h.wire[0].textFields.text,h.wire[0].textFields.description);
  assert.equal((await f.index.search({jobIds:[f.jobId],query:'EXACTPOST_SENTINEL'})).totalMatches,1);
});
test('selected detail page supplies source when its article exposes no permalink',async()=>{
  const h=await helper('detail-no-link',{pagePath:'/owner/reel/SAME/',targetPath:'/reel/SAME',operation:'read',description:'SAMEPAGE_CAPTION',body:'<article><h1>Observed caption without permalink</h1></article>'});
  assert.equal(h.error,undefined);const f=await consume('no-link',h.wire);
  assert.equal(f.records[0].text,'Observed caption without permalink');assert.equal(f.records[0].source,'https://www.instagram.com/owner/reel/SAME');
});
test('same profile handle is not publisher proof; observed header/time are literal evidence only',async()=>{
  const h=await helper('detail',{pagePath:'/reel/SAME/',targetPath:'/reel/SAME',operation:'read',description:'Page post metadata',body:'<article><header>owner and collaborator</header><a href="/owner/reel/SAME"></a><h1>Observed caption</h1><time datetime="2026-09-01T12:00:00Z">Date</time></article>'});
  const f=await consume('detail',h.wire),r=f.records[0];
  assert.equal(r.text,'Observed caption'); assert.equal(r.timestamp,'2026-09-01T12:00:00Z');
  assert.equal(r.author.observedText,'owner and collaborator'); assert.equal(r.publisher,undefined); assert.equal(r.collaborators,undefined);
  assert.ok(r.unresolvedFields.includes('publisher_identity_unverified')); assert.ok(r.unresolvedFields.includes('collaboration_unverified'));
});
test('different kind, shortcode, profile, malformed separators and origin never emit selected post',async()=>{
  for(const config of [
    {pagePath:'/p/SAME/',targetPath:'/reel/SAME',operation:'read'},
    {pagePath:'/reel/OTHER/',targetPath:'/reel/SAME',operation:'read'},
    {pagePath:'/chatgpt/',targetPath:'/openai'},
    {pagePath:'/reel//SAME',targetPath:'/reel/SAME',operation:'read'},
    {pagePath:'/reel/SAME/',targetPath:'/reel/SAME',targetOrigin:'https://www.instagram.com.evil',operation:'read'},
    {pagePath:'/reel/SAME/',targetPath:'/reel/SAME',operation:'read',body:'<article><a href="/p/SAME"></a></article>'},
    {pagePath:'/reel/SAME/',targetPath:'/reel/SAME',operation:'read',body:'<article><a href="https://evil.example/reel/OTHER">Invalid permalink</a><h1>UNRELATEDNODECAPTION</h1></article>'},
    {pagePath:'/reel/SAME/',targetPath:'/reel/SAME',operation:'read',body:'<article><a href="https://user@www.instagram.com/reel/OTHER">Invalid credentials permalink</a><h1>UNRELATEDNODECAPTION</h1></article>'},
  ]) { const h=await helper('source-reject',config); assert.equal(h.wire.length,0); assert.ok(h.error); }
});
test('exact4MiB UTF8 payload accepted and larger ASCII/emoji or multifield payload rejected',async()=>{
  const h=await helper('four-mib',{description:'B'.repeat(4*1024**2)}); assert.equal(h.error,undefined);
  const r=restoreResearchTextFields(h.wire[0],h.wire.map(r=>r.textPart.text).join('')); assert.equal(Buffer.byteLength(r.description),4*1024**2); assert.equal(r.text,undefined);
  const f=await consume('four-mib',h.wire);
  assert.equal(sha(Buffer.from(f.records[0].description)),sha(Buffer.from(r.description)));
  assert.equal(f.indexed.jobs[0].missingFields.contentText,1);
  assert.equal(f.indexed.indexedRecords,1);
  for(const config of [ {description:'x'.repeat(4*1024**2+1)}, {description:'🙂'.repeat(1024**2+1)},
    {description:'x'.repeat(3*1024**2),body:'<a href="/owner/reel/SAME">'+'y'.repeat(2*1024**2)+'</a>'} ]) {
    const bad=await helper('text-limit',config); assert.equal(bad.error,'TEXT_LIMIT'); assert.equal(bad.wire.length,0);
  }
});
test('legacy schema1 ranges restored in derived views without rewriting accepted JSONL',async()=>{
  const payload='REAL_LEGACY_CAPTION\nLEGACY_BIOGRAPHY';
  const record={schemaVersion:1,provider:'instagram',type:'reel',id:'legacy',source:'https://www.instagram.com/reel/LEGACY',text:payload,textFields:{text:{offset:0,length:19},description:{offset:20,length:16}},pageMetadata:{descriptionField:'description'}};
  // Exact lengths are calculated from the original field values, never UTF8 byte offsets.
  record.textFields.text.length='REAL_LEGACY_CAPTION'.length;record.textFields.description.offset='REAL_LEGACY_CAPTION'.length+1;record.textFields.description.length='LEGACY_BIOGRAPHY'.length;
  const before=JSON.stringify(record);const normalized=restoreResearchTextFields(record);
  assert.equal(normalized.text,'REAL_LEGACY_CAPTION');assert.equal(normalized.description,'LEGACY_BIOGRAPHY');assert.equal(JSON.stringify(record),before);
  for(const render of [formatResearchMarkdown,formatResearchHtml]) { const value=render({provider:'instagram',operation:'chat_export',jobId:'legacy',records:[record],partial:true}); assert.ok(value.includes('REAL_LEGACY_CAPTION'));assert.ok(value.includes('LEGACY_BIOGRAPHY')); }
  const f=await consume('legacy',[{...record,text:'REAL_LEGACY_CAPTION',description:'LEGACY_BIOGRAPHY',textFields:undefined}]);
  // Existing immutable legacy corpus is indexed directly, exercising recordFields restoration and original source hashes.
  await fs.writeFile(path.join(f.outputDirectory,'records.jsonl'),before+'\n');
  const rebuilt=await f.index.indexJobs({jobs:[f.job],replaceChanged:true});assert.equal(rebuilt.jobs[0].missingFields.contentText,0);
  assert.equal((await f.index.search({jobIds:[f.jobId],query:'LEGACY_BIOGRAPHY'})).totalMatches,0);
  assert.equal((await f.index.search({jobIds:[f.jobId],query:'REAL_LEGACY_CAPTION'})).totalMatches,1);
  assert.equal(sha(await fs.readFile(path.join(f.outputDirectory,'records.jsonl'))),sha(Buffer.from(before+'\n')));
});
test('normalization mismatch blocks search then rebuilds only explicitly selected unchanged-byte shards',async()=>{
  const f=await consume('rebuild',[{schemaVersion:1,provider:'instagram',type:'reel',id:'normalization',source:'https://www.instagram.com/reel/NORM',text:'NORMALIZATION_SENTINEL'}]);
  const hashBefore=sha(f.bytes);
  const otherId=randomUUID(), otherDirectory=path.join(f.outputRoot,otherId);await fs.mkdir(otherDirectory);
  const otherBytes=Buffer.from(JSON.stringify({schemaVersion:1,provider:'instagram',type:'reel',id:'other',source:'https://www.instagram.com/reel/OTHER',text:'UNSELECTED_SENTINEL'})+'\n');
  await fs.writeFile(path.join(otherDirectory,'records.jsonl'),otherBytes);
  const otherJob={...f.job,id:otherId,outputDirectory:otherDirectory};await f.index.indexJobs({jobs:[otherJob]});
  const db=new DatabaseSync(path.join(f.stateRoot,'local-index/index.sqlite'));
  for(const id of [f.jobId,otherId]) db.prepare('DELETE FROM index_meta WHERE key=?').run('normalization:'+id);db.close();
  await assert.rejects(f.index.search({jobIds:[f.jobId],query:'NORMALIZATION_SENTINEL'}),{code:'INDEX_NORMALIZATION_CHANGED'});
  await f.index.indexJobs({jobs:[f.job]});
  assert.equal((await f.index.indexJobs({jobs:[f.job]})).jobs[0].state,'unchanged');
  assert.equal((await f.index.search({jobIds:[f.jobId],query:'NORMALIZATION_SENTINEL'})).totalMatches,1);
  assert.equal(sha(await fs.readFile(path.join(f.outputDirectory,'records.jsonl'))),hashBefore);
  await assert.rejects(f.index.search({jobIds:[otherId],query:'UNSELECTED_SENTINEL'}),{code:'INDEX_NORMALIZATION_CHANGED'});
  assert.equal(sha(await fs.readFile(path.join(otherDirectory,'records.jsonl'))),sha(otherBytes));
  const result=await f.index.search({jobIds:[f.jobId],query:'NORMALIZATION_SENTINEL'});
  assert.equal(result.results[0].locator.file,path.join(f.outputDirectory,'records.jsonl'));assert.equal(result.jobs[0].sourceSha256,hashBefore);
});
test('malformed UTF16 maps, overlapping fields, changed continuation and missing final stay honest partial failures',async()=>{
  const base={schemaVersion:1,provider:'instagram',type:'reel',id:'bad',source:'https://www.instagram.com/reel/BAD'};
  assert.throws(()=>restoreResearchTextFields({...base,text:'\nxx',textFields:{description:{offset:1,length:2}}}),{code:'INVALID_TEXT_FIELDS'});
  const maps=[{}, {unknown:{offset:0,length:3}}, {text:{offset:-1,length:3}}, {text:{offset:0.5,length:3}}, {text:{offset:0,length:4}}, {text:{offset:0,length:2}}, {text:{offset:0,length:3,extra:1}}, {text:{offset:0,length:3},description:{offset:1,length:2}}];
  for(const fields of maps) {
    assert.throws(()=>restoreResearchTextFields({...base,text:'a🙂',textFields:fields}),{code:'INVALID_TEXT_FIELDS'});
    await assert.rejects(consume('invalid',[{...base,textFields:fields,textPart:{index:0,text:'a🙂',final:true}}]),{code:'INVALID_RESULT'});
  }
  for(const wire of [
    [{...base,textPart:{index:0,text:'unfinished',final:false}}],
    [{...base,textPart:{index:0,text:'a',final:false}},{...base,source:'https://www.instagram.com/reel/OTHER',textPart:{index:1,text:'b',final:true}}],
    [{...base,textPart:{index:0,text:'a',final:false}},{...base,textFields:{text:{offset:0,length:2}},textPart:{index:1,text:'b',final:true}}],
  ]) await assert.rejects(consume('invalid-stream',wire),{code:'INVALID_RESULT'});
  const fixture=path.join(root,'partial-explicit');await fs.mkdir(fixture);
  const good={...base,id:'good',text:'acceptedBeforeFailure'};
  const bridge={call:async(method,params,{onEvent})=>{await onEvent({kind:'scope',...accountScope});await onEvent({kind:'records',records:[good]});await onEvent({kind:'records',records:[{...base,text:'a🙂',textFields:{description:{offset:0,length:2}}}]});}};
  const provider=createRelayBridgeProvider({provider:'instagram',bridge},{diskFree:async()=>100*1024**3});
  await assert.rejects(provider.run({operation:'chat_export',input:{channel:'openai',limit:10,deadlineMs:10000},accountScope,jobId:randomUUID(),outputDirectory:fixture,signal:new globalThis.AbortController().signal}),{code:'INVALID_RESULT'});
  const partial=JSON.parse(await fs.readFile(path.join(fixture,'partial-manifest.json'),'utf8'));assert.equal(partial.count,1);assert.equal(partial.partial,true);assert.equal(partial.failure.code,'INVALID_RESULT');
  const rows=(await fs.readFile(path.join(fixture,'records.jsonl'),'utf8')).trim().split('\n');assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0]).text,'acceptedBeforeFailure');
});
after(async()=>{
  await browser.close();
  const receiptName=process.env.EGOIST_ATTRIBUTION_RECEIPT ?? 'instagram-attribution-next-tests-v1.json';
  const wireFile=path.join(work,receiptName.replace(/\.json$/, '-wire.json')); 
  await fs.writeFile(wireFile,JSON.stringify(nativeFixtures)+'\n');
  const receipt={schemaVersion:1,artifactId:'egoist-instagram-attribution-next-tests',version:'next-v1',createdAt:new Date().toISOString(),helperSha256:sha(sourceBytes),fixtureRoot:root,wireFile,wireSha256:sha(await fs.readFile(wireFile)),nativeFixtureCount:nativeFixtures.length,observations,liveAccess:false,mcpCalls:0,releaseEdits:0};
  await fs.writeFile(path.join(project,'docs/app-quality-audit-2026-10-02',receiptName),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log('NEXT receipt metadata: '+JSON.stringify({nativeFixtureCount:nativeFixtures.length,helperSha256:sha(sourceBytes),wireSha256:receipt.wireSha256}));
});
