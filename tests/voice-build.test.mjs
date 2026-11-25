import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installVoice} from '../scripts/build-voice.mjs';
const anchor="  if (req.method === 'POST' && ['/chat', '/image'].includes(req.url)) {";
const fixture="async function server(req,res,json){if (!(await nialAuthorizeRequest(req))) {return;}\n"+anchor+"return;} }";
const speech='export const MAX_AUDIO_BYTES=640000;\nexport const MAX_TEXT_CHARS=1500;';
test('routes follow existing auth; output is valid JavaScript',()=>{const out=installVoice(fixture,speech,'test');assert.ok(out.indexOf('nialAuthorizeRequest(req)')<out.indexOf('if (await nialVoiceRoute'));assert.ok(!out.includes('export const MAX_AUDIO'));new vm.Script(out);});
test('fail closed on changed server/auth structure',()=>{assert.throws(()=>installVoice('changed','',''));assert.throws(()=>installVoice(fixture.replace('nialAuthorizeRequest','other'),'',''));});
test('reject duplicate installation',()=>{assert.throws(()=>installVoice(installVoice(fixture,'',''),'',''));});
test('HTML is encoded rather than interpolated into code',()=>{const html='</script><script>alert(1)</script>',out=installVoice(fixture,'',html);assert.ok(!out.includes(html));assert.ok(out.includes(Buffer.from(html).toString('base64')));});
function context(env={}){const c=vm.createContext({Buffer,Date,process:{env},authorized:()=>true,origin:'https://nial.test',recognizeSpeech:async()=>{throw Error('Unexpected API call');},synthesizeSpeech:async()=>{throw Error('Unexpected API call');}});new vm.Script(installVoice(fixture,speech,'test')+'\nglobalThis.route=nialVoiceRoute;').runInContext(c);return c;}
test('disabled by default, no API calls',async()=>{let code;await context().route({url:'/voice/stt',method:'POST',headers:{}},{},n=>code=n);assert.equal(code,503);});
test('reject cross-origin request',async()=>{let code;await context({NIAL_VOICE_ENABLED:'test',YANDEX_SPEECHKIT_API_KEY:'fake'}).route({url:'/voice/stt',method:'POST',headers:{origin:'https://evil.test'}},{},n=>code=n);assert.equal(code,403);});
test('private voice test does not accept guest access',async()=>{const c=context();c.authorized=()=>false;let code;await c.route({url:'/voice',method:'GET',headers:{}},{},n=>code=n);assert.equal(code,403);});
