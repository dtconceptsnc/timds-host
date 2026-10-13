// Image-baked Git service. Never executes builds, npm, model commands or repo scripts.
// The only network route is the exact Artifacts remotes allowed by the Worker.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createSandboxRepositoryEngine} from './repository-engine.mjs';
const allowed=new Set(['provisionFiles','readSource','start','snapshot','stale','submit','update','mergeIntoDraft','close','merge','preparePublication','commitSource','pushMain','pushPublished','releaseCheckout','stagePublished','stageSource']);
let configuration, checkout, release, staged=[], stagedSource=[];
const responseTrees=new Map();
export function describeResponseTrees(result = {}){
 responseTrees.clear();const descriptor={...result};
 for(const role of ['files','priorFiles'])if(Array.isArray(result[role])){
  const entries=result[role].map(file=>({...file,bytes:typeof file.content==='string'&&file.encoding==='base64'?Buffer.from(file.content,'base64'):Buffer.from(file.content)}));
  responseTrees.set(role,entries);
  descriptor[role]={kind:'timds-container-tree',role,manifest:{version:1,totalBytes:entries.reduce((sum,file)=>sum+file.bytes.length,0),files:entries.map(file=>({path:file.path,mode:file.mode||'100644',size:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex')}))}};
 }
 return descriptor;
}
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const artifacts={
 getRepository:async(namespace,repository)=>configuration.repositories.find(row=>row.namespace===namespace&&row.repository===repository)||null,
 mintToken:async()=>({id:'gateway',token:''}),revokeToken:async()=>{},listTokens:async()=>[],forkRepository:async()=>{},deleteRepository:async()=>{},
};
const previewPath=manifest=>{const entry=manifest?.artifact?.entry||manifest?.viewer?.entry||manifest?.artifactEntry||'index.html';if(typeof entry!=='string'||/[\\\x00-\x1f\x7f?#%:]/.test(entry)||entry.split('/').some(x=>!x||x==='.'||x==='..'))throw fail(400,'Invalid preview entry');return '/'+entry.split('/').map(encodeURIComponent).join('/').replace(/(^|\/)index\.html$/,'');};
const engine=createSandboxRepositoryEngine({artifacts,previewUrl:source=>configuration.previewOrigin?configuration.previewOrigin+previewPath(source.manifest_json):'',ensurePreview:async()=>{},deletePreview:async()=>{},onForkPushed:async event=>{
 // This fixed route is intercepted by the trusted repository gateway. It is
 // never a public management route and carries no credential or source file.
 const response=await fetch('https://timds-repository.internal/fork-pushed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(2000),redirect:'error'});
 await response.body?.cancel();
}});
export async function dispatch(input){
 if(!allowed.has(input.method))throw fail(400,'Unsupported repository method');
 configuration={repositories:input.repositories||[],previewOrigin:input.previewOrigin||''};
 const {method,source,args=[]}=input;
 if(method==='preparePublication'){
  if(checkout)throw fail(409,'Release the existing publication checkout before preparing another');
  return new Promise((resolve,reject)=>{
   engine.withCheckout(source,args[0],async value=>{checkout=value;const descriptor={files:value.preparedFiles,priorFiles:value.priorFiles,parentRevision:value.parentRevision,resumed:value.resumed,autoRebased:value.autoRebased,mergedKeys:value.mergedKeys||[],conflictedKeys:value.conflictedKeys||[]};await new Promise(done=>{release=done;resolve(descriptor);});checkout=null;release=null;},args[1]||{}).catch(reject);
  });
 }
 if(method==='releaseCheckout'){release?.();staged=[];return{released:true};}
 if(['commitSource','pushMain','pushPublished','stagePublished','stageSource'].includes(method)){
  if(!checkout)throw fail(409,'Publication checkout expired; prepare from its saved source checkpoint');
  if(method==='commitSource'){const input=args[0]?.useStaged?{...args[0],files:stagedSource}:args[0];const result=await checkout.commitSource(input);stagedSource=[];return{...result,files:await checkout.sourceFiles()};}
  if(method==='pushMain')return checkout.pushMain();
  if(['stagePublished','stageSource'].includes(method)){
   let target=method==='stageSource'?stagedSource:staged;
   if(args[0].reset)target=[];
   for(const file of args[0].files){if(file.offset){const prior=target.at(-1);if(!prior||prior.path!==file.path||prior.content.length!==file.offset)throw fail(409,'Artifact fragment order changed');prior.content+=file.content;}else target.push({...file});}
   const sourceStage=method==='stageSource';if(target.length>(sourceStage?4000:10000)||target.reduce((n,file)=>n+Buffer.byteLength(file.content,'base64'),0)>(sourceStage?50:100)*1024*1024)throw fail(413,'Publication staging is too large');
   if(sourceStage)stagedSource=target;else staged=target;return{files:target.length};
  }
  return checkout.pushPublished({files:staged.map(file=>({...file,content:Buffer.from(file.content,'base64')})),stamp:args[0].stamp});
 }
 return engine[method](source,...args);
}
if(process.env.TIMDS_REPOSITORY_TEST_IMPORT!=='1')createServer(async(request,response)=>{
 try{
  const tree=/^\/trees\/(files|priorFiles)\/(0|[1-9][0-9]*)$/.exec(request.url||'');
  if(request.method==='GET'&&tree){const file=responseTrees.get(tree[1])?.[Number(tree[2])];if(!file)throw fail(404,'Snapshot file unavailable');response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.bytes.length});response.end(file.bytes);return;}
  if(request.method!=='POST'||request.url!=='/rpc')throw fail(404,'Not found');
  const chunks=[];let size=0;for await(const bytes of request){size+=bytes.length;if(size>80*1024*1024)throw fail(413,'Repository input is too large');chunks.push(bytes);}
  const input=JSON.parse(Buffer.concat(chunks)),value=await dispatch(input);
  const result=input.transport==='references'?describeResponseTrees(value):value;
  response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true,result}));
 }catch(error){response.writeHead(error.statusCode||500,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:false,error:{message:error.message,statusCode:error.statusCode||500,...(error.conflicts?{conflicts:error.conflicts,mainRevision:error.mainRevision}:{})}}));}
}).listen(8081,'0.0.0.0');
