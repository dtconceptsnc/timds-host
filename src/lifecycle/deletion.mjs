import { createHash, randomUUID } from 'node:crypto';
import { fail, principalId } from '../store/errors.mjs';
import { verifyDeletionConsumers } from './consumer-proof.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const retention={immutableReleaseBytes:'retained_inaccessible',audit:'retained'};
const view=row=>({apiVersion:1,operationId:row.id,sourceId:row.source_id,status:row.status,phase:row.phase,repository:row.inventory.repository,impactHash:row.impact_hash,counts:row.inventory.counts,retention,requiresConsumerProof:Boolean(row.portal_origin),awaitingConsumerProof:row.status==='awaiting_consumer_proof',error:row.error||null,createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at||null});

/** A durable, source-local cleanup engine. External calls execute outside the
 * coordinator mutation queue; every step reacquires its fenced lease before
 * committing. An alarm resumes a crash from the last durable checkpoint. */
export function createSourceDeletion({sourceId,storage,store,catalog,artifacts,preview,live,runMutation,env,origin,clock=()=>Date.now()}) {
  const sql=storage.sql,now=()=>new Date(clock()).toISOString();
  const readRows=table=>sql.exec(`SELECT row_json FROM ${table} ORDER BY id`).toArray().map(row=>JSON.parse(row.row_json));
  const get=id=>{const row=store.getLifecycleOperation(id);if(!row||row.kind!=='delete'||row.source_id!==sourceId)throw fail(404,'Deletion operation not found');return row;};
  const save=row=>store.saveLifecycle({...row,updated_at:now()});
  async function admin(actor){const row=await catalog.principal(principalId(actor));if(row?.status!=='active'||!row.admin)throw fail(403,'An active administrator is required');return row;}
  async function provenance(source){
    const native=await catalog.first('SELECT id FROM provision_operations WHERE source_id=?',sourceId);
    if(native){
      const operation=store.getLifecycleOperation(native.id),receipt=operation?.repository_receipt;
      if(operation?.source_id!==sourceId||operation.status!=='completed'||receipt?.id!==source.artifacts_repository_id||receipt.namespace!==source.artifacts_namespace||receipt.repository!==source.artifacts_repository)throw fail(409,'Completed native provisioning provenance is unavailable');
      return {kind:'native',portalOrigin:null,portalEpoch:null};
    }
    // No native receipt means import proof is mandatory. A missing migration or
    // unknown source provenance fails closed instead of assuming no consumers.
    const imported=await catalog.first("SELECT input_json FROM import_operations WHERE source_id=? AND state='active'",sourceId);
    let input;try{input=JSON.parse(imported?.input_json||'null');}catch{}
    if(!input||input.sourceId!==sourceId||input.manifest?.originalSource?.id!==sourceId||input.manifest?.source?.id!==sourceId||input.manifest?.repository?.id!==source.artifacts_repository_id)throw fail(409,'Source ownership provenance is unavailable');
    if(input.manifest.originalSource.source_path!=='.'||input.manifest.originalSource.dedicated_repository!==true)throw fail(409,'Only a dedicated standalone repository can be deleted');
    return {kind:'portal',portalOrigin:input.manifest.portalOrigin,portalEpoch:input.epoch};
  }
  async function inventory(source){
    if(!source?.artifacts_namespace||!source.artifacts_repository||!source.artifacts_repository_id)throw fail(409,'A verified hosted repository is required');
    if(store.pendingPublications().length)throw fail(409,'Finish outstanding publications before deleting this Design System');
    const root=await artifacts.getRepository(source.artifacts_namespace,source.artifacts_repository);
    if(!root||String(root.id)!==String(source.artifacts_repository_id))throw fail(409,'Repository identity changed');
    const sessions=readRows('sessions').map(row=>({id:row.id,status:row.status,fork:row.fork_repository||`session-${row.id}`,live:Boolean(row.sandbox_id||row.live_state&&row.live_state!=='closed')}));
    if(sessions.length>10000)throw fail(409,'Deletion inventory exceeds the supported bound');
    const forks=[];
    for(const session of sessions){
      if(!uuid.test(session.id)||session.fork!==`session-${session.id}`)throw fail(409,'Session fork ownership is unavailable');
      const fork=await artifacts.getRepository(source.artifacts_namespace,session.fork);
      const receipt=store.sessionRepository(session.id);
      if(fork&&(!receipt||receipt.namespace!==source.artifacts_namespace||receipt.repository!==session.fork||receipt.repository_id!==String(fork.id)))throw fail(409,'An existing historical fork lacks its exact immutable creation receipt');
      forks.push({sessionId:session.id,name:session.fork,id:fork?String(fork.id):null});
    }
    const grants=await catalog.all('SELECT principal_id,can_read,can_write FROM system_access WHERE source_id=? ORDER BY principal_id',sourceId);
    const publishers=await catalog.all('SELECT principal_id FROM publishers WHERE source_id=? ORDER BY principal_id',sourceId);
    const requests=readRows('request_jobs').map(row=>({id:row.id,status:row.status}));
    const previewReceipt=await preview.inspectSourcePreview(source);
    return {repository:{id:String(root.id),namespace:source.artifacts_namespace,name:source.artifacts_repository},sessions,forks,grants,publishers,requests,preview:previewReceipt,
      counts:{sessions:sessions.filter(row=>!['closed','expired'].includes(row.status)).length,forks:forks.filter(row=>row.id).length,publishers:publishers.length,requests:requests.filter(row=>['queued','leased','running'].includes(row.status)).length}};
  }
  function proofFresh(row){return !row.portal_origin||row.consumer_check?.expiresAt>Math.floor(clock()/1000);}
  function lease(row,token){if(row.status!=='running'||row.lease!==token||Date.parse(row.lease_expires_at)<=clock())throw fail(409,'Deletion cleanup lease is unavailable');return row;}
  async function renew(id,token,{consumers=false}={}){return runMutation(async()=>{
    let row=lease(get(id),token);await admin({principalId:row.confirmed_by});
    if(consumers&&!proofFresh(row)){save({...row,status:'awaiting_consumer_proof',lease:null,lease_expires_at:null,error:null});throw fail(409,'Refresh the portal consumer check to continue deletion');}
    return save({...row,lease_expires_at:new Date(clock()+180000).toISOString()});
  });}
  async function checkpoint(id,token,patch){return runMutation(()=>{const row=lease(get(id),token);return save({...row,...patch,checkpoints_json:{...row.checkpoints_json,...patch.checkpoints_json}});});}
  async function removeRepository(row,token,repository){
    await renew(row.id,token,{consumers:true});
    const actual=await artifacts.getRepository(row.inventory.repository.namespace,repository.name);
    if(!actual)return;
    if(!repository.id||String(actual.id)!==repository.id)throw fail(409,'Repository identity changed during deletion');
    for(const cap of await artifacts.listTokens(row.inventory.repository.namespace,repository.name)){
      await renew(row.id,token,{consumers:true});
      await artifacts.revokeToken(row.inventory.repository.namespace,cap.id,repository.name);
    }
    await renew(row.id,token,{consumers:true});
    // Re-read exact provider identity immediately before irreversible removal.
    const current=await artifacts.getRepository(row.inventory.repository.namespace,repository.name);
    if(current&&String(current.id)!==repository.id)throw fail(409,'Repository identity changed during deletion');
    if(current)await artifacts.deleteRepository(row.inventory.repository.namespace,repository.name);
  }
  return {
    async invoke({operation,actor,input={}}){
      const principal=await admin(actor);
      if(!uuid.test(input.operationId||''))throw fail(400,'A stable deletion operation UUID is required');
      if(operation==='prepare'){
        const prior=store.getLifecycleOperation(input.operationId);if(prior)return view(get(input.operationId));
        if(store.deletionFence())throw fail(409,'Resume the existing deletion operation');
        const source=await store.getSource(sourceId);if(source?.lifecycle_status!=='ready')throw fail(409,'Only an initialized source can be deleted');
        const owner=await provenance(source),impact=await inventory(source);
        const row={id:input.operationId,kind:'delete',source_id:sourceId,actor_principal_id:principal.id,portal_origin:owner.portalOrigin,portal_epoch:owner.portalEpoch,status:'awaiting_confirmation',phase:'inspect',inventory:impact,impact_hash:hash(impact),checkpoints_json:{},created_at:now(),updated_at:now()};
        return view(save(row));
      }
      let row=get(input.operationId);
      if(operation==='read')return view(row);
      if(operation==='history')return {operation:view(row),sessions:readRows('sessions').slice(-100).map(item=>({id:item.id,status:item.status,kind:item.kind,createdAt:item.created_at})),events:readRows('events').slice(-100).map(item=>({id:item.id,eventType:item.event_type,sessionId:item.session_id,actorPrincipalId:item.actor_principal_id,createdAt:item.created_at})),retention};
      if(operation!=='confirm')throw fail(404,'Unknown deletion operation');
      if(input.impactHash!==row.impact_hash||input.typedRepository!==row.inventory.repository.name)throw fail(409,'Type the reviewed repository name and use its current impact hash');
      if(row.status==='completed')return view(row);
      if(row.status==='running'&&Date.parse(row.lease_expires_at)>clock())throw fail(409,'Deletion is already running');
      const marker=store.deletionFence();
      if(marker&&marker.operationId!==row.id)throw fail(409,'Another deletion operation owns this source');
      if(!marker){
        const source=await store.getSource(sourceId);if(source?.lifecycle_status!=='ready')throw fail(409,'Source is no longer available for deletion');
        if(hash(await inventory(source))!==row.impact_hash)throw fail(409,'Deletion impact changed; prepare and review a new operation');
      }
      const consumerCheck=row.portal_origin?verifyDeletionConsumers({env,origin,proof:input.portalConsumerProof,operation:row,clock}):null;
      row={...row,confirmed_by:principal.id,confirmed_at:row.confirmed_at||now(),consumer_check:consumerCheck,status:'queued',phase:row.phase==='inspect'?'stop_work':row.phase,lease:null,lease_expires_at:null,error:null,updated_at:now()};
      // Local fence commits first and is overlaid on all source reads. D1 then
      // confirms the same source gate via the existing authority receipt/outbox.
      await store.beginDeletion({operationId:row.id,actor:{principalId:principal.id},confirmedOperation:row});
      await storage.setAlarm(clock()+1000);
      return view(row);
    },
    nextAlarm(){const row=store.activeDeletion();return row&&['queued','running'].includes(row.status)?Math.max(clock()+1000,Date.parse(row.lease_expires_at)||0):null;},
    async advance(){
      let row=await runMutation(async()=>{
        const candidate=store.activeDeletion();if(!candidate||!['queued','running'].includes(candidate.status)||candidate.lease_expires_at&&Date.parse(candidate.lease_expires_at)>clock())return null;
        try{await admin({principalId:candidate.confirmed_by});}
        catch(error){if(error.statusCode!==403)throw error;save({...candidate,status:'failed',lease:null,lease_expires_at:null,error:'An active administrator must confirm again to resume cleanup'});return null;}
        await store.beginDeletion({operationId:candidate.id,actor:{principalId:candidate.confirmed_by}});
        return save({...candidate,status:'running',lease:randomUUID(),lease_expires_at:new Date(clock()+180000).toISOString()});
      });
      if(!row)return null;
      const token=row.lease;
      try{
        let source=await store.getSource(sourceId);
        if(!row.checkpoints_json.stopped){
          for(const session of readRows('sessions'))if(session.status==='closing'||session.sandbox_id||session.live_state&&session.live_state!=='closed'){await renew(row.id,token);await live.close(session,source);}
          await runMutation(()=>{lease(get(row.id),token);store.finishDeletionSessions(row.id);});
          row=await checkpoint(row.id,token,{phase:'remove_repositories',checkpoints_json:{stopped:true}});
        }
        for(const repository of [...row.inventory.forks,{...row.inventory.repository,sessionId:null}]){
          if(row.checkpoints_json[`repository:${repository.name}`])continue;
          await removeRepository(row,token,repository);
          row=await checkpoint(row.id,token,{checkpoints_json:{[`repository:${repository.name}`]:true}});
        }
        row=await checkpoint(row.id,token,{phase:'remove_preview'});
        if(!row.checkpoints_json.preview){
          await renew(row.id,token,{consumers:true});
          await preview.deleteSourcePreview(source,{expected:row.inventory.preview});
          row=await checkpoint(row.id,token,{checkpoints_json:{preview:true}});
        }
        row=await checkpoint(row.id,token,{phase:'revoke_authority'});
        const principals=[...new Set([...row.inventory.grants,...row.inventory.publishers].map(item=>item.principal_id))];
        for(const id of principals)await runMutation(async()=>{lease(get(row.id),token);await store.deletionAuthority({operationId:row.id,actor:{principalId:row.confirmed_by},suffix:`revoke:${id}`,command:{principalId:id,read:false,write:false,publish:false}});});
        row=await checkpoint(row.id,token,{phase:'verify'});
        for(const repository of [...row.inventory.forks,row.inventory.repository]){
          await renew(row.id,token);
          if(await artifacts.getRepository(row.inventory.repository.namespace,repository.name))throw fail(409,'Repository removal is not yet verified');
        }
        if(await preview.inspectSourcePreview(source))throw fail(409,'Preview removal is not yet verified');
        const remaining=await catalog.first('SELECT (SELECT COUNT(*) FROM publishers WHERE source_id=?)+(SELECT COUNT(*) FROM system_access WHERE source_id=? AND (can_read=1 OR can_write=1)) AS n',sourceId,sourceId);
        if(remaining?.n!==0)throw fail(409,'Source grants are not fully revoked');
        return await runMutation(async()=>{
          row=lease(get(row.id),token);
          row=save({...row,completion_at:row.completion_at||now(),completion_actor:row.completion_actor||row.confirmed_by});
          await store.deletionAuthority({operationId:row.id,actor:{principalId:row.confirmed_by},suffix:'completed',command:{lifecycleStatus:'deleted',sourcePatch:{deleted_at:row.completion_at,deleted_by_principal_id:row.completion_actor,deletion_operation_id:row.id,retained_immutable_history:true}}});
          store.completeDeletion(row.id,row.confirmed_by);
          row=save({...row,status:'completed',phase:'completed',lease:null,lease_expires_at:null,completed_at:now(),error:null});
          await store.flushOutbox();return view(row);
        });
      }catch(error){
        await runMutation(()=>{const current=get(row.id);if(current.lease===token&&current.status==='running')save({...current,status:'failed',lease:null,lease_expires_at:null,error:'Cleanup paused; review provider readiness and confirm again to resume'});});
        return view(get(row.id));
      }
    },
  };
}
