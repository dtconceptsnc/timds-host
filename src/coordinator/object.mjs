import { createSourceMedia } from '../media/service.mjs';
import { errorResponse } from '../http.mjs';
import { DurableObject } from 'cloudflare:workers';
import { Catalog } from '../store/catalog.mjs';
import { createCoordinator } from './coordinator.mjs';
import { createAuthorization } from '../auth/authorization.mjs';
import { createRepositoryAdapter } from '../repository/adapter.mjs';
import { createArtifactsAdapter } from '../repository/artifacts.mjs';
import { createHostRequests } from '../requests/index.mjs';
import { createLivePreviewHosts } from '../live/hosts.mjs';
import { createActiveWorkersUrlProjection } from '../live/url-projection.mjs';
import { createAgentForkSubscriptions } from '../live/subscriptions.mjs';
import { createPublicationService } from '../publication/service.mjs';
import { createPublicationApi } from '../publication/api.mjs';
import { createPreviews } from '../preview/index.mjs';
import { fail } from '../store/errors.mjs';
import { safeRequestDiagnostic, requestDiagnostic, unwrapNativeBuildResult } from '../requests/diagnostics.mjs';
import { createImporter } from '../imports/service.mjs';
import { createPortalReceiptVerifier } from '../imports/portal-proof.mjs';
import { hostOrigin } from '../http.mjs';
import { createSourceDeletion } from '../lifecycle/deletion.mjs';
import { safeDeletionBlockers } from '../lifecycle/diagnostics.mjs';
import { createSourceInvitations } from '../invitations/service.mjs';
import { readSourceView } from '../source-view.mjs';
import { readImportedPublicMedia } from '../mcp/public-media.mjs';
import { createSourceFeed } from './feed.mjs';
import { createSessionChecks } from '../mcp/checks.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeError = error => ({ statusCode:Number.isInteger(error?.statusCode)?error.statusCode:500,
  message:error?.statusCode && error.statusCode < 500 ? error.message : 'The host could not complete this operation',
  details:{...(safeRequestDiagnostic(error?.requestDiagnostic)?{requestDiagnostic:safeRequestDiagnostic(error.requestDiagnostic)}:{}),
    ...(safeRequestDiagnostic(error?.cleanupDiagnostic)?{cleanupDiagnostic:safeRequestDiagnostic(error.cleanupDiagnostic)}:{}),
    ...(error?.statusCode===409&&safeDeletionBlockers(error?.deletionBlockers)?{deletionBlockers:safeDeletionBlockers(error.deletionBlockers)}:{}),
    ...(Array.isArray(error?.conflicts)?{conflicts:error.conflicts,mainRevision:error.mainRevision}:{})} });

