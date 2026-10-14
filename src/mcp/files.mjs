import { sessionFilePath } from '../domain/paths.mjs';
import { isFileTree, readTreeManifest, readTreeFile, sha256, validateTreeManifest } from '../repository/file-trees.mjs';
import { fail } from '../store/errors.mjs';

const maxFileBytes=10*1024*1024,maxTreeBytes=50*1024*1024;
const safePath=value=>{try{return sessionFilePath(value);}catch{return null;}};
const comparePath=(left,right)=>left.path<right.path?-1:left.path>right.path?1:0;
const metadata=file=>({path:file.path,size:file.size,sha256:file.sha256,mode:file.mode});
function integer(value,fallback,min,max,name) {
  const number=value===undefined?fallback:value;
  if(!Number.isSafeInteger(number)||number<min||number>max)throw fail(400,`${name} is outside its supported range`);
  return number;
}
function snapshotResult(result) {
  if(!result?.session?.id||!result.session.sourceId||!result.session.baseRevision)throw fail(409,'Session snapshot is unavailable');
  return {apiVersion:result.apiVersion||1,session:result.session};
}

/** Mutation receipts retain revision/conflict facts without source trees or
 * internal object references. Read the current session before another edit. */
export function compactSessionResult(result) {
  const {files,baseFiles,rebasedChanges,...receipt}=result;
  const omitted={...(files!==undefined?{filesOmitted:true}:{}),...(baseFiles!==undefined?{baseFilesOmitted:true}:{}),...(rebasedChanges!==undefined?{rebasedChangesOmitted:true}:{})};
  return {...receipt,...omitted,...(Object.keys(omitted).length?{rereadRequired:true}:{})};
}

function inlineBytes(file) {
  if(file.encoding!=='base64'||typeof file.content!=='string'||file.content.length>Math.ceil(maxFileBytes/3)*4)throw fail(409,'Session file is unavailable or too large');
  const bytes=Buffer.from(file.content,'base64');
  if(bytes.length>maxFileBytes||bytes.toString('base64')!==file.content)throw fail(409,'Session file encoding is invalid');
  return bytes;
}
async function snapshotFiles(result,bucket) {
  snapshotResult(result);
  if(isFileTree(result.files)) {
    const tree=result.files;
    if(!tree.ref?.startsWith(`snapshots/${result.session.sourceId}/`))throw fail(409,'Session snapshot source does not match');
    const manifest=validateTreeManifest(await readTreeManifest(bucket,tree));
    return {tree,files:manifest.files.filter(file=>safePath(file.path)).sort(comparePath)};
  }
  if(!Array.isArray(result.files)||result.files.length>4000)throw fail(409,'Session snapshot is unavailable');
  const files=[],seen=new Set();let total=0;
  for(const file of result.files) {
    if(!safePath(file?.path))continue;
    if(seen.has(file.path)||!['100644','100755','120000'].includes(file.mode||'100644'))throw fail(409,'Session snapshot contains an invalid file');
    seen.add(file.path);
    const bytes=inlineBytes(file);total+=bytes.length;
    if(total>maxTreeBytes)throw fail(409,'Session snapshot is too large');
    files.push({path:file.path,size:bytes.length,sha256:await sha256(bytes),mode:file.mode||'100644',inline:file});
  }
  return {files:files.sort(comparePath)};
}

export async function listSessionFiles(result,bucket,{prefix='',after='',limit}={}) {
  limit=integer(limit,100,1,200,'limit');
  if(typeof prefix!=='string'||prefix&& !safePath(prefix.endsWith('/')?prefix.slice(0,-1):prefix))throw fail(400,'prefix must be a safe relative source path');
  if(typeof after!=='string'||after&&!safePath(after))throw fail(400,'after must be a safe relative source path');
  const snapshot=await snapshotFiles(result,bucket),matching=snapshot.files.filter(file=>file.path.startsWith(prefix));
  const remaining=matching.filter(file=>!after||file.path>after),page=remaining.slice(0,limit);
  return {...snapshotResult(result),files:page.map(metadata),total:matching.length,returned:page.length,limit,nextAfter:remaining.length>page.length?page.at(-1).path:null};
}

async function boundedFileBytes(object,size) {
  if(!object.body?.getReader) {
    const bytes=new Uint8Array(await object.arrayBuffer());
    if(bytes.length!==size)throw fail(409,'Session file byte count changed');
    return bytes;
  }
  const reader=object.body.getReader(),bytes=new Uint8Array(size);let offset=0;
  try {
    while(true) {
      const {done,value}=await reader.read();if(done)break;
      if(offset+value.byteLength>size)throw fail(409,'Session file byte count changed');
      bytes.set(value,offset);offset+=value.byteLength;
    }
    if(offset!==size)throw fail(409,'Session file byte count changed');
    return bytes;
  } finally {await reader.cancel();reader.releaseLock();}
}

/** Offsets and lengths always count original bytes. A slice through a UTF-8
 * code point is returned as base64, so concatenating decoded pages is lossless. */
export async function readSessionFile(result,bucket,{path,encoding='utf8',offset,limit}={}) {
  sessionFilePath(path);
  if(!['utf8','base64'].includes(encoding))throw fail(400,'encoding must be utf8 or base64');
  offset=integer(offset,0,0,maxFileBytes,'offset');limit=integer(limit,64*1024,1,256*1024,'limit');
  const snapshot=await snapshotFiles(result,bucket),file=snapshot.files.find(file=>file.path===path);
  if(!file)throw fail(404,'Session file not found');
  if(offset>file.size)throw fail(400,'offset is past the end of the session file');
  const bytes=snapshot.tree?await boundedFileBytes(await readTreeFile(bucket,snapshot.tree,file),file.size):inlineBytes(file.inline);
  if(await sha256(bytes)!==file.sha256)throw fail(409,'Session file identity changed');
  const end=Math.min(bytes.length,offset+limit),slice=bytes.subarray(offset,end);let content;
  if(encoding==='utf8') {
    try {content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(slice);if(content.includes('\u0000'))encoding='base64';}
    catch {encoding='base64';}
  }
  if(encoding==='base64')content=Buffer.from(slice).toString('base64');
  return {...snapshotResult(result),file:{...metadata(file),encoding,offset,length:slice.length,nextOffset:end<bytes.length?end:null,content},limit};
}
