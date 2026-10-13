import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
test('real dev supervisor serves on the public port, injects reload, and rebuilds source edits within five seconds',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'timds-live-dev-'));
 await mkdir(path.join(root,'node_modules/.bin'),{recursive:true});await writeFile(path.join(root,'package.json'),'{}');await writeFile(path.join(root,'color.txt'),'blue');
 await Promise.all(Array.from({length:250},(_,index)=>mkdir(path.join(root,'node_modules',`dependency-${index}`,'nested'),{recursive:true})));
 const script=path.join(root,'node_modules/.bin/timds');await writeFile(script,`#!/usr/bin/env node\nconst http=require('node:http'),fs=require('node:fs');const color=fs.readFileSync('color.txt','utf8');http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html>'+color+'</html>');}).listen(Number(process.env.PORT),'127.0.0.1');`);await chmod(script,0o755);
 const devPort=await port(),livePort=await port(),url=`http://127.0.0.1:${livePort}`;
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../runtime/live-dev.mjs',import.meta.url))],{env:{...process.env,TIMDS_LIVE_ROOT:root,TIMDS_LIVE_STATUS_PATH:path.join(root,'.timds/status.json'),TIMDS_DEV_PORT:String(devPort),TIMDS_LIVE_PORT:String(livePort)},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null&&!child.signalCode){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}await rm(root,{recursive:true,force:true});});
 async function until(color,deadline){while(Date.now()<deadline){try{const response=await fetch(url);const text=await response.text();if(response.ok&&text.includes(color))return{response,text};}catch{}await pause(100);}throw new Error('Viewer did not update');}
 const first=await until('blue',Date.now()+10000);assert.match(first.text,/__timds_live\/version/);assert.equal(first.response.headers.get('x-robots-tag'),'noindex, nofollow, noarchive');
 const before=await(await fetch(`${url}/__timds_live/version`)).json();const start=Date.now();await writeFile(path.join(root,'color.txt'),'red');await until('red',start+5000);const after=await(await fetch(`${url}/__timds_live/version`)).json();assert.notEqual(before.version,after.version);assert.equal(after.ready,true);
 const {readFile}=await import('node:fs/promises');const statusPath=path.join(root,'.timds/status.json');assert.equal(JSON.parse(await readFile(statusPath,'utf8')).watchedDirectories,1,'dependency and generated directories open no source watchers');
 async function watched(count){const deadline=Date.now()+5000;while(Date.now()<deadline){if(JSON.parse(await readFile(statusPath,'utf8')).watchedDirectories===count)return;await pause(50);}assert.fail(`Expected ${count} source directory watchers`);}
 await mkdir(path.join(root,'new-source','nested'),{recursive:true});await writeFile(path.join(root,'new-source','nested','component.txt'),'new');await watched(3);
 await rm(path.join(root,'new-source'),{recursive:true});await watched(1);
 await mkdir(path.join(root,'new-source','nested'),{recursive:true});await writeFile(path.join(root,'new-source','nested','component.txt'),'recreated');await watched(3);
 const {symlink}=await import('node:fs/promises');await symlink(path.join(root,'node_modules'),path.join(root,'linked-dependencies'),'dir');await pause(300);await watched(3);
});


