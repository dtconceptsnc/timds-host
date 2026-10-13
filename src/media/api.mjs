import { fail } from '../store/errors.mjs';
import { jsonResponse } from '../http.mjs';
import { UUID } from './contract.mjs';

/** Only explicit source-bound media operations reach the coordinator. */
export async function mediaApi({path,method,input,actor,source,getCoordinator,context}){
 let match=path.match(/^\/api\/timds\/design-systems\/([^/]+)\/media(?:\/(uploads)(?:\/([^/]+)(?:\/(parts|complete))?)?|\/([^/]+)\/(download|archive))?$/);
 const compatibility=path==='/api/timds/media/uploads'&&method==='POST';
 if(!match&&!compatibility)return null;
 let reference;
 try{reference=compatibility?(input.sourceId||input.source_id||input.systemId||input.system_id):decodeURIComponent(match[1]);}catch{throw fail(400,'Invalid media source');}
 const row=await source(reference);
 if(input.sourceId&&input.sourceId!==row.id||input.source_id&&input.source_id!==row.id||input.systemId&&input.systemId!==row.system_id||input.system_id&&input.system_id!==row.system_id)throw fail(403,'Media source does not match this route');
 let operation,body={...input};
 if(compatibility||match[2]==='uploads'&&!match[3]&&method==='POST')operation='create';
 else if(!match[2]&&!match[5]&&method==='GET')operation='list';
 else if(match[3]&&UUID.test(match[3])){
  body.uploadId=match[3];
  if(method==='DELETE'&&!match[4])operation='cancel';
  if(method==='POST'&&match[4]==='parts')operation='part';
  if(method==='POST'&&match[4]==='complete')operation='complete';
 }else if(match[5]&&UUID.test(match[5])){
  body.assetId=match[5];
  if(method==='GET'&&match[6]==='download')operation='download';
  if(method==='POST'&&match[6]==='archive')operation='archive';
 }
 if(!operation)throw fail(405,'Unsupported media operation');
 const result=await getCoordinator(context,row.id).mediaOperation({operation,actor,input:body});
 if(!result?.ok)throw fail(result?.error?.statusCode||502,result?.error?.message||'Media operation failed');
 return jsonResponse(result.value,operation==='create'&&!result.value.reused?201:200);
}
