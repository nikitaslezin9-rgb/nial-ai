import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../voice.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,'Voice page must contain its browser script');
const requestSource=script.slice(script.indexOf('async function request('),script.indexOf('function pcm('));
assert.ok(requestSource.startsWith('async function request('));

function harness(fetchImpl,{fastTimeout=false}={}){
 const controller=new AbortController(),diagnostic={textContent:''},timeouts=[];
 let calls=0,lastSignal;
 const sandbox={
  controller,AbortController,Response,TextDecoder,performance,
  el:()=>diagnostic,
  fetch:(...args)=>{calls++;lastSignal=args[1].signal;return fetchImpl(...args);},
  setTimeout:(fn,ms)=>{timeouts.push(ms);return setTimeout(fn,fastTimeout?10:ms);},
  clearTimeout,setInterval,clearInterval
 };
 const context=vm.createContext(sandbox);
 new vm.Script(requestSource+'\nglobalThis.runRequest=request;').runInContext(context);
 return {request:context.runRequest,controller,diagnostic,timeouts,get calls(){return calls;},get signal(){return lastSignal;}};
}

test('complete browser script parses',()=>{new vm.Script(script);});

test('STT success buffers body and preserves JSON, with 40 second deadline',async()=>{
 const h=harness(async()=>new Response(JSON.stringify({text:'test speech'}),{headers:{'Content-Type':'application/json'}}));
 const response=await h.request('/voice/stt',new ArrayBuffer(3200),'application/octet-stream');
 assert.equal((await response.json()).text,'test speech');
 assert.deepEqual(h.timeouts,[40000]);
 assert.equal(h.calls,1);
 assert.match(h.diagnostic.textContent,/HTTP 200/);
 assert.ok(!h.diagnostic.textContent.includes('test speech'));
});

test('pending fetch times out and never retries',async()=>{
 const h=harness(()=>new Promise(()=>{}),{fastTimeout:true});
 await assert.rejects(h.request('/voice/stt',new ArrayBuffer(3200),'application/octet-stream'),/время ожидания истекло/);
 assert.equal(h.calls,1);
 assert.equal(h.signal.aborted,true);
 assert.match(h.diagnostic.textContent,/превышено время ожидания/);
});

test('deadline also bounds a response body that never finishes',async()=>{
 const h=harness(async()=>({status:200,ok:true,arrayBuffer:()=>new Promise(()=>{})}),{fastTimeout:true});
 await assert.rejects(h.request('/voice/stt',new ArrayBuffer(3200),'application/octet-stream'),/время ожидания истекло/);
 assert.equal(h.calls,1);
 assert.equal(h.signal.aborted,true);
 assert.match(h.diagnostic.textContent,/HTTP 200/);
});

test('pause cancellation aborts pending request without retry',async()=>{
 const h=harness(()=>new Promise(()=>{}));
 const pending=h.request('/voice/stt',new ArrayBuffer(3200),'application/octet-stream');
 h.controller.abort();
 await assert.rejects(pending,error=>error.name==='AbortError');
 assert.equal(h.signal.aborted,true);
 assert.equal(h.calls,1);
});

test('server error is surfaced with HTTP status and without retry',async()=>{
 const h=harness(async()=>new Response(JSON.stringify({error:'SpeechKit HTTP 403.'}),{status:502,headers:{'Content-Type':'application/json'}}));
 await assert.rejects(h.request('/voice/stt',new ArrayBuffer(3200),'application/octet-stream'),/SpeechKit HTTP 403/);
 assert.match(h.diagnostic.textContent,/HTTP 502/);
 assert.equal(h.calls,1);
});

test('non JSON server error still exposes status',async()=>{
 const h=harness(async()=>new Response('gateway error',{status:504}));
 await assert.rejects(h.request('/voice/stt',new ArrayBuffer(3200),'application/octet-stream'),/Ошибка сервера 504/);
 assert.equal(h.calls,1);
});

test('TTS preserves audio bytes',async()=>{
 const bytes=new Uint8Array([73,68,51,1,2,3]);
 const h=harness(async()=>new Response(bytes,{headers:{'Content-Type':'audio/mpeg'}}));
 const response=await h.request('/voice/tts','{}');
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
 assert.equal(response.headers.get('Content-Type'),'audio/mpeg');
 assert.deepEqual(h.timeouts,[40000]);
});

test('chat uses a separate 125 second deadline',async()=>{
 const h=harness(async()=>new Response('{"text":"ok"}',{headers:{'Content-Type':'application/json'}}));
 assert.equal((await(await h.request('/chat','{}')).json()).text,'ok');
 assert.deepEqual(h.timeouts,[125000]);
});
