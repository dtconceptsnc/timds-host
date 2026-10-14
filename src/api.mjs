import { mediaApi } from './media/api.mjs';
import { Catalog } from './store/catalog.mjs';
import { fail } from './store/errors.mjs';
import { apiHeaders, assertApiVersion, readJson, jsonResponse } from './http.mjs';
import { streamJsonFileTrees } from './repository/file-trees.mjs';
import { hostOrigin, oauthOrigin } from './http.mjs';
import { verifyBootstrapSecret } from './auth/access.mjs';
import { importApi } from './imports/api.mjs';
import { requestDiagnostic } from './requests/diagnostics.mjs';
import { createActiveWorkersUrlProjection } from './live/url-projection.mjs';
import { createStarterSystem, provisionNamespaces } from './lifecycle/creation.mjs';

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
    const media=await mediaApi({path,method,input,actor,source,getCoordinator,context});if(media)return media;
    const located = async (kind,id) => { if (!uuid.test(id)) throw fail(404,'Resource not found'); const row=await catalog.resource(kind,id); if (!row) throw fail(404,'Resource not found'); return row.source_id; };
    let statusOverride;
    const call = async (sourceId,operation,args=[]) => {
      const coordinator=getCoordinator(context,sourceId);
      let envelope;
      try { envelope = await coordinator.api({operation,actor,args}); }
      catch(error) { throw requestDiagnostic(error,'coordinator-rpc','host-boundary'); }
      if (!envelope.ok) throw Object.assign(fail(envelope.error.statusCode,envelope.error.message),envelope.error.details || {});
      statusOverride=envelope.httpStatus;
      // A long-running coordinator can finish on its prior deployment. Apply
      // current account aliases at the HTTP boundary as well; projection is
      // idempotent and never requires restarting that durable work.
      const project=createActiveWorkersUrlProjection({sourceId,aliases:env.TIMDS_WORKERS_SUBDOMAIN_ALIASES||'{}'});
      const preflightSubmission=operation==='publish'&&envelope.value?.preflight?await coordinator.resource('submission',args[0]):undefined;
      return project(envelope.value,{preflightSubmission});
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
    const sourceRoute=path.match(/^\/api\/timds\/design-systems\/([^/]+)$/);
    if(sourceRoute&&method==='GET'){const row=await source(segment(sourceRoute[1]));return respond(await call(row.id,'sourceView'));}
    let match=path.match(/^\/api\/timds\/sessions\/([^/]+)(?:\/(status|history|submit|update|close|join|claims|diagnostics))?$/);
    if (match) {
      const id=segment(match[1]), action=match[2] || 'snapshot';
      const expected=['snapshot','status','history','diagnostics'].includes(action)?'GET':'POST';
      if(method!==expected)throw fail(405,`Use ${expected}`);
      const operation=action==='claims'?'claim':action==='diagnostics'?'liveDiagnostics':action;
      return respond(await call(await located('session',id),operation,[id,...(method==='POST'&&action!=='close'?[input]:[])]));
    }
    match=path.match(/^\/api\/timds\/design-systems\/([^/]+)\/principals$/);
    if(match){if(method!=='GET')throw fail(405,'Use GET');const row=await source(segment(match[1]));return respond(await call(row.id,'principals',[]));}
    match=path.match(/^\/api\/timds\/design-systems\/([^/]+)\/(active-work|events|submissions|drafts|rollback|requests)(?:\/([^/]+))?(?:\/(snapshot|close))?$/);
    if(match) {
      const reference=segment(match[1]), action=match[2], child=match[3] && segment(match[3]), tail=match[4], row=await source(reference);
      if(action==='active-work'&&!child&&method==='GET')return respond(await call(row.id,'activeWork',[reference]));
      if(action==='events'&&!child&&method==='GET')return respond(await call(row.id,'sourceEvents',[reference,{after:url.searchParams.get('after'),limit:url.searchParams.get('limit')}]));
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
    // Live feed ticket: single use, 60 s, bound to this principal and source.
    // The WebSocket upgrade itself is routed before OAuth in entrypoint.mjs.
    match=path.match(/^\/api\/timds\/design-systems\/([^/]+)\/feed\/tickets$/);
    if(match) {
      if(method!=='POST')throw fail(405,'Use POST');
      const reference=segment(match[1]),row=await source(reference),issued=await call(row.id,'feedTicket',[reference]);
      return jsonResponse({ticket:issued.ticket,expiresAt:issued.expiresAt,url:`${oauthOrigin(env,url.origin).replace(/^http/,'ws')}/api/timds/design-systems/${row.id}/feed?ticket=${issued.ticket}`});
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
      if(method==='GET'&&['/api/timds/admin/organizations','/api/timds/admin/systems'].includes(path)) {
        const after=url.searchParams.get('after')||'';
        if(after&&!uuid.test(after))throw fail(400,'A UUID cursor is required');
        if(path.endsWith('/organizations'))return jsonResponse(await catalog.organizationPage(after));
        const page=await catalog.systemPage(after);
        return jsonResponse({systems:page.systems.map(row=>({id:row.id,systemId:row.system_id,name:row.name||row.system_id,organizationId:row.organization_id,lifecycleStatus:row.lifecycle_status,archivedAt:row.archived_at||null,namespace:row.artifacts_namespace,repository:row.artifacts_repository,provisionOperationId:row.provision_operation_id||null,deletionOperationId:row.deletion_operation_id||null,creationInput:row.provision_actor_id===principal.id?row.creation_input||null:null,creationPending:Boolean(row.creation_input&&row.provision_actor_id===principal.id&&['provisioning','ready'].includes(row.lifecycle_status)&&(!row.provision_grant_completed||row.lifecycle_status==='provisioning'))})),nextSystemCursor:page.nextSystemCursor,namespaces:provisionNamespaces(env)});
      }
      if(path==='/api/timds/admin/imports'||path.startsWith('/api/timds/admin/imports/'))return jsonResponse(await importApi({path,method,input,actor,context,catalog,getCoordinator}));
      if(path==='/api/timds/admin/organizations'&&method==='POST') {
        if(!uuid.test(input.id||'')||typeof input.name!=='string'||!input.name.trim()||input.name.length>200)throw fail(400,'Organization id and name are required');
        return jsonResponse({organization:await catalog.ensureOrganization({id:input.id,name:input.name})});
      }
      match=path.match(/^\/api\/timds\/admin\/organizations\/([^/]+)\/name$/);
      if(match) {
        if(method!=='POST')throw fail(405,'Use POST to rename an organization');
        const id=segment(match[1]);
        if(!uuid.test(id)||Object.keys(input).some(key=>!['apiVersion','name','expectedName'].includes(key))||typeof input.name!=='string'||!input.name.trim()||input.name.length>200||typeof input.expectedName!=='string'||input.expectedName.length>200)throw fail(400,'An organization UUID, name and expected name are required');
        return jsonResponse({organization:await catalog.renameOrganization({id,name:input.name.trim(),expectedName:input.expectedName,actor})});
      }
      if(path==='/api/timds/admin/systems'&&method==='POST'&&provision)return respond(await provision({input,actor,env,context,catalog}));
      if(path==='/api/timds/admin/systems/create'&&method==='POST'&&provision)return respond(await createStarterSystem({input,actor,env,context,catalog,provision}));
      match=path.match(/^\/api\/timds\/admin\/systems\/([^/]+)\/provision\/([^/]+)$/);
      if(match){
        if(method!=='GET')throw fail(405,'Use GET for a provision receipt');
        const sourceId=segment(match[1]),operationId=segment(match[2]);
        if(!uuid.test(sourceId)||!uuid.test(operationId))throw fail(404,'Provision operation not found');
        return respond(await call(sourceId,'provisionReceipt',[operationId]));
      }
      match=path.match(/^\/api\/timds\/admin\/systems\/([^/]+)\/invitations(?:\/([^/]+))?(?:\/(revoke))?$/);
      if(match){
        const row=await source(segment(match[1])),id=match[2]?segment(match[2]):null;
        if(id&&!uuid.test(id))throw fail(400,'An invitation UUID is required');
        if(!match[3]&&method==='GET')return respond(await call(row.id,'listInvitations',[{after:id||''}]));
        if(!id&&method==='POST')return respond(await call(row.id,'reserveInvitation',[input]));
        if(id&&match[3]==='revoke'&&method==='POST'){
          if(Object.keys(input).length)throw fail(400,'Invitation revocation has no additional inputs');
          return respond(await call(row.id,'revokeInvitation',[{invitationId:id}]));
        }
        throw fail(405,'Use invitation list, reservation or revocation');
      }
      match=path.match(/^\/api\/timds\/admin\/systems\/([^/]+)\/deletion(?:\/([^/]+))?(?:\/(confirm|history))?$/);
      if(match){
        const row=await source(segment(match[1])),operationId=match[2]?segment(match[2]):input.operationId,action=match[3];
        if(!uuid.test(operationId||'')||Object.keys(input).some(key=>!['apiVersion','operationId','impactHash','typedRepository','portalConsumerProof'].includes(key)))throw fail(400,'A stable deletion operation UUID is required');
        if(!match[2]&&method==='POST')return respond(await call(row.id,'prepareDeletion',[{operationId}]));
        if(match[2]&&!action&&method==='GET')return respond(await call(row.id,'readDeletion',[{operationId}]));
        if(action==='confirm'&&method==='POST')return respond(await call(row.id,'confirmDeletion',[{...input,operationId}]),202);
        if(action==='history'&&method==='GET')return respond(await call(row.id,'deletionHistory',[{operationId}]));
        throw fail(405,'Use the deletion prepare, read or confirmation route');
      }
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
      match=path.match(/^\/api\/timds\/admin\/systems\/([^/]+)\/(authority|principals)(?:\/([^/]+))?$/);
      if(match&&method==='GET') {
        const row=await source(segment(match[1])),after=match[3]?segment(match[3]):'';
        if(row.lifecycle_status!=='ready')throw fail(409,'Source authority is unavailable until initialization or transfer completes');
        if(after&&!uuid.test(after))throw fail(400,'A principal cursor UUID is required');
        const page=match[2]==='authority'?await catalog.publisherPage(row.id,after):await catalog.principalPage(after);
        return jsonResponse({apiVersion:1,sourceId:row.id,authorityVersion:row.authority_version,...page});
      }
      match=path.match(/^\/api\/timds\/admin\/systems\/([^/]+)\/(archive|restore)$/);
      if(match&&method==='POST') {
        const row=await source(segment(match[1]));
        if(!uuid.test(input.operationId||'')||Object.keys(input).some(key=>!['apiVersion','operationId'].includes(key)))throw fail(400,'A stable lifecycle operation UUID is required');
        return respond(await call(row.id,match[2],[{operationId:input.operationId}]));
      }
      match=path.match(/^\/api\/timds\/admin\/systems\/([^/]+)\/authority$/);
      if(match&&method==='POST') {
        const row=await source(segment(match[1]));
        if(row.lifecycle_status!=='ready')throw fail(409,'Source authority is unavailable until initialization or transfer completes');
        if(!uuid.test(input.operationId||''))throw fail(400,'An operation UUID is required');
        const allowed=['principalId','read','write','publish'];
        if(!input.command||Object.keys(input.command).some(key=>!allowed.includes(key))||!uuid.test(input.command.principalId||'')||!['read','write','publish'].some(key=>key in input.command)||['read','write','publish'].some(key=>key in input.command&&typeof input.command[key]!=='boolean'))throw fail(400,'Use a principal and explicit read, write or publish permissions');
        return respond(await call(row.id,'authority',[{operationId:input.operationId,command:input.command}]));
      }
    }
    throw fail(404,'Route not found');
  };
}
