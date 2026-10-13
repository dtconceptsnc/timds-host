import { fail } from '../store/errors.mjs';
import { UUID,DIGEST,canonical,digest,check } from './contract.mjs';
import { legacySourceRoots } from '../public/host-routes.mjs';

const identityFields=['system_id','operation_id','source_id','repo_id','deleted_at','created_at'];
const deletionFields=['id','kind','status','stage','system_id','source_id','repo_id','owner','repository_name','artifacts_repository_id','confirmed_at','completed_at','created_at','updated_at'];
const exact=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));

/** A retired identity is not an active source export. Only the retained portal
 * identity and completed delete receipt may reserve it; absence is insufficient. */
export function validateDeletedImport(input,origin){
  check(UUID.test(input?.operationId||'')&&UUID.test(input?.sourceId||'')&&input.portalSourceId===input.sourceId,'Preserve the original deleted source UUID and provide an operation UUID');
  const manifest=input.manifest,identity=manifest?.identity,deletion=manifest?.deletion;
  check(exact(manifest,['schemaVersion','kind','portalOrigin','organizationId','capturedAt','identity','deletion','legacyPublicRoots'])&&manifest.schemaVersion===1&&manifest.kind==='deleted-source'&&UUID.test(manifest.organizationId||'')&&timestamp(manifest.capturedAt),'A minimal deleted-source manifest is required');
  check(Buffer.byteLength(canonical(manifest))<=16384,'Deleted-source manifest exceeds its bound');
  let portal;try{portal=new URL(manifest.portalOrigin);}catch{throw fail(400,'The exact portal origin is required');}
  check(portal.protocol==='https:'&&portal.origin===manifest.portalOrigin&&!portal.username&&!portal.password,'The exact HTTPS portal origin is required');
  check(exact(identity,identityFields)&&exact(deletion,deletionFields),'Preserve the exact minimal identity and completed deletion fields');
  check(identity.source_id===input.sourceId&&deletion.source_id===input.sourceId&&UUID.test(identity.repo_id||'')&&deletion.repo_id===identity.repo_id&&UUID.test(deletion.id||'')&&(identity.operation_id===null||UUID.test(identity.operation_id||'')),'Deleted source, repository and original operation identities must match');
  check(typeof identity.system_id==='string'&&identity.system_id.length>0&&identity.system_id.length<=300&&deletion.system_id===identity.system_id,'The original system identity must match');
  check(deletion.kind==='delete'&&deletion.status==='deleted'&&deletion.stage==='deleted'&&['deleted_at','created_at'].every(key=>timestamp(identity[key]))&&['confirmed_at','completed_at','created_at','updated_at'].every(key=>timestamp(deletion[key])),'A confirmed completed portal deletion and retired identity are required');
  check(Date.parse(deletion.confirmed_at)<=Date.parse(deletion.completed_at)&&Date.parse(identity.deleted_at)<=Date.parse(manifest.capturedAt)&&Date.parse(deletion.completed_at)<=Date.parse(manifest.capturedAt),'Original deletion timestamps must precede the capture');
  check(['owner','repository_name'].every(key=>/^[a-z0-9][a-z0-9-]{0,62}$/.test(deletion[key]||''))&&typeof deletion.artifacts_repository_id==='string'&&deletion.artifacts_repository_id.length>0&&deletion.artifacts_repository_id.length<=200&&!/[\x00-\x20\x7f]/.test(deletion.artifacts_repository_id),'Retain the exact deleted provider repository identity');
  if(manifest.legacyPublicRoots!==null){try{legacySourceRoots(manifest.legacyPublicRoots);}catch{throw fail(400,'Invalid reviewed legacy public roots');}}
  check(DIGEST.test(input.exportDigest||'')&&digest(manifest)===input.exportDigest,'The deleted-source export digest differs');
  return {operationId:input.operationId,portalSourceId:input.sourceId,sourceId:input.sourceId,origin,exportDigest:input.exportDigest,manifest};
}

export const deletedReceipt=row=>({receiptId:`deleted-import:${row.operation_id}`,operationId:row.operation_id,sourceId:row.source_id,portalSourceId:row.source_id,origin:row.input.origin,exportDigest:row.input.exportDigest,stage:'deleted',hostState:'deleted',activationForbidden:true,originalDeletionOperationId:row.input.manifest.deletion.id,originalDeletedAt:row.input.manifest.identity.deleted_at,capturedAt:row.input.manifest.capturedAt,recordedAt:row.created_at});
export async function readDeletedImport(catalog,id){const row=await catalog.first('SELECT * FROM import_deleted_sources WHERE operation_id=?',id);return row&&{...row,input:JSON.parse(row.input_json)};}

