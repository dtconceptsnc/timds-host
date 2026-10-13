import { createPublicMedia } from './media/public.mjs';
import { createHostOAuth } from './auth/oauth.mjs';
import { createApi } from './api.mjs';
import { createProvisioner } from './provision.mjs';
import { Catalog } from './store/catalog.mjs';
import { apiHeaders, errorResponse, hostOrigin } from './http.mjs';
import { parsePreviewBuildEvent, createPreviewBuildHandler } from './preview/events.mjs';
import { createPreviews } from './preview/index.mjs';
import { agentPushEvent } from '../runtime/policy.mjs';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createPublicRoots } from './public/index.mjs';
import { createLegacyPublicRoots } from './public/legacy.mjs';
import { UUID } from './public/host-routes.mjs';
import { createHostMcp } from './mcp/index.mjs';
import { fail } from './store/errors.mjs';
import { studioFetch } from './studio.mjs';
import { claimLoginInvitations } from './invitations/service.mjs';

const getCoordinator=(ctx,id)=>ctx.exports.SystemCoordinator.getByName(id);
function publishedServices(env,ctx) {
  const resolvePublished=async(systemId,label,includeReadView=false)=>{
    const source=await new Catalog(env.CATALOG).source(systemId);
    if(!source)throw fail(404,'Published Design System not found');
    const result=await getCoordinator(ctx,source.id).publicVersion(label,includeReadView);
    if(!result)throw fail(404,'Published version not found');
    return result;
  };
  const options={resolvePublished,bucket:env,hostOrigin:env.HOST_ORIGIN,publicOrigin:env.TIMDS_PUBLIC_ORIGIN};
  const mcp=createHostMcp({...options,createRequest:async({sourceId,actor,input})=>{
    const response=await getCoordinator(ctx,sourceId).api({operation:'createRequest',actor,args:[sourceId,input]});
    if(!response.ok)throw fail(response.error.statusCode,response.error.message);
    return response.value;
  }});
  const legacy=createLegacyPublicRoots({bucket:env,hostOrigin:env.HOST_ORIGIN,resolvePublished:async(sourceId,label)=>{
    if(!UUID.test(sourceId))throw fail(404,'Published source not found');
    const result=await getCoordinator(ctx,sourceId).publicVersion(label);
    if(!result)throw fail(404,'Published version not found');
    return result;
  }});
  return {roots:createPublicRoots(options),legacy,mcp};
}
const api=createApi({getCoordinator,provision:createProvisioner({getCoordinator}),mcp:(request,env,ctx,actor)=>publishedServices(env,ctx).mcp(request,env,ctx,actor)});
export class PublicRoots extends WorkerEntrypoint {
  legacyFetch(request,sourceId) {return publishedServices(this.env,this.ctx).legacy.fetch(request,sourceId);}
  async fetch(request) {
    const media=await createPublicMedia({env:this.env,getCoordinator:id=>getCoordinator(this.ctx,id)})(request);if(media)return media;
    const services=publishedServices(this.env,this.ctx);
    return new URL(request.url).pathname==='/mcp'?services.mcp(request,this.env,this.ctx):services.roots.fetch(request);
  }
}
// Browsers cannot send a bearer header on a WebSocket upgrade, so the feed
// upgrade is routed before OAuth. Its credential is the single-use ticket that
// POST .../feed/tickets issued under OAuth; the source coordinator consumes it.
const feedRoute=/^\/api\/timds\/design-systems\/([^/]+)\/feed$/;
async function feedUpgrade(request,env,ctx,reference) {
  const url=new URL(request.url),origin=hostOrigin(env);
  if(url.origin!==origin)throw fail(421,'Use the configured host origin');
  if(request.method!=='GET')throw fail(405,'Use GET with Upgrade: websocket');
  if((request.headers.get('Upgrade')||'').toLowerCase()!=='websocket')throw fail(426,'Upgrade: websocket is required');
  if(request.headers.has('Origin')&&request.headers.get('Origin')!==origin)throw fail(403,'Cross-origin feed connections are not allowed');
  if(!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('ticket')||''))throw fail(400,'A feed ticket is required');
  let id;try{id=decodeURIComponent(reference);}catch{throw fail(400,'Invalid route encoding');}
  const row=await new Catalog(env.CATALOG).source(id);
  if(!row)throw fail(404,'Design System not found');
  return getCoordinator(ctx,row.id).fetch(request);
}
async function publicFetch(request,env,ctx) {
  const url=new URL(request.url);
  const studio=await studioFetch(request,env);if(studio)return studio;
  if(url.pathname==='/health')return Response.json({service:'timds-host',apiVersion:1,ready:false,phase:'integration'},{headers:{'Cache-Control':'no-store'}});
  const match=url.pathname.match(/^\/api\/public\/design-system-previews\/([^/]+)\/([^/]+)\/tokens\.css$/);
  if(match&&['GET','HEAD'].includes(request.method)) {
    let source,ref;try{source=decodeURIComponent(match[1]);ref=decodeURIComponent(match[2]);}catch{return new Response('Not found',{status:404});}
    const row=await new Catalog(env.CATALOG).source(source);
    if(!row)return new Response('Not found',{status:404,headers:apiHeaders});
    try {
      const css=await getCoordinator(ctx,row.id).previewTokens(source,ref);
      return new Response(request.method==='HEAD'?null:css,{headers:{...apiHeaders,'Content-Type':'text/css; charset=utf-8','X-Robots-Tag':'noindex'}});
    }catch{return new Response('Not found',{status:404,headers:apiHeaders});}
  }
  return new Response('Not found',{status:404});
}
export default {
  async fetch(request,env,ctx) {
    try {
      if(new URL(request.url).pathname==='/health')return publicFetch(request,env,ctx);
      const feed=new URL(request.url).pathname.match(feedRoute);if(feed)return await feedUpgrade(request,env,ctx,feed[1]);
      if(new URL(request.url).origin===env.TIMDS_PUBLIC_ORIGIN){
        const media=await createPublicMedia({env,getCoordinator:id=>getCoordinator(ctx,id)})(request);if(media)return media;
        const services=publishedServices(env,ctx);
        return new URL(request.url).pathname==='/mcp'?services.mcp(request,env,ctx):services.roots.fetch(request);
      }
      // TimDS 0.1.x media follows the returned canonical child URLs. Keep its
      // initial create path under the same OAuth authentication as the API.
      if(request.method==='POST'&&new URL(request.url).pathname==='/api/operator/design-system-assets/uploads'){
        const url=new URL(request.url);url.pathname='/api/timds/media/uploads';request=new Request(url,request);
      }
      return await createHostOAuth(env,{api,publicFetch,requestOrigin:new URL(request.url).origin,claimInvitations:(request,bindings)=>claimLoginInvitations({request,env:bindings,catalog:new Catalog(bindings.CATALOG),getCoordinator:id=>getCoordinator(ctx,id)})}).fetch(request,env,ctx);
    } catch(error) {return errorResponse(error);}
  },
  async queue(batch,env,ctx) {
    const catalog=new Catalog(env.CATALOG);
    for(const message of batch.messages) {
      try {
        let body=message.body;if(typeof body==='string')body=JSON.parse(body);
        const build=parsePreviewBuildEvent(body);
        if(build) {
          const coordinator=getCoordinator(ctx,build.sourceId);
          await createPreviewBuildHandler({sourceId:build.sourceId,getSource:()=>coordinator.currentSource(),
            submissions:()=>coordinator.publicationStore('submissionsForSource',[build.sourceId]),
            recordPreviewBuild:input=>coordinator.recordPreviewBuild(input),previews:createPreviews({env})})(body);
        } else if(agentPushEvent(body)) {
          const id=body.source.repoName.slice('session-'.length),locator=await catalog.resource('session',id);
          if(locator) {
            const response=await getCoordinator(ctx,locator.source_id).runtimeCallback('pushed',body);
            if(!response.ok)throw new Error('Push reconciliation failed');
          }
        }
        message.ack();
      }catch {message.retry({delaySeconds:30});}
    }
  },
};
