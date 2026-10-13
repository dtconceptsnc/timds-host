/** Bounded public-shape catalogue from authoritative coordinator SQLite. Raw
 * source JSON, artifact refs, runner state and provider credentials stay private. */
export function readSourceView({storage,source,canRollback,canAdmin}) {
  if(['deleting','deleted'].includes(source.lifecycle_status))return {apiVersion:1,source:{id:source.id,systemId:source.system_id,name:source.name||source.system_id,archivedAt:source.archived_at||null,lifecycleStatus:source.lifecycle_status,publishedVersionId:null,publishedVersion:null,sourceCommit:null,contentDigest:null},currentVersion:null,versions:[],canRollback:false,canAdmin:canAdmin===true};
  const sql=storage.sql;
  const descriptor=row=>({id:row.id,versionLabel:row.version_label,sourceCommit:row.source_commit,contentDigest:row.content_digest,publishedAt:row.first_published_at,rollbackEligible:true});
  const first=sql.exec(`WITH ranked AS (
    SELECT row_json,ROW_NUMBER() OVER(PARTITION BY json_extract(row_json,'$.version_label') ORDER BY json_extract(row_json,'$.created_at'),id) AS position
    FROM publication_events
  ) SELECT v.row_json AS version_json,json_extract(e.row_json,'$.created_at') AS published_at
    FROM ranked e JOIN versions v ON v.id=json_extract(e.row_json,'$.design_system_version_id')
    WHERE e.position=1 AND json_extract(v.row_json,'$.artifact_ref') IS NOT NULL
    ORDER BY published_at DESC,v.id DESC LIMIT 100`).toArray();
  const versions=first.map(row=>descriptor({...JSON.parse(row.version_json),first_published_at:row.published_at}));
  let currentVersion=null;
  if(source.published_version_id){
    const current=sql.exec(`SELECT v.row_json AS version_json,MIN(json_extract(e.row_json,'$.created_at')) AS published_at
      FROM versions v JOIN publication_events e ON json_extract(e.row_json,'$.design_system_version_id')=v.id
      WHERE v.id=? GROUP BY v.id`,source.published_version_id).toArray()[0];
    if(current){const value=JSON.parse(current.version_json);if(value.source_id===source.id&&value.artifact_ref)currentVersion=descriptor({...value,first_published_at:current.published_at});}
  }
  return {apiVersion:1,source:{id:source.id,systemId:source.system_id,name:source.name||source.system_id,archivedAt:source.archived_at||null,lifecycleStatus:source.lifecycle_status,publishedVersionId:source.published_version_id||null,publishedVersion:source.published_version||null,sourceCommit:source.source_commit||null,contentDigest:source.content_digest||null},currentVersion,versions,canRollback:canRollback===true,canAdmin:canAdmin===true};
}
