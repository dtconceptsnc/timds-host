import { sessionIdPattern } from '../../runtime/policy.mjs';
const fail = (statusCode,message) => Object.assign(new Error(message),{statusCode});

/** Native DO transport only: no bearer credential or portal URL is involved. */
export function createHostLiveSessions({sourceId, getLive, artifacts, store, hosts, subscriptions, clock = () => Date.now()}) {
  const configured=Boolean(getLive && artifacts && hosts && subscriptions);
  function native(id){if(!configured)throw fail(503,'The live session runner is not configured');if(!sessionIdPattern.test(id || ''))throw fail(404,'Live session not found');return getLive(id);}
  async function owned(id,{open = true}={}) {
    const session=await store.get(id),source=session && await store.getSource(session.source_id);
    if(!session || session.source_id!==sourceId || !source || source.id!==sourceId)throw fail(404,'Live session not found');
    if(session.fork_repository!==`session-${session.id}`)throw fail(409,'Live fork identity mismatch');
    if(open && (source.archived_at || source.lifecycle_status!=='ready' || store.eligible && !await store.eligible(source) || session.status!=='open' || session.expires_at && Date.parse(session.expires_at)<=clock()))throw fail(410,'Live session is closed or expired');
    return {session,source};
  }
  async function configure(session) {
    if(session.source_id!==sourceId)throw fail(409,'Live source identity mismatch');
    return native(session.id).configure(session.id,{sourceId,expiresAt:session.expires_at});
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
    async ensure(session,source) {
      if(!configured)return {live_url:'',sandbox_id:'',live_state:'unavailable'};
      if(source.id!==sourceId || session.source_id!==sourceId)throw fail(409,'Live source identity mismatch');
      await subscriptions.ensure(session,source);
      const status=await configure(session),url=await hosts.ensure(session,source);
      return {live_url:url,sandbox_id:session.id,live_state:status.state || 'sleeping'};
    },
    async credentials({sessionId}) {
      const {session,source}=await owned(sessionId);
      const repo=await artifacts.getRepository(source.artifacts_namespace,session.fork_repository);
      if(!repo?.remote)throw fail(409,'Live session fork is unavailable');
      const token=await artifacts.mintToken(source.artifacts_namespace,session.fork_repository,{permission:'read',ttlSeconds:900});
      return {remote:repo.remote,repoToken:token.token,baseRevision:session.base_revision,expiresAt:session.expires_at};
    },
    async state({sessionId,state}) {
      if(!['sleeping','starting','ready','running','failed','closed'].includes(state))throw fail(400,'Invalid live state');
      const {session}=await owned(sessionId,{open:false});
      if(session.status!=='open' && state!=='closed')throw fail(410,'Live session is closed');
      await store.updateSession(sessionId,{live_state:state},{expectedStatus:session.status});
      return {ok:true};
    },
    async pushed(session,{revision}={}) {
      if(!configured || !session.sandbox_id)return {ignored:true};
      await owned(session.id);
      return native(session.id).pushed(/^[a-f0-9]{40}$/.test(revision || '')?{revision}:{});
    },
    async close(session,source) {
      if(session.source_id!==sourceId || source.id!==sourceId)throw fail(409,'Live source identity mismatch');
      if(configured)await native(session.id).close(session.id);
      if(configured || session.sandbox_id){await hosts.close(session,source);await subscriptions.close(session,source);}
      await store.updateSession(session.id,{live_state:'closed',live_url:'',sandbox_id:''});
    },
  };
}

/** Called solely from the native runtime capability. The coordinator decides
 * serialization: live-credentials/state may be reentrant during native start;
 * complete and expired must use its normal durable mutation queue.
 */
export function createLiveCallbacks({sourceId,store,sessions,live,designer,clock = () => Date.now()}) {
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
    if(action==='live-state')return live.state(body);
    if(action==='expired') {
      const expired=Boolean(session.expires_at && Date.parse(session.expires_at)<=clock());
      if(!['closing','closed','expired'].includes(session.status) && !expired)throw fail(409,'Session has not expired');
      return sessions.close({operator:true,system:true,principalId:session.owner_principal_id,userId:null,tokenId:null},session.id,expired);
    }
    throw fail(404,'Unknown live callback');
  };
}
