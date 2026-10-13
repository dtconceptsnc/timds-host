import {verifyRelease,readReleaseFile} from './releases.mjs';
import {readTreeManifest,readTreeFile,sha256,FILE_TREE_KIND} from '../repository/file-trees.mjs';
const key=ref=>{if(!/^publication:[a-f0-9-]{36}:(?:build|source):[a-f0-9]{40}$/.test(ref||''))throw new Error('Invalid publication artifact reference');return `publications/${ref.replaceAll(':','/')}.json`;};
const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!(value.kind===FILE_TREE_KIND&&key==='ref')).map(([key,entry])=>[key,semantic(entry)])):value;
export function createPublicationArtifactStore(bucket){
 const get=async ref=>{const object=await bucket.get(key(ref));if(!object)return null;if(object.size>2*1024*1024)throw new Error('Publication receipt exceeds limit');const text=await object.text();if(await sha256(new TextEncoder().encode(text))!==object.customMetadata?.sha256)throw new Error('Publication receipt integrity changed');return JSON.parse(text);};
 return {get,async put(ref,value){const text=JSON.stringify(value);if(new TextEncoder().encode(text).length>2*1024*1024)throw new Error('Publication receipt exceeds limit');const digest=await sha256(new TextEncoder().encode(text));await bucket.put(key(ref),text,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256:digest},httpMetadata:{contentType:'application/json'}});const saved=await get(ref);if(JSON.stringify(semantic(saved))!==JSON.stringify(semantic(value)))throw new Error('Immutable publication receipt changed');return saved;}};
}
export async function loadArtifactTree(bucket,ref){
 if(typeof ref!=='string'||!/^snapshots\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-zA-Z][a-zA-Z0-9-]{0,79}\/([a-f0-9]{64})\/manifest\.json$/.test(ref))throw new Error('Invalid artifact reference');
 const object=await bucket.get(ref);if(!object||object.size>2*1024*1024)throw new Error('Published artifact unavailable');const text=await object.text(),digest=ref.split('/').at(-2);if(await sha256(new TextEncoder().encode(text))!==digest)throw new Error('Published artifact integrity changed');const manifest=JSON.parse(text),tree={kind:FILE_TREE_KIND,ref,digest,entryCount:manifest.files.length,totalBytes:manifest.totalBytes,artifact:true};await readTreeManifest(bucket,tree);return tree;
}
export async function verifyArtifact(bucket,version){
 if(version.artifact_ref?.startsWith('release:'))return verifyRelease(bucket,version);
 bucket=bucket.SNAPSHOTS||bucket.snapshots||bucket;
 const tree=await loadArtifactTree(bucket,version.artifact_ref),manifest=await readTreeManifest(bucket,tree);
 for(const file of manifest.files){const object=await bucket.head(tree.ref.replace(/manifest\.json$/,`blobs/${file.sha256}`));if(!object||object.size!==file.size||object.customMetadata?.sha256!==file.sha256)throw new Error('Published artifact file unavailable');}
 if(version.artifact?.fileCount!==manifest.files.length||version.artifact?.totalBytes!==manifest.totalBytes)throw new Error('Published artifact metadata changed');return true;
}
export async function readPublishedArtifactFile(bucket,version,path){
 if(version.artifact_ref?.startsWith('release:'))return readReleaseFile(bucket,version,path);
 bucket=bucket.SNAPSHOTS||bucket.snapshots||bucket;
 if(path==='.timds-artifact.json')return new Response(JSON.stringify(version.stamp,null,2)+'\n',{headers:{'Content-Type':'application/json'}});
 const tree=await loadArtifactTree(bucket,version.artifact_ref),manifest=await readTreeManifest(bucket,tree),file=manifest.files.find(file=>file.path===path);
 if(!file)return null;const object=await readTreeFile(bucket,tree,file);return {body:object.body,size:file.size,sha256:file.sha256};
}
