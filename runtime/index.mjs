// Native Sandbox exports. Host HTTP authentication remains in src/index.ts.
import { Files, SandboxFileError } from '@cloudflare/sandbox';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { outboundCredential, sessionIdPattern } from './policy.mjs';
import { RepositorySandboxRuntime, repositoryOutboundCredential, repositoryPushNotification } from './repository-service.mjs';
import { LiveSessionRuntime } from './live-session.mjs';

/** Callback identity is fixed by the trusted host, never source code or HTTP. */
export function coordinatorCallback(ctx) {
  return async (_env, action, body) => {
    const authority=ctx.storage.kv.get('authority');
    if(action!=='repository-control'&&body.sessionId!==authority?.sessionId)return Response.json({error:{message:'Runtime session authority changed'}},{status:403});
    const sourceId = action === 'repository-control' ? body.coordinatorId : authority?.sourceId;
    if (!sessionIdPattern.test(sourceId || '')) return Response.json({error:{message:'Runtime authority unavailable'}},{status:409});
    return ctx.exports.SystemCoordinator.getByName(sourceId).runtimeCallback(action, body);
  };
}
export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (this.ctx.props.allowDependencies && url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && ['GET','HEAD'].includes(request.method)) {
      const headers=new Headers(request.headers); headers.delete('authorization'); headers.delete('cookie');
      return fetch(new Request(request,{headers,redirect:'manual'}));
    }
    const token=outboundCredential(request,this.ctx.props,this.env.OPENAI_API_KEY);
    if(!token)return new Response('Forbidden',{status:403});
    const headers=new Headers(request.headers);headers.set('Authorization',`Bearer ${token}`);headers.delete('cookie');
    try{return await fetch(new Request(request,{headers,redirect:'manual'}));}
    catch{throw new Error('Outbound request failed');}
  }
}
export class RepositoryOutbound extends WorkerEntrypoint {
  async fetch(request) {
    const notification=await repositoryPushNotification(request,this.ctx.props,(sessionId,revision)=>{
      this.ctx.waitUntil(this.ctx.exports.LiveSession.getByName(sessionId).pushed({revision}).catch(()=>{}));
    });
    if(notification)return notification;
    const token=repositoryOutboundCredential(request,this.ctx.props);
    if(!token)return new Response('Forbidden',{status:403});
    const headers=new Headers(request.headers);headers.set('Authorization',`Bearer ${token}`);headers.delete('cookie');
    try{return await fetch(new Request(request,{headers,redirect:'manual'}));}
    catch{throw new Error('Repository outbound request failed');}
  }
}
export class RepositorySandbox extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.runtime=new RepositorySandboxRuntime(ctx,env,{portalCall:coordinatorCallback(ctx),snapshotBucket:env.SNAPSHOTS});}
  run(sourceId,input){return this.runtime.run(sourceId,input);}
  alarm(){return this.runtime.alarm();}
}
export class LiveSession extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.live=new LiveSessionRuntime(ctx,env,{Files,SandboxFileError,portalCall:coordinatorCallback(ctx)});}
  configure(id,input){
    if(!sessionIdPattern.test(id||'')||!sessionIdPattern.test(input?.sourceId||''))throw new Error('Invalid live authority');
    const prior=this.ctx.storage.kv.get('authority');
    if(prior&&(prior.sourceId!==input.sourceId||prior.sessionId!==id))throw new Error('Live authority changed');
    this.ctx.storage.kv.put('authority',{sourceId:input.sourceId,sessionId:id});
    return this.live.configure(id,input);
  }
  start(id,input){if(this.ctx.storage.kv.get('authority')?.sessionId!==id)throw new Error('Live authority unavailable');return this.live.start(id,input);}
  status(){return this.live.status();}
  diagnostics(input){return this.live.diagnostics(input);}
  retryCompletion(input){return this.live.retryCompletion(input);}
  pushed(input){return this.live.pushed(input);}
  close(id){return this.live.locked(()=>this.live.beginClose(id));}
  fetch(request){return this.live.fetch(request);}
  alarm(){return this.live.alarm();}
}
// Service binding only. The public host router must not dispatch this class.
export class LivePreview extends WorkerEntrypoint {
  fetch(request){const id=request.headers.get('x-timds-live-session');if(!sessionIdPattern.test(id||''))return new Response('Not found',{status:404});return this.ctx.exports.LiveSession.getByName(id).fetch(request);}
}
