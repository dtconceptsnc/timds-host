import {portal} from './callback.mjs';
import {persistContainerTree} from '../src/repository/file-trees.mjs';
import {sessionIdPattern,validateRun} from './policy.mjs';
export const repositoryMethods=new Set(['provisionFiles','readSource','start','snapshot','stale','submit','update','mergeIntoDraft','history','close','merge','preparePublication','commitSource','pushMain','pushPublished','releaseCheckout','stagePublished','stageSource','removeSource']);
export function repositoryLivePushTarget(method,plan){
 if(!['update','submit','mergeIntoDraft'].includes(method))return null;
 const session=plan.args?.[0],namespace=plan.source?.artifacts_namespace;
 if(!sessionIdPattern.test(plan.source?.id||'')||typeof namespace!=='string'||!/^[a-zA-Z0-9._-]+$/.test(namespace)||!sessionIdPattern.test(session?.id||'')||session.source_id!==plan.source?.id||session.fork_repository!==`session-${session.id}`)return null;
 if(!plan.repositories?.some(repo=>repo.namespace===namespace&&repo.repository===session.fork_repository&&repo.permission==='write'))return null;
 return{sessionId:session.id,namespace,repository:session.fork_repository};
}
export async function repositoryPushNotification(request,props,notify){
 const url=new URL(request.url);if(url.origin!=='https://timds-repository.internal')return null;
 const target=props.livePushTarget;
 if(request.method!=='POST'||url.pathname!=='/fork-pushed'||url.search||url.hash||!target||!sessionIdPattern.test(target.sessionId||'')||target.repository!==`session-${target.sessionId}`||!props.repositories?.some(repo=>repo.namespace===target.namespace&&repo.repository===target.repository&&repo.permission==='write'))return new Response('Forbidden',{status:403});
 if(request.headers.get('Content-Type')!=='application/json')return new Response('Invalid event',{status:400});
 let event;
 try{const reader=request.body?.getReader(),chunks=[];let size=0;while(reader){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();return new Response('Event too large',{status:413});}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}event=JSON.parse(new TextDecoder().decode(bytes));}
 catch{return new Response('Invalid event',{status:400});}
 if(!event||Object.keys(event).length!==2||event.repository!==target.repository||typeof event.headCommit!=='string'||!/^[a-f0-9]{40}$/.test(event.headCommit)||/^0+$/.test(event.headCommit))return new Response('Invalid event',{status:400});
 // notify schedules work with waitUntil; it must not await the target DO lock.
 notify(target.sessionId,event.headCommit);
 return new Response(null,{status:202});
}
export function repositoryOutboundCredential(request,{repositories=[]}={}){
 const url=new URL(request.url);if(url.protocol!=='https:')return null;
 for(const repo of repositories){const remote=new URL(repo.remote);if(url.origin!==remote.origin)continue;
  const read=request.method==='GET'&&url.pathname===`${remote.pathname}/info/refs`&&url.search==='?service=git-upload-pack'||request.method==='POST'&&url.pathname===`${remote.pathname}/git-upload-pack`&&!url.search;
  const write=repo.permission==='write'&&(request.method==='GET'&&url.pathname===`${remote.pathname}/info/refs`&&url.search==='?service=git-receive-pack'||request.method==='POST'&&url.pathname===`${remote.pathname}/git-receive-pack`&&!url.search);
  if(read||write)return repo.token;
 }
 return null;
}
export function validateRepositoryCredentials(plan){
 if(!Array.isArray(plan?.repositories)||plan.repositories.length>4)throw new Error('Invalid repository capability plan');
 for(const repo of plan.repositories){validateRun({remote:repo.remote,repoToken:repo.token,baseRevision:'a'.repeat(40),prompt:'Trusted repository operation'});if(!['read','write'].includes(repo.permission))throw new Error('Invalid repository permission');}
 return plan;
}
export class RepositorySandboxRuntime{
 constructor(ctx,env,{portalCall=portal,snapshotBucket}={}){this.ctx=ctx;this.env=env;this.portal=portalCall;this.snapshotBucket=snapshotBucket;this.serial=Promise.resolve();}
 run(coordinatorId,input){const work=this.serial.then(()=>this.execute(coordinatorId,input));this.serial=work.catch(()=>{});return work;}
 async execute(coordinatorId,input){
  if(!sessionIdPattern.test(coordinatorId||'')||!sessionIdPattern.test(input?.operationId||'')||!repositoryMethods.has(input?.method))throw new Error('Invalid repository operation');
  const prior=this.ctx.storage.kv.get('operation');
  if(prior && (prior.coordinatorId!==coordinatorId||prior.sourceId!==input.source?.id||prior.operationId!==input.operationId))throw new Error('Repository operation identity changed');
  if(prior?.publication&&!['preparePublication','commitSource','stagePublished','stageSource','pushMain','pushPublished','releaseCheckout'].includes(input.method))throw new Error('Publication checkout is reserved');
  this.ctx.storage.kv.put('operation',{coordinatorId,sourceId:input.source.id,operationId:input.operationId,publication:prior?.publication||input.method==='preparePublication'});
  let plan,streaming=false;const deadline=Date.now()+10*60_000,signal=AbortSignal.timeout(10*60_000);
  try{
   const response=await this.portal(this.env,'repository-control',{...input,coordinatorId,phase:'prepare'});if(!response.ok)return response;
   plan=await response.json();validateRepositoryCredentials(plan);
   if(plan.result!==undefined)return Response.json({ok:true,result:plan.result});
   const container=this.ctx.container;
   if(!container)throw new Error('Repository container unavailable');
   if(!container.running){container.start({image:container.images.repository,instance:'standard-1',enableInternet:false});await container.exec(['node','/usr/local/lib/timds-repository/repository-daemon.mjs'],{cwd:'/workspace',env:{NODE_EXTRA_CA_CERTS:'/etc/cloudflare/certs/cloudflare-containers-ca.crt',GIT_SSL_CAINFO:'/etc/cloudflare/certs/cloudflare-containers-ca.crt'},stdout:'ignore',stderr:'ignore'});}
   await container.setInactivityTimeout(20*60_000);await this.ctx.storage.setAlarm(Date.now()+20*60_000);
   const outbound=this.ctx.exports.RepositoryOutbound({props:{repositories:plan.repositories,livePushTarget:repositoryLivePushTarget(input.method,plan)}});
   await container.interceptAllOutboundHttp(outbound);await container.interceptOutboundHttps('*',outbound);
   const port=container.getTcpPort(8081),readinessDeadline=Date.now()+15_000;let ready=false;
   while(Date.now()<readinessDeadline){try{const probe=await port.fetch('http://repository/health',{signal:AbortSignal.timeout(1000)});await probe.body?.cancel();ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
   if(!ready)throw new Error('Repository service did not start');
   // Deliberately strip tokens before crossing the container boundary.
   const payload={...(this.snapshotBucket?{transport:'references'}:{}),method:input.method,source:plan.source,args:plan.args||input.args||[],previewOrigin:plan.previewOrigin,repositories:plan.repositories.map(({namespace,repository,remote})=>({namespace,repository,remote}))};
   const result=await port.fetch('http://repository/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
   if(result.ok){const finished=await this.portal(this.env,'repository-control',{...input,coordinatorId,phase:'complete'});if(!finished.ok){await result.body?.cancel();return finished;}}
   if(this.snapshotBucket&&result.ok){
    const data=await result.json();
    for(const role of ['files','priorFiles'])if(data.result?.[role]?.kind==='timds-container-tree'){
     const descriptor=data.result[role];
     data.result[role]=await persistContainerTree(this.snapshotBucket,{sourceId:input.source.id,operationId:input.operationId,role:`${input.method}-${role}`,manifest:descriptor.manifest,deadline,readFile:index=>port.fetch(`http://repository/trees/${role}/${index}`,{signal})});
    }
    return Response.json(data);
   }
   const retain=['preparePublication','commitSource','stagePublished','stageSource','pushMain','pushPublished'].includes(input.method);
   if(retain)return result;
   // Never JSON-buffer a 50 MiB snapshot in the Worker's 128 MiB heap. Keep
   // its service container alive until the RPC response stream drains/cancels.
   const reader=result.body?.getReader(),runtime=this;streaming=true;
   return new Response(new ReadableStream({
    async pull(controller){try{const item=reader?await reader.read():{done:true};if(item.done){await runtime.close();controller.close();}else controller.enqueue(item.value);}catch(error){await runtime.close();controller.error(error);}},
    async cancel(reason){try{await reader?.cancel(reason);}finally{await runtime.close();}}
   }),result);
  }finally{
   if(plan?.repositories?.length)await this.portal(this.env,'repository-control',{...input,coordinatorId,phase:'release',tokenIds:plan.repositories.map(repo=>repo.tokenId)}).catch(()=>{});
   // Publications retain only credential-free Git objects between bounded RPCs.
   if(!streaming&&!['preparePublication','commitSource','stagePublished','stageSource','pushMain','pushPublished'].includes(input.method))await this.close();
  }
 }
 async close(){await this.ctx.storage.deleteAlarm();if(this.ctx.container?.running)await this.ctx.container.destroy();return{closed:true};}
 async alarm(){return this.close();}
}
