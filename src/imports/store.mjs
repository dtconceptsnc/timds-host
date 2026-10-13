import { fail } from '../store/errors.mjs';
import { canonical,digest,UUID,check } from './contract.mjs';
import { validateLegacyReleaseMetadata } from '../public/legacy.mjs';

const tables=new Set(['sessions','members','submissions','publications','events','publication_events']);
const archiveTables=new Set(['claims','jobs','requests','observations','request_jobs','lifecycle_operations','legacy_drafts','legacy_draft_builds','assets','asset_uploads','artifact_upload_leases','principals','publishers','publisher_events','identities','portal_profiles']);
const terminal={sessions:['closed','expired'],submissions:['published','closed'],publications:['published','superseded']};
const resourceKinds={sessions:'session',submissions:'submission',publications:'publication',versions:'version'};
const secretKeys=/^(?:access_token|refresh_token|client_secret|plaintext|private_key|authorization|password|secret|credentials|callback_token)$/i;
function noSecrets(value){if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){check(!secretKeys.test(key),'Export history must omit credential material');noSecrets(item);}}

export function createImportStore({storage,sourceId,catalog,imports}) {
  const sql=storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS import_chunks(stage_id TEXT NOT NULL,position INTEGER NOT NULL,digest TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(stage_id,position));
    CREATE TABLE IF NOT EXISTS import_history(stage_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(stage_id,kind,id));
    CREATE TABLE IF NOT EXISTS import_releases(stage_id TEXT NOT NULL,version_id TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(stage_id,version_id));
    CREATE TABLE IF NOT EXISTS import_seals(stage_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL);`);
  const first=(query,...values)=>sql.exec(query,...values).toArray()[0]||null;
  const get=(table,id)=>{const row=first(`SELECT row_json FROM ${table} WHERE id=?`,id);return row&&JSON.parse(row.row_json);};
  const enqueue=(kind,row)=>sql.exec('INSERT INTO outbox(kind,row_json) VALUES(?,?)',kind,canonical(row));
  const insert=(table,row)=>{
    // Preserve stamp property order: its authored JSON bytes are immutable.
    const id=table==='members'?`${row.session_id}:${row.principal_id}`:row.id;
    const prior=get(table,id),text=JSON.stringify(row);
    // The coordinator numbers imported events after insert; a replay compares the original row.
    if(prior){const {seq,...original}=prior;if(canonical(table==='events'?original:prior)!==canonical(row))throw fail(409,'Imported history conflicts with an existing row');return;}
    sql.exec(`INSERT INTO ${table}(id,row_json) VALUES(?,?)`,id,text);
    if(resourceKinds[table])enqueue('resource',{kind:resourceKinds[table],id:row.id,tombstone:table==='sessions'});
    if(table==='events')enqueue('event',row);
    if(table==='publication_events')enqueue('publication',row);
    if(table==='sessions')enqueue('session',row);
  };
  function materialize(original,table,row){
    const maps=new Map(row.input.manifest.principalMap.map(item=>[item.portalPrincipalId,item.hostPrincipalId]));
    const result={...original};
    const map=id=>{if(!id)return null;const mapped=maps.get(id);if(!mapped)throw fail(409,'History refers to a principal without an explicit mapping');return mapped;};
    for(const key of ['owner_principal_id','principal_id','actor_principal_id','published_by','invited_by'])if(result[key])result[key]=map(result[key]);
    if(table==='sessions'&&!result.owner_principal_id)result.owner_principal_id=map(original.owner_user_id||original.owner_token_id);
    if(['events','publication_events','publications'].includes(table)&&!result.actor_principal_id&&original.actor_user_id)result.actor_principal_id=map(original.actor_user_id);
    if(table==='sessions')Object.assign(result,{lease_token:null,lease_expires_at:null,live_state:'stopped',live_url:'',sandbox_id:'',token_id:'',kind:result.kind||'session'});
    if(table==='publications')Object.assign(result,{checkpoints_json:result.checkpoints_json||{},result_json:result.result_json||{}});
    if(table==='events')delete result.seq;
    return result;
  }
  function validateRow(item,table){
    check(item&&typeof item==='object'&&!Array.isArray(item)&&new TextEncoder().encode(canonical(item)).length<=1024*1024,'History rows are limited to 1 MiB');noSecrets(item);
    if(table==='members')check(UUID.test(item.session_id||'')&&UUID.test(item.principal_id||''),'Membership requires its original composite identity');
    else if(!archiveTables.has(table))check(UUID.test(item.id||''),'Live history rows require their original UUID');
    if(item.source_id!=null)check(item.source_id===sourceId,'History row belongs to another source');
    if(item.design_system_source_id!=null)check(item.design_system_source_id===sourceId,'History row belongs to another source');
    if(terminal[table])check(terminal[table].includes(item.status),'Imported sessions, submissions and publications must be terminal');
    if(['sessions','submissions','publications','events'].includes(table))check(item.source_id===sourceId,'Source-bound history is required');
    if(table==='publication_events')check(item.design_system_source_id===sourceId,'Publication event belongs to another source');
  }
  return {
    chunk(row,position){const saved=first('SELECT digest,receipt_json FROM import_chunks WHERE stage_id=? AND position=?',row.stage_id,position);return saved&&{digest:saved.digest,...JSON.parse(saved.receipt_json)};},
    progress(row){return sql.exec('SELECT position,digest FROM import_chunks WHERE stage_id=? ORDER BY position',row.stage_id).toArray();},
    async append(row,{position,chunk,release}){
      check(Number.isSafeInteger(position)&&position>=0&&position<row.input.manifest.chunks.length,'Unknown import chunk position');
      const hash=digest(chunk);check(hash===row.input.manifest.chunks[position],'Chunk does not match its frozen export digest');
      check(new TextEncoder().encode(canonical(chunk)).length<=2*1024*1024,'Import chunks are limited to 2 MiB');
      const prior=this.chunk(row,position);if(prior)return prior;
      const items=[];
      if(chunk.kind==='version'){
        const value=chunk.version,original=chunk.original;validateRow(value,'versions');validateRow(original,'versions');check(value.source_id===sourceId&&original.design_system_source_id===sourceId&&typeof value.version_label==='string'&&value.version_label.length<=100,'Version source and label are required');
        for(const key of Object.keys(original))check(canonical(value[key])===canonical(original[key]),'Portable version must preserve every original legacy field');
        // A legacy duplicate stays intact in import_history. It has no live
        // artifact binding unless this exact version passed RELEASES verification.
        const derived={...value};if(!release){delete derived.artifact_ref;delete derived.source_ref;}
        items.push({table:'versions',original,value:derived});
      }else{
        check(chunk.kind==='rows'&&(tables.has(chunk.table)||archiveTables.has(chunk.table))&&Array.isArray(chunk.rows)&&chunk.rows.length<=100,'Unknown history chunk or too many rows');
        for(const original of chunk.rows){validateRow(original,chunk.table);items.push({table:chunk.table,original,value:archiveTables.has(chunk.table)?original:materialize(original,chunk.table,row)});}
      }
      for(const item of items)if(item.table==='sessions'&&item.value.idempotency_key){
        const reserved=await catalog.reserveStart(item.value);
        if(reserved.session_id!==item.value.id||canonical(reserved.session)!==canonical(item.value))throw fail(409,'Imported session idempotency key is already reserved');
      }
      // Portal Requests lived in observations/jobs. Preserve them as evidence;
      // never invent a live host runner or replay an old UUID as fresh work.
      const requestIds=items.flatMap(item=>[item.original.originating_request_id,
        item.table==='jobs'&&item.original.job_type==='timds_designer_request'?item.original.payload_json?.requestId:null]).filter(Boolean);
      check(requestIds.every(id=>UUID.test(id)),'Historical Request UUID is invalid');
      await imports.tombstoneRequests(row,requestIds);
      return storage.transactionSync(()=>{
        for(const {table,original,value}of items){
          const historyId=original.id||(table==='members'?`${original.session_id}:${original.principal_id}`:digest(original));
          const history=first('SELECT row_json FROM import_history WHERE stage_id=? AND kind=? AND id=?',row.stage_id,table,historyId),text=canonical(original);
          if(history&&history.row_json!==text)throw fail(409,'Original import history changed');
          sql.exec('INSERT OR IGNORE INTO import_history(stage_id,kind,id,row_json) VALUES(?,?,?,?)',row.stage_id,table,historyId,text);
          if(tables.has(table)||table==='versions')insert(table,value);
        }
        if(release)sql.exec('INSERT INTO import_releases(stage_id,version_id,receipt_json) VALUES(?,?,?) ON CONFLICT(stage_id,version_id) DO NOTHING',row.stage_id,release.versionId,canonical(release));
        const result={position,digest:hash,rows:items.length,...(release?{release}:{})};
        sql.exec('INSERT INTO import_chunks(stage_id,position,digest,receipt_json) VALUES(?,?,?,?)',row.stage_id,position,hash,canonical(result));return result;
      });
    },
    seal(row){
      const prior=first('SELECT receipt_json FROM import_seals WHERE stage_id=?',row.stage_id);if(prior)return JSON.parse(prior.receipt_json);
      const progress=this.progress(row);if(progress.length!==row.input.manifest.chunks.length||progress.some((item,index)=>item.position!==index||item.digest!==row.input.manifest.chunks[index]))throw fail(409,'Import chunks are incomplete');
      for(const [table,expected]of Object.entries(row.input.manifest.auditSnapshot.digests)){
        const originals=sql.exec('SELECT row_json FROM import_history WHERE stage_id=? AND kind=?',row.stage_id,table).toArray().map(item=>JSON.parse(item.row_json));
        originals.sort((a,b)=>{const x=canonical(a),y=canonical(b);return x<y?-1:x>y?1:0;});
        if(digest(originals)!==expected)throw fail(409,'Copied audit snapshot digest differs from its declared capture');
      }
      // Published label lookup deliberately retains the original first event.
      // Later duplicate rows/events remain historical, never silently rewritten.
      const firstByLabel=new Map(),firstEventByLabel=new Map();
      for(const item of sql.exec('SELECT row_json FROM publication_events ORDER BY json_extract(row_json,\'$.created_at\'),id')){
        const event=JSON.parse(item.row_json);
        const version=get('versions',event.design_system_version_id);
        if(!version||version.source_id!==sourceId||version.version_label!==event.version_label||version.content_digest!==event.content_digest)throw fail(409,'Publication history does not match its immutable version');
        if(!firstByLabel.has(event.version_label)){firstByLabel.set(event.version_label,version);firstEventByLabel.set(event.version_label,event.id);if(!first('SELECT 1 FROM import_releases WHERE stage_id=? AND version_id=?',row.stage_id,version.id))throw fail(409,'Every first published label needs verified immutable release bytes');}
        if(version.artifact_ref){
          if(row.input.manifest.source.legacy_public_roots&&!version.legacy_public)throw fail(409,'Legacy public roots require exact serving provenance');
          validateLegacyReleaseMetadata(version,{firstPublicationEventId:firstEventByLabel.get(event.version_label)});
          const initial=firstByLabel.get(event.version_label);if(version.content_digest!==initial.content_digest||version.source_commit!==initial.source_commit||canonical(version.stamp)!==canonical(initial.stamp))throw fail(409,'Duplicate version has a conflicting public artifact binding');}
      }
      // Audit references intentionally outlive deleted sessions/submissions.
      for(const [table,foreign,target]of [['members','session_id','sessions'],['submissions','session_id','sessions'],['publications','submission_id','submissions']]){
        if(first(`SELECT 1 FROM ${table} r WHERE json_extract(r.row_json,'$.${foreign}') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${target} t WHERE t.id=json_extract(r.row_json,'$.${foreign}')) LIMIT 1`))throw fail(409,'Imported history contains a missing parent');
      }
      const pointer=row.input.manifest.pointer,version=get('versions',pointer.versionId),event=get('publication_events',pointer.eventId);
      if(!version?.artifact_ref||!event||event.design_system_version_id!==version.id||!first('SELECT 1 FROM import_releases WHERE stage_id=? AND version_id=?',row.stage_id,version.id))throw fail(409,'Published pointer does not identify a verified released version and event');
      const original=row.input.manifest.source;
      if(original.published_version_id&&original.published_version_id!==version.id||original.published_version!==version.version_label||original.content_digest!==version.content_digest||original.source_commit!==version.source_commit)throw fail(409,'Frozen source pointer changed during export');
      const projection={published_version:version.version_label,source_commit:version.source_commit,content_digest:version.content_digest,published_version_id:version.id,artifact_ref:version.artifact_ref,source_ref:version.source_ref||null,initial_publication_required:false};
      const releases=this.releases(row);
      const verification={exportDigest:row.input.exportDigest,chunks:progress.length,pointer:{versionId:version.id,eventId:event.id},releaseCount:releases.length,releaseProofDigest:digest(releases),historyCount:first('SELECT COUNT(*) AS n FROM import_history WHERE stage_id=?',row.stage_id).n};
      storage.transactionSync(()=>{sql.exec("INSERT INTO coordinator_meta(key,value) VALUES('pointer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",canonical(projection));enqueue('pointer',projection);sql.exec('INSERT INTO import_seals(stage_id,receipt_json) VALUES(?,?)',row.stage_id,canonical(verification));});
      return verification;
    },
    releases(row){return sql.exec('SELECT receipt_json FROM import_releases WHERE stage_id=? ORDER BY version_id',row.stage_id).toArray().map(item=>JSON.parse(item.receipt_json));},
    version:id=>get('versions',id),
  };
}
