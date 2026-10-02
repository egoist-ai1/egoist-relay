import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createResearchBroker } from './broker.mjs';
import { assertSafeDirectory } from './job-store.mjs';
const work=process.env.EGOIST_RESEARCH_TEST_WORK;
if(!work||!path.isAbsolute(work)||path.basename(work).toLowerCase()!=='work')throw Error('Explicit task work required');
const source=await fs.readFile(new URL('../../../../Приложения/Egoist Relay/runtime/research/bridge-server.mjs',import.meta.url),'utf8');
const start=source.indexOf('  function output(peer, id, event) {'), end=source.indexOf('  function terminal(',start);
assert.ok(start>=0&&end>start);
// Exercise the production socket writer on a real owned connection, including actual drain/close events.
const {outputWithDrain}=new Function('MAX_FRAME',source.slice(start,end)+';return {outputWithDrain};')(262144);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(check,timeout=10000){const until=Date.now()+timeout;while(Date.now()<until){const value=await check();if(value)return value;await pause(5);}throw Error('Fixture deadline');}
async function pipeFixture(mode){
 const pipe=process.platform==='win32'?'\\\\.\\pipe\\relay-audit-drain-'+randomUUID():path.join(work,'relay-audit-'+randomUUID()+'.sock');
 const payload=Buffer.alloc(49152,1).toString('base64');const expected=createHash('sha256');const actual=createHash('sha256');
 let peak=0,received=0,buffer='',settle;
 const done=new Promise(resolve=>{settle=resolve;});
 const server=net.createServer(async peer=>{
  peer.on('error',()=>{});const write=peer.write;peer.write=function(...args){const value=write.apply(this,args);peak=Math.max(peak,peer.writableLength);return value;};
  const began=Date.now();let accepted=0;
  for(let sequence=0;sequence<200;sequence++){
   const okay=await outputWithDrain(peer,'fixture',{kind:'media_chunk',mediaId:'fixture',sequence,base64:payload},began+(mode==='deadline'?120:5000));
   if(!okay){peer.destroy();settle({accepted,elapsed:Date.now()-began});return;}
   accepted++;expected.update(payload);
  }
  peer.end();settle({accepted,elapsed:Date.now()-began});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
 const reader=net.createConnection(pipe);reader.on('error',()=>{});reader.on('data',chunk=>{
  buffer+=chunk.toString();let split;while((split=buffer.indexOf('\n'))>=0){const frame=JSON.parse(buffer.slice(0,split));buffer=buffer.slice(split+1);
   assert.equal(frame.event.sequence,received++);actual.update(frame.event.base64);}
 });
 const ended=new Promise(resolve=>{reader.once('end',resolve);reader.once('close',resolve);});reader.pause();
 const timer=setTimeout(()=>mode==='slow'?reader.resume():reader.destroy(),mode==='slow'?200:mode==='close'?100:2000);
 try{const result=await done;if(mode==='slow')await ended;assert.ok(peak<=1048576);
  if(mode==='slow'){assert.equal(result.accepted,200);assert.equal(received,200);assert.equal(actual.digest('hex'),expected.digest('hex'));assert.equal(buffer,'');}
  else{assert.ok(result.accepted<200);assert.ok(result.elapsed<1500);}
  return {...result,peak,received};
 }finally{clearTimeout(timer);reader.destroy();await new Promise(resolve=>server.close(resolve));}
}
for(const mode of ['slow','close','deadline'])test('production helper finite backpressure: '+mode,{timeout:10000},async()=>{await pipeFixture(mode);});
test('helper hard frame limit rejects oversized frame before delivery',{timeout:3000},async()=>{
 const {output}=new Function('MAX_FRAME',source.slice(start,end)+';return {output};')(262144);
 let writes=0;const peer={destroyed:false,writableEnded:false,writableLength:0,write(){writes++;return true;},destroy(){this.destroyed=true;}};
 assert.equal(output(peer,'fixture',{kind:'records',text:'A'.repeat(262144)}),false);assert.equal(writes,0);
});
test('rapid three-service alternation remains FIFO/serial and idempotent across disk recovery',{timeout:20000},async t=>{
 const directory=path.join(work,'relay-audit-queues-'+randomUUID());await assertSafeDirectory(directory,{create:true});
 const roots={stateRoot:path.join(directory,'state'),outputRoot:path.join(directory,'outputs')};
 const active={telegram:0,x:0,instagram:0},maximum={...active},orders={telegram:[],x:[],instagram:[]};let executions=0;
 const providers=Object.fromEntries(Object.keys(active).map(name=>[name,{requiresAccountBinding:true,
  status:async()=>({state:'ready',operations:['search'],accountRef:'synthetic-'+name,accountEpoch:'epoch-1'}),
  run:async({input,accountScope})=>{active[name]++;maximum[name]=Math.max(maximum[name],active[name]);executions++;orders[name].push(input.query);
   assert.equal(accountScope.accountEpoch,'epoch-1');await pause(2);active[name]--;return {count:1,coverage:'platform_search'};}}]));
 const broker=await createResearchBroker({...roots,providers});t.after(()=>broker.close());const requests=[],jobs=[];
 for(let round=0;round<8;round++)for(const name of Object.keys(active)){
  const request={provider:name,operation:'search',idempotencyKey:`synthetic-${name}-${round}`,input:{query:'fixture '+round,...(name==='instagram'?{scope:'profiles'}:{})}};
  requests.push(request);const [a,b]=await Promise.all([broker.submit(request),broker.submit(request)]);assert.equal(a.id,b.id);jobs.push(a);
 }
 for(const job of jobs)assert.equal((await bounded(async()=>{const value=await broker.get(job.id);return ['completed','failed','partial'].includes(value.state)&&value;})).state,'completed');
 assert.equal(executions,24);assert.deepEqual(maximum,{telegram:1,x:1,instagram:1});
 for(const order of Object.values(orders))assert.deepEqual(order,Array.from({length:8},(_,i)=>'fixture '+i));
 await broker.close();const recovered=await createResearchBroker({...roots,providers});t.after(()=>recovered.close());
 for(let i=0;i<requests.length;i++)assert.equal((await recovered.submit(requests[i])).id,jobs[i].id);assert.equal(executions,24);
});