export class SystemCoordinator extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    const sourceId=ctx.id.name;
    if(!uuid.test(sourceId||''))throw new Error('Coordinator name must be a source UUID');
    this.sourceId=sourceId;
    this.projectActiveUrls=createActiveWorkersUrlProjection({sourceId,aliases:env.TIMDS_WORKERS_SUBDOMAIN_ALIASES||'{}'});
    this.catalog=new Catalog(env.CATALOG);
    this.artifacts=createArtifactsAdapter({env});
    this.preview=createPreviews({env});
    let requestService;
    this.engine=createCoordinator({sourceId,storage:ctx.storage,catalog:this.catalog,
      repository:store=>this.repository=createRepositoryAdapter({artifacts:this.artifacts,store,getSandbox:id=>ctx.exports.RepositorySandbox.getByName(id),snapshotBucket:env.SNAPSHOTS,
        ensurePreview:source=>this.preview.ensure(source),previewUrl:(source,branch)=>this.preview.url(source,branch),deletePreview:(source,branch)=>this.preview.remove(source,branch)}),
      authorization:({store,catalog})=>{
        this.store=store;
        return this.authorization=createAuthorization({catalog,hasSessionAccess:(_sourceId,id)=>store.hasSessionAccess(id,sourceId),requestBinding:id=>requestService?.binding(id)});
      },
      publication:({store})=>this.publication=createPublicationService({coordinator:{publicationStore:(operation,args)=>store[operation](...args)},workflow:env.PUBLICATION_WORKFLOW,bucket:env}),
      requests:input=>requestService=this.requests=createHostRequests({...input,artifacts:this.artifacts,
        getLive:id=>ctx.exports.LiveSession.getByName(id),hosts:createLivePreviewHosts({env}),subscriptions:createAgentForkSubscriptions({env}),designerPrincipalId:env.TIMDS_DESIGNER_PRINCIPAL_ID,
        schedule:()=>ctx.storage.setAlarm(Date.now()+1000),ensurePreview:source=>this.preview.ensure(source),
        reconcilePush:async(source,session,revision,actor)=>{
          await this.authorization.authorizeSource(source,actor);
          // Queue payloads are hints. Only a matching authoritative fork head
          // becomes an audit event; replay of the same head is harmless.
          const snapshot=await this.repository.snapshot(source,session);
          if(snapshot.baseRevision!==revision)return {ignored:true};
          if(!(await this.store.eventForHead(session.id,revision)).length)await this.store.appendEvent({source_id:source.id,session_id:session.id,event_type:'updated',actor_principal_id:session.owner_principal_id,originating_request_id:session.originating_request_id,details_json:{outOfBandHead:revision}});
          return {detected:true,sessionId:session.id};
        }}),
      onSessionReserved:(session,source)=>requestService.live.schedule(session,source),
      onSessionStarted:(session,source)=>requestService.live.ensure(session,source),
      cleanupAgentSession:(session,source)=>requestService.live.close(session,source),
      nextLifecycleAlarm:()=>this.store?.deletionFence()?this.deletion?.nextAlarm():this.media?.nextAlarm(),
    });
    this.publicationApi=createPublicationApi({sourceId,publicOrigin:env.TIMDS_PUBLIC_ORIGIN,store:this.store,authorization:this.authorization,repository:this.repository,publication:this.publication,
      metadata:input=>unwrapNativeBuildResult(ctx.exports.BuildSandbox.getByName(`metadata:${input.publicationId}`).metadata(input),input.operation),
      build:input=>unwrapNativeBuildResult(ctx.exports.BuildSandbox.getByName(`build:${input.publicationId}`).run(input),'build')});
    this.sessionChecks=createSessionChecks({sourceId,storage:ctx.storage,bucket:env.SNAPSHOTS,engine:this.engine,
      build:input=>unwrapNativeBuildResult(ctx.exports.BuildSandbox.getByName(`check:${sourceId}:${input.publicationId}`).run(input),'build')});
    this.importer=createImporter({sourceId,storage:ctx.storage,catalog:this.catalog,store:this.store,artifacts:this.artifacts,releases:env,origin:hostOrigin(env),verifyPortalReceipt:createPortalReceiptVerifier(env)});
    this.media=createSourceMedia({sourceId,storage:ctx.storage,catalog:this.catalog,sourceStore:this.store,authorization:this.authorization,runMutation:this.engine.runMutation,env,
      schedule:async due=>{const prior=await ctx.storage.getAlarm();if(!prior||due<prior)await ctx.storage.setAlarm(due);}});
    this.deletion=createSourceDeletion({sourceId,storage:ctx.storage,catalog:this.catalog,store:this.store,artifacts:this.artifacts,preview:this.preview,live:this.requests.live,stopMedia:options=>this.media.expire({fenced:true,...options}),mediaInventory:()=>this.media.inventory(),runMutation:this.engine.runMutation,env,origin:hostOrigin(env)});
    this.invitations=createSourceInvitations({sourceId,catalog:this.catalog,store:this.store,env});
    // Live feed: hibernatable sockets; raw `ping` heartbeats never wake the object.
    this.feed=createSourceFeed({sourceId,ctx,store:this.store,catalog:this.catalog,authorize:(actor,reference)=>this.engine.invoke({operation:'sourceEvents',actor,args:[reference,{limit:1}]}),
      watch:(id,options)=>this.requests.live.watch(id,options)});
    this.store.onEvent(row=>this.feed.onEvent(row));
    if(typeof WebSocketRequestResponsePair==='function')ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  async fetch(request){try{return await this.feed.accept(request);}catch(error){return errorResponse(error);}}
  async webSocketMessage(ws,message){try{await this.feed.message(ws,message);}catch{try{ws.close(1011,'Feed error');}catch{}}}
  async webSocketClose(ws){await this.feed.closed(ws);}
  async webSocketError(ws){await this.feed.closed(ws);}
  async mediaOperation(input){try{return {ok:true,value:await this.media.invoke(input)};}catch(error){return {ok:false,error:safeError(error)};}}
  async mediaUpload(request,route){try{return await this.media.upload(request,route);}catch(error){return errorResponse(error);}}
  async mediaFetch(request,route){try{return await this.media.fetch(request,route);}catch(error){return errorResponse(error);}}
  async importOperation(input){
    try{return {ok:true,value:await this.engine.runMutation(()=>this.importer(input))};}
    catch(error){return {ok:false,error:safeError(error)};}
  }
  async claimAccessInvitation(input){
    try{return {ok:true,value:await this.engine.runMutation(()=>this.invitations.claim(input))};}
    catch(error){return {ok:false,error:safeError(error)};}
  }
  async api({operation,actor,args=[]}) {
    try {
      let value, httpStatus;
      if(operation==='sourceView')value=await this.engine.sourceView(actor);
      else if(operation==='provisionReceipt')value=await this.engine.provisionReceipt(actor,args[0]);
      else if(['listInvitations','reserveInvitation','revokeInvitation'].includes(operation))value=await this.engine.runMutation(()=>this.invitations.admin({operation:{listInvitations:'list',reserveInvitation:'reserve',revokeInvitation:'revoke'}[operation],actor,input:args[0]}));
      else if(['prepareDeletion','readDeletion','confirmDeletion','deletionHistory'].includes(operation))value=await this.engine.runMutation(()=>this.deletion.invoke({operation:{prepareDeletion:'prepare',readDeletion:'read',confirmDeletion:'confirm',deletionHistory:'history'}[operation],actor,input:args[0]}));
      else if(operation==='createRequest'||operation==='readRequest')value=await this.engine.requestsInvoke({operation:operation==='createRequest'?'create':'read',actor,args});
      else if(['checkSession','readSessionCheck','readCheckDerived'].includes(operation))value=await this.sessionChecks[{checkSession:'run',readSessionCheck:'read',readCheckDerived:'derived'}[operation]](actor,...args);
      else if(operation==='feedTicket')value=await this.feed.ticket(actor,args[0]);
      // Presence: committed rows plus each open session's stored runner record; never queued, never starts a container.
      else if(operation==='activeWork'||operation==='status')value=await this.requests.presence(await this.engine.invoke({operation,actor,args}));
      // Invite directory: activeWork's read authorization, D1 grants only, no writer queue.
      else if(operation==='principals')value=await this.engine.runRead(actor,async verified=>{const source=await this.store.getSource(this.sourceId);if(!source||source.archived_at||source.lifecycle_status!=='ready')throw fail(404,'Design System not found');await this.authorization.authorizeSource(source,verified);return {apiVersion:1,sourceId:source.id,principals:await this.catalog.sourcePrincipals(source.id,this.env.TIMDS_DESIGNER_PRINCIPAL_ID)};});
      else if(operation==='rollback')value=await this.engine.rollbackVersion({actor,input:args[0],operationId:args[0]?.operationId??crypto.randomUUID()});
      else if(operation==='authority')value=await this.engine.mutateAuthority({...args[0],actor});
      else if(operation==='archive'||operation==='restore')value=await this.engine.setArchived({...args[0],actor,restore:operation==='restore'});
      else if(operation==='listSubmissions'||operation==='readPublication') {
        value=await this.engine.runRead(actor,verified=>this.publicationApi[operation==='listSubmissions'?'list':'read'](verified,...args));
      } else if(operation==='publish') {
        value=await this.engine.runMutation(()=>{if(this.store.deletionFence())throw fail(409,'Publication is fenced by source deletion');return this.publicationApi.publish(actor,...args);});
        httpStatus=value.status;value=value.body;
        await this.store.flushOutbox();
      } else if(operation==='sourceEvents') {
        // Event feed: committed SQLite rows after the activeWork read check; never queued.
        value=await this.engine.invoke({operation,actor,args});
      } else value=await this.engine.invoke({operation,actor,args});
      this.feed.afterOperation(operation,args);
      value=this.projectActiveUrls(value,{preflightSubmission:operation==='publish'&&value?.preflight?this.store.getSubmission(args[0]):undefined});
      return {ok:true,value,...(httpStatus?{httpStatus}:{})};
    } catch(error) {return {ok:false,error:safeError(requestDiagnostic(error,'coordinator-operation','host-boundary'))};}
  }
  async runtimeCallback(action,body) {
    try {
      const value=action==='repository-control'?await this.repository.control(body):await this.engine.runtimeCallback(action,body);
      return Response.json(value);
    } catch(error) { const detail=safeError(error);return Response.json({error:{message:detail.message,...detail.details}},{status:detail.statusCode}); }
  }
  repositoryControl(input){return this.repository.control(input);}
  publicationStore(operation,args){return this.engine.publicationStore(operation,args);}
  stageVersion(input){return this.engine.stageVersion(input);}
  closeForPublication(sessionId,publicationId){return this.engine.closeForPublication(sessionId,publicationId);}
  currentSource(){return this.engine.currentSource();}
  resource(kind,id){return this.engine.resource(kind,id);}
  previewTokens(source,ref){return this.engine.previewTokens(source,ref);}
  recordPreviewBuild(input){return this.engine.recordPreviewBuild(input);}
  initializeSource(input){return this.engine.initializeSource(input);}
  ensureProvisionRepository(input){return this.engine.runMutation(async()=>{
    const {operation,source}=await this.engine.provisionState(input),ns=source.artifacts_namespace,name=source.artifacts_repository;
    if(!await this.artifacts.getNamespace(ns))await this.artifacts.createNamespace(ns);
    let repository=await this.artifacts.getRepository(ns,name);
    const saved=operation.checkpoints_json?.repositoryReceipt;
    if(saved&&(saved.namespace!==ns||saved.repository!==name))throw fail(409,'Provisioning repository receipt identity changed');
    if(repository&&!saved)throw fail(409,'Repository already exists without an owned provisioning receipt; use the import procedure');
    if(!repository){
      if(saved)throw fail(409,'The reserved repository was removed; restore its identity before retrying');
      await this.engine.provisionState(input);
      repository=await this.artifacts.createRepository(ns,name);
    }
    if(repository?.id==null||!String(repository.id))throw fail(502,'Repository creation did not return an identity');
    if(saved&&String(saved.id)!==String(repository.id))throw fail(409,'Provisioning repository identity changed');
    const repositoryReceipt={id:String(repository.id),namespace:ns,repository:name};
    return this.store.saveLifecycle({...operation,checkpoints_json:{...operation.checkpoints_json,repositoryReceipt}});
  });}
  checkpointProvision(input){return this.engine.checkpointProvision(input);}
  completeProvision(input){return this.engine.completeProvision(input);}
  fencePrincipal(input){this.feed.closePrincipal(input?.principalId);return this.engine.fencePrincipal(input);}
  async publicVersion(label,includeReadView=false) {
    // Anonymous immutable reads must remain available during source edits.
    // getSource overlays the committed SQLite pointer on current D1 authority.
    const source=await this.store.getSource(this.sourceId);
    if(!source||source.archived_at||source.lifecycle_status!=='ready')return null;
    if((await this.catalog.organization(source.organization_id))?.status!=='active')return null;
    const id=label?this.store.resolveRollbackVersion(this.sourceId,label):source.published_version_id;
    const version=id&&this.store.getVersion(id);
    if(!version||version.source_id!==source.id||!version.artifact_ref)return null;
    const firstEvent=this.ctx.storage.sql.exec("SELECT id FROM publication_events WHERE json_extract(row_json,'$.design_system_source_id')=? AND json_extract(row_json,'$.version_label')=? ORDER BY json_extract(row_json,'$.created_at'),id LIMIT 1",source.id,version.version_label).toArray()[0];
    if(!firstEvent)return null;
    return {source,version,firstPublicationEventId:firstEvent.id,...(includeReadView?{readView:readSourceView({storage:this.ctx.storage,source,canRollback:false,canAdmin:false}),publicMedia:await readImportedPublicMedia({catalog:this.catalog,storage:this.ctx.storage,sourceId:source.id,mediaStore:this.media.records,publicUrl:this.media.publicUrl})}:{})};
  }
  async provisionFiles(input) {
    const {source}=await this.engine.runMutation(()=>this.engine.provisionState(input));
    return this.repository.provisionFiles({...source,lifecycleOperationId:input.operationId,lifecycleLease:input.lease},{operationId:input.operationId,files:input.files});
  }
  async alarm() {
    const result=await this.engine.alarm();
    if(this.store.deletionFence()){await this.deletion.advance();return result;}
    await this.media.expire().catch(()=>{});
    for(const job of await this.engine.requestStore('due',[2])) {
      const lease={jobId:job.id,leaseToken:crypto.randomUUID()};
      const claimed=await this.engine.requestStore('claim',[{...lease,leaseOwner:`alarm:${this.sourceId}`,leaseSeconds:600}]);
      if(!claimed)continue;
      try {await this.engine.executeRequest(job.payload_json.requestId,lease);}
      catch (error) {await this.engine.requestStore('fail',[{...lease,diagnostic:safeRequestDiagnostic(error?.requestDiagnostic)}]);}
    }
    return result;
  }
}
