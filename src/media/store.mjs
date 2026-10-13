import { importedMedia } from './contract.mjs';
export function createMediaStore({storage,catalog,sourceId}){
 const sql=storage.sql;
 for(const table of ['media_assets','media_uploads','media_capabilities'])sql.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)))`);
 sql.exec('CREATE TABLE IF NOT EXISTS media_parts(upload_id TEXT NOT NULL,number INTEGER NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(upload_id,number))');
 const get=(table,id)=>{const row=sql.exec(`SELECT row_json FROM ${table} WHERE id=?`,id).toArray()[0];return row?JSON.parse(row.row_json):null;};
 const put=(table,row)=>{sql.exec(`INSERT INTO ${table}(id,row_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET row_json=excluded.row_json`,row.id,JSON.stringify(row));return row;};
 async function legacy(id,limit=500){
  if(await catalog.first('SELECT id FROM provision_operations WHERE source_id=?',sourceId))return [];
  const active=await catalog.first("SELECT stage_id FROM import_operations WHERE source_id=? AND state='active'",sourceId);if(!active)return [];
  return sql.exec(`SELECT row_json FROM import_history WHERE stage_id=? AND kind='assets' AND json_extract(row_json,'$.design_system_source_id')=? ${id?'AND id=?':''} ORDER BY id LIMIT ?`,active.stage_id,sourceId,...(id?[id]:[]),limit+1).toArray().map(row=>importedMedia(JSON.parse(row.row_json),sourceId)).filter(Boolean);
 }
 return {
  getUpload:id=>get('media_uploads',id),putUpload:row=>put('media_uploads',row),
  getCapability:id=>get('media_capabilities',id),putCapability:row=>put('media_capabilities',row),
  putAsset:row=>put('media_assets',row),
  async asset(id){return get('media_assets',id)||(await legacy(id))[0]||null;},
  async assets(limit=500){limit=Math.max(1,Math.min(1000,Math.floor(limit)));const local=sql.exec('SELECT row_json FROM media_assets ORDER BY id LIMIT ?',limit+1).toArray().map(row=>JSON.parse(row.row_json)),seen=new Set(local.map(row=>row.id));return [...local,...(await legacy(null,limit)).filter(row=>!seen.has(row.id))].slice(0,limit+1);},
  async ownedAssets(){const local=sql.exec('SELECT row_json FROM media_assets ORDER BY id LIMIT 10001').toArray().map(row=>JSON.parse(row.row_json)),seen=new Set(local.map(row=>row.id));return [...local,...(await legacy(null,10000)).filter(row=>!seen.has(row.id))].slice(0,10001);},
  pendingArchives:()=>sql.exec("SELECT row_json FROM media_assets WHERE json_extract(row_json,'$.status')='archiving' ORDER BY id LIMIT 101").toArray().map(row=>JSON.parse(row.row_json)),
  byDigest:sha=>{const row=sql.exec("SELECT row_json FROM media_assets WHERE json_extract(row_json,'$.sha256')=? ORDER BY (json_extract(row_json,'$.status')='ready') DESC,id LIMIT 1",sha).toArray()[0];return row?JSON.parse(row.row_json):null;},
  parts:id=>sql.exec('SELECT row_json FROM media_parts WHERE upload_id=? ORDER BY number',id).toArray().map(row=>JSON.parse(row.row_json)),
  putPart:(id,row)=>sql.exec('INSERT INTO media_parts(upload_id,number,row_json) VALUES(?,?,?) ON CONFLICT(upload_id,number) DO UPDATE SET row_json=excluded.row_json',id,row.partNumber,JSON.stringify(row)),
  activeUploads:()=>sql.exec("SELECT row_json FROM media_uploads WHERE json_extract(row_json,'$.status') IN ('active','completing','creating','cancelling') ORDER BY id LIMIT 101").toArray().map(row=>JSON.parse(row.row_json)),
  expireCapabilities:now=>sql.exec("DELETE FROM media_capabilities WHERE json_extract(row_json,'$.expires_at')<?",now),
 };
}
