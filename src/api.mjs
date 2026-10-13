import { Catalog } from './store/catalog.mjs';
import { fail } from './store/errors.mjs';
import { apiHeaders, assertApiVersion, readJson, jsonResponse } from './http.mjs';
import { streamJsonFileTrees } from './repository/file-trees.mjs';
import { hostOrigin } from './http.mjs';
import { verifyBootstrapSecret } from './auth/access.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function segment(value) { try { return decodeURIComponent(value); } catch { throw fail(400,'Invalid route encoding'); } }
/** Public callers can select only these operations. Native control methods have
 * no HTTP route and cannot be selected through an input body. */
export function createApi({ getCoordinator, provision, mcp }) {
  return async function api(request, env, context, actor) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const catalog = new Catalog(env.CATALOG);
    if (path === '/api/timds/mcp' && mcp) return mcp(request,env,context,actor);
    const input = method === 'POST' ? await readJson(request) : {};
    assertApiVersion(request,input);
    const source = async reference => { const row = typeof reference === 'string' && await catalog.source(reference); if (!row) throw fail(404,'Design System not found'); return row; };
    const located = async (kind,id) => { if (!uuid.test(id)) throw fail(404,'Resource not found'); const row=await catalog.resource(kind,id); if (!row) throw fail(404,'Resource not found'); return row.source_id; };
    let statusOverride;
    const call = async (sourceId,operation,args=[]) => {
      const envelope = await getCoordinator(context,sourceId).api({operation,actor,args});
      if (!envelope.ok) throw Object.assign(fail(envelope.error.statusCode,envelope.error.message),envelope.error.details || {});
      statusOverride=envelope.httpStatus;
      return envelope.value;
    };
    const respond = (result,status=200) => streamJsonFileTrees(result,env.SNAPSHOTS,{status,headers:apiHeaders});
    if (path === '/api/timds/me' && method === 'GET') {
      const principal = await catalog.principal(actor.principalId);
      return jsonResponse({ principal:{id:principal.id,type:principal.type,name:principal.name,admin:principal.admin} });
    }
    if(path==='/api/timds/bootstrap'&&method==='POST') {
      if(actor.type!=='user'||!uuid.test(input.operationId||'')||!verifyBootstrapSecret(request.headers.get('X-TimDS-Bootstrap-Secret'),env.TIMDS_BOOTSTRAP_SECRET))throw fail(403,'Bootstrap authentication failed');
      const principal=await catalog.bootstrapAdmin(actor,input.operationId);
      return jsonResponse({principal:{id:principal.id,type:principal.type,name:principal.name,admin:principal.admin}});
    }
    if (path === '/api/timds/design-systems' && method === 'GET') {
      return jsonResponse({systems:(await catalog.sourcesForPrincipal(actor.principalId)).filter(row=>row.lifecycle_status==='ready'&&!row.archived_at).map(row=>({id:row.id,systemId:row.system_id,name:row.name||row.system_id}))});
    }
    if (path === '/api/timds/sessions' && method === 'POST') {
      const row=await source(input.systemId); return respond(await call(row.id,'start',[input]));
    }
    let match=path.match(/^\/api\/timds\/sessions\/([^/]+)(?:\/(status|history|submit|update|close|join|claims))?$/);
    if (match) {
      const id=segment(match[1]), action=match[2] || 'snapshot';
      const expected=['snapshot','status','history'].includes(action)?'GET':'POST';
      if(method!==expected)throw fail(405,`Use ${expected}`);
      const operation=action==='claims'?'claim':action;
      return respond(await call(await located('session',id),operation,[id,...(method==='POST'&&action!=='close'?[input]:[])]));
    }
    match=path.match(/^\/api\/timds\/design-systems\/([^/]+)\/(active-work|submissions|drafts|rollback|requests)(?:\/([^/]+))?(?:\/(snapshot|close))?$/);
    if(match) {
      const reference=segment(match[1]), action=match[2], child=match[3] && segment(match[3]), tail=match[4], row=await source(reference);
      if(action==='active-work'&&!child&&method==='GET')return respond(await call(row.id,'activeWork',[reference]));
      if(action==='submissions'&&!child&&method==='GET')return respond(await call(row.id,'listSubmissions',[]));
      if(action==='drafts') {
        if(!child&&method==='GET')return respond(await call(row.id,'listDrafts',[reference]));
        if(!child&&method==='POST')return respond(await call(row.id,'createDraft',[reference,input]));
        if(child&&tail==='snapshot'&&method==='GET')return respond(await call(row.id,'draftSnapshot',[reference,child]));
        if(child&&tail==='close'&&method==='POST')return respond(await call(row.id,'closeDraft',[reference,child]));
      }
      if(action==='rollback'&&!child&&method==='POST')return respond(await call(row.id,'rollback',[input]));
      if(action==='requests'&&uuid.test(reference)) {
        if(!child&&method==='POST')return respond(await call(row.id,'createRequest',[row.id,input]),202);
        if(child&&!tail&&method==='GET')return respond(await call(row.id,'readRequest',[row.id,child]));
      }
      throw fail(404,'Route not found');
    }
    match=path.match(/^\/api\/timds\/submissions\/([^/]+)\/publish$/);
    if(match&&method==='POST') {
      const id=segment(match[1]), result=await call(await located('submission',id),'publish',[id,input]);
      return respond(result,statusOverride || (input.preflight||input.dryRun?200:202));
    }
    match=path.match(/^\/api\/timds\/publications\/([^/]+)$/);
    if(match&&method==='GET') {const id=segment(match[1]);return respond(await call(await located('publication',id),'readPublication',[id]));}
    if(path.startsWith('/api/timds/admin/')) {
      const principal=await catalog.principal(actor.principalId);
      if(!principal?.admin||principal.status!=='active')throw fail(403,'An active administrator is required');
      if(path==='/api/timds/admin/organizations'&&method==='POST') {
        if(!uuid.test(input.id||'')||typeof input.name!=='string'||input.name.length>200)throw fail(400,'Organization id and name are required');
        return jsonResponse({organization:await catalog.ensureOrganization({id:input.id,name:input.name})});
      }
      if(path==='/api/timds/admin/systems'&&method==='POST'&&provision)return respond(await provision({input,actor,env,context,catalog}));
      if(path==='/api/timds/admin/agents'&&method==='POST') {
        if(!uuid.test(input.id||'')||typeof input.name!=='string'||!input.name.trim()||input.name.length>200)throw fail(400,'A stable agent UUID and name are required');
        const saved=await catalog.resolveIdentity({issuer:`urn:timds:host:${hostOrigin(env)}`,subject:`agent:${input.id}`,type:'agent',name:input.name});
        if(saved.status!=='active')throw fail(409,'This agent was deactivated; create a new identity');
        return jsonResponse({principal:{id:saved.id,name:saved.name,type:saved.type,status:saved.status}});
      }
      match=path.match(/^\/api\/timds\/admin\/principals\/([^/]+)\/deactivate$/);
      if(match&&method==='POST') {
        const id=segment(match[1]);
        if(!uuid.test(id)||!uuid.test(input.operationId||''))throw fail(400,'Principal and operation UUIDs are required');
        if(id===actor.principalId)throw fail(409,'Use another administrator to deactivate your own identity');
        const operation=await catalog.beginPrincipalDeactivation({principalId:id,actor,operationId:input.operationId});
        for(const target of operation.targets)if(!target.fenced)await getCoordinator(context,target.source_id).fencePrincipal({operationId:input.operationId,principalId:id,version:operation.version});
        const saved=await catalog.finalizePrincipalDeactivation({operationId:input.operationId,actor});
        return jsonResponse({principal:{id:saved.id,status:saved.status}});
      }
      match=path.match(/^\/api\/timds\/admin\/systems\/([^/]+)\/authority$/);
      if(match&&method==='POST') {
        const row=await source(segment(match[1]));
        if(!uuid.test(input.operationId||''))throw fail(400,'An operation UUID is required');
        const allowed=['principalId','read','write','publish'];
        if(!input.command||Object.keys(input.command).some(key=>!allowed.includes(key))||!uuid.test(input.command.principalId||'')||['read','write','publish'].some(key=>key in input.command&&typeof input.command[key]!=='boolean'))throw fail(400,'Use a principal and explicit read, write or publish permissions');
        return respond(await call(row.id,'authority',[{operationId:input.operationId,command:input.command}]));
      }
    }
    throw fail(404,'Route not found');
  };
}
