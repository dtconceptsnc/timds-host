import { randomUUID } from 'node:crypto';
import {isFileTree,treeFiles} from './file-trees.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (statusCode,message) => Object.assign(new Error(message),{statusCode});
const methods = new Set(['provisionFiles','readSource','start','snapshot','stale','submit','update','mergeIntoDraft','history','close','merge','preparePublication','commitSource','pushMain','pushPublished','releaseCheckout','stagePublished','stageSource','removeSource']);
/** Native binding adapter. The coordinator injects its local authoritative store. */
export function createRepositoryAdapter({artifacts,store,getSandbox,snapshotBucket,ensurePreview=async()=>{},previewUrl=()=>'',deletePreview=async()=>{}}) {
  async function call(source,method,args=[],operationId=randomUUID()) {
    const response=await getSandbox(operationId).run(source.id,{operationId,method,source:{id:source.id,...(source.lifecycleOperationId?{lifecycleOperationId:source.lifecycleOperationId,lifecycleLease:source.lifecycleLease}:{})},args});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.ok!==true)throw Object.assign(fail(response.status===200?502:response.status,data.error?.message||'Hosted repository operation failed'),data.error?.conflicts?{conflicts:data.error.conflicts,mainRevision:data.error.mainRevision}:{});
    return data.result;
  }
  async function revoke(namespace,repository) { let tokens;try{tokens=await artifacts.listTokens(namespace,repository);}catch(error){if(error.statusCode===404)return;throw error;}for(const token of tokens)await artifacts.revokeToken(namespace,token.id); }
  async function control(input) {
    if(!methods.has(input?.method)||!uuid.test(input?.operationId||'')||!uuid.test(input?.source?.id||'')||input.coordinatorId!==input.source.id||!['prepare','complete','release'].includes(input.phase))throw fail(400,'Invalid repository control operation');
    let source;
    if(input.source.lifecycleOperationId) {
      if(!['provisionFiles','removeSource'].includes(input.method)||!uuid.test(input.source.lifecycleOperationId))throw fail(400,'Invalid lifecycle repository operation');
      const operation=await store.getLifecycleOperation(input.source.lifecycleOperationId);
      source=await store.getSource(input.source.id);
      const expected=input.method==='provisionFiles'?'provisioning':'deleting';
      if(!operation||operation.source_id!==input.source.id||operation.status!=='running'||operation.lease!==input.source.lifecycleLease||source?.lifecycle_status!==expected||!source.artifacts_namespace||!source.artifacts_repository)throw fail(409,'Lifecycle execution lease is unavailable');
      const receipt=operation.checkpoints_json?.repositoryReceipt;
      const repository=await artifacts.getRepository(source.artifacts_namespace,source.artifacts_repository);
      const expectedId=receipt?.id||source.artifacts_repository_id;
      if(!expectedId||receipt&&(receipt.namespace!==source.artifacts_namespace||receipt.repository!==source.artifacts_repository)||repository&&String(repository.id)!==String(expectedId)||!repository&&input.method!=='removeSource')throw fail(409,'Lifecycle repository identity changed');
      source={...source,artifacts_repository_id:expectedId};
    } else source=await store.getSource(input.source.id);
    if(!source?.artifacts_namespace||!source.artifacts_repository)throw fail(404,'Hosted source not found');
    const ns=source.artifacts_namespace, main=source.artifacts_repository, args=structuredClone(input.args||[]), caps=new Map();
    const add=(repository,permission='read')=>{if(caps.get(repository)!=='write')caps.set(repository,permission);};
    async function session(value,{closed=false}={}) { const row=await store.get(value?.id||value);if(!row||row.source_id!==source.id||row.fork_repository&&row.fork_repository!==`session-${row.id}`)throw fail(404,'Session repository not found');if(!closed&&['closing','closed','expired'].includes(row.status))throw fail(410,'Session closed');return {...row,fork_repository:`session-${row.id}`}; }
    async function submission(value) { const row=await store.getSubmission(value?.id);if(!row||row.source_id!==source.id)throw fail(404,'Submission repository not found');return row; }
    let fork, branches=[], result, origin='';
    if(input.method==='start') {
      const row=await session(args[0]?.sessionId), from=row.draft_session_id?await session(row.draft_session_id):null;
      fork=row.fork_repository;args[0]={sessionId:row.id,fromRepository:from?.fork_repository||main,fromRevision:row.origin_revision||null};
      if(input.phase==='prepare') {if(!await artifacts.getRepository(ns,fork))await artifacts.forkRepository(ns,fork,{sourceRepository:args[0].fromRepository});await revoke(ns,fork);}
      add(fork,'write');add(args[0].fromRepository);
    } else if(['snapshot','stale','submit','update','history','close','merge'].includes(input.method)) {
      args[0]=await session(args[0],{closed:['close','history'].includes(input.method)});fork=args[0].fork_repository;
      if(input.method==='history')result={commits:await artifacts.log(ns,['closing','closed','expired'].includes(args[0].status)?main:fork,{ref:'main',limit:50})};
      else if(input.method==='close') {branches=(await store.submissions(args[0].id)).map(row=>row.review_branch).filter(Boolean);args[1]={reviewBranches:branches};add(main,'write');}
      else {add(fork,['submit','update'].includes(input.method)?'write':'read');if(['submit','update'].includes(input.method)) {const target=args[0].draft_session_id?await session(args[0].draft_session_id):null;args[2]={...args[2],targetRepository:target?.fork_repository||main};add(args[2].targetRepository);}
        if(input.method==='submit') {const saved=await submission({id:args[2]?.submissionId});if(saved.session_id!==args[0].id||saved.review_branch!==args[2].reviewBranch)throw fail(409,'Submission identity changed');add(main,'write');if(input.phase==='prepare'){await ensurePreview(source);origin=new URL(await previewUrl(source,saved.review_branch)).origin;}}
        if(input.method==='merge'){args[1]=await submission(args[1]);add(main,'write');}
      }
    } else if(input.method==='mergeIntoDraft') {args[0]=await session(args[0]);if(args[0].kind!=='draft')throw fail(409,'Draft required');const candidate=args[1];args[1]=await submission(candidate);const child=await session(args[1].session_id);if(child.draft_session_id!==args[0].id)throw fail(409,'Submission does not target this draft');if(!args[1].head_commit&&args[1].status==='preparing'&&/^[a-f0-9]{40}$/.test(candidate.head_commit||''))args[1].head_commit=candidate.head_commit;add(args[0].fork_repository,'write');add(main);}
    else if(input.method==='preparePublication') {args[0]=await submission(args[0]);add(main);}
    else if(['provisionFiles','pushMain','pushPublished'].includes(input.method)){if(input.method==='provisionFiles'&&input.phase==='prepare')await revoke(ns,main);add(main,'write');}
    else if(input.method==='readSource')add(main);
    else if(input.method==='removeSource'&&input.phase==='prepare') {const repo=await artifacts.getRepository(ns,main);if(repo){if(!source.artifacts_repository_id||String(repo.id)!==String(source.artifacts_repository_id))throw fail(409,'Repository identity changed');await revoke(ns,main);await artifacts.deleteRepository(ns,main);}result={removed:true};}
    if(input.phase==='release') {for(const repository of caps.keys()){const tokens=await artifacts.listTokens(ns,repository).catch(error=>{if(error.statusCode===404)return[];throw error;});for(const token of tokens)if(input.tokenIds?.includes(token.id))await artifacts.revokeToken(ns,token.id);}return {released:true};}
    if(input.phase==='complete') {if(input.method==='close'){for(const branch of branches)await deletePreview(source,branch);await revoke(ns,fork);await artifacts.deleteRepository(ns,fork);}return {completed:true};}
    if(result!==undefined)return {repositories:[],result};
    const repositories=[];
    try {for(const [repository,permission] of caps) {const repo=await artifacts.getRepository(ns,repository);if(!repo?.remote)throw fail(409,'Artifacts repository unavailable');const token=await artifacts.mintToken(ns,repository,{permission,ttlSeconds:300});repositories.push({namespace:ns,repository,remote:repo.remote,permission,tokenId:token.id,token:token.token});}}
    catch(error){for(const repo of repositories)await artifacts.revokeToken(ns,repo.tokenId).catch(()=>{});throw error;}
    return {source,args,previewOrigin:origin,repositories};
  }
  const api={control};
  api.tokenFiles=async(source,session)=>{
    const result=await call(source,'snapshot',[session]);
    if(!isFileTree(result.files))return result.files.filter(file=>/^tokens\/.+\.json$/.test(file.path)||file.path==='tokens.json');
    const files=[];for await(const file of treeFiles(snapshotBucket,result.files,{filter:file=>/^tokens\/.+\.json$/.test(file.path)||file.path==='tokens.json'}))files.push(file);return files;
  };
  for(const method of methods)if(!['control','preparePublication','commitSource','pushMain','pushPublished','releaseCheckout','stagePublished','stageSource'].includes(method))api[method]=(source,...args)=>call(source,method,args);
  api.preparePublication=async(source,submission,resume={})=>{const checkoutId=randomUUID();return {...await call(source,'preparePublication',[submission,resume],checkoutId),checkoutId};};
  api.commitSource=async(source,checkoutId,input)=>{if(!isFileTree(input.files))return call(source,'commitSource',[input],checkoutId);await stageTree(source,checkoutId,input.files,'stageSource');return call(source,'commitSource',[{useStaged:true,message:input.message}],checkoutId);};
  api.pushMain=(source,checkoutId)=>call(source,'pushMain',[],checkoutId);
  api.releaseCheckout=(source,checkoutId)=>call(source,'releaseCheckout',[],checkoutId);
  async function stageTree(source,checkoutId,files,method){
    let batch=[],size=0,reset=true;
    const flush=async()=>{await call(source,method,[{reset,files:batch}],checkoutId);reset=false;batch=[];size=0;};
    const limit=8*1024*1024; // Base64 boundary; every native RPC stays below 32 MiB.
    for await(const file of isFileTree(files)?treeFiles(snapshotBucket,files):files){
      const content=typeof file.content==='string'&&file.encoding==='base64'?file.content:Buffer.from(file.content).toString('base64');
      for(let offset=0;offset<content.length||offset===0;offset+=limit){const part=content.slice(offset,offset+limit);if(size+part.length>limit&&batch.length)await flush();batch.push({path:file.path,encoding:'base64',content:part,offset});size+=part.length;}
    }
    await flush();
  }
  api.pushPublished=async(source,checkoutId,{files,stamp})=>{await stageTree(source,checkoutId,files,'stagePublished');return call(source,'pushPublished',[{stamp}],checkoutId);};
  return api;
}
