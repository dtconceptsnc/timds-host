import { fail } from '../store/errors.mjs';
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const PART_BYTES=16*1024*1024,MAX_BYTES=PART_BYTES*10000,SINGLE_BYTES=32*1024*1024;
export const text=(value,max,label,required=false)=>{const out=String(value||'').trim();if(required&&!out||out.length>max)throw fail(400,`Invalid media ${label}`);return out;};
function safeFilename(filename){
 const extension=/\.([a-zA-Z0-9]{1,16})$/.exec(filename)?.[1]?.toLowerCase();
 const basename=filename.slice(0,extension?-extension.length-1:undefined).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120)||'asset';
 return basename+(extension?'.'+extension:'');
}
export const publicMediaFilename=row=>row.legacy?safeFilename(String(row.filename||'asset')):row.safe_filename;
export function normalizeMedia(input){
 const filename=text(input.filename,300,'filename',true);
 const contentType=text(input.contentType||input.content_type,200,'content type',true).toLowerCase();
 if(!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(contentType))throw fail(400,'Invalid media content type');
 const bytes=Number(input.bytes),sha256=text(input.sha256,64,'SHA256',true).toLowerCase(),key=text(input.key,80,'key');
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_BYTES)throw fail(400,`Media must be between 1 byte and ${MAX_BYTES} bytes`);
 if(!/^[a-f0-9]{64}$/.test(sha256)||key&&!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(key))throw fail(400,'Invalid media digest or key');
 if(input.visibility&&input.visibility!=='public')throw fail(400,'TimDS currently accepts public media only');
 const metadata={key};for(const field of ['durationSeconds','width','height','frameRate'])if(Number.isFinite(input[field])&&input[field]>=0)metadata[field]=input[field];if(input.codec)metadata.codec=text(input.codec,100,'codec');
 return {bytes,sha256,key,metadata,contentType,filename,safeFilename:safeFilename(filename),visibility:'public',rights:{},kind:text(input.kind||contentType.split('/')[0],40,'kind',true),title:text(input.title||filename,300,'title',true),tags:Array.isArray(input.tags)?[...new Set(input.tags.slice(0,50).map(value=>text(value,80,'tag',true)))]:[]};
}
export function mediaView(row){return {id:row.id,sourceId:row.source_id,clientId:row.client_id||null,bytes:row.bytes,contentType:row.content_type,createdAt:row.created_at,filename:row.filename,kind:row.kind,metadata:row.metadata||{},publicUrl:row.public_url||null,readyAt:row.ready_at||null,rights:row.rights||{},sha256:row.sha256,status:row.status,tags:row.tags||[],title:row.title,updatedAt:row.updated_at,visibility:row.visibility};}
export function importedMedia(row,sourceId){
 if(row.design_system_source_id!==sourceId||!UUID.test(row.id||'')||!['public','private'].includes(row.visibility)||!['ready','archived'].includes(row.status)||!/^[a-f0-9]{64}$/.test(row.sha256||'')||!Number.isSafeInteger(Number(row.byte_size))||Number(row.byte_size)<1||!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(row.content_type||''))return null;
 return {id:row.id,source_id:sourceId,client_id:row.client_id,bytes:Number(row.byte_size),content_type:row.content_type,created_at:row.created_at,filename:row.original_filename,kind:row.kind,metadata:row.metadata_json||{},public_url:row.public_url||null,ready_at:row.ready_at,rights:row.rights_json||{},sha256:row.sha256,status:row.status,tags:row.tags||[],title:row.title,updated_at:row.updated_at,visibility:row.visibility,legacy:true,storage_bucket:row.storage_bucket,object_key:row.object_key};
}
