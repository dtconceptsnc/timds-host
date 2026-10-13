import {designSystemPreviewWorker} from './index.mjs';
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Exact event fields observed in the disposable cf/Builds proof. No URL,
 * principal, publication or arbitrary source selector is trusted from events.
 */
export function parsePreviewBuildEvent(input) {
  let event=input;
  if(typeof input==='string'){if(Buffer.byteLength(input)>128*1024)return null;try{event=JSON.parse(input);}catch{return null;}}
  const payload=event?.payload,metadata=payload?.buildTriggerMetadata;
  if(event?.type!=='cf.workersBuilds.worker.build.succeeded' || event.source?.type!=='workersBuilds.worker' || !/^timds-[a-f0-9]{32}$/.test(event.source.workerName || '') || payload?.status!=='stopped' || payload.buildOutcome!=='success' || !uuid.test(payload.buildUuid || '') || !/^review-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata?.branch || '') || !/^[a-f0-9]{40}$/.test(metadata?.commitHash || ''))return null;
  const id=event.source.workerName.slice(6),sourceId=`${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
  return {sourceId,workerName:event.source.workerName,buildId:payload.buildUuid,branch:metadata.branch,headCommit:metadata.commitHash};
}

export function createPreviewBuildHandler({sourceId,getSource,submissions,recordPreviewBuild,previews}) {
  return async input=>{
    const event=parsePreviewBuildEvent(input);
    if(!event || event.sourceId!==sourceId)return {ignored:true};
    const source=await getSource(sourceId);
    if(!source || source.id!==sourceId || source.archived_at || source.lifecycle_status!=='ready' || event.workerName!==designSystemPreviewWorker(source))return {ignored:true};
    const matches=(await submissions(sourceId)).filter(row=>row.source_id===sourceId && row.review_branch===event.branch && row.head_commit===event.headCommit && ['submitted','publishing','published'].includes(row.status));
    if(!matches.length)return {ignored:true};
    if(matches.length!==1)throw fail(409,'Preview build matches more than one submission');
    const ready=await previews.readyPreview(source,event.branch);
    // The durable store repeats all identities and status under its local
    // transaction, so a close during the network reads cannot resurrect work.
    return recordPreviewBuild({submissionId:matches[0].id,sourceId,branch:event.branch,headCommit:event.headCommit,buildId:event.buildId,url:ready.url,workerTag:ready.workerTag});
  };
}
