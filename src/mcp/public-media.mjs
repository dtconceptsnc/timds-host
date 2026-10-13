const limit=1000;
/** Imported catalogue rows are retained history, not public JSON wholesale. */
export async function readImportedPublicMedia({catalog,storage,sourceId}){
  const active=await catalog.first("SELECT stage_id FROM import_operations WHERE source_id=? AND state='active'",sourceId);
  if(!active)return null;
  const rows=storage.sql.exec(`SELECT row_json FROM import_history WHERE stage_id=? AND kind='assets'
    AND json_extract(row_json,'$.design_system_source_id')=?
    AND json_extract(row_json,'$.status')='ready' AND json_extract(row_json,'$.visibility')='public'
    ORDER BY id LIMIT ?`,active.stage_id,sourceId,limit+1).toArray();
  const assets=[];
  for(const item of rows.slice(0,limit)){
    const row=JSON.parse(item.row_json),metadata=row.metadata_json||{};let url;
    try{url=new URL(row.public_url);}catch{continue;}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)continue;
    const value={id:row.id,key:typeof metadata.key==='string'?metadata.key.slice(0,300):null,
      title:String(row.title||'').slice(0,500),kind:String(row.kind||'').slice(0,40),
      tags:Array.isArray(row.tags)?row.tags.slice(0,50).map(tag=>String(tag).slice(0,100)):[],
      publicUrl:url.href,contentType:String(row.content_type||'').slice(0,150),
      bytes:Number(row.byte_size)||0,sha256:/^[a-f0-9]{64}$/.test(row.sha256||'')?row.sha256:null};
    for(const key of ['durationSeconds','width','height','frameRate'])if(Number.isFinite(metadata[key])&&metadata[key]>=0)value[key]=metadata[key];
    if(typeof metadata.codec==='string')value.codec=metadata.codec.slice(0,100);
    assets.push(value);
  }
  return {schemaVersion:2,assets,truncated:rows.length>limit,limit};
}
