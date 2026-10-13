import { fail } from '../store/errors.mjs';
import { ImportCatalog } from './catalog.mjs';
import { UUID } from './contract.mjs';
import { readDeletedImport } from './tombstone.mjs';

export async function importApi({path,method,input,actor,context,catalog,getCoordinator}){
  let operation,sourceId,operationId;
  if(['/api/timds/admin/imports','/api/timds/admin/imports/abort-unprepared','/api/timds/admin/imports/tombstone'].includes(path)&&method==='POST'){
    operation=path.endsWith('/abort-unprepared')?'abort-unprepared':path.endsWith('/tombstone')?'tombstone':'prepare';sourceId=input.sourceId;
    if(!UUID.test(sourceId||''))throw fail(400,'An original source UUID is required');
  }else{
    const match=path.match(/^\/api\/timds\/admin\/imports\/([a-f0-9-]+)(?:\/(chunk|seal|activate|abort))?$/i);
    if(!match||!UUID.test(match[1]))throw fail(404,'Import route not found');
    operationId=match[1];operation=match[2]||'read';
    if(method!==(operation==='read'?'GET':'POST'))throw fail(405,operation==='read'?'Use GET':'Use POST');
    if(input.operationId!==undefined&&input.operationId!==operationId)throw fail(409,'Import route and body operation differ');
    const imports=new ImportCatalog(catalog),row=await imports.read(operationId),aborted=row?null:await imports.aborted(operationId),deleted=row||aborted?null:await readDeletedImport(catalog,operationId);
    if(!row&&!aborted&&!deleted)throw fail(404,'Import operation not found');
    if(deleted&&operation!=='read')throw fail(409,'A deleted-source import can never activate or thaw');
    sourceId=row?.source_id||aborted?.sourceId||deleted.source_id;
  }
  const response=await getCoordinator(context,sourceId).importOperation({operation,actor,input:{...input,...(operationId?{operationId}:{})}});
  if(!response.ok)throw fail(response.error.statusCode,response.error.message);
  return response.value;
}
