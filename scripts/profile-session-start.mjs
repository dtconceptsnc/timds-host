// Opt-in Node preload: --import /absolute/path/to/profile-session-start.mjs.
// No requests or files are created by this module. It measures the real CLI's
// existing fetch calls without cloning, buffering or consuming their bodies.
import {performance} from 'node:perf_hooks';
const originalFetch=globalThis.fetch;
const now=()=>performance.now(),processElapsed=()=>Math.round(process.uptime()*1000);
let startAttempts=0,readAttempts=0,lastStartBodyAt=null,firstReadFinished=false;
function emit(stage,{operation,durationMs,outcome='ok',statusCode,attempt}={}){
 const value={timdsClientTiming:1,event:'session_start_client_step',stage,outcome,atUnixMs:Date.now(),processElapsedMs:processElapsed()};
 if(operation)value.operation=operation;
 if(Number.isFinite(durationMs))value.durationMs=Math.max(0,Math.round(durationMs));
 if(Number.isInteger(statusCode))value.statusCode=statusCode;
 if(Number.isInteger(attempt))value.attempt=attempt;
 process.stderr.write(JSON.stringify(value)+'\n');
}
function operationFor(input,options){
 try{
  const request=typeof Request==='function'&&input instanceof Request;
  const value=request?input.url:input instanceof URL?input.href:typeof input==='string'?input:null;
  if(!value)return null;
  const pathname=new URL(value).pathname,method=String(options?.method||(request?input.method:'GET')).toUpperCase();
  if(method==='POST'&&pathname==='/api/timds/sessions')return 'start';
  if(method==='GET'&&/^\/api\/timds\/sessions\/[a-f0-9-]{36}(?:\/snapshot)?$/i.test(pathname))return 'read';
 }catch{}
 return null;
}
emit('client-invoked');
globalThis.fetch=async function(input,options){
 const operation=operationFor(input,options);
 if(!operation)return originalFetch.apply(this,arguments);
 const attempt=operation==='start'?++startAttempts:++readAttempts,began=now();
 emit('request-dispatched',{operation,attempt,durationMs:processElapsed()});
 let response;
 try{response=await originalFetch.apply(this,arguments);}
 catch(error){emit('response-headers',{operation,attempt,durationMs:now()-began,outcome:'error'});throw error;}
 emit('response-headers',{operation,attempt,statusCode:response.status,durationMs:now()-began,outcome:response.ok?'ok':'error'});
 let finished=false;
 const finish=outcome=>{
  if(finished)return;finished=true;
  const ended=now();
  emit('response-body',{operation,attempt,statusCode:response.status,durationMs:ended-began,outcome:response.ok?outcome:'error'});
  if(outcome!=='ok'||!response.ok)return;
  if(operation==='start')lastStartBodyAt=ended;
  else if(!firstReadFinished){firstReadFinished=true;if(lastStartBodyAt!==null)emit('first-read-after-start',{operation,attempt,durationMs:ended-lastStartBodyAt});}
 };
 // The CLI consumes JSON. These convenience methods also cover tooling that
 // reads text/bytes; raw response.body readers are deliberately not intercepted.
 for(const method of ['json','text','arrayBuffer','blob','bytes','formData'])if(typeof response[method]==='function'){
  const read=response[method].bind(response);
  Object.defineProperty(response,method,{configurable:true,value:async(...args)=>{try{const value=await read(...args);finish('ok');return value;}catch(error){finish('error');throw error;}}});
 }
 return response;
};
process.once('exit',code=>emit('client-exit',{durationMs:processElapsed(),outcome:code===0?'ok':'error'}));
