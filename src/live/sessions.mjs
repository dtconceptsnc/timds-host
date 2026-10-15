import { sessionIdPattern } from '../../runtime/policy.mjs';
import { safeRequestDiagnostic } from '../requests/diagnostics.mjs';
import { fail } from '../store/errors.mjs';
// One keepalive window; the Studio client re-sends `viewing` every five minutes.
export const WATCH_MS = 30*60_000;

/** Native DO transport only: no bearer credential or portal URL is involved. */
export function createHostLiveSessions({sourceId, getLive, artifacts, store, hosts, subscriptions, clock = () => Date.now()}) {
  const configured=Boolean(getLive && artifacts && hosts && subscriptions);
  function native(id){if(!configured)throw fail(503,'The live session runner is not configured');if(!sessionIdPattern.test(id || ''))throw fail(404,'Live session not found');return getLive(id);}
  async function owned(id,{open = true,fork = true}={}) {
    const session=await store.get(id),source=session && await store.getSource(session.source_id);
    if(!session || session.source_id!==sourceId || !source || source.id!==sourceId)throw fail(404,'Live session not found');
    if(fork && session.fork_repository!==`session-${session.id}`)throw fail(409,'Live fork identity mismatch');
    if(open && (source.archived_at || source.lifecycle_status!=='ready' || store.eligible && !await store.eligible(source) || session.status!=='open' || session.expires_at && Date.parse(session.expires_at)<=clock()))throw fail(410,'Live session is closed or expired');
    return {session,source};
  }
  // Host-written wake marker. setLiveState dedupes it, and the runtime's own
  // starting/ready/failed reports follow it. Never thrown to the caller.
  async function mark(id,state = 'waking') {
    try {const session=await store.get(id);if(session?.source_id===sourceId && session.status==='open')await store.setLiveState(id,state,{expectedStatus:'open'});}catch{}
  }
  async function configure(session) {
    if(session.source_id!==sourceId)throw fail(409,'Live source identity mismatch');
    return native(session.id).configure(session.id,{sourceId,expiresAt:session.expires_at});
  }
  // Host preparation needs no fork and can overlap repository.start. Keep its
  // URL private until the coordinator checkpoints both independent jobs.
  async function ensureHost(session,source,{authorize = async()=>{},signal,step = (_stage,run)=>run()} = {}) {
    if(!configured)return {live_host_url:'',sandbox_id:'',live_state:'unavailable'};
    if(source.id!==sourceId || session.source_id!==sourceId)throw fail(409,'Live source identity mismatch');
    const check=async()=>{signal?.throwIfAborted();await authorize();signal?.throwIfAborted();};
    await check();const status=await step('live-configure',()=>configure(session));
    await check();const url=await hosts.ensure(session,source,{signal,authorize:check,step});
    return {live_host_url:url,sandbox_id:session.id,live_state:status.state || 'sleeping'};
  }
  // Fork completion need not wait for the Worker. Confirm the alarm actually
  // began its wake while subscription provisioning runs, without awaiting ready.
  async function ensureFork(session,source,{authorize = async()=>{},signal,step = (_stage,run)=>run(),wakeIssued = async()=>{}} = {}) {
    if(!configured)return {sandbox_id:'',live_state:'unavailable'};
    if(source.id!==sourceId || session.source_id!==sourceId)throw fail(409,'Live source identity mismatch');
    const check=async()=>{signal?.throwIfAborted();await authorize();signal?.throwIfAborted();await owned(session.id);};
    // Either job can reach configure first; it must be idempotent and preserve
    // an already requested wake when the other job arrives later.
    await check();await step('live-configure',()=>configure(session));
    let issuedAt=session.live_wake_issued_at;
    const wake=async()=>{
      const prior=issuedAt?await native(session.id).status():null;
      if(prior?.wakeStartedAt)return prior;
      return step('live-wake',async()=>{
        await check();await mark(session.id);let status=await native(session.id).resume(session.id);
        if(!issuedAt){issuedAt=new Date(clock()).toISOString();await check();await wakeIssued(issuedAt);}
        const receiptSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000);
        while(!status?.wakeStartedAt){
          await check();
          if(['closing','closed'].includes(status?.state))throw fail(410,'Live session closed before wake');
          if(receiptSignal.aborted)throw fail(503,'Live session wake did not begin');
          await new Promise(resolve=>setTimeout(resolve,250));
          let abort;
          try{status=await Promise.race([native(session.id).status(),new Promise((_,reject)=>{abort=()=>reject(fail(503,'Live session wake did not begin'));receiptSignal.addEventListener('abort',abort,{once:true});if(receiptSignal.aborted)abort();})]);}
          finally{if(abort)receiptSignal.removeEventListener('abort',abort);}
        }
        return status;
      });
    };
    // Keep both branches inside the provisioning lease even when one fails;
    // a late subscription response must not outlive a failed job's authority.
    const completed=await Promise.allSettled([wake(),(async()=>{await check();return subscriptions.ensure(session,source,{signal,authorize:check,step});})()]);
    const failed=completed.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    await check();const status=await native(session.id).status();
    return {sandbox_id:session.id,live_state:status.state==='sleeping'?'waking':status.state || 'waking',live_wake_issued_at:issuedAt};
  }
  async function remove(session,source) {
    if(session.source_id!==sourceId || source.id!==sourceId)throw fail(409,'Live source identity mismatch');
    const fork=`session-${session.id}`;
    if(session.fork_repository && session.fork_repository!==fork)throw fail(409,'Live fork identity mismatch');
    if(configured)await native(session.id).close(session.id);
    if(configured || session.sandbox_id){await hosts.close(session,source);await subscriptions.close({...session,fork_repository:fork},source);}
  }
  return {
    configured,
    async runner(id,action = '',method = 'GET',body) {
      const live=native(id);
      if(action==='' && method==='GET')return live.status();
      if(action==='run' && method==='POST'){await owned(id);return live.start(id,body);}
      if(action==='push' && method==='POST'){await owned(id);return live.pushed(body);}
      if(action==='' && method==='DELETE'){await owned(id,{open:false});return live.close(id);}
      throw fail(400,'Unsupported native live operation');
    },
    async schedule(session) {if(configured)return configure(session);},
    // Runtime diagnostics for a session the caller may read: last wake phase
    // timings, dependency cache outcome, startup error and dev server state.
    // Never starts a container; a closed session still reports its last wake.
    async diagnostics(id) {
      const {session}=await owned(id,{open:false,fork:false});
      const recovery=prefix=>({pending:Boolean(session[`${prefix}_pending`]),attempts:session[`${prefix}_attempts`]||0,nextAttemptAt:session[`${prefix}_retry_at`]||null,error:session[`${prefix}_error`]||'',diagnostic:safeRequestDiagnostic(session[`${prefix}_diagnostic`])});
      const runtime=configured?await native(id).diagnostics():{state:'unavailable'};
      return {...runtime,startStartedAt:session.start_started_at||null,startPhases:session.start_phases||{},startBackgroundPhases:session.start_background_phases||{},startRecovery:{fork:recovery('start'),host:recovery('live_host'),live:recovery('live'),wakeIssued:Boolean(session.live_wake_issued_at),wakeIssuedAt:session.live_wake_issued_at||null}};
    },
    waking:id=>mark(id,'waking'),
    // A viewer that waits for a wake which then never starts sees `sleeping` again.
    slept:id=>mark(id,'sleeping'),
    /** Feed keepalive. watched refreshes the LiveSession's idle deadline and its
     * 30-minute watch; opened (a viewer arriving) or a lapsed watch on a session
     * that slept normally also wakes it visibly. The coordinator never waits on
     * a container start: resume() only arms the LiveSession's own alarm. */
    async watch(id,{watched,opened = false}={}) {
      if(!configured || !sessionIdPattern.test(id || ''))return {ignored:true};
      const session=await store.get(id);
      if(!session || session.source_id!==sourceId)return {ignored:true};
      if(!watched)return native(id).watch({sessionId:id,watched:false});
      try{await owned(id);}catch{return {ignored:true};}
      const status=await native(id).watch({sessionId:id,watched:true,until:clock()+WATCH_MS});
      // A failed wake is retried only by a viewer arriving, never by the periodic refresh.
      if(status?.state==='sleeping' && (opened?status.reported!=='none':status.reported==='sleeping')){await mark(id,'waking');await native(id).resume(id);return {...status,waking:true};}
      return status;
    },
    ensureHost,
    ensureFork,
    async ensure(session,source,options = {}) {
      const host=await ensureHost(session,source,options);
      const fork=await ensureFork({...session,...host},source,options);
      return {...host,...fork,live_url:host.live_host_url};
    },
    async credentials({sessionId}) {
      const {session,source}=await owned(sessionId);
      const repo=await artifacts.getRepository(source.artifacts_namespace,session.fork_repository);
      if(!repo?.remote)throw fail(409,'Live session fork is unavailable');
      const token=await artifacts.mintToken(source.artifacts_namespace,session.fork_repository,{permission:'read',ttlSeconds:900});
      return {remote:repo.remote,repoToken:token.token,baseRevision:session.base_revision,expiresAt:session.expires_at};
    },
    async state({sessionId,state},request = null) {
      if(!['sleeping','starting','ready','running','failed','closed'].includes(state))throw fail(400,'Invalid live state');
      const {session}=await owned(sessionId,{open:false});
      if(session.status!=='open' && state!=='closed')throw fail(410,'Live session is closed');
      await store.setLiveState(sessionId,state,{expectedStatus:session.status,request});
      return {ok:true};
    },
    async pushed(session,{revision}={}) {
      if(!configured || !session.sandbox_id)return {ignored:true};
      await owned(session.id);
      return native(session.id).pushed(/^[a-f0-9]{40}$/.test(revision || '')?{revision}:{});
    },
    async close(session,source) {
      await remove(session,source);
      await store.updateSession(session.id,{live_state:'closed',live_url:'',live_host_url:'',sandbox_id:'',live_pending:false,live_lease_token:null,live_lease_expires_at:null,live_host_pending:false,live_host_lease_token:null,live_host_lease_expires_at:null});
    },
    // A close can finish while deferred provisioning is in flight. Repeat its
    // deterministic remote cleanup without changing the terminal session row.
    remove,
  };
}

