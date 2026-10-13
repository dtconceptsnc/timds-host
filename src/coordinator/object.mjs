import { DurableObject } from 'cloudflare:workers';
import { Catalog } from '../store/catalog.mjs';
import { createCoordinator } from './coordinator.mjs';
import { createAuthorization } from '../auth/authorization.mjs';
import { createRepositoryAdapter } from '../repository/adapter.mjs';
import { createArtifactsAdapter } from '../repository/artifacts.mjs';
import { createHostRequests } from '../requests/index.mjs';
import { createLivePreviewHosts } from '../live/hosts.mjs';
import { createAgentForkSubscriptions } from '../live/subscriptions.mjs';
import { createPublicationService } from '../publication/service.mjs';
import { createPublicationApi } from '../publication/api.mjs';
import { createPreviews } from '../preview/index.mjs';
import { fail } from '../store/errors.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeError = error => ({ statusCode:Number.isInteger(error?.statusCode)?error.statusCode:500,
  message:error?.statusCode && error.statusCode < 500 ? error.message : 'The host could not complete this operation',
  ...(Array.isArray(error?.conflicts)?{details:{conflicts:error.conflicts,mainRevision:error.mainRevision}}:{}) });

export class SystemCoordinator extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    const sourceId=ctx.id.name;
    if(!uuid.test(sourceId||''))throw new Error('Coordinator name must be a source UUID');
    this.sourceId=sourceId;
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
          // A push notification is a reconciliation hint. The next snapshot
          // reads authoritative main; it never accepts arbitrary changed bytes.
          await this.authorization.authorizeSource(source,actor);
          return {observed:true,revision,sessionId:session.id};
        }}),
      onSessionReserved:(session,source)=>requestService.live.schedule(session,source),
      onSessionStarted:(session,source)=>requestService.live.ensure(session,source),
      cleanupAgentSession:(session,source)=>requestService.live.close(session,source),
    });
    this.publicationApi=createPublicationApi({sourceId,store:this.store,authorization:this.authorization,repository:this.repository,publication:this.publication,
      metadata:input=>ctx.exports.BuildSandbox.getByName(`metadata:${input.publicationId}`).metadata(input),
      build:input=>ctx.exports.BuildSandbox.getByName(`build:${input.publicationId}`).run(input)});
  }
  async api({operation,actor,args=[]}) {
    try {
      let value, httpStatus;
      if(operation==='createRequest'||operation==='readRequest')value=await this.engine.requestsInvoke({operation:operation==='createRequest'?'create':'read',actor,args});
      else if(operation==='rollback')value=await this.engine.rollbackVersion({actor,input:args[0],operationId:crypto.randomUUID()});
      else if(operation==='authority')value=await this.engine.mutateAuthority({...args[0],actor});
      else if(operation==='listSubmissions'||operation==='publish'||operation==='readPublication') {
        value=await this.engine.runMutation(()=>this.publicationApi[operation==='listSubmissions'?'list':operation==='readPublication'?'read':'publish'](actor,...args));
        if(operation==='publish'){httpStatus=value.status;value=value.body;}
        await this.store.flushOutbox();
      } else value=await this.engine.invoke({operation,actor,args});
      return {ok:true,value,...(httpStatus?{httpStatus}:{})};
    } catch(error) {return {ok:false,error:safeError(error)};}
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
  checkpointProvision(input){return this.engine.checkpointProvision(input);}
  completeProvision(input){return this.engine.completeProvision(input);}
  fencePrincipal(input){return this.engine.fencePrincipal(input);}
  publicVersion(label) {
    return this.engine.runMutation(async()=>{
      const source=await this.store.getSource(this.sourceId);
      if(!source||source.archived_at||source.lifecycle_status!=='ready')return null;
      if((await this.catalog.organization(source.organization_id))?.status!=='active')return null;
      const id=label?this.store.resolveRollbackVersion(this.sourceId,label):source.published_version_id;
      const version=id&&this.store.getVersion(id);
      if(!version||version.source_id!==source.id||!version.artifact_ref)return null;
      return {source,version};
    });
  }
  async provisionFiles(input) {
    const operation=await this.engine.publicationStore('getLifecycleOperation',[input.operationId]);
    if(!operation)throw fail(409,'Provision operation unavailable');
    const source=await this.engine.currentSource();
    return this.repository.provisionFiles({...source,lifecycleOperationId:input.operationId,lifecycleLease:input.lease},{operationId:input.operationId,files:input.files});
  }
  async alarm() {
    const result=await this.engine.alarm();
    for(const job of await this.engine.requestStore('due',[2])) {
      const lease={jobId:job.id,leaseToken:crypto.randomUUID()};
      const claimed=await this.engine.requestStore('claim',[{...lease,leaseOwner:`alarm:${this.sourceId}`,leaseSeconds:600}]);
      if(!claimed)continue;
      try {await this.engine.executeRequest(job.payload_json.requestId,lease);}
      catch {await this.engine.requestStore('fail',[lease]);}
    }
    return result;
  }
}
