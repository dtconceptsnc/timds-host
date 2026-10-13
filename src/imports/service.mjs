import { fail } from '../store/errors.mjs';
import { ImportCatalog } from './catalog.mjs';
import { createImportStore } from './store.mjs';
import { validatePrepare,receipt,sameFence,UUID,canonical } from './contract.mjs';
import { verifyImportedRelease } from './releases.mjs';
import { createDeletedImporter,readDeletedImport } from './tombstone.mjs';

/** Every method is called under the owning coordinator's mutation queue. No
 * imported source is ready until SQLite seal+outbox are durable and D1 commits
 * the activation receipt, grants and lifecycle gate in one D1 transaction. */
export function createImporter({sourceId,storage,catalog,store,artifacts,releases,origin,verifyPortalReceipt=async()=>{throw fail(503,'Portal transfer proof verification is not configured');}}){
  const imports=new ImportCatalog(catalog),local=createImportStore({sourceId,storage,catalog,imports});
  const deletedImporter=createDeletedImporter({sourceId,storage,catalog,store,imports,origin,verifyPortalReceipt});
  async function repository(row){const expected=row.input.manifest.repository,actual=await artifacts.getRepository(expected.namespace,expected.name);if(!actual||String(actual.id)!==expected.id)throw fail(409,'Existing Artifacts repository identity does not match the frozen export');return {id:expected.id,namespace:expected.namespace,name:expected.name};}
  storage.sql.exec('CREATE TABLE IF NOT EXISTS import_abort_tombstones(operation_id TEXT PRIMARY KEY,input_json TEXT NOT NULL)');
  const abortedView=input=>({...input,receiptId:`import-abort:${input.operationId}`,hostState:'inactive',stage:'aborted',activationForbidden:true});
  const view=row=>({...receipt(row),verification:row.verification||null,receivedChunks:local.progress(row)});
  return async ({operation,actor,input})=>{
    await imports.admin(actor);
    if(operation==='tombstone')return deletedImporter({operation,actor,input});
    if(operation==='abort-unprepared'){
      if(!UUID.test(input.operationId||'')||input.sourceId!==sourceId||input.portalSourceId!==sourceId||input.origin!==origin||!Number.isSafeInteger(input.epoch)||input.epoch<1)throw fail(400,'An exact frozen transfer binding is required');
      const fixed={operationId:input.operationId,portalSourceId:sourceId,sourceId,origin,epoch:input.epoch};
      await verifyPortalReceipt({action:'abort-unprepared',proof:input.portalProof,row:{input:fixed}});
      if(await imports.read(input.operationId)||await catalog.source(sourceId))throw fail(409,'Existing source requires the prepared import abort protocol');
      const text=canonical(fixed),prior=storage.sql.exec('SELECT input_json FROM import_abort_tombstones WHERE operation_id=?',fixed.operationId).toArray()[0];
      if(prior&&prior.input_json!==text)throw fail(409,'Aborted operation binding differs');
      storage.sql.exec('INSERT OR IGNORE INTO import_abort_tombstones(operation_id,input_json) VALUES(?,?)',fixed.operationId,text);
      return abortedView(await imports.abortUnprepared(fixed,actor));
    }
    if(operation==='prepare'){
      if(store.deletionFence()||(await catalog.source(sourceId))?.lifecycle_status==='deleted')throw fail(409,'Deleted-source identity cannot activate');
      if(storage.sql.exec('SELECT 1 FROM import_abort_tombstones WHERE operation_id=?',input.operationId).toArray().length)throw fail(409,'This operation was durably aborted before import');
      const fixed=validatePrepare(input,origin);if(fixed.sourceId!==sourceId)throw fail(409,'Import is bound to another coordinator');
      await verifyPortalReceipt({action:'prepare',proof:input.portalProof,row:{input:fixed}});
      await repository({input:fixed});
      const row=await imports.prepare(fixed,actor);return view(row);
    }
    if(!UUID.test(input?.operationId||''))throw fail(400,'An import operation UUID is required');
    let row=await imports.read(input.operationId);
    if(!row){
      const aborted=await imports.aborted(input.operationId);if(aborted?.sourceId===sourceId&&operation==='read')return abortedView(aborted);
      const deleted=await readDeletedImport(catalog,input.operationId);
      if(deleted?.source_id===sourceId){if(operation!=='read')throw fail(409,'A deleted-source import can never activate or thaw');return deletedImporter({operation,actor,input});}
    }
    if(!row||row.source_id!==sourceId)throw fail(404,'Import operation not found');
    if(operation==='read')return view(row);
    if(operation==='abort')return view(await imports.abort(row,actor));
    if(row.state==='aborted')throw fail(409,'This import was durably aborted and can never activate');
    if(operation==='chunk'){
      if(row.state!=='prepared')throw fail(409,'The import has already been sealed');
      let release=null;
      if(input.chunk?.kind==='version'&&input.chunk.releaseManifestDigest)release=await verifyImportedRelease(releases,input.chunk.version,input.chunk.releaseManifestDigest);
      const result=await local.append(row,{position:input.position,chunk:input.chunk,release});
      await store.flushOutbox();return {...receipt(row),chunk:result};
    }
    if(operation==='seal'){
      if(row.state==='active')return view(row);
      const proof=await verifyPortalReceipt({action:'seal',proof:input.portalProof,row});sameFence(row,proof);
      await repository(row);
      const verification=local.seal(row);
      // A seal can be retried after a lost projection without rewriting history.
      await store.flushOutbox();
      row=await imports.seal(row,verification);return view(row);
    }
    if(operation==='activate'){
      const proof=await verifyPortalReceipt({action:'activate',proof:input.portalProof,row});sameFence(row,proof,{activation:true});
      if(input.activationId!==proof.activationId)throw fail(409,'Activation request does not match the durable portal intent');
      if(row.state==='active')return view(await imports.activate(row,input.activationId,actor));
      if(row.state!=='sealed')throw fail(409,'Import must be sealed before activation');
      await repository(row);
      // RELEASES is write-once and bucket-locked. Each version's physical bytes
      // were verified in its bounded chunk; the seal binds those durable proofs.
      // Rechecking all files here would defeat per-version resumability.
      if(local.seal(row).releaseProofDigest!==row.verification?.releaseProofDigest)throw fail(409,'Immutable release verification receipt changed');
      await store.flushOutbox();
      row=await imports.activate(row,input.activationId,actor);return view(row);
    }
    throw fail(404,'Unknown import operation');
  };
}
