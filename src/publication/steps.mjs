// Seven repeatable stages. Durable receipts contain identities/references, never
// credentials, local paths, large trees or a live checkout handle.
import {finishCleanup} from '../requests/diagnostics.mjs';
import {verifyPublishedRead} from './public-read.mjs';
const fail=message=>Object.assign(new Error(message),{statusCode:409});
export const PUBLICATION_STAGES=['preflight','merge','build','prepare','release','flip','close'];
export function createPublicationSteps({store,repository,artifacts,metadata,build,artifactManifest,releaseArtifact,stageVersion,closePublishedSession,lease,publicUrls,verifyPublic=verifyPublishedRead,now=()=>new Date().toISOString()}){
 const context=async id=>{const row=await store.publication(id);if(!row)throw fail('Publication not found');const [source,submission]=await Promise.all([store.getSource(row.source_id),store.getSubmission(row.submission_id)]);if(!source||!submission||submission.source_id!==source.id)throw fail('Publication source identity changed');return{row,source,submission};};
 const save=(id,patch)=>store.checkpointPublication(id,lease,patch);
 const checkpoint=(row,stage,patch={})=>save(row.id,{status:'running',stage,error_message:null,checkpoints_json:{...row.checkpoints_json,...patch}});
 const stored=async ref=>{const receipt=await artifacts.get(ref);if(!receipt)throw fail('Saved publication bytes are unavailable; restore the immutable artifact before retrying');return receipt;};
 const committed=row=>Boolean(row.checkpoints_json?.pointerEventId)||['closing','published'].includes(row.status);
 const ready=(source,submission)=>{if(source.lifecycle_status!=='ready'||source.archived_at||!source.artifacts_namespace||submission.target_draft_session_id)throw fail('Publication requires an active main-target submission');};
 const authorize=(id)=>store.authorizePublication(id,lease);
 // Container phase durations from this attempt, keyed by operation. They live
 // in the checkpoint, not in the immutable artifact receipt a retry may reuse.
 const timed=(row,name,result)=>result?.phases?{timings:{...(row.checkpoints_json?.timings||{}),[name]:{phases:result.phases,...(result.dependencyCache?{dependencyCache:result.dependencyCache}:{})}}}:{};
 return {
  async preflight({publicationId}){const {row,source,submission}=await context(publicationId);if(!committed(row)){ready(source,submission);await authorize(publicationId);}return{publicationId,sourceId:source.id,submissionId:submission.id};},
  async merge({publicationId}){
   let {row,source,submission}=await context(publicationId);if(committed(row))return{publicationId,sourceRef:row.checkpoints_json.sourceRef};ready(source,submission);await authorize(publicationId);
   const previous=row.checkpoints_json?.sourceRef?await stored(row.checkpoints_json.sourceRef):null;
   if(previous&&(previous.submissionId!==submission.id||row.checkpoints_json.sourceCommit&&previous.sourceCommit!==row.checkpoints_json.sourceCommit))throw fail('Saved source differs from this publication');
   const preparedAt=row.checkpoints_json.releasePreparedAt||previous?.releasePreparedAt||now();if(!Number.isFinite(Date.parse(preparedAt)))throw fail('Invalid publication date');row=await checkpoint(row,'merge',{releasePreparedAt:preparedAt});
   const resume=row.checkpoints_json.artifactRef?previous:row.checkpoints_json;
   const checkout=await repository.preparePublication(source,submission,{sourceCommit:resume?.sourceCommit,parentRevision:resume?.parentRevision,commitDate:resume?.commitDate||submission.created_at});
   let primary;try{
    let releaseFiles=previous?.parentRevision===checkout.parentRevision?previous.releaseFiles:null,release=null;
    if(!releaseFiles){if(checkout.resumed)throw fail('Committed source has no immutable release metadata');release=await metadata({operation:'release-metadata',sourceId:source.id,publicationId,source:checkout.files,prior:checkout.priorFiles,preparedAt,note:submission.note});releaseFiles=release.files;}
    const sourceResult=await repository.commitSource(source,checkout.checkoutId,{files:releaseFiles,message:`Publish TimDS submission ${submission.id}`});
    const sourceRef=`publication:${publicationId}:source:${checkout.parentRevision}`;
    await artifacts.put(sourceRef,{sourceCommit:sourceResult.headCommit,parentRevision:checkout.parentRevision,sourceFiles:sourceResult.files,releaseFiles,releasePreparedAt:preparedAt,commitDate:submission.created_at,submissionId:submission.id});
    await checkpoint(row,'merge',{sourceRef,mergedKeys:checkout.mergedKeys||[],conflictedKeys:checkout.conflictedKeys||[],...timed(row,'releaseMetadata',release)});
    return{publicationId,sourceRef,sourceCommit:sourceResult.headCommit,parentRevision:checkout.parentRevision};
   }catch(error){primary=error;throw error;}finally{await finishCleanup(()=>repository.releaseCheckout(source,checkout.checkoutId),primary);}
  },
  async build({publicationId,sourceRef}){
   const {row,source}=await context(publicationId);if(committed(row))return{publicationId,artifactRef:row.checkpoints_json.artifactRef,sourceRef:row.checkpoints_json.sourceRef};
   const snapshot=await stored(sourceRef),artifactRef=row.checkpoints_json.artifactRef||`publication:${publicationId}:build:${snapshot.parentRevision}`;let artifact=await artifacts.get(artifactRef),built=null;
   if(!artifact){if(row.checkpoints_json.artifactRef)throw fail('Saved artifact bytes unavailable');await checkpoint(row,'build');built=await build({sourceId:source.id,publicationId,files:snapshot.sourceFiles});artifact=await artifacts.put(artifactRef,{sourceRef,submissionId:snapshot.submissionId,files:built.files,cacheKey:built.cacheKey,checks:built.checks});}
   if(artifact.sourceRef!==sourceRef||artifact.submissionId!==snapshot.submissionId)throw fail('Saved build belongs to another source');
   const fresh=await store.publication(publicationId);await checkpoint(fresh,'build',{artifactRef,sourceRef,staged:true,sourceCommit:snapshot.sourceCommit,parentRevision:snapshot.parentRevision,commitDate:snapshot.commitDate,...timed(fresh,'build',built)});return{publicationId,artifactRef,sourceRef};
  },
  async prepare({publicationId,artifactRef}){
   const {row,source}=await context(publicationId);if(committed(row))return{publicationId,artifactRef:row.checkpoints_json.artifactRef,stamp:row.checkpoints_json.stamp};
   const artifact=await stored(artifactRef),snapshot=await stored(artifact.sourceRef),result=await metadata({operation:'stamp',sourceId:source.id,publicationId,source:snapshot.sourceFiles,artifact:artifact.files,sourceCommit:snapshot.sourceCommit,systemId:source.system_id});
   if(row.checkpoints_json.stamp&&JSON.stringify(row.checkpoints_json.stamp)!==JSON.stringify(result.stamp))throw fail('Saved publication stamp changed');
   await checkpoint(row,'prepare',{artifactRef,sourceRef:artifact.sourceRef,stamp:result.stamp,artifact:result.artifact,...timed(row,'stamp',result)});return{publicationId,artifactRef,stamp:result.stamp};
  },
  async release({publicationId,artifactRef,stamp}){
   let {row,source,submission}=await context(publicationId);if(committed(row))return{publicationId,artifactRef,versionId:row.checkpoints_json.pointerVersionId};ready(source,submission);await authorize(publicationId);
   if(JSON.stringify(stamp)!==JSON.stringify(row.checkpoints_json.stamp))throw fail('Publication stamp differs from prepared receipt');
   if(artifactRef!==row.checkpoints_json.artifactRef)throw fail('Publication artifact differs from prepared receipt');
   const artifact=await stored(artifactRef),snapshot=await stored(artifact.sourceRef),prepared=row.checkpoints_json.artifact;
   // prepare hashed these two immutable, content-addressed trees. The
   // digest-checked artifact manifest against the prepared receipt pins the
   // tree identity without a second stamp container; the sha256-checked
   // release copy below pins the bytes. The entry path is not compared here:
   // the toolkit normalizes it before its own check and the driver does not.
   if(artifact.sourceRef!==row.checkpoints_json.sourceRef||stamp.sourceCommit!==snapshot.sourceCommit||stamp.systemId!==source.system_id)throw fail('Prepared stamp belongs to another source');
   const manifest=await artifactManifest(artifact.files);
   if(!prepared||prepared.fileCount!==manifest.files.length||prepared.totalBytes!==manifest.totalBytes)throw fail('Immutable bytes differ from stamp');
   const checkout=await repository.preparePublication(source,submission,{sourceCommit:snapshot.sourceCommit,parentRevision:snapshot.parentRevision,commitDate:snapshot.commitDate});
   let primary;try{
    const committedSource=await repository.commitSource(source,checkout.checkoutId,{files:snapshot.releaseFiles,message:`Publish TimDS submission ${submission.id}`});if(committedSource.headCommit!==stamp.sourceCommit)throw fail('Reconstructed source differs from stamp');
    const releaseRef=await releaseArtifact({sourceId:source.id,files:artifact.files,stamp,manifest});
    const version={id:publicationId,source_id:source.id,version_label:stamp.version,source_commit:stamp.sourceCommit,content_digest:stamp.contentDigest,artifact_ref:releaseRef,source_ref:snapshot.sourceFiles.ref,stamp,publication_id:publicationId,created_at:snapshot.releasePreparedAt,artifact:prepared};
    const staged=await stageVersion({publicationId,lease,version});row=await checkpoint(row,'release',{versionId:staged.versionId});
    await repository.pushMain(source,checkout.checkoutId);row=await checkpoint(row,'release',{mainPushed:true});
    await repository.pushPublished(source,checkout.checkoutId,{files:artifact.files,stamp});await checkpoint(row,'release',{artifactPushed:true});
    return{publicationId,artifactRef,versionId:staged.versionId};
   }catch(error){primary=error;throw error;}finally{await finishCleanup(()=>repository.releaseCheckout(source,checkout.checkoutId),primary);}
  },
  async flip({publicationId,versionId}){
   const {row,source}=await context(publicationId);if(row.status==='published')return{publicationId,result:row.result_json};
   const selected=versionId||row.checkpoints_json.versionId||row.checkpoints_json.pointerVersionId;if(!selected)throw fail('Immutable publication version is missing');
   const receipt=await store.releasePublicationVersion({publicationId,versionId:selected,jobId:lease.jobId,leaseToken:lease.leaseToken});
   const fresh=await store.publication(publicationId),urls=publicUrls(source,fresh.result_json.version);const result={...fresh.result_json,status:'published',publicRoot:urls.root,versionedUrls:{root:urls.version,llmsTxt:`${urls.version}llms.txt`,bundleJson:`${urls.version}bundle.json`,artifact:`${urls.version}.timds-artifact.json`},publication:receipt,timings:fresh.checkpoints_json.timings||{}};
   await save(publicationId,{status:'closing',stage:'close',result_json:result,error_message:null});
   await verifyPublic({root:urls.root,stamp:fresh.checkpoints_json.stamp});return{publicationId,result};
  },
  async close({publicationId}){const {row,source,submission}=await context(publicationId);if(row.status==='published')return{publicationId,status:'published',publication:row};if(!committed(row))throw fail('Publication must commit its pointer before cleanup');await closePublishedSession(source,submission,publicationId);const saved=await save(publicationId,{status:'published',stage:'close',error_message:null});return{publicationId,status:'published',publication:saved};},
 };
}
