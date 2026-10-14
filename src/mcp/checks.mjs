import { fail } from '../store/errors.mjs';
import { isFileTree, readTreeManifest, safeTreePath } from '../repository/file-trees.mjs';
import { snapshotFileBytes, fileBytePage } from './files.mjs';
import { authoredWorkspace } from './authoring.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const documents={brand:'brand.json',tokens:'tokens.json',index:'index.json',designs:'designs.json',formats:'formats.json',changelog:'changelog.json',bundle:'bundle.json',llms:'llms.txt',llmsFull:'llms-full.txt'};
const sameHead=(session,check)=>session.baseRevision===check.baseRevision&&(session.lastUpdateHash||'')===check.lastUpdateHash;
const ready=session=>session.status==='open'&&(!session.expiresAt||Date.parse(session.expiresAt)>Date.now());
const key=id=>`session-check:${id}`;
function publicReceipt(result,record) {
  const {id,sessionId,baseRevision,lastUpdateHash,status,checks,createdAt,completedAt,error}=record;
  return {apiVersion:1,session:result.session,check:{id,sessionId,baseRevision,lastUpdateHash,status,checks,createdAt,completedAt,...(error?{error}:{}),stale:!ready(result.session)||!sameHead(result.session,record)}};
}

/** Checks retain an immutable input and receipt, never a publication pointer.
 * Slow builds run outside the writer queue. Every reservation, retry, result
 * commit and read rechecks current coordinator authority and membership. */
