const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const label=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const activeSession=new Set(['starting','open']);
const activeSubmission=new Set(['preparing','submitted','publishing']);
const fail=()=>Object.assign(new Error('Workers subdomain aliases are not configured correctly'),{statusCode:503});

/** Account renames change owned Workers hostnames, not durable source history.
 * Project only the documented active API DTO fields. Never walk file trees,
 * publication receipts, audit events, arbitrary URLs, or stored row objects.
 */
export function createActiveWorkersUrlProjection({sourceId,aliases='{}'}) {
  let mapping;
  try {mapping=JSON.parse(aliases);} catch {throw fail();}
  if(!uuid.test(sourceId)||!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.keys(mapping).length>10)throw fail();
  for(const [from,to] of Object.entries(mapping))if(!label.test(from)||typeof to!=='string'||!label.test(to)||from===to||Object.hasOwn(mapping,to))throw fail();
  const sourceWorker=`timds-${sourceId.replaceAll('-','').toLowerCase()}`;
  function projectUrl(value,worker) {
    if(typeof value!=='string'||!value||worker.length>63)return value;
    let url;try {url=new URL(value);}catch{return value;}
    if(url.protocol!=='https:'||url.username||url.password||url.port)return value;
    for(const [from,to] of Object.entries(mapping)) {
      if(url.hostname!==`${worker}.${from}.workers.dev`)continue;
      url.hostname=`${worker}.${to}.workers.dev`;
      return url.href;
    }
    return value;
  }
  function submission(row,sessionId) {
    if(!row||!uuid.test(row.id||'')||!uuid.test(row.sessionId||'')||sessionId&&row.sessionId!==sessionId||!activeSubmission.has(row.status)||!/^review-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.reviewBranch||''))return row;
    return {...row,previewUrl:projectUrl(row.previewUrl,`${row.reviewBranch}-${sourceWorker}`)};
  }
  function session(row) {
    if(!row||row.sourceId!==sourceId||!uuid.test(row.id||''))return row;
    return {...row,
      ...(activeSession.has(row.status)?{liveUrl:projectUrl(row.liveUrl,`live-${row.id.replaceAll('-','').toLowerCase()}`)}:{}),
      ...(Array.isArray(row.submissions)?{submissions:row.submissions.map(item=>submission(item,row.id))}:{}),
    };
  }
  return (value,{preflightSubmission}={})=>{
    if(!Object.keys(mapping).length||!value||typeof value!=='object')return value;
    const result={...value};
    if(value.session)result.session=session(value.session);
    for(const key of ['sessions','drafts'])if(Array.isArray(value[key]))result[key]=value[key].map(session);
    if(value.submission)result.submission=submission(value.submission,value.session?.id);
    if(Array.isArray(value.submissions))result.submissions=value.submissions.map(item=>submission(item,value.session?.id));
    const preflight=value.preflight,row=preflightSubmission;
    if(preflight&&row?.source_id===sourceId&&preflight.submissionId===row.id&&preflight.sessionId===row.session_id) {
      const projected=submission({id:row.id,sessionId:row.session_id,status:row.status,reviewBranch:row.review_branch,previewUrl:preflight.previewUrl});
      result.preflight={...preflight,previewUrl:projected.previewUrl};
    }
    return result;
  };
}
