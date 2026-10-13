// Trusted supervisor: serve the repo's dev server on the container interface,
// restart it after source edits, and reload browsers only after it is ready.
import {spawn,spawnSync} from 'node:child_process';
import {watch,readFileSync,readdirSync,lstatSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
const root = process.env.TIMDS_LIVE_ROOT || '/workspace/repo';
const devPort = Number(process.env.TIMDS_DEV_PORT || 4321), livePort = Number(process.env.TIMDS_LIVE_PORT || 8080);
const contents = new Map();
const statusPath=process.env.TIMDS_LIVE_STATUS_PATH || '/workspace/task/live-dev-status.json';
const startupMs=Number(process.env.TIMDS_LIVE_STARTUP_MS || 120_000);
let child, timer, reconcileTimer, restarting = false, pending = false, pendingRefresh = false, refreshEpoch = 0, generation = 0, ready = false, status={state:'starting'};
const changes=new Set();
const redact=value=>String(value).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@').replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi,'$1[redacted]');
function report(patch){status={...status,...patch};mkdirSync(dirname(statusPath),{recursive:true});writeFileSync(`${statusPath}.tmp`,JSON.stringify(status));renameSync(`${statusPath}.tmp`,statusPath);}
const ignored = /(^|\/)(?:\.git|node_modules|dist|\.timds|\.astro|\.vite|\.cache|media-local)(\/|$)/;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const mandatoryRestart=new Set(['timds.json','package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','.npmrc','tsconfig.json','jsconfig.json',...['astro','vite','next','svelte'].flatMap(name=>['js','cjs','mjs','ts','mts'].map(ext=>`${name}.config.${ext}`))]);
function liveConfig(){
  let manifest;try{manifest=JSON.parse(readFileSync(join(root,'timds.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(manifest.live===undefined||manifest.live===null)return null;
  const live=manifest.live;
  if(typeof live!=='object'||Array.isArray(live)||live.strategy!=='hmr'||!Array.isArray(live.restartOn)||live.restartOn.length>100||live.restartOn.some(file=>typeof file!=='string'||file.length>500||/[\\\x00-\x1f\x7f*?\[\]{}:]/.test(file)||file.startsWith('/')||file.split('/').some(part=>!part||part==='.'||part==='..')))throw Error('Invalid live configuration');
  return live;
}
function generatedPaths(files){
  // Normal check-ignore deliberately retains tracked files, even when a rule
  // matches them. Recompute every batch so nested ignore-rule edits take effect.
  const result=spawnSync('git',['check-ignore','-z','--stdin'],{cwd:root,input:files.join('\0')+'\0',encoding:'utf8',timeout:2000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','ignore'],env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  const output=new Set(result.status===0?result.stdout.split('\0').filter(Boolean):[]);
  try{const layout=JSON.parse(readFileSync(join(root,'.timds/contract-layout.json'),'utf8'));if(layout.schemaVersion===1)for(const file of layout.generated||[])if(['tokens.json','media.json'].includes(file))output.add(file);}catch{}
  return output;
}
async function refreshNative({deadline=Date.now()+startupMs,epoch=++refreshEpoch}={}){
  if(restarting){pendingRefresh=true;return;}
  if(!child||!ready){void restart();return;}
  try{const response=await fetch(`http://127.0.0.1:${devPort}/`,{signal:AbortSignal.timeout(Math.max(1,Math.min(1000,deadline-Date.now())))});await response.body?.cancel();if(epoch!==refreshEpoch)return;if(response.status>=500)throw Error('Dev server is not ready');if(ready){pendingRefresh=false;generation=Math.max(Date.now(),generation+1);report({state:'ready'});}}
  catch{if(epoch!==refreshEpoch||restarting)return;if(Date.now()>=deadline){ready=false;pendingRefresh=false;report({state:'failed',reason:'refresh_timeout'});return;}pendingRefresh=true;clearTimeout(timer);timer=setTimeout(()=>void refreshNative({deadline,epoch}),100);}
}
function flushChanges(){
  const files=[...changes];changes.clear();let live;
  try{live=liveConfig();}catch{ready=false;report({state:'failed',reason:'configuration_invalid'});return;}
  const generated=generatedPaths(files);
  if(live&&files.every(file=>!mandatoryRestart.has(file.split('/').at(-1))&&!live.restartOn.includes(file))){
    // Native dev watchers own compilation. Generated output still advances the
    // reload hint after a ready response, including delayed async compilers.
    void refreshNative();return;
  }
  if(files.some(file=>!generated.has(file)))void restart();
}
async function restart() {
  if (restarting) {pending = true;return;}
  try{liveConfig();}catch{ready=false;report({state:'failed',reason:'configuration_invalid'});return;}
  restarting = true; ready = false;refreshEpoch++;
  if(child) {try{process.kill(-child.pid,'SIGTERM');}catch{} await pause(200); try{process.kill(-child.pid,'SIGKILL');}catch{}}
  report({state:'starting',startedAt:new Date().toISOString(),output:'',exitCode:null,signal:null,reason:null});
  const current = child = spawn(join(root,'node_modules/.bin/timds'),['dev'],{cwd:root,env:{...process.env,PORT:String(devPort)},detached:true,stdio:['ignore','pipe','pipe']});
  const capture=data=>{if(child===current)report({output:redact(status.output+data.toString()).slice(-8192)});};
  current.stdout.on('data',capture);current.stderr.on('data',capture);
  current.on('error',error=>{if(child===current){ready=false;report({state:'failed',reason:error.code==='ENOENT'?'command_missing':'spawn_failed'});}});
  current.on('exit',(exitCode,signal)=>{if(child===current){ready=false;report({state:'failed',reason:status.reason==='startup_timeout'?'startup_timeout':'process_exited',exitCode,signal});}});
  const deadline=Date.now()+startupMs;
  while(Date.now()<deadline && status.state!=='failed') {
    await pause(100);
    try {const response=await fetch(`http://127.0.0.1:${devPort}/`,{signal:AbortSignal.timeout(500)});await response.body?.cancel();if(status.state==='failed')break;if(response.status>=500)continue;ready=true;generation=Date.now();report({state:'ready'});break;}catch{}
  }
  if(!ready && status.state!=='failed'){try{process.kill(-current.pid,'SIGKILL');}catch{}report({state:'failed',reason:'startup_timeout'});}
  restarting=false;
  if(pending){pending=false;pendingRefresh=false;void restart();}
  else if(pendingRefresh){pendingRefresh=false;if(ready)void refreshNative();}
}
const watchers=new Map();
function watchSources(){
  const directories=new Set();
  const visit=directory=>{let entries;try{entries=readdirSync(directory,{withFileTypes:true});}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return;throw error;}directories.add(directory);for(const item of entries)if(item.isDirectory()&&!ignored.test(relative(root,join(directory,item.name))))visit(join(directory,item.name));};
  visit(root);
  for(const [directory,watcher] of watchers)if(!directories.has(directory)){watcher.close();watchers.delete(directory);}
  for(const directory of directories)if(!watchers.has(directory)){try{watchers.set(directory,watch(directory,(_event,file)=>changed(file&&relative(root,join(directory,String(file))))));}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}}
  report({watchedDirectories:watchers.size});
}
function changed(file){
  if(!file || ignored.test(file))return;
  // Topology may change without changing the 'missing' file digest. Reconcile
  // before the content shortcut, including delete/recreate and rename races.
  clearTimeout(reconcileTimer);reconcileTimer=setTimeout(watchSources,100);
  let directory=watchers.has(join(root,file));try{directory ||= lstatSync(join(root,file)).isDirectory();}catch{}
  let digest;try{digest=createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex');}catch{digest='missing';}
  if(contents.get(file)===digest&&!directory)return;contents.set(file,digest);
  changes.add(file);refreshEpoch++;clearTimeout(timer);timer=setTimeout(flushChanges,100);
}
// A recursive fs.watch opens handles for node_modules before an event filter
// runs. Enumerate source directories first so dependency trees consume none.
watchSources();
const reload = `<script>(()=>{let v;setInterval(async()=>{if(document.hidden)return;try{const r=await fetch('/__timds_live/version',{cache:'no-store'});const j=await r.json();if(!j.ready)return;if(v!==undefined&&v!==j.version)location.reload();v=j.version;}catch{}},500)})();</script>`;
createServer((incoming,outgoing)=>{
  outgoing.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  outgoing.setHeader('Cache-Control','no-store');
  if(incoming.url==='/__timds_live/version'){outgoing.setHeader('Content-Type','application/json');outgoing.end(JSON.stringify({ready,version:generation,state:status.state}));return;}
  if(!ready){outgoing.writeHead(503,{'Retry-After':'2','Content-Type':'text/html'});outgoing.end(status.state==='failed'?'<!doctype html><p>Live preview could not start.</p>':'<!doctype html><meta http-equiv="refresh" content="2"><p>Preparing live preview…</p>');return;}
  const upstream=httpRequest({hostname:'127.0.0.1',port:devPort,path:incoming.url,method:incoming.method,headers:{...incoming.headers,host:`127.0.0.1:${devPort}`,'accept-encoding':'identity'}},response=>{
    const headers={...response.headers,'cache-control':'no-store','x-robots-tag':'noindex, nofollow, noarchive'};
    delete headers['content-length'];delete headers['content-security-policy'];
    outgoing.writeHead(response.statusCode,headers);
    if(String(headers['content-type']).includes('text/html')) {response.pipe(outgoing,{end:false});response.on('end',()=>outgoing.end(reload));} else response.pipe(outgoing);
  });
  upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end('Live preview is restarting');});incoming.pipe(upstream);
}).listen(livePort,'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{if(child)try{process.kill(-child.pid,'SIGKILL');}catch{}process.exit(0);});
void restart();
