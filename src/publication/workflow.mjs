import {WorkflowEntrypoint} from 'cloudflare:workers';
import {NonRetryableError} from 'cloudflare:workflows';
import {createRepositoryAdapter} from '../repository/adapter.mjs';
import {publishReleaseTree} from './releases.mjs';
import {createPublicationArtifactStore} from './artifacts.mjs';
import {createPublicationSteps,PUBLICATION_STAGES} from './steps.mjs';
import {publicUrls} from './urls.mjs';
import {verifyPublishedRead} from './public-read.mjs';
import {unwrapNativeBuildResult,finishCleanup,safeRequestDiagnostic} from '../requests/diagnostics.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function publicationStoreProxy(coordinator){return new Proxy({}, {get:(_target,name)=>(...args)=>coordinator.publicationStore(name,args)});}
export function publicationServices(ctx,env,coordinator,lease){
 const store=publicationStoreProxy(coordinator),repository=createRepositoryAdapter({store,getSandbox:id=>ctx.exports.RepositorySandbox.getByName(id),snapshotBucket:env.SNAPSHOTS});
 return createPublicationSteps({store,repository,lease,artifacts:createPublicationArtifactStore(env.SNAPSHOTS),metadata:input=>unwrapNativeBuildResult(ctx.exports.BuildSandbox.getByName(`metadata:${input.publicationId}`).metadata(input),input.operation),build:input=>unwrapNativeBuildResult(ctx.exports.BuildSandbox.getByName(`build:${input.publicationId}`).run(input),'build'),releaseArtifact:input=>publishReleaseTree({snapshots:env.SNAPSHOTS,releases:env.RELEASES},input),stageVersion:input=>coordinator.stageVersion(input),closePublishedSession:(_source,submission,publicationId)=>coordinator.closeForPublication(submission.session_id,publicationId),publicUrls:(source,version)=>publicUrls(env,source,version),verifyPublic:verifyPublishedRead});
}
export class PublicationWorkflow extends WorkflowEntrypoint {
 async run(event,step){
  const {sourceId,publicationId}=event.payload||{};
  if(!uuid.test(sourceId||'')||!uuid.test(publicationId||'')||event.instanceId!==publicationId)throw new NonRetryableError('Invalid publication workflow identity');
  const coordinator=this.ctx.exports.SystemCoordinator.getByName(sourceId),store=publicationStoreProxy(coordinator);
  let receipt={publicationId};
  for(const name of PUBLICATION_STAGES){
   const input=receipt;
   const result=await step.do(name,{retries:{limit:8,delay:'1 minute',backoff:'exponential'},timeout:'55 minutes'},async()=>{
    const row=await store.publication(publicationId);
    if(!row||row.source_id!==sourceId||row.execution_job_id!==publicationId)throw new NonRetryableError('Publication workflow authority changed');
    if(row.status==='published')return{publicationId,status:'published',publication:row};
    const lease={jobId:publicationId,leaseToken:crypto.randomUUID()};
    const claim=await store.claimPublicationJob({...lease,leaseOwner:`workflow:${publicationId}:${name}`,leaseSeconds:3600});
    if(!claim)throw new Error('Publication is waiting for its source queue or expired attempt lease');
    let primary;try{return await publicationServices(this.ctx,this.env,coordinator,lease)[name](input);}
    catch(error){
     const message=/^Isolated publication (?:workspace|token_reference|token_cycle|media_reference|artifact_reference) check failed$/.test(error?.message||'')?error.message:`Publication ${name} failed`;
     const fresh=await store.publication(publicationId).catch(()=>null),committed=Boolean(fresh?.checkpoints_json?.pointerEventId||row.checkpoints_json?.pointerEventId);
     const requestDiagnostic=safeRequestDiagnostic(error?.requestDiagnostic),cleanupDiagnostic=safeRequestDiagnostic(error?.cleanupDiagnostic);
     if(fresh)await store.checkpointPublication(publicationId,lease,{status:committed?'closing':'failed',stage:committed?'close':name,error_message:message,checkpoints_json:{...fresh.checkpoints_json,...(requestDiagnostic?{requestDiagnostic}:{}),...(cleanupDiagnostic?{cleanupDiagnostic}:{})}}).catch(()=>{});
     primary=fresh&&!committed&&[400,403,404,409,410,413].includes(error?.statusCode)?new NonRetryableError(message):new Error(message);
     if(requestDiagnostic)primary.requestDiagnostic=requestDiagnostic;
     if(cleanupDiagnostic)primary.cleanupDiagnostic=cleanupDiagnostic;
     throw primary;
    }finally{await finishCleanup(()=>store.yieldPublicationLease({publicationId,...lease}),primary,'lease-yield');}
   });
   receipt={...receipt,...result};
  }
  return receipt;
 }
}
