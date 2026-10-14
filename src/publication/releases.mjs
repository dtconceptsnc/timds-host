// RELEASES has a bucket lock on sources/. Objects become public only after the
// coordinator commits an event; partial copies are safe to resume byte-for-byte.
import {readTreeManifest,readTreeFile,sha256,validateTreeManifest} from '../repository/file-trees.mjs';
const fail=message=>Object.assign(new Error(message),{statusCode:409});
const pattern=/^release:(sources\/[a-f0-9-]{36}\/v\/[^/]+\/)\.timds-release\.json$/;
const stampText=stamp=>JSON.stringify(stamp,null,2)+'\n';
const reserved=new Set(['.timds-artifact.json','.timds-release.json']);
function prefix(sourceId,version){if(!/^[a-f0-9-]{36}$/.test(sourceId||'')||typeof version!=='string'||!version||version.length>100||/[\\/\x00-\x20\x7f]/.test(version)||['.','..'].includes(version))throw fail('Invalid immutable release identity');return `sources/${sourceId}/v/${encodeURIComponent(version)}/`;}
function digestOf(object){const value=object.checksums?.sha256;return value?Buffer.from(value).toString('hex'):null;}
async function verifyObject(bucket,key,size,digest){
 const object=await bucket.head(key);if(!object)return false;
 if(object.size!==size||object.customMetadata?.sha256!==digest)throw fail('Immutable release object collision');
 const checksum=digestOf(object);if(checksum&&checksum!==digest)throw fail('Immutable release checksum changed');
 if(!checksum){const body=await bucket.get(key);if(!body||body.size!==size||await sha256(await body.arrayBuffer())!==digest)throw fail('Immutable release bytes changed');}
 return true;
}
async function writeOnce(bucket,key,{size,digest,body,contentType='application/octet-stream'}){
 if(await verifyObject(bucket,key,size,digest))return;
 await bucket.put(key,await body(),{onlyIf:{etagDoesNotMatch:'*'},sha256:digest,customMetadata:{sha256:digest},httpMetadata:{contentType}});
 if(!await verifyObject(bucket,key,size,digest))throw fail('Immutable release write unavailable');
}
function fixed(body,size){if(typeof FixedLengthStream==='function')return body.pipeThrough(new FixedLengthStream(size));return body;}
/** `manifest` is the tree's manifest when the caller already read it through readTreeManifest; otherwise it is read here. */
export async function publishReleaseTree({snapshots,releases},{sourceId,files,stamp,manifest:verified}){
 if(!releases)throw fail('Immutable release storage unavailable');
 const root=prefix(sourceId,stamp?.version),manifest=verified||await readTreeManifest(snapshots,files);
 if(manifest.files.some(file=>file.mode==='120000'||reserved.has(file.path)))throw fail('Release has unsafe or reserved artifact files');
 const receipt={schemaVersion:1,sourceId,version:stamp.version,stamp,manifest};
 const receiptText=JSON.stringify(receipt);if(new TextEncoder().encode(receiptText).length>2*1024*1024)throw fail('Immutable release manifest exceeds limit');
 const receiptDigest=await sha256(new TextEncoder().encode(receiptText)),ref=`release:${root}.timds-release.json`;
 // A finalized label cannot acquire different bytes even if all file names differ.
 const prior=await releases.get(root+'.timds-release.json');if(prior){if(prior.size>2*1024*1024||await prior.text()!==receiptText)throw fail('Immutable release label already names different bytes');}
 for(const file of manifest.files)await writeOnce(releases,root+file.path,{size:file.size,digest:file.sha256,body:async()=>fixed((await readTreeFile(snapshots,files,file)).body,file.size)});
 const stampBytes=new TextEncoder().encode(stampText(stamp));await writeOnce(releases,root+'.timds-artifact.json',{size:stampBytes.length,digest:await sha256(stampBytes),body:async()=>stampBytes,contentType:'application/json'});
 const receiptBytes=new TextEncoder().encode(receiptText);await writeOnce(releases,root+'.timds-release.json',{size:receiptBytes.length,digest:receiptDigest,body:async()=>receiptBytes,contentType:'application/json'});
 return ref;
}
export async function loadRelease(storage,version){
 const match=pattern.exec(version?.artifact_ref||'');if(!match)throw fail('Invalid immutable release reference');
 const bucket=storage.RELEASES||storage.releases;if(!bucket)throw fail('Immutable release storage unavailable');
 const root=match[1],object=await bucket.get(root+'.timds-release.json');if(!object||object.size>2*1024*1024)throw fail('Immutable release unavailable');
 const text=await object.text(),manifestDigest=await sha256(new TextEncoder().encode(text));if(manifestDigest!==object.customMetadata?.sha256)throw fail('Immutable release manifest changed');
 const receipt=JSON.parse(text);validateTreeManifest(receipt.manifest,{maxFiles:2000,maxBytes:80_000_000,maxFileBytes:12_000_000});
 if(receipt.schemaVersion!==1||prefix(receipt.sourceId,receipt.version)!==root||receipt.sourceId!==version.source_id||receipt.version!==version.version_label||JSON.stringify(receipt.stamp)!==JSON.stringify(version.stamp)||receipt.stamp.contentDigest!==version.content_digest||receipt.stamp.sourceCommit!==version.source_commit)throw fail('Immutable release identity changed');
 return{bucket,root,receipt,manifestDigest};
}
export async function verifyRelease(storage,version){
 const {bucket,root,receipt}=await loadRelease(storage,version),manifest=receipt.manifest;
 if(version.artifact?.fileCount!==manifest.files.length||version.artifact?.totalBytes!==manifest.totalBytes)throw fail('Immutable release metadata changed');
 for(const file of manifest.files)if(!await verifyObject(bucket,root+file.path,file.size,file.sha256))throw fail('Immutable release file unavailable');
 const stamp=new TextEncoder().encode(stampText(version.stamp));if(!await verifyObject(bucket,root+'.timds-artifact.json',stamp.length,await sha256(stamp)))throw fail('Immutable release stamp unavailable');return true;
}
export async function readReleaseFile(storage,version,path){
 const {bucket,root,receipt}=await loadRelease(storage,version);
 let file=receipt.manifest.files.find(file=>file.path===path);
 if(path==='.timds-artifact.json'){const bytes=new TextEncoder().encode(stampText(version.stamp));file={size:bytes.length,sha256:await sha256(bytes)};}
 if(!file)return null;
 const object=await bucket.get(root+path);if(!object||object.size!==file.size||object.customMetadata?.sha256!==file.sha256||digestOf(object)&&digestOf(object)!==file.sha256)throw fail('Immutable release file unavailable');
 return{body:object.body,size:file.size,sha256:file.sha256};
}