export function createDeletedImporter({sourceId,storage,catalog,store,imports,origin,verifyPortalReceipt}){
  function finishLocal(row){
    const fence=store.deletionFence();
    if(fence){if(!fence.completed||!fence.importedTombstone||fence.operationId!==row.operation_id||fence.exportDigest!==row.input.exportDigest)throw fail(409,'The source already has another deletion fence');return;}
    const event={id:row.operation_id,source_id:sourceId,session_id:null,submission_id:null,actor_user_id:null,actor_token_id:null,actor_principal_id:row.actor_id,originating_request_id:null,event_type:'deleted_source_imported',note:'Transferred the completed portal deletion identity',merged_keys:[],conflicted_keys:[],created_at:row.created_at,details_json:{exportDigest:row.input.exportDigest,originalDeletionOperationId:row.input.manifest.deletion.id,originalDeletedAt:row.input.manifest.identity.deleted_at}};
    storage.transactionSync(()=>{
      storage.sql.exec('INSERT INTO coordinator_meta(key,value) VALUES(?,?)','deletion_fence',canonical({operationId:row.operation_id,completed:true,importedTombstone:true,exportDigest:row.input.exportDigest,at:row.created_at}));
      storage.sql.exec('INSERT INTO events(id,row_json) VALUES(?,?)',event.id,canonical(event));
      storage.sql.exec('INSERT INTO outbox(kind,row_json) VALUES(?,?)','event',canonical(event));
    });
  }
  return async({operation,actor,input})=>{
    const principal=await imports.admin(actor);
    if(operation==='read'){
      const row=await readDeletedImport(catalog,input.operationId);if(!row||row.source_id!==sourceId)throw fail(404,'Deleted-source import not found');
      finishLocal(row);await store.flushOutbox();return deletedReceipt(row);
    }
    const fixed=validateDeletedImport(input,origin);if(fixed.sourceId!==sourceId)throw fail(409,'Deleted-source import belongs to another coordinator');
    await verifyPortalReceipt({action:'tombstone',proof:input.portalProof,row:{input:fixed}});
    const fingerprint=digest({input:fixed,actorId:principal.id});
    let row=await readDeletedImport(catalog,fixed.operationId);
    if(row){if(row.fingerprint!==fingerprint)throw fail(409,'Deleted-source import belongs to different immutable inputs');}
    else{
      if(await imports.read(fixed.operationId)||await imports.aborted(fixed.operationId)||await catalog.source(sourceId))throw fail(409,'An existing source or transfer operation cannot be replaced by a tombstone');
      // Never mask a partial native provision or imported history with a fence.
      if(storage.sql.exec("SELECT 1 FROM coordinator_meta WHERE key<>'source_id' LIMIT 1").toArray().length)throw fail(409,'The coordinator already contains source state');
      const existingTables=new Set(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row=>row.name));
      for(const table of ['sessions','versions','lifecycle_operations','events','publication_events','outbox','requests','request_jobs','import_abort_tombstones','import_chunks','import_history','import_releases','import_seals'])if(existingTables.has(table)&&storage.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length)throw fail(409,'The coordinator already contains source state');
      const organization=await catalog.organization(fixed.manifest.organizationId);if(organization?.status!=='active')throw fail(409,'Deleted-source import organization is unavailable');
      const {identity,deletion,legacyPublicRoots}=fixed.manifest,now=new Date().toISOString();
      const source={id:sourceId,system_id:identity.system_id,organization_id:organization.id,name:identity.system_id,lifecycle_status:'deleted',archived_at:null,deleted_at:identity.deleted_at,artifacts_namespace:deletion.owner,artifacts_repository:deletion.repository_name,artifacts_repository_id:deletion.artifacts_repository_id,...(legacyPublicRoots?{legacy_public_roots:legacyPublicRoots}:{}),imported_deleted_identity:{operationId:fixed.operationId,exportDigest:fixed.exportDigest,originalDeletionOperationId:deletion.id}};
      // Both inserts commit in D1 or neither does. There is no transaction
      // spanning D1 and SQLite: a crash here leaves an already-inactive source;
      // the same operation or readback completes the local audit/fence.
      await catalog.batch([
        ['INSERT INTO systems(id,system_id,organization_id,lifecycle_status,artifacts_namespace,artifacts_repository,artifacts_repository_id,source_json) VALUES(?,?,?,\'deleted\',?,?,?,?)',[source.id,source.system_id,source.organization_id,source.artifacts_namespace,source.artifacts_repository,source.artifacts_repository_id,canonical(source)]],
        ['INSERT INTO import_deleted_sources(operation_id,source_id,actor_id,fingerprint,input_json,created_at) VALUES(?,?,?,?,?,?)',[fixed.operationId,sourceId,principal.id,fingerprint,canonical(fixed),now]],
      ]);
      row=await readDeletedImport(catalog,fixed.operationId);
      if(row?.fingerprint!==fingerprint)throw fail(409,'Deleted-source reservation did not commit');
    }
    finishLocal(row);await store.flushOutbox();return deletedReceipt(row);
  };
}