test('failed dev commands publish bounded private diagnostics and never show command output publicly',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'timds-live-failed-'));
 await mkdir(path.join(root,'node_modules/.bin'),{recursive:true});await writeFile(path.join(root,'package.json'),'{}');
 const script=path.join(root,'node_modules/.bin/timds');await writeFile(script,`#!/usr/bin/env node\nconsole.error('x'.repeat(20000));console.error('private-business-content Bearer secret-value');process.exit(7);`);await chmod(script,0o755);
 const devPort=await port(),livePort=await port(),url=`http://127.0.0.1:${livePort}`,statusPath=path.join(root,'.timds/status.json');
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../runtime/live-dev.mjs',import.meta.url))],{env:{...process.env,TIMDS_LIVE_ROOT:root,TIMDS_LIVE_STATUS_PATH:statusPath,TIMDS_DEV_PORT:String(devPort),TIMDS_LIVE_PORT:String(livePort)},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null&&!child.signalCode){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}await rm(root,{recursive:true,force:true});});
 let value;const deadline=Date.now()+10000;while(Date.now()<deadline){try{value=await(await fetch(`${url}/__timds_live/version`)).json();if(value.state==='failed')break;}catch{}await pause(100);}
 assert.equal(value.state,'failed');assert.equal(value.ready,false);assert.equal(JSON.stringify(value).includes('private-business-content'),false);
 const response=await fetch(url);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-business-content|secret-value|Preparing/);
 const {readFile}=await import('node:fs/promises');const diagnostic=JSON.parse(await readFile(statusPath,'utf8'));assert.equal(diagnostic.exitCode,7);assert.equal(diagnostic.reason,'process_exited');assert.ok(diagnostic.output.length<=8192);assert.match(diagnostic.output,/private-business-content/);assert.doesNotMatch(diagnostic.output,/secret-value/);
});

async function refreshFixture(t,{native=false,startupMs=120000,initialFailure=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),'timds-live-refresh-'));await mkdir(path.join(root,'node_modules/.bin'),{recursive:true});await mkdir(path.join(root,'.timds'));await mkdir(path.join(root,'nested'));
 await writeFile(path.join(root,'package.json'),'{}');await writeFile(path.join(root,'color.txt'),'blue');await writeFile(path.join(root,'config.txt'),'one');
 if(initialFailure)await writeFile(path.join(root,'.timds/fail'),'fail');
 await writeFile(path.join(root,'.gitignore'),'node_modules/\n.timds/\n/generated.css\ntracked.css\n');await writeFile(path.join(root,'tracked.css'),'tracked');await writeFile(path.join(root,'nested/.gitignore'),'generated.css\n');
 execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','-f','color.txt','tracked.css','nested/.gitignore'],{cwd:root});
 await writeFile(path.join(root,'timds.json'),JSON.stringify(native?{live:{strategy:'hmr',restartOn:['config.txt']}}:{}));
 const script=path.join(root,'node_modules/.bin/timds');await writeFile(script,`#!/usr/bin/env node
const http=require('node:http'),fs=require('node:fs');const count='.timds/starts';fs.writeFileSync(count,String(Number(fs.existsSync(count)?fs.readFileSync(count):0)+1));
const compile=()=>fs.writeFileSync('generated.css',fs.readFileSync('color.txt'));compile();
${native?"const delayed=()=>{if(fs.existsSync('.timds/compiler-hold'))return setTimeout(delayed,20);compile();};fs.watch('color.txt',()=>setTimeout(delayed,700));":''}
http.createServer((req,res)=>{const calls='.timds/requests';fs.writeFileSync(calls,String(Number(fs.existsSync(calls)?fs.readFileSync(calls):0)+1));res.statusCode=fs.existsSync('.timds/fail')?503:200;res.setHeader('Content-Type','text/html');res.end('<html>'+fs.readFileSync('generated.css')+'</html>');}).listen(Number(process.env.PORT),'127.0.0.1');`);await chmod(script,0o755);
 const devPort=await port(),livePort=await port(),url=`http://127.0.0.1:${livePort}`,statusPath=path.join(root,'.timds/status.json');
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../runtime/live-dev.mjs',import.meta.url))],{env:{...process.env,TIMDS_LIVE_ROOT:root,TIMDS_LIVE_STATUS_PATH:statusPath,TIMDS_LIVE_STARTUP_MS:String(startupMs),TIMDS_DEV_PORT:String(devPort),TIMDS_LIVE_PORT:String(livePort)},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null&&!child.signalCode){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}await rm(root,{recursive:true,force:true});});
 const until=async check=>{const deadline=Date.now()+5000;while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch{}await pause(40);}assert.fail('Refresh condition did not settle');};
 const version=async()=>fetch(url+'/__timds_live/version').then(r=>r.json()),starts=async()=>Number(await readFile(path.join(root,'.timds/starts'),'utf8'));
 if(initialFailure)await until(async()=>(await version()).state==='failed');
 else await until(async()=>{const r=await fetch(url);return r.ok&&(await r.text()).includes('blue');});
 return{root,url,statusPath,until,version,starts};
}

