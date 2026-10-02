import test from 'node:test';
import assert from 'node:assert/strict';
const {createResearchDispatcher,RESEARCH_TOOLS,validateResearchArguments}=await import(process.env.EGOIST_AUDIT_MCP_MODULE??'./mcp.mjs');
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'index-audit',version:'1'}}};
const notice={jsonrpc:'2.0',method:'notifications/initialized'};
const request=(name,args,id=2)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
const ids=['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'];
const config={stateRoot:'C:/selected-private-state',outputRoot:'C:/selected-source-exports'};
const ready=async dispatch=>{await dispatch(init);await dispatch(notice);return dispatch;};
test('catalog advertises explicit local corpus tools without opening accounts or index',async()=>{
 let touched=0;const forbidden=()=>{touched++;throw Error('unexpected side effect');};
 const d=await ready(createResearchDispatcher({connect:forbidden,readConfig:forbidden,createIndex:forbidden}));
 const list=(await d({jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools;
 assert.equal(list.length,8); assert.equal(touched,0);
 const index=list.find(t=>t.name==='social_index_jobs'),search=list.find(t=>t.name==='social_search_index');
 assert.deepEqual(index.annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 assert.deepEqual(search.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 assert.ok(!('method'in search));
});
test('local corpus schemas reject broad file selection, duplicate jobs and unknown modes before IO',async()=>{
 let calls=0;const d=await ready(createResearchDispatcher({connect:()=>{calls++;throw Error();}}));
 for(const args of [{jobIds:[]},{jobIds:[ids[0],ids[0]]},{jobIds:ids,path:'C:/all-files'},{jobIds:['*']},{jobIds:ids,replaceChanged:'yes'}])assert.equal((await d(request('social_index_jobs',args))).error.code,-32602);
 for(const args of [{jobIds:ids,query:''},{jobIds:ids,query:'x',limit:101},{jobIds:ids,query:'x',allAccounts:true}])assert.equal((await d(request('social_search_index',args))).error.code,-32602);
 assert.equal(calls,0);
 const schema=RESEARCH_TOOLS.find(t=>t.name==='social_search_index').inputSchema;
 assert.equal(validateResearchArguments(schema,{jobIds:ids,query:'исследование "точная фраза"',limit:100}),true);
});
test('index resolves only exact accepted job IDs and passes actual metadata to atomic module',async()=>{
 const seen=[],jobs=ids.map(id=>({id,state:'partial',result:{count:1}}));let built;
 const d=await ready(createResearchDispatcher({connect:async()=>({call:async(method,args)=>{seen.push({method,args});return jobs.find(j=>j.id===args.jobId);}}),readConfig:async()=>config,createIndex:options=>{assert.deepEqual(options,config);return {indexJobs:async args=>{built=args;return {state:'indexed',incomplete:true,indexedRecords:2};}};}}));
 const reply=(await d(request('social_index_jobs',{jobIds:ids,replaceChanged:true,deadlineMs:5000}))).result;
 assert.equal(reply.isError,false);assert.equal(reply.structuredContent.incomplete,true);
 assert.deepEqual(seen,ids.map(jobId=>({method:'get',args:{jobId}})));assert.deepEqual(built.jobs,jobs);assert.equal(built.replaceChanged,true);assert.ok(built.deadlineMs>0&&built.deadlineMs<=5000);
});
test('local search works without daemon, account readiness, source submit or implicit indexing',async()=>{
 let searchArgs,configurationCalls=0;
 const d=await ready(createResearchDispatcher({connect:()=>{throw Error('account access forbidden');},readConfig:async()=>{configurationCalls++;return config;},createIndex:()=>({indexJobs:()=>{throw Error('implicit indexing forbidden');},search:async args=>{searchArgs=args;return {state:'results',returned:1,incomplete:true,results:[{jobId:ids[0],locator:{line:2},source:'https://x.com/public/status/1'}]};}})}));
 const result=(await d(request('social_search_index',{jobIds:[ids[0]],query:'literal phrase',limit:1}))).result;
 assert.equal(result.isError,false);assert.equal(result.structuredContent.results[0].locator.line,2);assert.deepEqual(searchArgs.jobIds,[ids[0]]);assert.equal(configurationCalls,1);
 await d(request('social_search_index',{jobIds:[ids[1]],query:'different'}));assert.equal(configurationCalls,1);
});
test('index failures retain actionable code but never disclose raw source or storage error',async()=>{
 for(const code of ['INDEX_MISSING','INDEX_SOURCE_CHANGED','INVALID_CORPUS']){
 const d=await ready(createResearchDispatcher({readConfig:async()=>config,createIndex:()=>({search:()=>{throw Object.assign(new Error('private-path-cookie-auth-content'),{code});}})}));
 const result=(await d(request('social_search_index',{jobIds:ids,query:'text'}))).result;
 assert.equal(result.isError,true);assert.equal(result.structuredContent.code,code);assert.ok(!JSON.stringify(result).includes('private-path-cookie-auth-content'));
 }
});
test('lookup deadline returns finitely without committing a partial index',async()=>{
 let touched=0;
 const d=await ready(createResearchDispatcher({connect:async()=>({call:()=>new Promise(()=>{})}),readConfig:async()=>config,createIndex:()=>{touched++;return {};}}));
 const start=Date.now();const result=(await d(request('social_index_jobs',{jobIds:ids,deadlineMs:1000}))).result;
 assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'INDEX_DEADLINE');assert.equal(touched,0);assert.ok(Date.now()-start<2000);
});
test('combined content and structured output fit frame or return explicit finite error',async()=>{
 const d=await ready(createResearchDispatcher({readConfig:async()=>config,createIndex:()=>({search:async()=>({state:'results',snippet:'\\'.repeat(200000)})})}));
 const reply=await d(request('social_search_index',{jobIds:ids,query:'text'}));
 assert.equal(reply.result.isError,true);assert.equal(reply.result.structuredContent.code,'RESEARCH_FRAME_TOO_LARGE');assert.ok(Buffer.byteLength(JSON.stringify(reply))<262144);
});
test('stale text normalization retains selected reindex guidance without bridge access',async()=>{
 let connectionCalls=0,indexCalls=0;
 const d=await ready(createResearchDispatcher({connect:()=>{connectionCalls++;throw Error('unexpected bridge access');},readConfig:async()=>config,createIndex:()=>({indexJobs:()=>{indexCalls++;throw Error('unexpected implicit reindex');},search:()=>{throw Object.assign(new Error('private-path-cookie-auth-content'),{code:'INDEX_NORMALIZATION_CHANGED'});}})}));
 const result=(await d(request('social_search_index',{jobIds:[ids[0]],query:'selected text'}))).result;
 assert.equal(result.isError,true);
 assert.equal(result.structuredContent.code,'INDEX_NORMALIZATION_CHANGED');
 assert.equal(result.structuredContent.recovery,'The selected derived snapshot uses older text roles. Explicitly index the exact selected accepted job IDs before searching again.');
 assert.ok(!JSON.stringify(result).includes('private-path-cookie-auth-content'));
 assert.equal(connectionCalls,0);assert.equal(indexCalls,0);
});
