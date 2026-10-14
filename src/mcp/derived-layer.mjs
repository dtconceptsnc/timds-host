import { fail } from '../store/errors.mjs';
import { publishedBundle, publishedDocumentUrls } from '../public/urls.mjs';
import { publishedFile, publicSystemUrls, safePublicPath } from '../public/index.mjs';

const files={index:'index.json',tokens:'tokens.json',brand:'brand.json',llms:'llms.txt',formats:'formats.json',designs:'designs.json',changelog:'changelog.json',bundle:'bundle.json'};
const maxBytes=8*1024*1024;
const descriptor=value=>value&&({id:value.id,versionLabel:value.versionLabel,sourceCommit:value.sourceCommit,contentDigest:value.contentDigest,publishedAt:value.publishedAt||null});

async function bytesOf(file,remaining){
  if(file.size>remaining){await file.body?.cancel();throw fail(409,'The published derived layer exceeds its read limit');}
  const reader=file.body?.getReader(),chunks=[];let size=0;
  if(!reader)return new Uint8Array();
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>remaining){await reader.cancel();throw fail(409,'The published derived layer exceeds its read limit');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}

/** One coordinator pointer resolution supplies every document. Storage refs,
 * authored source, grants and raw imported history never enter this response. */
export async function readPublicDerivedLayer({resolved,bucket,readFile,publicOrigin,metadataOnly=false,pinned=false}){
  const {source,version,firstPublicationEventId,readView}=resolved;
  if(!readView?.currentVersion||readView.source?.id!==source.id||version.source_id!==source.id)throw fail(503,'Published read metadata is unavailable');
  const entry=safePublicPath(version.artifact?.entryPath||'index.html');
  const directory=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):'';
  const urls=publicSystemUrls(publicOrigin,source.system_id,version.version_label);
  const versions=readView.versions.map(descriptor),current=descriptor(readView.currentVersion);
  const first=versions.find(item=>item.versionLabel===version.version_label);
  // Legacy same-label republications can have a current release distinct from
  // the first event pinned at /v/<label>/. Do not mislabel that asset base.
  const immutableBase=pinned||first?.contentDigest===version.content_digest;
  const base=immutableBase?urls.version:urls.root;
  const response={schemaVersion:1,source:{id:source.id,systemId:source.system_id,name:source.name||source.system_id},
    release:{id:version.id,versionLabel:version.version_label,sourceCommit:version.source_commit,contentDigest:version.content_digest,firstPublicationEventId},
    currentVersion:current,versions,versionsLimit:100,publicRoot:urls.root,publicUrls:urls,entryPath:entry};
  if(metadataOnly)return response;
  const documents={};let consumed=0;
  for(const [key,name]of Object.entries(files)){
    const file=await publishedFile(readFile,bucket,version,`${directory}${name}`);
    if(!file){documents[key]=null;continue;}
    const bytes=await bytesOf(file,maxBytes-consumed);consumed+=bytes.byteLength;
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    documents[key]=name.endsWith('.json')?JSON.parse(text):text;
  }
  // Resolve only paths inside this already-published immutable artifact. Never
  // fetch an authored URL or expose a bucket reference when normalizing media.
  const mediaFiles=new Map();let references=0;
  async function rewrite(value){
    if(!value||typeof value!=='object')return;
    if(typeof value.url==='string'&&value.url.startsWith('/')&&!value.url.startsWith('//')
      &&('key'in value||'contentType'in value||'bytes'in value||'sha256'in value)){
      if(++references>1000)throw fail(409,'The published media reference limit was exceeded');
      const relative=value.url.split('?')[0].slice(1);let filePath;
      try{filePath=safePublicPath(relative);}catch{return;}
      if(!mediaFiles.has(filePath)){
        const file=await publishedFile(readFile,bucket,version,filePath);
        mediaFiles.set(filePath,file?{bytes:file.size,sha256:file.sha256}:null);await file?.body?.cancel();
      }
      const file=mediaFiles.get(filePath);
      if(file){value.url=`${base}${filePath.split('/').map(encodeURIComponent).join('/')}`;if(Number.isSafeInteger(file.bytes))value.bytes=file.bytes;if(file.sha256)value.sha256=file.sha256;}
      return;
    }
    for(const item of Array.isArray(value)?value:Object.values(value))await rewrite(item);
  }
  for(const name of ['index','brand','designs'])await rewrite(documents[name]);
  for(const name of ['index','brand','formats','designs','changelog'])publishedDocumentUrls(documents[name],base);
  if(documents.designs)documents.designs.base=base;
  if(documents.bundle)documents.bundle=publishedBundle(documents.bundle,{base,manifestPath:`${directory}bundle.json`,versionBase:immutableBase?urls.version:null,latestBase:urls.latest});
  const layer={source:{kind:'published',base,artifact:{sourceId:source.id,contentDigest:version.content_digest}},
    system:{id:source.system_id,name:source.name||source.system_id,version:version.version_label},
    derived:Boolean(documents.index||documents.tokens||documents.brand),stale:false,
    provenance:{schemaVersion:1,sourceCommit:version.source_commit,version:version.version_label,systemId:source.system_id,entry,
      files:Object.fromEntries(Object.entries(files).map(([key,name])=>[key,`${directory}${name}`]))},
    ...documents,changelog:documents.changelog?{...documents.changelog,base}:null};
  return {...response,layer,media:resolved.publicMedia||null};
}