test('default refresh ignores generated output but preserves tracked ignored source and nested ignore edits',async t=>{
 const f=await refreshFixture(t);await pause(500);assert.equal(await f.starts(),1,'initial generated CSS must not cause a second startup');
 await writeFile(path.join(f.root,'color.txt'),'red');await f.until(async()=>{const r=await fetch(f.url);return r.ok&&(await r.text()).includes('red');});await pause(400);assert.equal(await f.starts(),2);
 await writeFile(path.join(f.root,'tracked.css'),'changed tracked source');await f.until(async()=>await f.starts()===3);
 await writeFile(path.join(f.root,'nested/generated.css'),'ignored');await pause(400);assert.equal(await f.starts(),3);
 await writeFile(path.join(f.root,'nested/.gitignore'),'');await f.until(async()=>await f.starts()===4);await f.until(async()=>(await f.version()).ready);await pause(150);
 await writeFile(path.join(f.root,'nested/generated.css'),'now authored');await f.until(async()=>await f.starts()===5);
});

test('native HMR retains the dev process and reloads again after delayed generated output; configs still restart',async t=>{
 const f=await refreshFixture(t,{native:true});await pause(300);const before=await f.version();
 await writeFile(path.join(f.root,'.timds/compiler-hold'),'hold');
 await writeFile(path.join(f.root,'color.txt'),'red');const early=await f.until(async()=>{const v=await f.version();return v.version!==before.version&&v;});
 assert.equal(await f.starts(),1);assert.match(await(await fetch(f.url)).text(),/blue/,'compiler is intentionally still pending');
 await rm(path.join(f.root,'.timds/compiler-hold'));
 await f.until(async()=>{const v=await f.version();return v.version!==early.version&&v.ready;});assert.match(await(await fetch(f.url)).text(),/red/);assert.equal(await f.starts(),1,'generated CSS updates the reload hint without restarting');
 await writeFile(path.join(f.root,'config.txt'),'two');await f.until(async()=>await f.starts()===2);await f.until(async()=>(await f.version()).ready);await pause(150);
 await writeFile(path.join(f.root,'package-lock.json'),'{}');await f.until(async()=>await f.starts()===3);
 await writeFile(path.join(f.root,'timds.json'),JSON.stringify({live:{strategy:'hmr',restartOn:['../outside']}}));await f.until(async()=>(await f.version()).state==='failed');assert.equal(JSON.parse(await readFile(f.statusPath,'utf8')).reason,'configuration_invalid');
});

test('native refresh failure has a deadline and a later source edit can recover',async t=>{
 const f=await refreshFixture(t,{native:true,startupMs:1000});await writeFile(path.join(f.root,'.timds/fail'),'fail');await writeFile(path.join(f.root,'color.txt'),'red');
 await f.until(async()=>(await f.version()).state==='failed');assert.equal(JSON.parse(await readFile(f.statusPath,'utf8')).reason,'refresh_timeout');
 const requests=await readFile(path.join(f.root,'.timds/requests'),'utf8');await pause(300);assert.equal(await readFile(path.join(f.root,'.timds/requests'),'utf8'),requests,'readiness probes stop after the bounded deadline');
 await rm(path.join(f.root,'.timds/fail'));await writeFile(path.join(f.root,'color.txt'),'green');await f.until(async()=>{const r=await fetch(f.url);return r.ok&&(await r.text()).includes('green');});assert.equal(await f.starts(),2);
});

test('an HTTP500 dev startup never becomes ready and a later source edit retries startup',async t=>{
 const f=await refreshFixture(t,{native:true,startupMs:1000,initialFailure:true});assert.equal((await f.version()).ready,false);assert.equal(JSON.parse(await readFile(f.statusPath,'utf8')).reason,'startup_timeout');
 await rm(path.join(f.root,'.timds/fail'));await writeFile(path.join(f.root,'color.txt'),'green');await f.until(async()=>{const r=await fetch(f.url);return r.ok&&(await r.text()).includes('green');});assert.equal(await f.starts(),2);
});
