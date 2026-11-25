import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function installVoice(source,speech,html){
 const anchor="  if (req.method === 'POST' && ['/chat', '/image'].includes(req.url)) {";
 if(source.split(anchor).length!==2||!source.includes('if (!(await nialAuthorizeRequest(req))) {'))throw Error('Voice: unexpected server/auth structure');
 if(source.includes('async function nialVoiceRoute'))throw Error('Voice already installed');
 const helpers=speech.replace(/^export /gm,'');
 const runtime=`
const nialVoicePage = Buffer.from(__PAGE__, 'base64');
const nialVoiceWindow=[];
let nialVoiceCalls=0,nialVoiceActive=0;
async function nialVoiceRoute(req,res,json){
 if(!['/voice','/voice/status','/voice/stt','/voice/tts'].includes(req.url))return false;
 // Private browser test only. Anonymous Android voice access remains blocked.
 if(!authorized(req)){json(403,{error:'Нужен закрытый вход сайта.'});return true;}
 if(req.method==='GET'&&req.url==='/voice'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Permissions-Policy':'microphone=(self)'});res.end(nialVoicePage);return true;}
 const enabled=process.env.NIAL_VOICE_ENABLED==='test'&&Boolean(process.env.YANDEX_SPEECHKIT_API_KEY);
 if(req.method==='GET'&&req.url==='/voice/status'){json(200,{enabled});return true;}
 if(!enabled){json(503,{error:'Голосовой тест ещё не включён на сервере.'});return true;}
 if(req.method!=='POST'||!['/voice/stt','/voice/tts'].includes(req.url)){json(405,{error:'Метод не поддерживается.'});return true;}
 if(req.headers.origin!==origin){json(403,{error:'Запрос разрешён только со страницы приложения.'});return true;}
 const stt=req.url==='/voice/stt',type=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
 if(type!==(stt?'application/octet-stream':'application/json')){json(415,{error:'Неверный формат запроса.'});return true;}
 const now=Date.now();while(nialVoiceWindow.length&&nialVoiceWindow[0]<=now-60000)nialVoiceWindow.shift();
 // These reset on cold start: NOT a durable or monetary budget.
 if(nialVoiceActive>=1||nialVoiceWindow.length>=10||nialVoiceCalls>=60){json(429,{error:'Достигнут лимит тестового сервера.'});return true;}
 nialVoiceActive++;
 try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(stt?MAX_AUDIO_BYTES:16000)){json(413,{error:'Слишком большой запрос.'});return true;}chunks.push(chunk);}const body=Buffer.concat(chunks);let text;
 if(stt){if(body.length<3200||body.length%2){json(400,{error:'Неверная PCM-запись.'});return true;}}
 else{let payload;try{payload=JSON.parse(body.toString('utf8'));}catch{json(400,{error:'Неверный JSON.'});return true;}text=payload?.text;if(typeof text!=='string'||!text.trim()||text.length>MAX_TEXT_CHARS){json(400,{error:'Неверная длина текста.'});return true;}}
 nialVoiceCalls++;nialVoiceWindow.push(Date.now());
 if(stt)json(200,{text:await recognizeSpeech(body)});else{const audio=await synthesizeSpeech(text);res.writeHead(200,{'Content-Type':'audio/mpeg','Content-Length':audio.length});res.end(audio);}
 }catch(error){if(!res.writableEnded)json(502,{error:error.message||'Ошибка речевого сервиса.'});}finally{nialVoiceActive--;}
 return true;
}
`.replace('__PAGE__',JSON.stringify(Buffer.from(html).toString('base64')));
 return source.replace(anchor,'  if (await nialVoiceRoute(req,res,json)) return;\n'+anchor)+'\n'+helpers+'\n'+runtime;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const path='netlify/server/index.mjs';
 const [source,speech,html]=await Promise.all([readFile(path,'utf8'),readFile('speechkit.mjs','utf8'),readFile('voice.html','utf8')]);
 await writeFile(path,installVoice(source,speech,html));
 execFileSync(process.execPath,['--check',path],{stdio:'inherit'});
}
