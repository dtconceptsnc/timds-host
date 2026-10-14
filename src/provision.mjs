import { fail } from './store/errors.mjs';
import { validateTimdsChangeSet } from './domain/sessions.mjs';
import { createHash } from 'node:crypto';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const slug=/^[a-z0-9][a-z0-9-]{0,62}$/;
/** Administrative source initialization uses a stable operation/source UUID.
 * A failed external step retains its receipt and can be resumed with the same
 * input. Existing repositories are never silently adopted by this endpoint. */
export function createProvisioner({getCoordinator}) {
  return async function provision({input,creationInput,actor,env,context,catalog}) {
    if(!uuid.test(input.operationId||'')||!uuid.test(input.sourceId||'')||!uuid.test(input.organizationId||'')||!slug.test(input.namespace||'')||!slug.test(input.repository||'')||typeof input.systemId!=='string'||!input.systemId.trim()||input.systemId.length>300)throw fail(400,'Provide operation, source and organization UUIDs, systemId, namespace and repository');
    if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>200))throw fail(400,'Source name must be 1–200 characters');
    if(input.grantPublisher!==undefined&&typeof input.grantPublisher!=='boolean')throw fail(400,'grantPublisher must be a boolean');
    const files=validateTimdsChangeSet({baseRevision:'0'.repeat(40),changedFiles:input.files,deletedPaths:[],note:'Initialize hosted Design System'}).changedFiles;
    const manifestFile=files.find(file=>file.path==='timds.json');
    let manifest;try{manifest=JSON.parse(Buffer.from(manifestFile.content,'base64').toString('utf8'));}catch{throw fail(400,'A valid timds.json is required');}
    if(manifest.systemId!==input.systemId)throw fail(400,'The manifest must identify this Design System');
    const organization=await catalog.organization(input.organizationId);
    if(organization?.status!=='active')throw fail(409,'Create an active organization first');
    const source={id:input.sourceId,system_id:input.systemId,organization_id:input.organizationId,name:input.name??input.systemId,artifacts_namespace:input.namespace,artifacts_repository:input.repository,manifest_json:manifest,...(creationInput?{creation_input:creationInput}:{})};
    // Hash canonical paths/modes and exact file bytes, not just the manifest.
    // D1 reserves this input before any Artifacts or coordinator side effect.
    const provisionInput={fileTreeDigest:createHash('sha256').update(JSON.stringify(files.map(file=>[file.path,file.mode,file.content]))).digest('hex'),grantPublisher:input.grantPublisher===true};
    const reservation=await catalog.reserveSystem({operationId:input.operationId,actor,source,provisionInput});
    const coordinator=getCoordinator(context,source.id);
    let operation=await coordinator.initializeSource({operationId:input.operationId,source,reservation});
    const ensurePublisher=async()=>{
      if(!provisionInput.grantPublisher)return;
      const grant=await coordinator.api({operation:'authority',actor,args:[{operationId:`${input.operationId}:publisher`,command:{principalId:actor.principalId,read:true,write:true,publish:true}}]});
      if(!grant.ok)throw fail(grant.error.statusCode,grant.error.message);
    };
    // Completion and the authority mutation are separately durable. A lost
    // response between them must resume the original grant on the same ID.
    if(operation.status==='completed'){
      await ensurePublisher();
      return{apiVersion:1,source:await coordinator.currentSource()};
    }
    operation=await coordinator.checkpointProvision({operationId:input.operationId,lease:operation.lease,patch:{provisionInput:reservation.provisionInput}});
    // Creation and its receipt share the coordinator's serial queue with
    // deletion review/fencing. Concurrent retries cannot create twice, and a
    // delayed create cannot race a confirmed absent-repository inventory.
    operation=await coordinator.ensureProvisionRepository({operationId:input.operationId,lease:operation.lease});
    const repositoryReceipt=operation.checkpoints_json.repositoryReceipt;
    const initialized=await coordinator.provisionFiles({operationId:input.operationId,lease:operation.lease,files});
    await coordinator.completeProvision({operationId:input.operationId,lease:operation.lease,repositoryReceipt,sourceCommit:initialized.headCommit,manifest});
    await ensurePublisher();
    return{apiVersion:1,source:await coordinator.currentSource()};
  };
}