/** Called solely from the native runtime capability. The coordinator decides
 * serialization: live-credentials/state may be reentrant during native start;
 * complete and expired must use its normal durable mutation queue.
 */
export function createLiveCallbacks({sourceId,store,sessions,live,designer,requestBinding = async () => null,onRunnerIdle = async () => {},clock = () => Date.now()}) {
  async function sessionBound(body) {
    if(!sessionIdPattern.test(body?.sessionId || ''))throw fail(404,'Session not found');
    const session=await store.get(body.sessionId);
    if(!session || session.source_id!==sourceId)throw fail(404,'Session not found');
    return session;
  }
  return async function callback(action,body) {
    if(action==='pushed')return designer.pushed(body);
    const session=await sessionBound(body);
    if(action==='complete')return designer.complete(body);
    if(action==='live-credentials')return live.credentials(body);
    if(action==='live-state') {
      // The runtime may name its current Request; only a binding to this
      // source and session attributes the state (and a failed run) to it.
      const requestId=sessionIdPattern.test(body?.requestId || '')?body.requestId:null;
      const binding=requestId?await requestBinding(requestId):null;
      const bound=binding?.sourceId===sourceId && (binding.sessionId?binding.sessionId===session.id:session.originating_request_id===requestId);
      const result=await live.state({sessionId:body.sessionId,state:body?.state},bound?{requestId,agentPrincipalId:binding.agentPrincipalId || null,note:binding.note || ''}:null);
      // ready/failed/sleeping/closed release the session to its next queued Request.
      if(['ready','failed','sleeping','closed'].includes(body?.state))try{await onRunnerIdle(session.id);}catch{}
      return result;
    }
    if(action==='expired') {
      const expired=Boolean(session.expires_at && Date.parse(session.expires_at)<=clock());
      if(!['closing','closed','expired'].includes(session.status) && !expired)throw fail(409,'Session has not expired');
      return sessions.close({operator:true,system:true,principalId:session.owner_principal_id,userId:null,tokenId:null},session.id,expired);
    }
    throw fail(404,'Unknown live callback');
  };
}
