import { randomUUID } from 'node:crypto';
import { safeRequestDiagnostic } from './diagnostics.mjs';

const fail = (statusCode, message) => Object.assign(new Error(message), {statusCode});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const terminal = status => ['failed','dead_letter','cancelled'].includes(status);

/** Source-local durable Request jobs. Catalog reserves global Request identity first.
 * Invoke through the coordinator's serialized queue; never hold a transaction
 * across a catalog read or a native runtime call.
 */
export function createRequestStore({storage, sourceId, catalog, store, clock = () => Date.now(), ids = randomUUID}) {
  if (!uuid.test(sourceId) || !storage?.sql || !storage.transactionSync) throw new Error('A source SQLite coordinator is required');
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
    CREATE TABLE IF NOT EXISTS request_jobs(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)),
      request_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.payload_json.requestId')) STORED UNIQUE REFERENCES requests(id));`);
  const get = (table,id) => {const row=sql.exec(`SELECT row_json FROM ${table} WHERE id=?`,id).toArray()[0];return row ? JSON.parse(row.row_json) : null;};
  const put = (table,row) => {sql.exec(`INSERT INTO ${table}(id,row_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET row_json=excluded.row_json`,row.id,JSON.stringify(row));return row;};
  const timestamp = () => new Date(clock()).toISOString();
  const atomic = fn => storage.transactionSync(fn);
  const binding = request => JSON.stringify([request.source_id,request.requested_by,request.prompt,request.session_id || null]);
  const leased = ({jobId,leaseToken}) => {
    const job=get('request_jobs',jobId);
    if (!job || !leaseToken || job.lease_token!==leaseToken || !['leased','running'].includes(job.status) || !(Date.parse(job.lease_expires_at)>clock())) throw fail(409,'Designer Request execution lease is unavailable');
    return job;
  };
  // Request feed rows commit inside the same transaction as the job transition.
  const requestEvent = (event_type,request,job,details = {}) => {
    let sessionId = request?.session_id || null;
    if (!sessionId) try { sessionId = store.sessionForRequest(sourceId,job.payload_json.requestId)?.id || null; } catch { sessionId = null; }
    return store.recordEvent({event_type,session_id:sessionId,actor_principal_id:event_type === 'request_received' ? request.requested_by : request?.runner_principal_id || null,
      originating_request_id:job.payload_json.requestId,note:request?.prompt?.slice(0,2000) || '',details_json:{requestId:job.payload_json.requestId,executionJobId:job.id,...details}});
  };
  // Requests that name a session run one at a time in arrival order: only the
  // oldest pending job per target session is a candidate, never beside a live
  // lease or a runner the session last reported as running. A runner report lost
  // for longer than the runtime task limit stops holding the session.
  const pending = () => sql.exec("SELECT row_json FROM request_jobs WHERE json_extract(row_json,'$.status') IN ('queued','leased','running') ORDER BY json_extract(row_json,'$.created_at'),id").toArray().map(row=>JSON.parse(row.row_json));
  const target = job => job.payload_json?.sessionId || null;
  const holding = job => ['leased','running'].includes(job.status) && Date.parse(job.lease_expires_at) > clock();
  const runnerBusy = id => {const row=get('sessions',id);return row?.live_state==='running' && Date.parse(row.updated_at)>clock()-15*60_000;};
  const heads = () => {const seen=new Set(),out=[];for(const job of pending()){const id=target(job);if(!id){out.push({job});continue;}if(seen.has(id))continue;seen.add(id);out.push({job,blocked:!holding(job) && runnerBusy(id)});}return out;};
  const before = (a,b) => a.created_at<b.created_at || a.created_at===b.created_at && a.id<b.id;
  const failed = (job,status,error,diagnostic = null) => requestEvent('request_failed',get('requests',job.payload_json.requestId),job,{attempt:job.attempt_count,status,error,...(diagnostic ? {diagnostic} : {})});
  return {
    async reserve({requestId,sourceId:id,requestedBy,runnerPrincipalId,prompt,sessionId = null}) {
      if(id!==sourceId || !uuid.test(requestId) || !uuid.test(requestedBy) || !uuid.test(runnerPrincipalId || '') || sessionId && !uuid.test(sessionId) || typeof prompt!=='string' || !prompt.trim() || Buffer.byteLength(prompt)>32*1024) throw fail(400,'Invalid Designer Request identity');
      const request={id:requestId,source_id:sourceId,requested_by:requestedBy,runner_principal_id:runnerPrincipalId,prompt:prompt.trim(),session_id:sessionId || null,status:'new',created_at:timestamp(),updated_at:timestamp()};
      const existing=get('requests',requestId);
      if(existing && binding(existing)!==binding(request)) throw fail(409,'This Request belongs to another source, requester, session or prompt');
      if(existing) return {request:existing,job:this.jobForRequest(requestId)};
      const job={id:ids(),job_type:'timds_designer_request',payload_json:{requestId,sourceId,requestedBy,...(sessionId?{sessionId}:{})},status:'queued',attempt_count:0,max_attempts:3,lease_token:null,lease_owner:null,lease_expires_at:null,available_at:timestamp(),created_at:timestamp(),updated_at:timestamp(),error_message:null};
      const receipt=await catalog.reserveRequest({request,job});
      if(!receipt?.request || !uuid.test(receipt.request.runner_principal_id || '') || binding(receipt.request)!==binding(request) || receipt.request.id!==requestId || receipt.job?.payload_json?.requestId!==requestId || receipt.job.payload_json.sourceId!==sourceId || receipt.job.payload_json.requestedBy!==requestedBy || (receipt.job.payload_json.sessionId || null)!==request.session_id) throw fail(409,'Request reservation identity mismatch');
      return atomic(()=>{
        const saved=get('requests',requestId);
        if(saved) {if(binding(saved)!==binding(request))throw fail(409,'Request reservation identity mismatch');return {request:saved,job:this.jobForRequest(requestId)};}
        put('requests',receipt.request);put('request_jobs',receipt.job);
        store.enqueueResource('request',requestId);store.enqueueResource('request-job',receipt.job.id);
        requestEvent('request_received',receipt.request,receipt.job,{runnerPrincipalId:receipt.request.runner_principal_id,targetSessionId:receipt.request.session_id || null});
        return receipt;
      });
    },
    get: id => get('requests',id),
    getJob: id => get('request_jobs',id),
    jobForRequest(id) {const row=sql.exec('SELECT row_json FROM request_jobs WHERE request_id=?',id).toArray()[0];return row?JSON.parse(row.row_json):null;},
    claim({jobId,leaseToken,leaseOwner,leaseSeconds = 300}) {return atomic(()=>{
      const job=get('request_jobs',jobId);
      if(!job || !uuid.test(leaseToken || '') || !leaseOwner || terminal(job.status) || job.status==='succeeded' || job.available_at>timestamp() || job.lease_expires_at && Date.parse(job.lease_expires_at)>clock())return null;
      if(job.attempt_count>=job.max_attempts){put('request_jobs',{...job,status:'dead_letter',lease_token:null,lease_expires_at:null,updated_at:timestamp()});failed(job,'dead_letter','Designer Request execution did not finish');return null;}
      return put('request_jobs',{...job,status:'running',attempt_count:job.attempt_count+1,lease_token:leaseToken,lease_owner:leaseOwner,lease_expires_at:new Date(clock()+Math.max(30,Math.min(leaseSeconds,3600))*1000).toISOString(),updated_at:timestamp()});
    });},
    validateLease: leased,
    finish(input) {return atomic(()=>{const job=leased(input),request=get('requests',job.payload_json.requestId);put('requests',{...request,status:'processed',updated_at:timestamp()});return put('request_jobs',{...job,status:'succeeded',result_json:input.result || {},error_message:null,failure_diagnostic:null,lease_token:null,lease_owner:null,lease_expires_at:null,updated_at:timestamp()});});},
    fail(input) {return atomic(()=>{const job=leased(input),saved=put('request_jobs',{...job,status:job.attempt_count>=job.max_attempts?'dead_letter':'queued',error_message:'Designer Request execution failed',failure_diagnostic:safeRequestDiagnostic(input.diagnostic),lease_token:null,lease_owner:null,lease_expires_at:null,available_at:new Date(clock()+60_000).toISOString(),updated_at:timestamp()});failed(job,saved.status,saved.error_message,saved.failure_diagnostic);return saved;});},
    retry(jobId) {return atomic(()=>{const job=get('request_jobs',jobId);if(!job)throw fail(404,'Designer Request not found');if(!terminal(job.status))return job;return put('request_jobs',{...job,status:'queued',attempt_count:0,error_message:null,failure_diagnostic:null,lease_token:null,lease_owner:null,lease_expires_at:null,available_at:timestamp(),updated_at:timestamp()});});},
    // A session that is busy at dispatch time puts its Request back without
    // consuming an attempt or writing request_failed; it keeps its FIFO place.
    requeue(input) {return atomic(()=>{const job=leased(input);return put('request_jobs',{...job,status:'queued',attempt_count:Math.max(0,job.attempt_count-1),lease_token:null,lease_owner:null,lease_expires_at:null,available_at:new Date(clock()+(input.delayMs ?? 5_000)).toISOString(),updated_at:timestamp()});});},
    due(limit = 10) {const now=timestamp();return heads().filter(({job,blocked})=>!blocked && job.available_at<=now && (!job.lease_expires_at || job.lease_expires_at<=now)).slice(0,Math.max(1,Math.min(Number.isInteger(limit)?limit:10,100))).map(({job})=>job);},
    // Runner-held sessions re-arm through the live-state callback; one minute is the lost-report fallback.
    nextAlarm() {const times=heads().map(({job,blocked})=>blocked?clock()+60_000:Math.max(clock()+1000,Date.parse(job.available_at) || 0,Date.parse(job.lease_expires_at) || 0));return times.length?Math.min(...times):null;},
    // 0 when running, finished or not behind anyone; otherwise the Requests ahead
    // in its session, counting the one whose runner currently holds it.
    queuePosition(requestId,{runnerActive}={}) {
      const job=this.jobForRequest(requestId),id=job && target(job);
      if(!id || job.status!=='queued')return 0;
      const ahead=pending().filter(item=>item.id!==job.id && target(item)===id && before(item,job));
      return ahead.length+((runnerActive ?? runnerBusy(id)) && !ahead.some(holding)?1:0);
    },
    queueLengths() {const counts={};for(const job of pending())if(target(job) && job.status==='queued')counts[target(job)]=(counts[target(job)] || 0)+1;return counts;},
  };
}
