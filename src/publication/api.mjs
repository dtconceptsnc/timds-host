// v1 publication response/preflight surface, independent of HTTP framework.
import {requestDiagnostic,safeRequestDiagnostic,finishCleanup} from '../requests/diagnostics.mjs';
import {publishedResult} from './urls.mjs';
import {timdsSubmissionView} from '../domain/sessions.mjs';
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const submissionPublicationView=row=>({id:row.id,sourceId:row.source_id,submissionId:row.submission_id,executionJobId:row.execution_job_id,status:row.status,stage:row.stage,error:row.error_message,result:row.result_json,createdAt:row.created_at,completedAt:row.completed_at,queuePosition:row.queue_position,conflictRate:row.conflict_rate,autoRebaseSuccess:row.auto_rebase_success,submitToPublishMs:row.submit_to_publish_ms,
 // The allowlisted diagnostic of the last failed attempt (operation, stage label, error class, fault); never a provider message.
 diagnostic:safeRequestDiagnostic(row.checkpoints_json?.requestDiagnostic),cleanupDiagnostic:safeRequestDiagnostic(row.checkpoints_json?.cleanupDiagnostic)});
export function createPublicationApi({store,repository,metadata,build,authorization,publication,sourceId,publicOrigin,authorizePublish=authorization?.authorizePublish,service=publication,now=()=>new Date().toISOString()}){
 const view=(row,source)=>({...submissionPublicationView(row),result:publishedResult(row.result_json,publicOrigin,source)});
 const committedReplay=(row,actor)=>row&&row.actor_principal_id===(actor?.principalId||actor?.id||actor?.userId)&&(['closing','published'].includes(row.status)||Boolean(row.checkpoints_json?.pointerEventId));
 async function preflight(input){let stage='authority';try{return await preflightSteps({...input,stage:value=>{stage=value;}});}catch(error){throw requestDiagnostic(error,stage,'publication-preflight');}}
 async function preflightSteps({source,submission,actor,dryRun=false,stage}){
  const existing=await store.publicationBySubmission(submission.id);
  if(!committedReplay(existing,actor))await authorizePublish(source,actor);
  if(existing&&(['published','closing'].includes(existing.status)||existing.checkpoints_json?.pointerEventId))return{systemId:source.system_id,submissionId:submission.id,sessionId:submission.session_id,version:existing.result_json?.version,previewUrl:submission.preview_url||'',diffSummary:{alreadyPublished:true},currency:'published',dryRun,buildChecked:true};
  if(submission.target_draft_session_id)throw fail(409,'This submission targets a draft; publish the draft when it is ready');
  if(submission.source_id!==source.id||source.lifecycle_status!=='ready'||source.archived_at||!source.artifacts_namespace)throw fail(409,'Hosted Design System is unavailable for publication');
  stage('merge');
  const checkout=await repository.preparePublication(source,submission),publicationId=crypto.randomUUID();let primary;
  try{
   stage('metadata');
   const release=await metadata({operation:'release-metadata',sourceId:source.id,publicationId,source:checkout.files,prior:checkout.priorFiles,preparedAt:now(),note:submission.note});
   if(dryRun){stage('commit');const committed=await repository.commitSource(source,checkout.checkoutId,{files:release.files});stage('build');const artifact=await build({sourceId:source.id,publicationId,files:committed.files});stage('stamp');await metadata({operation:'stamp',sourceId:source.id,publicationId,source:committed.files,artifact:artifact.files,sourceCommit:committed.headCommit,systemId:source.system_id});}
   const diff=submission.diff_json,diffSummary=typeof diff==='string'?{files:(diff.match(/^diff --git /gm)||[]).length,addedLines:(diff.match(/^\+(?!\+\+)/gm)||[]).length,removedLines:(diff.match(/^-(?!--)/gm)||[]).length}:{files:Array.isArray(diff)?diff.length:0};
   return{systemId:source.system_id,submissionId:submission.id,sessionId:submission.session_id,version:release.version,previewUrl:submission.preview_url||'',diffSummary,currency:'clean',autoRebased:Boolean(checkout.autoRebased),mainRevision:checkout.parentRevision,dryRun,buildChecked:dryRun};
  }catch(error){primary=error;throw error;}finally{await finishCleanup(()=>repository.releaseCheckout(source,checkout.checkoutId),primary);}
 }
 async function request({source,submission,actor}){
  if(!(actor?.principalId||actor?.id||actor?.userId)||!uuid.test(source?.id||'')||!uuid.test(submission?.id||'')||submission.source_id!==source.id)throw fail(400,'An authorized source, submission and publisher principal are required');
  const existing=await store.publicationBySubmission(submission.id);if(!committedReplay(existing,actor))await authorizePublish(source,actor);
  await service.publish(source.id,submission.id,actor);const row=await store.publicationBySubmission(submission.id);return view(row,source);
 }
 const api={preflight,request,get:async id=>{const row=await store.publication(id);return row&&view(row,await store.getSource(sourceId));},
  async publishResponse({source,submission,actor,input={}}){if(!input||typeof input!=='object'||Array.isArray(input)||input.apiVersion!==undefined&&input.apiVersion!==1)throw fail(400,'A compatible publication request is required');const session=await store.get(submission.session_id);if(!session||session.source_id!==source.id)throw fail(409,'Submission session does not match its Design System');const boundActor={...actor,requestId:session.originating_request_id||null};if(input.preflight===true||input.dryRun===true)return{status:200,body:{apiVersion:1,preflight:await preflight({source,submission,actor:boundActor,dryRun:input.dryRun===true})}};return{status:202,body:{apiVersion:1,publication:await request({source,submission,actor:boundActor})}};},
  async readResponse(id){const row=await store.publication(id);if(!row)throw fail(404,'Publication not found');return{apiVersion:1,publication:view(row,await store.getSource(sourceId))};},
 };
 api.publish=async(actor,submissionId,input={})=>{const [source,submission]=await Promise.all([store.getSource(sourceId),store.getSubmission(submissionId)]);if(!source?.artifacts_namespace||!submission||submission.source_id!==sourceId)throw fail(404,'Submission not found');return api.publishResponse({source,submission,actor,input});};
 api.read=async(actor,id)=>{const row=await store.publication(id);if(!row||row.source_id!==sourceId)throw fail(404,'Publication not found');if(row.actor_principal_id!==(actor.principalId||actor.id||actor.userId))await authorization.authorizeSource(await store.getSource(sourceId),actor);return{apiVersion:1,publication:view(row,await store.getSource(sourceId))};};
 api.list=async actor=>{const source=await store.getSource(sourceId);if(!source?.artifacts_namespace)throw fail(404,'Hosted Design System not found');await authorization.authorizeSource(source,actor);const [submissions,publications]=await Promise.all([store.submissionsForSource(sourceId),store.publicationsForSource(sourceId)]),bySubmission=new Map(publications.map(row=>[row.submission_id,row]));let canPublish=false;try{await authorizePublish(source,actor);canPublish=true;}catch(error){if(error.statusCode!==403)throw error;}return{apiVersion:1,canPublish,submissions:submissions.map(row=>({...timdsSubmissionView(row),publication:bySubmission.has(row.id)?view(bySubmission.get(row.id),source):null}))};};
 return api;
}
