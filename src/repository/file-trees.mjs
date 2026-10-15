// Large trees cross native RPC as references; prefetched bodies remain streams.
// No storage credentials or general-purpose object proxy enter a source container.
import {createHash} from 'node:crypto';
import {sessionFilePath as safeSessionTreePath} from '../domain/paths.mjs';
export {safeSessionTreePath};
const encoder=new TextEncoder();
export const FILE_TREE_KIND='timds-file-tree';
export const ARTIFACTS_TREE_KIND='timds-artifacts-tree';
export const ARTIFACTS_TREE_READ_LIMIT=200;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const fail=message=>Object.assign(new Error(message),{statusCode:409});
export const isFileTree=value=>value?.kind===FILE_TREE_KIND;
export const isArtifactsTree=value=>value?.kind===ARTIFACTS_TREE_KIND;
export function safeTreePath(value){
 if(typeof value!=='string'||!value||value.length>1000||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))throw fail('Invalid snapshot path');
 return value;
}
export async function sha256(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function validateTreeManifest(manifest,{maxFiles=4000,maxBytes=50*1024*1024,maxFileBytes=10*1024*1024}={}){
 if(manifest?.version!==1||!Array.isArray(manifest.files)||manifest.files.length>maxFiles)throw fail('Invalid snapshot manifest');
 const seen=new Set();let total=0;
 for(const file of manifest.files){safeTreePath(file.path);if(seen.has(file.path)||!hash.test(file.sha256||'')||!Number.isSafeInteger(file.size)||file.size<0||file.size>maxFileBytes||!['100644','100755','120000'].includes(file.mode))throw fail('Invalid snapshot entry');seen.add(file.path);total+=file.size;}
 if(total>maxBytes||manifest.totalBytes!==total)throw fail('Invalid snapshot size');
 return manifest;
}
const outputLimits={maxFiles:10000,maxBytes:100*1024*1024,maxFileBytes:12_000_000};
function identity(sourceId,operationId,role){if(!uuid.test(sourceId)||!uuid.test(operationId)||!/^[a-zA-Z][a-zA-Z0-9-]{0,79}$/.test(role))throw fail('Invalid snapshot identity');return `snapshots/${sourceId}/${operationId}/${role}`;}
function immutableObject(object,size,digest){if(!object||object.size!==size||object.customMetadata?.sha256!==digest)throw fail('Immutable snapshot collision');}
async function putOnce(bucket,key,body,size,options={}){
 const written=await bucket.put(key,body,{...options,onlyIf:{etagDoesNotMatch:'*'}});
 if(!written){if(typeof body?.cancel==='function'&&!body.locked)await body.cancel();immutableObject(await bucket.head(key),size,options.customMetadata.sha256);}
 return written;
}
async function putTreeFile(bucket,key,response,file){
 // A zero-length upload may complete without pulling its body at all.
 if(file.size===0&&file.sha256!==createHash('sha256').digest('hex')){await response.body?.cancel();throw fail('Snapshot file identity changed');}
 const digest=createHash('sha256');let bytes=0,tail;
 const verify=new TransformStream({
  transform(chunk,controller){
   bytes+=chunk.byteLength;if(bytes>file.size)throw fail('Snapshot byte count changed');digest.update(chunk);
   if(!chunk.byteLength)return;
   if(tail)controller.enqueue(tail);
   if(chunk.byteLength>1)controller.enqueue(chunk.subarray(0,chunk.byteLength-1));
   tail=chunk.slice(-1);
  },
  flush(controller){
   if(bytes!==file.size)throw fail('Snapshot byte count changed');
   if(digest.digest('hex')!==file.sha256)throw fail('Snapshot file identity changed');
   if(tail)controller.enqueue(tail);
  },
 });
 // Hold the final byte until verification, then expose a known-length stream
 // to R2. Keep its checksum guard too; a failed upload never owns a shared key.
 const transfer=typeof FixedLengthStream==='function'?new FixedLengthStream(file.size):new TransformStream(),abort=new AbortController();
 const input=response.body||new Response(new Uint8Array()).body;
 const completion=input.pipeThrough(verify).pipeTo(transfer.writable,{signal:abort.signal}).then(()=>({}),error=>({error}));
 try{
  const written=await putOnce(bucket,key,transfer.readable,file.size,{sha256:file.sha256,customMetadata:{sha256:file.sha256},httpMetadata:{contentType:'application/octet-stream'}});
  if(written){const result=await completion;if(result.error)throw result.error;}
 }finally{abort.abort();if(!transfer.readable.locked)await transfer.readable.cancel().catch(()=>{});await completion;}
}
/** Bound streamed transfers and drain in-flight work before caller cleanup. */
export async function transferFiles(items, task,{concurrency=4}={}) {
 let cursor=0,failed=false,failure;
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
  while(!failed&&cursor<items.length){const index=cursor++;try{await task(items[index],index);}catch(error){if(!failed){failed=true;failure=error;}}}
 }));
 if(failed)throw failure;
}
/** descriptor is generated by image-baked code; readFile never accepts an external URL. */
export async function persistContainerTree(bucket,{sourceId,operationId,role,manifest,readFile,artifact=false,deadline=Infinity,stats={blobsRead:0,blobsFound:0}}){
 validateTreeManifest(manifest,artifact?outputLimits:undefined);
 const bytes=encoder.encode(JSON.stringify(manifest)),digest=await sha256(bytes),operationPrefix=identity(sourceId,operationId,role),prefix=artifact?`${operationPrefix}/${digest}`:`snapshots/${sourceId}/trees/${digest}`,blobPrefix=artifact?`${prefix}/blobs`:`snapshots/${sourceId}/blobs`;
 const ref={kind:FILE_TREE_KIND,ref:`${prefix}/manifest.json`,digest,entryCount:manifest.files.length,totalBytes:manifest.totalBytes,...(artifact?{artifact:true}:{})};
 // A repeated digest names one blob, even when several paths use its bytes.
 const unique=new Map();
 manifest.files.forEach((file,index)=>{const prior=unique.get(file.sha256);if(prior&&prior.file.size!==file.size)throw fail('Immutable snapshot collision');if(!prior)unique.set(file.sha256,{file,index});});
 if(!artifact){const prior=await bucket.get(ref.ref);if(prior){immutableObject(prior,bytes.byteLength,digest);await storedManifest(prior,ref);stats.blobsFound+=unique.size;return ref;}}
 await transferFiles([...unique.values()],async({file,index})=>{
  if(Date.now()>deadline)throw fail('Snapshot transfer deadline exceeded');
  const key=`${blobPrefix}/${file.sha256}`;
  const prior=await bucket.head(key);if(prior){immutableObject(prior,file.size,file.sha256);stats.blobsFound++;return;}
  stats.blobsRead++;
  const response=await readFile(index);
  if(!response.ok)throw fail('Snapshot file unavailable');
  await putTreeFile(bucket,key,response,file);
 },{concurrency:8});
 await putOnce(bucket,ref.ref,bytes,bytes.byteLength,{sha256:digest,customMetadata:{sha256:digest},httpMetadata:{contentType:'application/json'}});
 return ref;
}
async function storedManifest(object,tree){
 if(!object||object.size>2*1024*1024)throw fail('Snapshot manifest unavailable');
 const text=await object.text();if(await sha256(encoder.encode(text))!==tree.digest)throw fail('Snapshot manifest identity changed');
 const manifest=validateTreeManifest(JSON.parse(text),tree.artifact?outputLimits:undefined);
 if(manifest.files.length!==tree.entryCount||manifest.totalBytes!==tree.totalBytes)throw fail('Snapshot reference identity changed');
 return manifest;
}
export async function readTreeManifest(bucket,tree){
 if(!isFileTree(tree)||!/^snapshots\/[a-f0-9-]{36}\/(?:trees|[a-f0-9-]{36}\/[a-zA-Z][a-zA-Z0-9-]{0,79})\/[a-f0-9]{64}\/manifest\.json$/.test(tree.ref||'')||!hash.test(tree.digest||'')||!tree.ref.endsWith(`/${tree.digest}/manifest.json`))throw fail('Invalid snapshot reference');
 return storedManifest(await bucket.get(tree.ref),tree);
}
export async function readTreeFile(bucket,tree,file){
 const key=tree.ref.replace(/^(snapshots\/[a-f0-9-]{36})\/trees\/[a-f0-9]{64}\/manifest\.json$/,`$1/blobs/${file.sha256}`).replace(/manifest\.json$/,`blobs/${file.sha256}`),object=await bucket.get(key);
 if(!object||object.size!==file.size||object.customMetadata?.sha256!==file.sha256)throw fail('Snapshot file unavailable');
 return object;
}
export async function* treeFiles(bucket,tree,{filter=()=>true}={}){
 const manifest=await readTreeManifest(bucket,tree);
 for(const file of manifest.files){if(!filter(file))continue;const object=await readTreeFile(bucket,tree,file);const bytes=new Uint8Array(await object.arrayBuffer());if(await sha256(bytes)!==file.sha256)throw fail('Snapshot file identity changed');yield {path:file.path,mode:file.mode,encoding:'base64',content:Buffer.from(bytes).toString('base64')};}
}
async function* jsonFiles(files,readFile,{maxBytes=Infinity,gitObjects=false,concurrency=4}={}){
 const pending=new Map();let cursor=0,total=0;
 const prefetch=()=>{while(cursor<files.length&&pending.size<concurrency){const index=cursor++;pending.set(index,Promise.resolve().then(()=>readFile(files[index])).then(object=>({object}),error=>({error})));}};
 yield '[';
 try{
  prefetch();
  for(let index=0;index<files.length;index++){
   const entry=await pending.get(index);pending.delete(index);
   if(entry.error)throw entry.error;
   const file=files[index],object=entry.object,reader=object.body.getReader();let carry=new Uint8Array(),size=0;
   const digest=gitObjects?createHash('sha1').update(`blob ${object.size}\0`):createHash('sha256');
   try{
    total+=object.size;if(!Number.isSafeInteger(object.size)||object.size<0||total>maxBytes)throw fail('Design System source exceeds the session limit');
    if(index)yield ',';yield `{"path":${JSON.stringify(file.path)},"mode":${JSON.stringify(file.mode)},"encoding":"base64","content":"`;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>object.size)throw fail('Snapshot byte count changed');digest.update(value);const chunk=new Uint8Array(carry.length+value.length);chunk.set(carry);chunk.set(value,carry.length);const end=chunk.length-chunk.length%3;if(end)yield Buffer.from(chunk.subarray(0,end)).toString('base64');carry=chunk.slice(end);}
    if(size!==object.size||digest.digest('hex')!==(gitObjects?file.oid:file.sha256))throw fail('Snapshot file identity changed');
    if(carry.length)yield Buffer.from(carry).toString('base64');yield '"}';
   }finally{await reader.cancel();}
   prefetch();
  }
  yield ']';
 }finally{await Promise.allSettled([...pending.values()].map(async promise=>{const {object}=await promise;await object?.body.cancel();}));}
}
async function* jsonTree(bucket,tree){
 const manifest=await readTreeManifest(bucket,tree);
 yield* jsonFiles(manifest.files,file=>readTreeFile(bucket,tree,file),{concurrency:16});
}
export function validateArtifactsTree(tree){
 if(!isArtifactsTree(tree)||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(tree.namespace||'')||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(tree.repository||'')||!/^[a-f0-9]{40}$/.test(tree.revision||'')||!Array.isArray(tree.files)||tree.files.length>ARTIFACTS_TREE_READ_LIMIT)throw fail('Invalid Artifacts tree reference');
 const seen=new Set();for(const file of tree.files){safeSessionTreePath(file.path);if(seen.has(file.path)||!['100644','100755'].includes(file.mode)||!/^[a-f0-9]{40}$/.test(file.oid||''))throw fail('Invalid Artifacts tree entry');seen.add(file.path);}
 return tree;
}
async function* jsonArtifactsTree(artifacts,tree){
 if(!artifacts)throw fail('Artifacts binding unavailable');
 validateArtifactsTree(tree);
 yield* jsonFiles(tree.files,file=>artifacts.readFileStream(tree.namespace,tree.repository,file.path,tree.revision,{maxBytes:10*1024*1024}),{maxBytes:50*1024*1024,gitObjects:true});
}
async function* jsonValue(value,bucket,artifacts){
 if(isFileTree(value)){yield* jsonTree(bucket,value);return;}
 if(isArtifactsTree(value)){yield* jsonArtifactsTree(artifacts,value);return;}
 if(Array.isArray(value)){yield '[';for(let i=0;i<value.length;i++){if(i)yield ',';yield* jsonValue(value[i]??null,bucket,artifacts);}yield ']';return;}
 if(value&&typeof value==='object'){yield '{';let first=true;for(const [key,entry] of Object.entries(value)){if(entry===undefined)continue;if(!first)yield ',';first=false;yield `${JSON.stringify(key)}:`;yield* jsonValue(entry,bucket,artifacts);}yield '}';return;}
 yield JSON.stringify(value)??'null';
}
/** Public v1 JSON stays byte-compatible, but a 50 MiB tree never enters Worker heap. */
export function streamJsonFileTrees(result,bucket,{status=200,headers={},artifacts,onFinish}={}){
 const iterator=jsonValue(result,bucket,artifacts)[Symbol.asyncIterator]();let finished=false;
 const finish=outcome=>{if(finished)return;finished=true;try{onFinish?.(outcome);}catch{}};
 return new Response(new ReadableStream({async pull(controller){
  try{const item=await iterator.next();if(item.done){controller.close();finish('ok');}else controller.enqueue(encoder.encode(item.value));}
  catch(error){finish('error');controller.error(error);await iterator.return?.();}
 },async cancel(){finish('cancelled');await iterator.return?.();}}),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
}
