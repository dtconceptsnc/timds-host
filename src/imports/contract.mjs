import { createHash } from 'node:crypto';
import { fail } from '../store/errors.mjs';
import { legacySourceRoots } from '../public/host-routes.mjs';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const HISTORY_ISSUER_PREFIX='urn:timds:portal-history:';
export const historyIssuer=manifest=>HISTORY_ISSUER_PREFIX+manifest.portalOrigin;
export const DIGEST = /^[a-f0-9]{64}$/;
export const canonical = value => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])]));
  return value;
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const byteDigest = value => createHash('sha256').update(value).digest('hex');
export const check = (value,message) => {if(!value)throw fail(400,message);};
export function validatePrepare(input,origin) {
  check(input && UUID.test(input.operationId||'') && UUID.test(input.portalSourceId||'') && input.sourceId===input.portalSourceId,'Preserve the original source UUID and provide an operation UUID');
  check(Number.isSafeInteger(input.epoch)&&input.epoch>0&&DIGEST.test(input.snapshotDigest||'')&&DIGEST.test(input.exportDigest||''),'Provide the frozen ownership epoch and snapshot/export digests');
  const manifest=input.manifest,source=manifest?.source,repository=manifest?.repository;
  let portal;try{portal=new URL(manifest?.portalOrigin);}catch{throw fail(400,'The exact portal origin is required');}
  check(portal.protocol==='https:'&&portal.origin===manifest.portalOrigin&&!portal.username&&!portal.password,'The exact HTTPS portal origin is required');
  check(manifest&&Buffer.byteLength(canonical(manifest))<=1024*1024,'The export manifest is limited to 1 MiB');
  check(manifest?.schemaVersion===1&&source?.id===input.sourceId&&UUID.test(source.organization_id||'')&&typeof source.system_id==='string'&&source.system_id.length>0&&source.system_id.length<=300,'A source export manifest is required');
  check(typeof repository?.id==='string'&&repository.id.length>0&&repository.id.length<=200&&!/[\x00-\x20\x7f]/.test(repository.id)&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(repository?.namespace||'')&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(repository?.name||'')&&repository.id===source.artifacts_repository_id&&repository.namespace===source.artifacts_namespace&&repository.name===source.artifacts_repository,'The exact existing repository ID, namespace and name must match the source');
  if(source.legacy_public_roots){try{legacySourceRoots(source.legacy_public_roots);}catch{throw fail(400,'Invalid imported legacy public roots');}}
  if(source.public_root_url){
    let publicRoot;try{publicRoot=new URL(source.public_root_url);}catch{throw fail(400,'Invalid imported public root');}
    check(publicRoot.protocol==='https:'&&!publicRoot.username&&!publicRoot.password&&publicRoot.pathname==='/'&&!publicRoot.search&&!publicRoot.hash&&!publicRoot.port&&publicRoot.origin!==origin&&source.legacy_public_roots?.hosts.includes(publicRoot.hostname),'Imported public root must be a distinct explicitly reviewed legacy hostname');
  }
  check(manifest.originalSource?.id===source.id,'Retain the exact original portal source row');
  check(manifest.originalSource.lifecycle_status==='ready'&&!manifest.originalSource.archived_at&&source.lifecycle_status==='ready'&&!source.archived_at,'Only a ready, unarchived source may become an active import; deleted identities require tombstone migration');
  for(const key of ['system_id','artifacts_namespace','artifacts_repository','published_version','source_commit','content_digest'])check(source[key]===manifest.originalSource[key],'Normalized source provenance differs from the original portal row');
  check(Array.isArray(manifest.principalMap)&&manifest.principalMap.length<=200&&Array.isArray(manifest.grants)&&manifest.grants.length<=100,'Provide explicit principal mappings (up to 200) and grants (up to 100)');
  const audit=manifest.auditSnapshot;
  check(audit?.kind==='point-in-time'&&Number.isFinite(Date.parse(audit.capturedAt))&&audit.digests&&Object.keys(audit.digests).length===3&&['observations','principals','portal_profiles'].every(table=>DIGEST.test(audit.digests[table]||'')),'Explicit copied audit snapshot digests are required');
  const keys=new Set(),targets=new Set(),archiveTargets=new Set();
  for(const entry of manifest.principalMap){
    check(UUID.test(entry?.portalPrincipalId||'')&&UUID.test(entry?.hostPrincipalId||'')&&['user','agent'].includes(entry.type)&&!keys.has(entry.portalPrincipalId)&&[undefined,'existing','archive'].includes(entry.mode),'Principal mappings must be explicit and unique');
    if(entry.mode==='archive'){
      check(!targets.has(entry.hostPrincipalId)&&typeof entry.name==='string'&&entry.name.length>0&&entry.name.length<=320,'Archive identities require a distinct explicit host UUID and display name');
      archiveTargets.add(entry.hostPrincipalId);
    }else check(!archiveTargets.has(entry.hostPrincipalId),'A history identity cannot also map to a live identity');
    keys.add(entry.portalPrincipalId);targets.add(entry.hostPrincipalId);
  }
  const grantees=new Set();
  for(const grant of manifest.grants){check(targets.has(grant?.principalId)&&!archiveTargets.has(grant.principalId)&&!grantees.has(grant.principalId)&&['read','write','publish'].every(key=>typeof grant[key]==='boolean'),'Grants must name mapped principals with explicit permissions');grantees.add(grant.principalId);}
  check(Array.isArray(manifest.chunks)&&manifest.chunks.length>0&&manifest.chunks.length<=10000&&manifest.chunks.every(value=>DIGEST.test(value)),'Provide the ordered canonical chunk digests');
  check(UUID.test(manifest.pointer?.versionId||'')&&UUID.test(manifest.pointer?.eventId||''),'The exact published version and pointer event are required');
  check(digest(manifest)===input.exportDigest,'The export digest does not match the canonical manifest');
  return {operationId:input.operationId,portalSourceId:input.portalSourceId,sourceId:input.sourceId,origin,epoch:input.epoch,snapshotDigest:input.snapshotDigest,exportDigest:input.exportDigest,manifest};
}
export function receipt(row) {
  const input=row.input;
  return {receiptId:`import:${row.stage_id}:${row.state}`,operationId:row.operation_id,portalSourceId:input.portalSourceId,sourceId:row.source_id,origin:input.origin,epoch:input.epoch,snapshotDigest:input.snapshotDigest,exportDigest:input.exportDigest,stageId:row.stage_id,hostState:row.state==='active'?'active':'inactive',stage:row.state,...(row.activation_id?{activationId:row.activation_id}:{}),...(row.state==='aborted'?{activationForbidden:true}:{})};
}
export function sameFence(row,input,{activation=false}={}) {
  const expected=receipt(row);
  for(const key of ['operationId','portalSourceId','sourceId','origin','epoch','snapshotDigest','exportDigest','stageId'])if(input?.[key]!==expected[key])throw fail(409,'Portal ownership receipt does not match this import');
  if(activation&&!UUID.test(input.activationId||''))throw fail(400,'A durable portal activation intent UUID is required');
}