export function createSessionChecks({sourceId,storage,bucket,engine,build}) {
  const running=new Map();
  const status=(actor,id,write=false)=>engine.invoke({operation:'status',actor:{...actor,accessMode:write?'write':'read'},args:[id]});
  const current=async(actor,id)=>{
    let result=await status(actor,id);
    if(ready(result.session)) {
      // A native CLI/runner push can advance Git before its session row. Read
      // the authoritative fork before claiming an old check is still current.
      try {result=await engine.invoke({operation:'snapshot',actor:{...actor,accessMode:'read'},args:[id]});}
      catch(error){if(error.statusCode!==410)throw error;result=await status(actor,id);if(ready(result.session))throw error;}
    }
    return result;
  };
  const recordFor=async(sessionId,checkId)=>{
    if(!uuid.test(checkId||''))throw fail(400,'A check UUID is required');
    const record=await storage.get(key(checkId.toLowerCase()));
    if(!record||record.sourceId!==sourceId||record.sessionId!==sessionId)throw fail(404,'Session check not found');
    return record;
  };
  const verifyRetry=(record,actor,sessionId,input)=>{
    if(record.sourceId!==sourceId||record.sessionId!==sessionId||record.requestedBy!==actor.principalId||record.baseRevision!==input.baseRevision||record.lastUpdateHash!==input.lastUpdateHash)throw fail(409,'Check ID is already bound to another request');
  };
  async function run(actor,sessionId,input) {
    if(!uuid.test(input?.checkId||'')||!/^[a-f0-9]{40}$/.test(input.baseRevision||'')||typeof input.lastUpdateHash!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/.test(input.lastUpdateHash))throw fail(400,'Check ID and exact session revision/hash are required');
    input={...input,checkId:input.checkId.toLowerCase()};
    await status(actor,sessionId,true);
    let record=await storage.get(key(input.checkId));
    if(record)verifyRetry(record,actor,sessionId,input);
    if(record&&record.status!=='running')return publicReceipt(await current(actor,sessionId),record);
    if(!record) {
      const snapshot=await engine.invoke({operation:'snapshot',actor:{...actor,accessMode:'write'},args:[sessionId]});
      if(!sameHead(snapshot.session,input))throw fail(409,'Session changed; read its current revision/hash before checking');
      if(!isFileTree(snapshot.files)||!snapshot.files.ref?.startsWith(`snapshots/${sourceId}/`))throw fail(409,'A native immutable session snapshot is required for checking');
      const workspace=await authoredWorkspace(snapshot,bucket),entry=safeTreePath(workspace.manifest.artifact?.entry||workspace.manifest.viewer?.entry||workspace.manifest.artifactEntry||'index.html'),derivedPrefix=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):'';
      record=await engine.runMutation(async()=>{
        const latest=await status(actor,sessionId,true),prior=await storage.get(key(input.checkId));
        if(prior){verifyRetry(prior,actor,sessionId,input);return prior;}
        if(!ready(latest.session)||!sameHead(latest.session,input))throw fail(409,'Session changed; read its current revision/hash before checking');
        const saved={id:input.checkId,sourceId,sessionId,requestedBy:actor.principalId,baseRevision:input.baseRevision,lastUpdateHash:input.lastUpdateHash,status:'running',checks:{},createdAt:new Date().toISOString(),completedAt:null,snapshot:snapshot.files,derivedPrefix};
        await storage.put(key(saved.id),saved);return saved;
      });
    }
    if(record.status==='running') {
      if(!ready((await status(actor,sessionId,true)).session))throw fail(409,'Close or expiry prevents resuming a session check');
      record=await recordFor(sessionId,record.id);
      if(record.status!=='running')return publicReceipt(await current(actor,sessionId),record);
      if(!running.has(record.id)) {
        // Starting the promise and registering it have no asynchronous gap.
        const task=(async()=>{
          let completion;
          try {
            const result=await build({sourceId,publicationId:record.id,files:record.snapshot});
            if(!isFileTree(result?.files)||!result.files.artifact||!result.files.ref?.startsWith(`snapshots/${sourceId}/${record.id}/build-artifact/`))throw fail(409,'Checked output identity is unavailable');
            await readTreeManifest(bucket,result.files);
            completion={status:'passed',checks:{workspace:true,tokenReferences:true,mediaReferences:true,artifactReferences:true},artifact:result.files};
          }catch(error){
            const category=String(error?.message||'').match(/^Isolated publication (workspace|token_reference|token_cycle|media_reference|artifact_reference) check failed$/)?.[1];
            completion={status:'failed',checks:{},error:{code:category||'build',message:category?`The ${category.replaceAll('_',' ')} check failed`:'The host could not complete this session check'}};
          }
          return engine.runMutation(async()=>{
            await status(actor,sessionId,true);
            const saved=await recordFor(sessionId,record.id);
            verifyRetry(saved,actor,sessionId,input);
            if(saved.status!=='running')return saved;
            const completed={...saved,...completion,completedAt:new Date().toISOString()};
            await storage.put(key(saved.id),completed);return completed;
          });
        })();
        running.set(record.id,task);
        task.finally(()=>{if(running.get(record.id)===task)running.delete(record.id);}).catch(()=>{});
      }
      record=await running.get(record.id);
    }
    return publicReceipt(await current(actor,sessionId),record);
  }
  async function read(actor,sessionId,input) {
    await status(actor,sessionId);
    const record=await recordFor(sessionId,input?.checkId);
    return publicReceipt(await current(actor,sessionId),record);
  }
  async function derived(actor,sessionId,input) {
    await status(actor,sessionId);
    if(!Object.hasOwn(documents,input?.name||''))throw fail(400,'Unknown derived document');
    const record=await recordFor(sessionId,input.checkId);
    if(record.status!=='passed'||!record.artifact)throw fail(409,'Derived output requires a successful session check');
    if(!record.artifact.ref?.startsWith(`snapshots/${sourceId}/${record.id}/build-artifact/`))throw fail(409,'Checked output identity is unavailable');
    const path=safeTreePath(`${record.derivedPrefix||''}${documents[input.name]}`),manifest=await readTreeManifest(bucket,record.artifact),file=manifest.files.find(file=>file.path===path);
    if(!file||file.mode==='120000')throw fail(404,'Derived document is unavailable for this check');
    const page=fileBytePage(file,await snapshotFileBytes({tree:record.artifact},bucket,file),input);
    return {...publicReceipt(await current(actor,sessionId),record),...page};
  }
  return {run,read,derived};
}
