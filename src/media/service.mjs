import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../store/errors.mjs';
import { createMediaStore } from './store.mjs';
import { normalizeMedia,mediaView,UUID,PART_BYTES,SINGLE_BYTES } from './contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const etag=value=>String(value||'').replace(/^"|"$/g,'');
const now=()=>new Date().toISOString();
const TRANSFER_MS=10*60_000;

export function createSourceMedia({sourceId,storage,catalog,sourceStore,authorization,runMutation,env,schedule=async()=>{}}){
 const records=createMediaStore({storage,catalog,sourceId}),bucket=()=>{if(!env.MEDIA)throw fail(503,'Native media storage is not configured');return env.MEDIA;};
 const origin=new URL(env.TIMDS_PUBLIC_ORIGIN).origin;
 const api=`/api/timds/design-systems/${sourceId}/media`;
 async function source(){const row=await sourceStore.getSource(sourceId);if(!row||row.archived_at||row.lifecycle_status!=='ready'||sourceStore.deletionFence()||(await catalog.organization(row.organization_id))?.status!=='active')throw fail(404,'Design System media is unavailable');return row;}
 async function authorize(actor,write=false){const row=await source();if(write&&actor?.accessMode==='read')throw fail(403,'Media changes require write access');await authorization.authorizeSource(row,{...actor,accessMode:write?'write':'read'},{starting:write});return row;}
 const upload=id=>{const row=UUID.test(id||'')&&records.getUpload(id);if(!row)throw fail(404,'Media upload not found');return row;};
 async function asset(id){const row=UUID.test(id||'')&&await records.asset(id);if(!row||row.source_id!==sourceId)throw fail(404,'Media asset not found');return row;}
 function active(row){if(row.status!=='active')throw fail(409,`Media upload is ${row.status}`);if(row.expires_at<=Date.now())throw fail(410,'Media upload expired');}
 function cap(input){const token=randomBytes(32).toString('base64url');records.expireCapabilities(Date.now());records.putCapability({id:hash(token),...input});return token;}
 function plan(row,token){return {id:row.id,method:row.method,expiresAt:new Date(row.expires_at).toISOString(),partSize:row.method==='multipart'?PART_BYTES:null,headers:token?{Authorization:`Bearer ${token}`}:{},url:token?`${origin}/media/uploads/${sourceId}/${row.id}/0`:null,partsUrl:row.method==='multipart'?`${api}/uploads/${row.id}/parts`:null,completeUrl:`${api}/uploads/${row.id}/complete`,cancelUrl:`${api}/uploads/${row.id}`};}
 async function capability(token,kind){if(!/^[a-zA-Z0-9_-]{43}$/.test(token||''))throw fail(401,'Media capability is required');const row=records.getCapability(hash(token));if(!row||row.kind!==kind||row.source_id!==sourceId||row.expires_at<=Date.now())throw fail(401,'Media capability expired');await authorize({principalId:row.principal_id},kind==='upload');return row;}
 function storageFor(row){
  if(!row.legacy){if(!new RegExp(`^sources/${sourceId}/media/[a-f0-9-]{36}/${row.sha256}/[a-zA-Z0-9.-]+$`).test(row.object_key||''))throw fail(409,'Media storage ownership is invalid');return bucket();}
  let bindings;try{bindings=JSON.parse(env.TIMDS_MEDIA_LEGACY_BINDINGS||'{}');}catch{throw fail(503,'Legacy media bindings are invalid');}
  const key=bindings[row.storage_bucket],prefix=`clients/${encodeURIComponent(row.client_id)}/design-systems/${sourceId}/media/${row.sha256}/`;
  if(!/^MEDIA_LEGACY_[A-Z0-9_]+$/.test(key||'')||!env[key]||!row.object_key?.startsWith(prefix)||!row.object_key.slice(prefix.length)||row.object_key.slice(prefix.length).includes('/'))throw fail(503,'Imported media storage is not bound');
  return env[key];
 }
 async function archive(id,actor,{fenced=false,deleting=false}={}){
  const row=await runMutation(async()=>{if(!fenced)await authorize(actor,true);const value=await asset(id);if(value.status==='archived'&&value.purged_at)return value;if(!['ready','archiving','archived'].includes(value.status))throw fail(409,'Cancel the unfinished upload first');storageFor(value);const saved=records.putAsset({...value,status:'archiving',purge_requires_lifecycle:deleting||value.purge_requires_lifecycle===true,updated_at:now()});await schedule(Date.now()+1000);return saved;});
  if(!row.purged_at){const target=storageFor(row);await target.delete(row.object_key);if(await target.head(row.object_key))throw fail(409,'Media removal is not yet verified');await runMutation(()=>records.putAsset({...row,status:'archived',purged_at:now(),updated_at:now()}));}
  return {archived:true,asset:mediaView(await asset(id))};
 }
 async function verifyObject(row){const object=await bucket().get(row.object_key);if(!object||object.size!==row.bytes){await object?.body?.cancel();throw fail(409,'Media byte count did not match');}const digest=new crypto.DigestStream('SHA-256');await object.body.pipeTo(digest,{signal:AbortSignal.timeout(10*60_000)});const actual=Buffer.from(await digest.digest).toString('hex');if(actual!==row.sha256)throw fail(409,'Media SHA256 did not match');return {etag:object.etag,bytes:object.size,sha256:actual};}
 async function cancel(id,actor,{fenced=false,beforeDelete=async()=>{}}={}){
  const row=await runMutation(async()=>{
   if(!fenced)await authorize(actor,true);
   const value=upload(id);if(value.status==='completed')throw fail(409,'Completed media cannot be cancelled');if(value.status==='cancelled')return value;
   const until=Math.max(Date.now(),value.cleanup_after||0,...records.parts(id).filter(part=>part.status==='uploading').map(part=>part.lease_until+60_000),value.status==='completing'?(value.lease_until||0)+60_000:0,value.status==='creating'?(value.creation_lease_until||value.expires_at)+60_000:0);
   const saved=records.putUpload({...value,status:'cancelling',cleanup_after:until,updated_at:now()});await schedule(until+1000);return saved;
  });
  if(row.status!=='cancelled'){
   // An upload never reuses its storage key. Wait for bounded transfers before
   // the final delete; late callbacks also delete their cancelled object.
   if(row.cleanup_after>Date.now())return {ok:true,pending:true,asset:mediaView(await asset(row.asset_id))};
   if(row.multipart_id&&!row.multipart_aborted){
    await beforeDelete();
    await bucket().resumeMultipartUpload(row.object_key,row.multipart_id).abort();
    await runMutation(()=>records.putUpload({...upload(id),multipart_aborted:true}));
   }
   await beforeDelete();
   await bucket().delete(row.object_key);
   if(await bucket().head(row.object_key))throw fail(409,'Media removal is not yet verified');
   await runMutation(async()=>{const current=upload(id);if(current.status!=='cancelling')throw fail(409,'Media cancellation changed');records.putUpload({...current,status:'cancelled',updated_at:now()});const value=await asset(row.asset_id);if(value.status!=='ready')records.putAsset({...value,status:'failed',purged_at:now(),updated_at:now()});});
  }
  return {ok:true,asset:mediaView(await asset(row.asset_id))};
 }

 return {
  records,
  async invoke({operation,actor,input={}}){
   if(operation==='list')return runMutation(async()=>{await authorize(actor);const rows=await records.assets(),items=rows.slice(0,500).filter(row=>row.status!=='archived').map(mediaView);return {assets:items,truncated:rows.length>500,limit:500,storage:{configured:Boolean(env.MEDIA),publicDeliveryConfigured:Boolean(env.MEDIA)},summary:{total:items.length,ready:items.filter(row=>row.status==='ready').length,public:items.filter(row=>row.visibility==='public').length,private:items.filter(row=>row.visibility==='private').length}};});
   if(operation==='create'){
    const normalized=normalizeMedia(input);
    const prepared=await runMutation(async()=>{
     const current=await authorize(actor,true);bucket();
     if(records.activeUploads().length>=20)throw fail(429,'Finish or cancel an existing media upload');
     let existing=records.byDigest(normalized.sha256);
     if(existing?.status==='ready'){
      if(existing.bytes!==normalized.bytes||existing.content_type!==normalized.contentType)throw fail(409,'Existing media digest has different metadata');
      existing=records.putAsset({...existing,title:normalized.title,tags:normalized.tags,kind:normalized.kind,metadata:normalized.metadata,updated_at:now()});return {asset:mediaView(existing),reused:true,upload:null};
     }
     if(existing&&records.activeUploads().some(row=>row.asset_id===existing.id))throw fail(409,'This media already has an active upload');
     const id=randomUUID(),assetId=randomUUID(),time=now(),object_key=`sources/${sourceId}/media/${id}/${normalized.sha256}/${normalized.safeFilename}`;
     const row={id:assetId,source_id:sourceId,client_id:current.client_id||null,bytes:normalized.bytes,sha256:normalized.sha256,content_type:normalized.contentType,filename:normalized.filename,safe_filename:normalized.safeFilename,title:normalized.title,kind:normalized.kind,metadata:normalized.metadata,rights:normalized.rights,tags:normalized.tags,visibility:'public',status:'uploading',created_at:time,updated_at:time,public_url:`${origin}/media/${sourceId}/${assetId}/${normalized.safeFilename}`,object_key};
     records.putAsset(row);const transfer=records.putUpload({id,asset_id:assetId,source_id:sourceId,principal_id:actor.principalId,status:'creating',creation_lease_until:Date.now()+TRANSFER_MS,method:normalized.bytes>SINGLE_BYTES?'multipart':'single',bytes:normalized.bytes,sha256:normalized.sha256,object_key,created_at:time,updated_at:time,expires_at:Date.now()+3600000});await schedule(transfer.expires_at);return {row,transfer};
    });
    if(prepared.reused)return prepared;
    const {row,transfer}=prepared;
    let multipart,creationTimeout;
    try{
     if(transfer.creation_lease_until<=Date.now())throw fail(410,'Media upload creation expired');
     if(transfer.method==='multipart')multipart=await Promise.race([bucket().createMultipartUpload(row.object_key,{httpMetadata:{contentType:row.content_type},customMetadata:{sha256:row.sha256,sourceId,assetId:row.id}}),new Promise((_,reject)=>{creationTimeout=setTimeout(()=>reject(fail(504,'Media upload creation timed out')),Math.max(1,transfer.creation_lease_until-Date.now()));})]);
     return await runMutation(async()=>{await authorize(actor,true);const current=upload(transfer.id);if(current.status!=='creating')throw fail(409,'Media upload reservation changed');const ready=records.putUpload({...current,status:'active',creation_lease_until:null,multipart_id:multipart?.uploadId||null});const token=ready.method==='single'?cap({kind:'upload',source_id:sourceId,upload_id:ready.id,part:0,principal_id:actor.principalId,expires_at:ready.expires_at}):null;await schedule(ready.expires_at);return {asset:mediaView(row),reused:false,upload:plan(ready,token)};});
    }catch(error){await runMutation(async()=>{const current=upload(transfer.id);records.putUpload({...current,status:'cancelling',creation_lease_until:null,multipart_id:multipart?.uploadId||current.multipart_id||null,cleanup_after:Date.now(),updated_at:now()});records.putAsset({...row,status:'failed',updated_at:now()});await schedule(Date.now()+1000);});throw error;}
    finally{clearTimeout(creationTimeout);}
   }
   if(operation==='part')return runMutation(async()=>{await authorize(actor,true);const row=upload(input.uploadId);active(row);const part=Number(input.partNumber),count=Math.ceil(row.bytes/PART_BYTES);if(row.method!=='multipart'||!Number.isInteger(part)||part<1||part>count)throw fail(400,'Invalid multipart part');const token=cap({kind:'upload',source_id:sourceId,upload_id:row.id,part,principal_id:actor.principalId,expires_at:Math.min(row.expires_at,Date.now()+900000)});return {partNumber:part,url:`${origin}/media/uploads/${sourceId}/${row.id}/${part}`,headers:{Authorization:`Bearer ${token}`}};});
   if(operation==='cancel')return cancel(input.uploadId,actor);
   if(operation==='complete'){
    const claim=await runMutation(async()=>{await authorize(actor,true);const row=upload(input.uploadId);if(row.status==='completed')return {completed:mediaView(await asset(row.asset_id))};if(row.status==='completing'&&row.lease_until>Date.now())throw fail(409,'Media verification is in progress');if(!['active','completing'].includes(row.status)||row.expires_at<=Date.now())throw fail(410,'Media upload is unavailable or expired');const parts=records.parts(row.id),expected=row.method==='multipart'?Math.ceil(row.bytes/PART_BYTES):1;if(parts.length!==expected||parts.some((part,index)=>part.status!=='uploaded'||part.partNumber!==(row.method==='single'?0:index+1)))throw fail(409,'Upload every media part before completing');if(row.method==='multipart'&&(!Array.isArray(input.parts)||input.parts.length!==parts.length||input.parts.some((part,index)=>Number(part.partNumber)!==parts[index].partNumber||etag(part.etag)!==etag(parts[index].etag))))throw fail(409,'Multipart completion differs from the uploaded part receipts');const lease=randomUUID();records.putUpload({...row,status:'completing',lease,lease_until:Date.now()+900000});return {row,parts,lease};});
    if(claim.completed)return {ok:true,asset:claim.completed};
    try{
     if(claim.row.method==='multipart'&&!await bucket().head(claim.row.object_key))await bucket().resumeMultipartUpload(claim.row.object_key,claim.row.multipart_id).complete(claim.parts.map(({partNumber,etag})=>({partNumber,etag})));
     const verified=await verifyObject(claim.row);
     return await runMutation(async()=>{await authorize(actor,true);const row=upload(claim.row.id);if(row.status!=='completing'||row.lease!==claim.lease)throw fail(409,'Media completion reservation changed');const value=await asset(row.asset_id),ready=records.putAsset({...value,status:'ready',ready_at:now(),updated_at:now(),verified});records.putUpload({...row,status:'completed',lease:null,lease_until:null,completed_at:now()});return {ok:true,asset:mediaView(ready)};});
    }catch(error){await runMutation(()=>{const row=upload(claim.row.id);if(row.status==='completing'&&row.lease===claim.lease)records.putUpload({...row,status:error.statusCode===409?'cancelling':'active',cleanup_after:Date.now(),lease:null,lease_until:null,updated_at:now()});});await schedule(Date.now()+1000);throw error;}
   }
   if(operation==='archive')return archive(input.assetId,actor);
   if(operation==='download')return runMutation(async()=>{await authorize(actor);const row=await asset(input.assetId);if(row.status!=='ready')throw fail(404,'Ready media not found');if(row.visibility==='public'&&row.public_url)return {asset:mediaView(row),url:row.public_url};const token=cap({kind:'download',source_id:sourceId,asset_id:row.id,principal_id:actor.principalId,expires_at:Date.now()+300000});return {asset:mediaView(row),url:`${origin}/media/downloads/${sourceId}/${row.id}?cap=${token}`};});
   throw fail(404,'Unknown media operation');
  },
  async upload(request,{uploadId,part}){
   const token=/^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.get('Authorization')||'')?.[1];
   if(!request.body)throw fail(400,'Media body is required');
   const prepared=await runMutation(async()=>{
    const grant=await capability(token,'upload');if(grant.upload_id!==uploadId||grant.part!==part)throw fail(403,'Media capability does not match this part');
    const row=upload(uploadId);active(row);
    const expected=part===0?row.bytes:Math.min(PART_BYTES,row.bytes-(part-1)*PART_BYTES);
    if(expected<1||Number(request.headers.get('Content-Length'))!==expected)throw fail(400,'Media part length does not match');
    // A started transfer is never taken over. If its worker disappears, expiry
    // cancels the whole upload; retrying the same R2 part could race old bytes.
    const prior=records.parts(uploadId).find(item=>item.partNumber===part);
    if(prior)throw fail(409,'This part already started; complete it or cancel the upload');
    const attempt=randomUUID();records.putPart(uploadId,{partNumber:part,status:'uploading',attempt,lease_until:Date.now()+TRANSFER_MS});
    return {row,expected,attempt};
   });
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),TRANSFER_MS);
   let size=0;const length=new FixedLengthStream(prepared.expected);
   const counting=new TransformStream({transform(chunk,sink){size+=chunk.byteLength;if(size>prepared.expected)throw fail(413,'Media part is too large');sink.enqueue(chunk);},flush(){if(size!==prepared.expected)throw fail(400,'Media part length changed');}});
   const piping=request.body.pipeThrough(counting).pipeTo(length.writable,{signal:controller.signal});piping.catch(()=>{});
   let result;
   try{
    result=part===0?await bucket().put(prepared.row.object_key,length.readable,{sha256:prepared.row.sha256,httpMetadata:{contentType:(await asset(prepared.row.asset_id)).content_type},customMetadata:{sha256:prepared.row.sha256,sourceId,assetId:prepared.row.asset_id}}):await bucket().resumeMultipartUpload(prepared.row.object_key,prepared.row.multipart_id).uploadPart(part,length.readable);
    await piping;
    await runMutation(async()=>{await capability(token,'upload');const current=upload(uploadId);active(current);const pending=records.parts(uploadId).find(item=>item.partNumber===part);if(pending?.attempt!==prepared.attempt)throw fail(409,'Media transfer reservation changed');records.putPart(uploadId,{partNumber:part,status:'uploaded',etag:result.etag,bytes:prepared.expected});});
    return new Response(null,{headers:{ETag:`"${etag(result.etag)}"`,'Cache-Control':'no-store'}});
   }catch(error){
    controller.abort();await piping.catch(()=>{});
    await runMutation(async()=>{const row=upload(uploadId);records.putPart(uploadId,{partNumber:part,status:'failed',attempt:prepared.attempt});if(row.status!=='completed'){records.putUpload({...row,status:'cancelling',cleanup_after:Date.now(),updated_at:now()});await schedule(Date.now()+1000);}});
    throw fail(error.statusCode||409,'Media transfer failed; cancel it and start a new upload');
   }finally{clearTimeout(timeout);}
  },
  async fetch(request,{assetId,filename,downloadToken}){
   await source();const row=await asset(assetId);if(row.status!=='ready')throw fail(404,'Media not found');
   if(downloadToken){const grant=await capability(downloadToken,'download');if(grant.asset_id!==assetId)throw fail(403,'Download capability belongs to another asset');}
   else if(row.visibility!=='public'||row.legacy||filename!==row.safe_filename)throw fail(404,'Public media not found');
   const binding=storageFor(row);
   const range=request.headers.get('Range');if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))throw fail(416,'Use one byte range');
   const object=request.method==='HEAD'?await binding.head(row.object_key):await binding.get(row.object_key,range?{range:new Headers({Range:range})}:{});
   if(!object||object.size!==row.bytes){await object?.body?.cancel();throw fail(503,'Media object is unavailable');}
   // R2 can return range metadata describing the whole object even when the
   // caller did not request a range. HEAD also uses the full object metadata.
   const servedRange=request.method==='GET'&&range?object.range:null;
   const headers=new Headers({'Content-Type':row.content_type,'Content-Length':String(servedRange?.length??object.size),ETag:object.httpEtag,'X-Content-Type-Options':'nosniff','Cache-Control':downloadToken?'private, no-store':'public, max-age=31536000, immutable','Referrer-Policy':'no-referrer','Accept-Ranges':'bytes'});
   if(downloadToken)headers.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(row.filename||'asset')}`);
   else if(/^(text\/html|application\/(xhtml\+xml|javascript))/.test(row.content_type))headers.set('Content-Disposition','attachment');
   if(request.headers.get('If-None-Match')===object.httpEtag){await object.body?.cancel();headers.delete('Content-Length');return new Response(null,{status:304,headers});}
   if(servedRange)headers.set('Content-Range',`bytes ${servedRange.offset}-${servedRange.offset+servedRange.length-1}/${object.size}`);
   return new Response(request.method==='HEAD'?null:object.body,{status:servedRange?206:200,headers});
  },
  nextAlarm(){if(records.pendingArchives().some(row=>!row.purge_requires_lifecycle))return Date.now()+60_000;const rows=records.activeUploads();return rows.length?Math.max(Date.now()+1000,Math.min(...rows.map(row=>row.status==='cancelling'?(row.cleanup_after||Date.now()):row.expires_at))):null;},
  async expire({fenced=false,beforeDelete=async()=>{}}={}){
   try{
    for(const row of records.activeUploads().filter(row=>fenced?row.status!=='cancelling'||!row.cleanup_after||row.cleanup_after<=Date.now():row.status==='cancelling'||row.expires_at<=Date.now()).slice(0,20))await cancel(row.id,null,{fenced:true,beforeDelete});
    if(fenced){const rows=await records.ownedAssets();if(rows.length>10000)throw fail(409,'Media deletion inventory exceeds its bound');for(const row of rows)if(['ready','archiving','archived'].includes(row.status)&&!row.purged_at){await beforeDelete();await archive(row.id,null,{fenced:true,deleting:true});}}
    else for(const row of records.pendingArchives().filter(row=>!row.purge_requires_lifecycle).slice(0,20))await archive(row.id,null,{fenced:true});
   }finally{const due=this.nextAlarm();if(due)await schedule(Math.max(Date.now()+60_000,due));}
   if(fenced){const pending=records.activeUploads();if(pending.length)return {pending:true,retryAt:Math.max(Date.now()+1000,Math.min(...pending.map(row=>row.status==='cancelling'?(row.cleanup_after||Date.now()):Date.now())))};}
   return {pending:false};
  },

  async inventory(){const assets=await records.ownedAssets();if(assets.length>10000)throw fail(409,'Media deletion inventory exceeds its bound');return {assets:assets.filter(row=>!row.purged_at).map(row=>({id:row.id,status:row.status,bytes:row.bytes,sha256:row.sha256,legacy:Boolean(row.legacy)})),uploads:records.activeUploads().map(row=>({id:row.id,status:row.status,expiresAt:row.expires_at}))};},
 };
}
