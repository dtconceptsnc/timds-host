import { publishedBundle, rewriteNativeBrowser } from './urls.mjs';
import { sha256 } from '../repository/file-trees.mjs';
import { fail } from '../store/errors.mjs';

/** Standalone viewers author root-relative navigation and CSS URLs. Rebase
 * only their browser representation; immutable bundles and release bytes keep
 * their original hashes. A pinned request always retains its version prefix. */
export async function nativeViewerFile(file,{path,type,systemId,label,publicOrigin}) {
  const manifest=/(?:^|\/)bundle\.json$/.test(path);
  if(!manifest&&(!/^(?:text\/html|text\/css)(?:;|$)/.test(type)||/(?:^|\/)bundle\//.test(path)))return file;
  const limit=12_000_000,reader=file.body?.getReader(),chunks=[];let size=0;
  if(file.size>limit){await reader?.cancel();throw fail(503,'Published viewer exceeds its rendering limit');}
  try{
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw fail(503,'Published viewer exceeds its rendering limit');}chunks.push(value);}
  }finally{reader?.releaseLock();}
  const original=new Uint8Array(size);let offset=0;for(const chunk of chunks){original.set(chunk,offset);offset+=chunk.byteLength;}
  const prefix=`/systems/${encodeURIComponent(systemId)}${label?`/v/${encodeURIComponent(label)}`:''}`;
  const text=new TextDecoder('utf-8',{fatal:true}).decode(original);
  const body=new TextEncoder().encode(manifest
    ?JSON.stringify(publishedBundle(JSON.parse(text),{base:publicOrigin+prefix,manifestPath:path,versionBase:label?publicOrigin+prefix:null}),null,2)+'\n'
    :rewriteNativeBrowser(text,type,prefix));
  return {body:new Response(body).body,size:body.byteLength,sha256:await sha256(body)};
}
