import {portal} from './callback.mjs';
import {validateRun,sessionIdPattern,safeTaskDiagnostics} from './policy.mjs';
const idleMs=10*60_000, taskMs=12*60_000;
const ca='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const trust={NODE_EXTRA_CA_CERTS:ca,GIT_SSL_CAINFO:ca,CURL_CA_BUNDLE:ca,SSL_CERT_FILE:ca};
const active=run=>run && ['starting','running','submitting'].includes(run.state);
const commandFailureReason=bytes=>{
  const value=typeof bytes==='string'?bytes:new TextDecoder().decode(bytes||new Uint8Array());
  const patterns=[['authentication',/authentication failed|could not read username|access denied/i],['tls',/certificate|ssl connect|tls/i],['dns',/could not resolve|name or service not known/i],['ownership',/dubious ownership|unsafe repository/i],['permission',/permission denied|operation not permitted/i],['git-lock',/unable to create.*\.lock|another git process|cannot lock ref|unable to lock/i],['not-repository',/not a git repository/i],['remote-ref',/not our ref|couldn't find remote ref|could not find remote ref/i],['missing-object',/bad object|missing.*object|object.*missing|invalid object/i],['shallow',/shallow/i],['pack',/index-pack|unpack|packfile|pack has|bad pack/i],['protocol',/protocol error|expected.*(?:pack|ack|flush)|invalid.*(?:packet|response)|early eof|remote end hung up|rpc failed/i],['disk',/no space left|disk quota/i]];
  return patterns.find(([,pattern])=>pattern.test(value))?.[0]||'unknown';
};
const packFailureDetails=bytes=>{
  const value=typeof bytes==='string'?bytes:new TextDecoder().decode(bytes||new Uint8Array());
  return [['unresolved-deltas',/unresolved deltas/i],['invalid-header',/(?:bad|invalid).*pack.*header|pack.*(?:bad|invalid).*header/i],['checksum',/checksum|hash mismatch|sha1 mismatch|sha-1 mismatch/i],['missing-base',/missing.*(?:delta|base)|(?:delta|base).*missing|cannot resolve.*delta/i],['early-eof',/early eof|premature end|unexpected end/i],['inflate',/inflate|zlib/i],['index-pack',/index-pack/i],['unpack-objects',/unpack-objects/i],['pack-objects',/pack-objects/i],['missing-objects',/did not send all necessary objects|missing.*object/i]].filter(([,pattern])=>pattern.test(value)).map(([name])=>name);
};
const startupDiagnostic=error=>/^Live sandbox command failed \((?:git-(?:clone|fetch|reset|rev-parse)|npm-ci|mkdir|rm|unknown); exit (?:-?\d+|unknown)\)$/.test(error?.message||'')?error.message:['Live credential unavailable','Live supervisor did not become ready'].includes(error?.message)?error.message:'Live startup failed';
/** SDK-independent orchestration, also exercised with a fake container in Node. */
export class LiveSessionRuntime {
  constructor(ctx,env,{Files,SandboxFileError,portalCall=portal}) {
    this.ctx=ctx;this.env=env;this.portal=portalCall;this.Files=Files;this.FileError=SandboxFileError;this.serial=Promise.resolve();
    if(ctx.container?.running) void ctx.blockConcurrencyWhile(()=>ctx.container.setInactivityTimeout(this.idleTimeout()));
  }
  locked(fn){const next=this.serial.then(fn);this.serial=next.catch(()=>{});return next;}
  record(){return this.ctx.storage.kv.get('live');}
  idleTimeout(){return this.record()?.idleTimeoutMs||idleMs;}
  run(){return this.ctx.storage.kv.get('task');}
  save(patch){const value={...this.record(),...patch};this.ctx.storage.kv.put('live',value);return value;}
  async schedule(at){const expires=Date.parse(this.record()?.expiresAt);await this.ctx.storage.setAlarm(Number.isFinite(expires)?Math.min(at,expires):at);}
  async touch(){this.save({lastActivityAt:Date.now()});if(!active(this.run()))await this.schedule(Date.now()+this.idleTimeout());}
  // requestId names the Request a running/failed task belongs to; the host verifies its binding.
  async report(state,requestId){this.save({state});try{await this.portal(this.env,'live-state',{sessionId:this.record().id,state,...(requestId?{requestId}:{})});}catch{}}
  assertOpen(){const live=this.record();if(!live || ['closed','closing'].includes(live.state) || (live.expiresAt && Date.parse(live.expiresAt)<=Date.now()))throw Object.assign(new Error('Live session is closed'),{status:410});return live;}
  status(){const live=this.record(),run=this.run();return{state:['closed','closing'].includes(live?.state)?live.state:!this.ctx.container?.running?'sleeping':live?.state||'none',runner:run?{requestId:run.requestId,state:run.state,...(run.submissionId?{submissionId:run.submissionId}:{}),...(run.error?{error:run.error}:{}),...(run.diagnostics?{diagnostics:safeTaskDiagnostics(run.diagnostics)}:{}),...(run.conflicts?{conflicts:run.conflicts}:{})}:null};}
  async configure(id,{expiresAt=null,idleTimeoutMs,interruptCleanupOnce}={}){if(!sessionIdPattern.test(id))throw new Error('Invalid session');if(['closed','closing'].includes(this.record()?.state))throw Object.assign(new Error('Closed'),{status:410});if(expiresAt!==null&&!Number.isFinite(Date.parse(expiresAt)))throw new Error('Invalid expiry');if(idleTimeoutMs!==undefined&&(!Number.isInteger(idleTimeoutMs)||idleTimeoutMs<60_000||idleTimeoutMs>idleMs))throw new Error('Idle timeout must be between one and ten minutes');if(interruptCleanupOnce!==undefined&&typeof interruptCleanupOnce!=='boolean')throw new Error('Invalid cleanup interruption');if(interruptCleanupOnce&&(!expiresAt||!this.ctx.container?.running))throw new Error('Cleanup interruption requires a running finite session');this.save({id,expiresAt,...(idleTimeoutMs===undefined?{}:{idleTimeoutMs}),...(interruptCleanupOnce===undefined?{}:{interruptCleanupOnce}),state:this.record()?.state||'sleeping'});if(this.ctx.container?.running)await this.ctx.container.setInactivityTimeout(this.idleTimeout());if(active(this.run())||this.ctx.container?.running||expiresAt)await this.schedule(active(this.run())?Date.now()+1000:this.ctx.container?.running?Date.now()+this.idleTimeout():Date.parse(expiresAt));else await this.ctx.storage.deleteAlarm();return this.status();}
  async command(args,cwd='/workspace'){
    const result=await(await this.ctx.container.exec(args,{cwd,env:trust})).output();
    if(result.exitCode!==0){
      // Classify only our fixed command prefix. Arguments and process output
      // can contain source content or credentials and must never enter logs.
      const git=args[0]==='git'?(args[1]==='-c'?args[3]:args[1]):null;
      const phase=['clone','fetch','reset','rev-parse'].includes(git)?`git-${git}`:args[0]==='npm'&&args[1]==='ci'?'npm-ci':args[0]==='mkdir'?'mkdir':args[0]==='rm'?'rm':'unknown';
      const exitCode=Number.isInteger(result.exitCode)?result.exitCode:'unknown';
      this.save({commandFailure:{phase,exitCode,reason:commandFailureReason(result.stderr),packDetails:packFailureDetails(result.stderr)}});
      throw new Error(`Live sandbox command failed (${phase}; exit ${exitCode})`);
    }
    return result;
  }
  async credential(){const live=this.assertOpen();const response=await this.portal(this.env,'live-credentials',{sessionId:live.id});if(!response.ok)throw Object.assign(new Error('Live credential unavailable'),{status:response.status});const input=await response.json();const run=validateRun({...input,prompt:'Restore live session'});this.save({expiresAt:input.expiresAt??null});return run;}
  async intercept(run){const outbound=this.ctx.exports.Outbound({props:{remote:run.remote,repoToken:run.repoToken,allowDependencies:true}});await this.ctx.container.interceptAllOutboundHttp(outbound);await this.ctx.container.interceptOutboundHttps('*',outbound);}
  async ensureServer(){
    const port=this.ctx.container.getTcpPort(8080);
    const probe=async()=>{const response=await port.fetch('http://container/__timds_live/version',{signal:AbortSignal.timeout(1000)});const status=await response.json(),state=status.ready?'ready':status.state==='failed'?'failed':'starting';if(!active(this.run())&&this.record()?.state!==state)await this.report(state);};
    try{await probe();return;}catch{}
    // Keep the supervisor independent of the request's exec process group.
    await this.ctx.container.exec(['/bin/sh','-c','setsid node /usr/local/lib/timds-live-dev.mjs >/workspace/task/live-dev.log 2>&1'],{cwd:'/workspace/repo',env:{...trust,PORT:'4321'},stdout:'ignore',stderr:'ignore'});
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline){try{await probe();return;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
    throw new Error('Live supervisor did not become ready');
  }
  async wake(){
    this.assertOpen();const container=this.ctx.container;if(!container)throw new Error('Missing live container');
    if(container.running){if(this.record().pendingPush&&!active(this.run()))await this.sync();await this.ensureServer();return;}
    try {
    this.save({startupError:null,restoredRevision:null,syncedRevision:null});await this.report('starting');const credential=await this.credential();
    container.start({image:container.images.agent,instance:'standard-1',enableInternet:false});await container.setInactivityTimeout(this.idleTimeout());await this.intercept(credential);
    // Artifacts forks retain the source repository's default HEAD, which may
    // name a historical publishing branch. Live work always follows main.
    await this.command(['git','-c','protocol.version=1','clone','--branch','main','--single-branch','--',''+credential.remote,'/workspace/repo']);
    const head=(await this.command(['git','rev-parse','HEAD'],'/workspace/repo')).stdout;
    const restoredRevision=(typeof head==='string'?head:new TextDecoder().decode(head)).trim();
    if(!/^[a-f0-9]{40}$/.test(restoredRevision))throw new Error('Invalid restored live head');
    this.save({restoredRevision,syncedRevision:restoredRevision});
    await this.command(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],'/workspace/repo');
    await this.command(['mkdir','-p','/workspace/task']);
    await this.ensureServer();
    await this.touch();
    }catch(error){this.save({startupError:startupDiagnostic(error)});if(container.running)await container.destroy();await this.report('failed');throw error;}
  }
  async sync(revision){
    this.assertOpen();
    if(!this.ctx.container?.running)return {state:'sleeping'};
    if(active(this.run())){this.save({pendingPush:true});return{state:'running',deferred:true};}
    if(revision&&this.record().syncedRevision===revision&&!this.record().pendingPush)return{...this.status(),duplicate:true};
    const credential=await this.credential();await this.intercept(credential);
    // Artifacts v1 incremental packs can have an invalid header even when the
    // local clone is connected. Its supported v2 fetch preserves incremental sync.
    try{await this.command(['git','-c','protocol.version=2','fetch','--no-tags','origin','main'],'/workspace/repo');}
    catch(error){const origin=await(await this.ctx.container.exec(['git','remote','get-url','origin'],{cwd:'/workspace/repo',env:trust})).output();this.save({originMatches:origin.exitCode===0&&(typeof origin.stdout==='string'?origin.stdout:new TextDecoder().decode(origin.stdout)).trim()===credential.remote});throw error;}
    await this.command(['git','reset','--hard','origin/main'],'/workspace/repo');
    const output=(await this.command(['git','rev-parse','HEAD'],'/workspace/repo')).stdout;
    const syncedRevision=(typeof output==='string'?output:new TextDecoder().decode(output)).trim();
    if(!/^[a-f0-9]{40}$/.test(syncedRevision))throw new Error('Invalid synchronized live head');
    this.save({pendingPush:false,syncedRevision});await this.touch();return this.status();
  }
  async pushed(input={}){const revision=input?.revision;if(revision!==undefined&&(typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||/^0+$/.test(revision)))throw new Error('Invalid pushed revision');return this.locked(()=>this.sync(revision));}
  async start(id,input){return this.locked(async()=>{
    this.assertOpen();const prior=this.run();
    if(prior?.requestId===input.requestId)return this.status();
    if(active(prior))throw Object.assign(new Error('Another Request is running in this session'),{status:409});
    if(!sessionIdPattern.test(input.requestId||''))throw new Error('Invalid Request');
    if(typeof this.env.MODEL!=='string'||!this.env.MODEL.trim()||this.env.MODEL.length>100)throw Object.assign(new Error('Designer model is not configured'),{statusCode:503});
    const run=validateRun(input,{maxPromptBytes:48*1024});await this.wake();await this.sync();
    const output=(await this.command(['git','rev-parse','HEAD'],'/workspace/repo')).stdout;
    const revision=(typeof output==='string'?output:new TextDecoder().decode(output)).trim();
    if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('Invalid live head');
    // Persist no repository credential. The task sees only its prompt and revision.
    this.ctx.storage.kv.put('task',{requestId:input.requestId,note:input.note||run.prompt.slice(0,2000),state:'starting',startedAt:Date.now()});
    await this.command(['rm','-f','/workspace/task/result.json','/workspace/task/progress.json']);
    await this.ctx.container.exec(['/bin/sh','-c','setsid node /usr/local/lib/timds-agent.mjs "$@" >/workspace/task/stdout.log 2>/workspace/task/stderr.log','agent',revision,this.env.MODEL,run.prompt],{cwd:'/workspace/repo',env:trust,stdout:'ignore',stderr:'ignore'});
    this.ctx.storage.kv.put('task',{...this.run(),state:'running'});await this.report('running',input.requestId);await this.schedule(Date.now()+1000);return this.status();
  });}
  async diagnostics(input){
    if(input?.fetchProbe!==undefined)return this.locked(async()=>{
      const modes={'v1-index-pack':['-c','protocol.version=1','-c','fetch.unpackLimit=1','fetch','--no-tags','origin','main'],'v2':['-c','protocol.version=2','fetch','--no-tags','origin','main'],'refetch':['-c','protocol.version=1','fetch','--no-tags','--refetch','origin','main']};
      if(typeof input.fetchProbe!=='string'||!Object.hasOwn(modes,input.fetchProbe))throw new Error('Unsupported fetch diagnostic');
      this.assertOpen();if(active(this.run())||!this.ctx.container?.running)throw Object.assign(new Error('Fetch diagnostic requires an idle running session'),{status:409});
      await this.intercept(await this.credential());const started=Date.now();
      const output=await(await this.ctx.container.exec(['git',...modes[input.fetchProbe]],{cwd:'/workspace/repo',env:trust})).output();
      const probe={mode:input.fetchProbe,ok:output.exitCode===0,elapsedMs:Date.now()-started,exitCode:Number.isInteger(output.exitCode)?output.exitCode:null,...(output.exitCode===0?{}:{reason:commandFailureReason(output.stderr),packDetails:packFailureDetails(output.stderr)})};
      this.save({fetchProbe:probe});await this.touch();return this.diagnostics();
    });
    const result={...this.status(),...(this.record()?.restoredRevision?{restoredRevision:this.record().restoredRevision}:{}),...(this.record()?.startupError?{startupError:this.record().startupError}:{}),...(this.record()?.commandFailure?{commandFailure:this.record().commandFailure}:{}),...(typeof this.record()?.originMatches==='boolean'?{originMatches:this.record().originMatches}:{})};if(!this.ctx.container?.running)return result;
    if(this.record()?.fetchProbe)result.fetchProbe=this.record().fetchProbe;
    if(this.record()?.commandFailure?.reason==='pack'&&!active(this.run())){const checked=await(await this.ctx.container.exec(['git','fsck','--connectivity-only','--no-reflogs'],{cwd:'/workspace/repo',env:trust})).output();result.connectivityOk=checked.exitCode===0;}
    try{const file=await new this.Files(this.ctx.container).readFile('/workspace/task/live-dev-status.json');if(file.size>16*1024)return result;const value=JSON.parse(await file.text());
      let output=String(value.output||'').slice(-8192);for(const secret of [this.env.TIMDS_SANDBOX_RUNNER_TOKEN,this.env.OPENAI_API_KEY].filter(Boolean))output=output.replaceAll(secret,'[redacted]');output=output.replace(/Bearer\s+\S+/gi,'Bearer [redacted]');
      result.dev={state:['starting','ready','failed'].includes(value.state)?value.state:'unknown',reason:['command_missing','spawn_failed','process_exited','startup_timeout','configuration_invalid','refresh_timeout'].includes(value.reason)?value.reason:null,exitCode:Number.isInteger(value.exitCode)?value.exitCode:null,signal:['SIGTERM','SIGKILL','SIGABRT','SIGSEGV'].includes(value.signal)?value.signal:null,output};
    }catch{}return result;
  }
  async retryCompletion({requestId}={}){return this.locked(async()=>{
    this.assertOpen();const run=this.run();
    if(!sessionIdPattern.test(requestId||'')||run?.requestId!==requestId||run.state!=='conflicted'||run.conflicts?.length||run.completionRecoveryUsed||!this.ctx.container?.running)throw Object.assign(new Error('This Request has no recoverable completion'),{status:409});
    const result=JSON.parse(await(await new this.Files(this.ctx.container).readFile('/workspace/task/result.json')).text());
    if(result.state!=='succeeded'||!result.changeSet)throw Object.assign(new Error('This Request has no saved successful result'),{status:409});
    // Reuse only the immutable saved model result and original Request identity.
    // The normal callback reauthorizes and reruns all stale/merge checks.
    this.ctx.storage.kv.put('task',{...run,state:'submitting',error:undefined,completionRecoveryUsed:true,completionStartedAt:Date.now()});
    await this.report('running');await this.schedule(Date.now()+1000);return this.status();
  });}
  async alarm(){
    const expired=this.record();
    if(expired?.state==='closed'&&!expired.cleanupPending)return;
    if(expired?.cleanupPending||expired?.expiresAt&&Date.parse(expired.expiresAt)<=Date.now()) {
      // Do not hold the local task lock across a callback that closes this DO.
      await this.destroyForCleanup();
      try {const response=await this.portal(this.env,'expired',{sessionId:expired.id});if(response.ok||[404,410].includes(response.status)){await this.close();return;}}catch{}
      // A publication lease may still own the session. Retry its bounded cleanup.
      await this.ctx.storage.setAlarm(Date.now()+30_000);return;
    }
    return this.locked(async()=>{
    const run=this.run();if(!active(run)){const live=this.record();if(live?.state==='closed')return;if(Date.now()-(live?.lastActivityAt||0)>=this.idleTimeout()){if(this.ctx.container?.running)await this.ctx.container.destroy();await this.report('sleeping');if(live?.expiresAt)await this.ctx.storage.setAlarm(Date.parse(live.expiresAt));}else await this.schedule(live.lastActivityAt+this.idleTimeout());return;}
    let taskDiagnostics;
    try{
      this.assertOpen();if(!this.ctx.container?.running||Date.now()-(run.state==='submitting'?run.completionStartedAt||run.startedAt:run.startedAt)>taskMs)throw new Error('Task stopped');
      let result;
      try{const file=await new this.Files(this.ctx.container).readFile('/workspace/task/result.json');result=JSON.parse(await file.text());}catch(error){if(!this.FileError.is(error)||error.code!=='ENOENT')throw error;}
      if(result){
        taskDiagnostics=safeTaskDiagnostics(result.diagnostics);
        if(result.state!=='succeeded')throw new Error('Task failed');
        this.ctx.storage.kv.put('task',{...run,state:'submitting',completionStartedAt:run.completionStartedAt||Date.now(),diagnostics:safeTaskDiagnostics(result.diagnostics)});
        let response;
        try{response=await this.portal(this.env,'complete',{sessionId:this.record().id,requestId:run.requestId,changeSet:{...result.changeSet,note:run.note}});}
        catch{await this.schedule(Date.now()+1000);return;}
        if(response.status===410||response.status===404){await this.close();return;}
        if(response.ok){const saved=await response.json();if(saved.state==='conflicted'){this.ctx.storage.kv.put('task',{...run,state:'conflicted',conflicts:saved.conflicts||[],error:'This Request overlaps a newer edit. Start a follow-up Request to resolve it.'});await this.report('ready');await this.touch();return;}this.ctx.storage.kv.put('task',{...run,state:'submitted',submissionId:saved.submissionId});await this.report('ready');try{await this.sync();}catch{this.save({pendingPush:true});await this.touch();}return;}
        if(response.status===409){
          const rejected=await response.json().catch(()=>null);
          if(rejected?.error==='This session is busy; retry when its current operation finishes'){await this.schedule(Date.now()+1000);return;}
          this.ctx.storage.kv.put('task',{...run,state:'conflicted',...(Array.isArray(rejected?.conflicts)?{conflicts:rejected.conflicts}:{}),error:'This Request overlaps a newer edit. Start a follow-up Request to resolve it.'});await this.report('ready');await this.touch();return;
        }
        if(response.status<500&&response.status!==429)throw new Error('Submission rejected');
      }
      await this.schedule(Date.now()+1000);
    }catch{this.ctx.storage.kv.put('task',{...run,state:'failed',...(taskDiagnostics?{diagnostics:taskDiagnostics}:{}),error:'The Request failed or exceeded its time limit'});if(this.ctx.container?.running)await this.ctx.container.destroy();await this.report('failed',run.requestId);if(this.record()?.expiresAt)await this.ctx.storage.setAlarm(Date.parse(this.record().expiresAt));}
  });}
  async fetch(request){
    let phase='wake';
    try{await this.locked(async()=>{await this.wake();await this.touch();});phase='forward';const url=new URL(request.url);url.protocol='http:';url.host='container';const headers=new Headers(request.headers);headers.delete('host');headers.delete('authorization');headers.delete('cookie');headers.delete('x-timds-live-session');
      const response=await this.ctx.container.getTcpPort(8080).fetch(new Request(url,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));
      const safe=new Response(response.body,response);safe.headers.set('X-Robots-Tag','noindex, nofollow, noarchive');safe.headers.set('Cache-Control','no-store');return safe;
    }catch(error){if(error.status!==410)console.warn({stage:'live-fetch',phase,sessionId:this.record()?.id,error:phase==='forward'?String(error.message).slice(0,300):startupDiagnostic(error)});return new Response(error.status===410?'Live session is closed':'Live preview is starting; refresh shortly',{status:error.status===410?410:503,headers:{'X-Robots-Tag':'noindex, nofollow, noarchive','Retry-After':'2'}});}
  }
  async destroyForCleanup(){
    const interrupt=this.record()?.interruptCleanupOnce===true, running=this.ctx.container?.running;
    if(interrupt){
      // Internal acceptance control only: consume durably before the real kill.
      this.save({interruptCleanupOnce:false,cleanupPending:true,state:'closing'});
      await this.ctx.storage.setAlarm(Date.now()+30_000);
    }
    if(running)await this.ctx.container.destroy();
    if(interrupt&&running){console.info({stage:'cleanup',sessionId:this.record().id,intentionalInterruption:true});throw Object.assign(new Error('Intentional cleanup interruption after container destruction'),{statusCode:503});}
  }
  async beginClose(id=this.record()?.id){
    if(!sessionIdPattern.test(id||''))throw new Error('Invalid closing session');
    if(this.record()?.state==='closed')return{state:'closed'};
    this.ctx.storage.kv.delete('task');this.save({id,state:'closing',cleanupPending:true});
    await this.ctx.storage.setAlarm(Date.now()+30_000);await this.destroyForCleanup();
    return{state:'closing'};
  }
  async close(){await this.ctx.storage.deleteAlarm();if(this.ctx.container?.running)await this.ctx.container.destroy();this.ctx.storage.kv.delete('task');this.save({state:'closed',cleanupPending:false});return{state:'closed'};}
}
