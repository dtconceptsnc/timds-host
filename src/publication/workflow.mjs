import {WorkflowEntrypoint} from 'cloudflare:workers';
import {NonRetryableError} from 'cloudflare:workflows';
import {createRepositoryAdapter} from '../repository/adapter.mjs';
import {publishReleaseTree,loadRelease} from './releases.mjs';
import {createPublicationArtifactStore} from './artifacts.mjs';
import {createPublicationSteps,PUBLICATION_STAGES} from './steps.mjs';
import {publicUrls} from './urls.mjs';
import {verifyPublishedRead} from './public-read.mjs';
import {readTreeManifest} from '../repository/file-trees.mjs';
import {unwrapNativeBuildResult,finishCleanup,safeRequestDiagnostic} from '../requests/diagnostics.mjs';
import {logEvent,errorFields} from '../log.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Ordinary FIFO/lease waits do not spend the retry budget for a publication
// stage. A bounded six hours of durable sleeps leaves the same row recoverable.
const QUEUE_WAIT_LIMIT=720;
export function publicationStoreProxy(coordinator){return new Proxy({}, {get:(_target,name)=>(...args)=>coordinator.publicationStore(name,args)});}
export function publicationServices(ctx,env,coordinator,lease){
 const store=publicationStoreProxy(coordinator),repository=createRepositoryAdapter({store,getSandbox:id=>ctx.exports.RepositorySandbox.getByName(id),snapshotBucket:env.SNAPSHOTS});
 // The current pointer's immutable release receipt, so the published-branch
 // push can reuse unchanged blobs. Reuse is an optimisation: a pointer on a
 // legacy artifact layout or an unreadable receipt means no reuse, not failure.
 const priorRelease=async source=>{
  if(!source.published_version_id)return null;
  try{const version=await store.getVersion(source.published_version_id);if(!version?.artifact_ref?.startsWith('release:')||version.source_id!==source.id)return null;const {root,receipt}=await loadRelease({RELEASES:env.RELEASES},version);return {root,version:version.version_label,stamp:version.stamp,files:new Map(receipt.manifest.files.map(file=>[file.path,file]))};}
  catch(error){logEvent({event:'release_reuse',operation:'publication',stage:'release',outcome:'skipped',sourceId:source.id,...errorFields(error)});return null;}
 };
 return createPublicationSteps({store,repository,lease,priorRelease,artifacts:createPublicationArtifactStore(env.SNAPSHOTS),metadata:input=>unwrapNativeBuildResult(ctx.exports.BuildSandbox.getByName(`metadata:${input.publicationId}`).metadata(input),input.operation),build:input=>unwrapNativeBuildResult(ctx.exports.BuildSandbox.getByName(`build:${input.publicationId}`).run(input),'build'),artifactManifest:tree=>readTreeManifest(env.SNAPSHOTS,tree),releaseArtifact:input=>publishReleaseTree({snapshots:env.SNAPSHOTS,releases:env.RELEASES},input),stageVersion:input=>coordinator.stageVersion(input),closePublishedSession:(_source,submission,publicationId)=>coordinator.closeForPublication(submission.session_id,publicationId),publicUrls:(source,version)=>publicUrls(env,source,version),verifyPublic:verifyPublishedRead});
}
export class PublicationWorkflow extends WorkflowEntrypoint {
 async run(event,step){
  const {sourceId,publicationId}=event.payload||{};
  if(!uuid.test(sourceId||'')||!uuid.test(publicationId||'')||event.instanceId!==publicationId)throw new NonRetryableError('Invalid publication workflow identity');
  const coordinator=this.ctx.exports.SystemCoordinator.getByName(sourceId),store=publicationStoreProxy(coordinator);
  let receipt={publicationId},queueWaits=0;
  for(const name of PUBLICATION_STAGES){
   const input=receipt;
   let attempt=0;
   for(;;){
    const readiness=await step.do(`${name}:queue:${attempt}`,{retries:{limit:3,delay:'5 seconds',backoff:'constant'}},()=>store.publicationReadiness({publicationId,jobId:publicationId}));
    if(readiness.status==='superseded')throw new NonRetryableError('Publication was superseded');
    let result;
    if(readiness.ready||readiness.status==='published')result=await step.do(attempt===0?name:`${name}:attempt:${attempt}`,{retries:{limit:8,delay:'1 minute',backoff:'exponential'},timeout:'55 minutes'},async stepContext=>{
    const row=await store.publication(publicationId);
    if(!row||row.source_id!==sourceId||row.execution_job_id!==publicationId)throw new NonRetryableError('Publication workflow authority changed');
    if(row.status==='published')return{publicationId,status:'published',publication:row};
    const lease={jobId:publicationId,leaseToken:crypto.randomUUID()};
    const claim=await store.claimPublicationJob({...lease,leaseOwner:`workflow:${publicationId}:${name}`,leaseSeconds:3600});
    // Another attempt can acquire the lease after the read-only readiness
    // check. Persist this as queue state, then wait outside the stage retry.
    if(!claim)return{queuePending:true};
    // The coordinator writes the publication_stage feed row (deduplicated per
    // queue cycle) under this lease; the Workflow never writes SQLite itself.
    // The runtime counts retries; the outer counter only names queue cycles.
    const started=Date.now(),stageLog=fields=>logEvent({event:'publication_stage',operation:'publication',stage:name,attempt:stepContext.attempt,sourceId,publicationId,durationMs:Date.now()-started,...fields});
    let primary;try{await store.recordPublicationStage({publicationId,stage:name,...lease});const value=await publicationServices(this.ctx,this.env,coordinator,lease)[name](input);stageLog({outcome:'ok'});return value;}
    catch(error){
     const message=/^Isolated publication (?:workspace|token_reference|token_cycle|media_reference|artifact_reference) check failed$/.test(error?.message||'')?error.message:`Publication ${name} failed`;
     const fresh=await store.publication(publicationId).catch(()=>null),committed=Boolean(fresh?.checkpoints_json?.pointerEventId||row.checkpoints_json?.pointerEventId);
     const requestDiagnostic=safeRequestDiagnostic(error?.requestDiagnostic),cleanupDiagnostic=safeRequestDiagnostic(error?.cleanupDiagnostic);
     if(fresh)await store.checkpointPublication(publicationId,lease,{status:committed?'closing':'failed',stage:committed?'close':name,error_message:message,checkpoints_json:{...fresh.checkpoints_json,...(requestDiagnostic?{requestDiagnostic}:{}),...(cleanupDiagnostic?{cleanupDiagnostic}:{})}}).catch(()=>{});
     primary=fresh&&!committed&&[400,403,404,409,410,413].includes(error?.statusCode)?new NonRetryableError(message):new Error(message);
     stageLog({outcome:primary instanceof NonRetryableError?'failed':'error',...errorFields(error)});
     if(requestDiagnostic)primary.requestDiagnostic=requestDiagnostic;
     if(cleanupDiagnostic)primary.cleanupDiagnostic=cleanupDiagnostic;
     throw primary;
    }finally{await finishCleanup(()=>store.yieldPublicationLease({publicationId,...lease}),primary,'lease-yield');}
    });
    if(result&&!result.queuePending){receipt={...receipt,...result};break;}
    if(queueWaits>=QUEUE_WAIT_LIMIT)throw new NonRetryableError('Publication queue wait expired; resume the same publication after its source is available');
    await step.sleep(`${name}:wait:${attempt}`,'30 seconds');
    queueWaits++;attempt++;
   }
  }
  return receipt;
 }
}
