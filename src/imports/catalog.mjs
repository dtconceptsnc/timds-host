import { randomUUID } from 'node:crypto';
import { fail, principalId } from '../store/errors.mjs';
import { canonical,digest,receipt,historyIssuer } from './contract.mjs';

/** D1 reservation and final gate. Call mutations only from the source coordinator
 * serial queue. This is not a transaction spanning D1 and DO SQLite. */
export class ImportCatalog {
  constructor(catalog,{clock=()=>Date.now(),ids=randomUUID}={}){this.catalog=catalog;this.clock=clock;this.ids=ids;}
  async read(id){const row=await this.catalog.first('SELECT * FROM import_operations WHERE operation_id=?',id);return row&&{...row,input:JSON.parse(row.input_json),verification:row.verification_json&&JSON.parse(row.verification_json)};}
  async aborted(id){const row=await this.catalog.first('SELECT * FROM import_abort_tombstones WHERE operation_id=?',id);return row&&JSON.parse(row.input_json);}
  async abortUnprepared(input,actor){
    const principal=await this.admin(actor),prior=await this.aborted(input.operationId);
    if(prior){if(canonical(prior)!==canonical(input))throw fail(409,'Aborted operation binding differs');return prior;}
    await this.catalog.run('INSERT INTO import_abort_tombstones(operation_id,source_id,epoch,input_json,actor_id,created_at) VALUES(?,?,?,?,?,?)',input.operationId,input.sourceId,input.epoch,canonical(input),principal.id,new Date(this.clock()).toISOString());
    return this.aborted(input.operationId);
  }
  async admin(actor){const principal=await this.catalog.principal(principalId(actor));if(!principal?.admin||principal.status!=='active')throw fail(403,'An active administrator is required');return principal;}
  async identities(manifest,{prepare=false}={}){
    const organization=await this.catalog.organization(manifest.source.organization_id),statements=[];
    if(organization?.status!=='active')throw fail(409,'Import organization is unavailable');
    for(const mapping of manifest.principalMap){
      const principal=await this.catalog.principal(mapping.hostPrincipalId);
      if(mapping.mode==='archive'){
        const issuer=historyIssuer(manifest),existing=await this.catalog.first('SELECT id FROM principals WHERE issuer=? AND subject=?',issuer,mapping.portalPrincipalId);
        if(existing&&existing.id!==mapping.hostPrincipalId)throw fail(409,'Historical identity already has a different explicit host UUID');
        if(principal){
          if(principal.issuer!==issuer||principal.subject!==mapping.portalPrincipalId||principal.type!==mapping.type||principal.status!=='inactive'||principal.admin)throw fail(409,'Archive identity collides with an authenticatable identity');
        }else if(prepare)statements.push(['INSERT INTO principals(id,type,name,issuer,subject,status,admin) VALUES(?,?,?,?,?,\'inactive\',0)',[mapping.hostPrincipalId,mapping.type,mapping.name,issuer,mapping.portalPrincipalId]]);
        else throw fail(409,'Historical identity is unavailable');
      }else if(!principal||principal.type!==mapping.type||String(principal.issuer).startsWith('urn:timds:portal-history:'))throw fail(409,'Explicit live mapping does not identify an existing host identity');
    }
    for(const grant of manifest.grants)if(Object.values(grant).includes(true)&&(await this.catalog.principal(grant.principalId))?.status!=='active')throw fail(409,'Cannot import a grant for an inactive principal');
    return statements;
  }
  async prepare(input,actor){
    if(await this.aborted(input.operationId))throw fail(409,'This operation was durably aborted before import');
    const principal=await this.admin(actor),fingerprint=digest({input,actorId:principal.id});
    const prior=await this.read(input.operationId);
    if(prior){if(prior.fingerprint!==fingerprint)throw fail(409,'Import operation belongs to different immutable inputs');return prior;}
    const archiveIdentities=await this.identities(input.manifest,{prepare:true});
    const source={...input.manifest.source,lifecycle_status:'importing',archived_at:null};
    // The catalogue row has no published pointer while staging; the complete
    // original source remains bound in the immutable export manifest.
    for(const key of ['published_version_id','published_version','source_commit','content_digest','artifact_ref','source_ref'])delete source[key];
    const stage=this.ids(),now=new Date(this.clock()).toISOString();
    await this.catalog.batch([
      ...archiveIdentities,
      ['INSERT INTO systems(id,system_id,organization_id,lifecycle_status,artifacts_namespace,artifacts_repository,artifacts_repository_id,source_json) VALUES(?,?,?,?,?,?,?,?)',[source.id,source.system_id,source.organization_id,'importing',source.artifacts_namespace,source.artifacts_repository,source.artifacts_repository_id,canonical(source)]],
      ['INSERT INTO import_operations(operation_id,stage_id,source_id,actor_id,fingerprint,input_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,\'prepared\',?,?)',[input.operationId,stage,source.id,principal.id,fingerprint,canonical(input),now,now]],
    ]);
    return this.read(input.operationId);
  }
  async seal(row,verification){
    const text=canonical(verification);
    await this.catalog.run("UPDATE import_operations SET state='sealed',verification_json=?,updated_at=? WHERE operation_id=? AND state='prepared'",text,new Date(this.clock()).toISOString(),row.operation_id);
    const saved=await this.read(row.operation_id);
    if(!['sealed','active'].includes(saved?.state)||saved.verification_json!==text)throw fail(409,'Import seal is unavailable or changed');
    return saved;
  }
  async tombstoneRequests(row,ids){
    const unique=[...new Set(ids)];if(!unique.length)return;
    const fingerprint=`import:${row.stage_id}:${row.input.exportDigest}`;
    await this.catalog.batch(unique.map(id=>['INSERT INTO request_reservations(request_id,source_id,fingerprint,receipt_json) VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING',[id,row.source_id,fingerprint,canonical({imported:true,requestId:id,sourceId:row.source_id,stageId:row.stage_id})]]));
    const rows=await this.catalog.all(`SELECT source_id,fingerprint FROM request_reservations WHERE request_id IN (${unique.map(()=>'?').join(',')})`,...unique);
    if(rows.length!==unique.length||rows.some(item=>item.source_id!==row.source_id||item.fingerprint!==fingerprint))throw fail(409,'Historical Request UUID is already reserved by another operation');
  }
  async activate(row,activationId,actor){
    const principal=await this.admin(actor);
    if(row.state==='active'){if(row.activation_id!==activationId)throw fail(409,'A different activation intent already owns this source');return row;}
    if(row.state!=='sealed')throw fail(409,'Only a verified, sealed import can be activated');
    await this.identities(row.input.manifest);
    const now=new Date(this.clock()).toISOString(),statements=[];
    const gate="EXISTS(SELECT 1 FROM import_operations WHERE operation_id=? AND state='active' AND activation_id=?)";
    statements.push([`UPDATE import_operations SET state='active',activation_id=?,updated_at=? WHERE operation_id=? AND state='sealed'
      AND EXISTS(SELECT 1 FROM principals WHERE id=? AND status='active' AND admin=1)
      AND EXISTS(SELECT 1 FROM organizations WHERE id=json_extract(import_operations.input_json,'$.manifest.source.organization_id') AND status='active')
      AND NOT EXISTS(SELECT 1 FROM json_each(import_operations.input_json,'$.manifest.grants') g
        WHERE (json_extract(g.value,'$.read')=1 OR json_extract(g.value,'$.write')=1 OR json_extract(g.value,'$.publish')=1)
        AND NOT EXISTS(SELECT 1 FROM principals p WHERE p.id=json_extract(g.value,'$.principalId') AND p.status='active'))`,[activationId,now,row.operation_id,principal.id]]);
    for(const grant of row.input.manifest.grants){
      statements.push([`INSERT INTO system_access(source_id,principal_id,can_read,can_write) SELECT ?,?,?,? WHERE ${gate} AND EXISTS(SELECT 1 FROM principals WHERE id=? AND status='active') ON CONFLICT(source_id,principal_id) DO UPDATE SET can_read=excluded.can_read,can_write=excluded.can_write`,[row.source_id,grant.principalId,Number(grant.read||grant.write),Number(grant.write),row.operation_id,activationId,grant.principalId]]);
      if(grant.publish)statements.push([`INSERT INTO publishers(source_id,principal_id) SELECT ?,? WHERE ${gate} AND EXISTS(SELECT 1 FROM principals WHERE id=? AND status='active') ON CONFLICT DO NOTHING`,[row.source_id,grant.principalId,row.operation_id,activationId,grant.principalId]]);
    }
    statements.push([`UPDATE systems SET lifecycle_status='ready',authority_version=authority_version+1 WHERE id=? AND lifecycle_status='importing' AND ${gate}`,[row.source_id,row.operation_id,activationId]]);
    await this.catalog.batch(statements);
    const saved=await this.read(row.operation_id),source=await this.catalog.source(row.source_id);
    if(saved?.state!=='active'||saved.activation_id!==activationId||source?.lifecycle_status!=='ready')throw fail(409,'Activation did not commit');
    return saved;
  }
  async abort(row,actor){
    await this.admin(actor);
    await this.catalog.batch([
      ["UPDATE import_operations SET state='aborted',updated_at=? WHERE operation_id=? AND state IN ('prepared','sealed')",[new Date(this.clock()).toISOString(),row.operation_id]],
      ["UPDATE systems SET lifecycle_status='import_aborted' WHERE id=? AND lifecycle_status='importing' AND EXISTS(SELECT 1 FROM import_operations WHERE operation_id=? AND state='aborted')",[row.source_id,row.operation_id]],
    ]);
    const saved=await this.read(row.operation_id);if(saved?.state!=='aborted')throw fail(409,'An activated import cannot be aborted');return saved;
  }
  receipt(row){return receipt(row);}
}
