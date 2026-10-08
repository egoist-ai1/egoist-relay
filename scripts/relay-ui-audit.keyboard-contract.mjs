import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import captureKeyboardListeners, { ALLOW_KEYBOARD_EVENT_PROPAGATION } from '../src/util/captureKeyboardListeners.ts';
const output=process.env.RELAY_UI_AUDIT_EVIDENCE||process.env.RELAY_UI_AUDIT_OUTPUT;
if(!output)throw new Error('Own audit evidence output required');
await mkdir(output,{recursive:true});
const dom=new JSDOM('<!doctype html><button id="target">Synthetic target</button>');
globalThis.document=dom.window.document;
const target=document.querySelector('#target');
const results=[];
function run(id,topResult,expected,options={}){
 const calls=[];let targetEvents=0;const onTarget=()=>targetEvents++;
 target.addEventListener('keydown',onTarget);
 const releaseEarlier=captureKeyboardListeners({onEnter:()=>{calls.push('earlier');return true;}});
 const releaseTop=captureKeyboardListeners({onEnter:()=>{calls.push('top');return topResult;}});
 const event=new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:options.isComposing||false});
 target.dispatchEvent(event);releaseTop();releaseEarlier();target.removeEventListener('keydown',onTarget);
 assert.deepEqual({calls,targetEvents},expected,id);results.push({id,status:'pass',calls,targetEvents,defaultPrevented:event.defaultPrevented});
}
try{
 run('default-undefined-stops-dom-and-earlier',undefined,{calls:['top'],targetEvents:0});
 run('true-stops-dom-and-earlier',true,{calls:['top'],targetEvents:0});
 run('false-continues-earlier-handler',false,{calls:['top','earlier'],targetEvents:0});
 run('explicit-sentinel-blocks-earlier-allows-dom',ALLOW_KEYBOARD_EVENT_PROPAGATION,{calls:['top'],targetEvents:1});
 run('composition-bypasses-capture',undefined,{calls:[],targetEvents:1},{isComposing:true});
 const calls=[];const release=captureKeyboardListeners({onEnter:()=>calls.push('removed')});release();
 target.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(calls.length,0);
 results.push({id:'released-listener-does-not-handle',status:'pass'});
 const event=new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
 const releaseDefault=captureKeyboardListeners({onEnter:e=>{e.preventDefault();return ALLOW_KEYBOARD_EVENT_PROPAGATION;}});
 target.dispatchEvent(event);releaseDefault();assert.equal(event.defaultPrevented,true);
 results.push({id:'sentinel-preserves-caller-prevent-default',status:'pass'});
}finally{await writeFile(path.join(output,'ui-keyboard-contract-results.json'),JSON.stringify({schemaVersion:1,environment:'Actual TypeScript capture module imported by Node; existing jsdom DOM event propagation, no app/accounts',source:'src/util/captureKeyboardListeners.ts',cases:results,summary:{total:results.length,pass:results.filter(r=>r.status==='pass').length}},null,2)+'\n');dom.window.close();}
console.log(JSON.stringify({total:results.length,pass:results.length}));
