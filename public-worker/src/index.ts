import { legacyHostRoutes } from '../../src/public/host-routes.mjs';

type PublicService={fetch(request:Request):Promise<Response>;legacyFetch(request:Request,sourceId:string):Promise<Response>};
type Env={PUBLIC_ROOTS:PublicService;PUBLIC_ORIGIN:string;LEGACY_PUBLIC_HOSTS:string};
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url),headers={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
    let routes:Record<string,string>;
    try{routes=legacyHostRoutes(env.LEGACY_PUBLIC_HOSTS);}catch{return new Response('Design System temporarily unavailable.',{status:503,headers});}
    const sourceId=Object.hasOwn(routes,url.hostname)?routes[url.hostname]:null;
    // The native public origin keeps its /systems and /mcp surface. Unknown
    // custom hosts (including deleted sources) never borrow that fallback.
    if(!sourceId){
      if(url.origin===env.PUBLIC_ORIGIN)return env.PUBLIC_ROOTS.fetch(request);
      return new Response(request.method==='HEAD'?null:'Design System not found.',{status:404,headers});
    }
    if(url.protocol!=='https:'||url.port)return new Response('Design System not found.',{status:404,headers});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'If-None-Match'}});
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed.',{status:405,headers:{...headers,Allow:'GET, HEAD, OPTIONS'}});
    const forwarded=new Headers();if(request.headers.has('If-None-Match'))forwarded.set('If-None-Match',request.headers.get('If-None-Match')!);
    try{
      const response=await env.PUBLIC_ROOTS.legacyFetch(new Request(url,{method:request.method,headers:forwarded,redirect:'manual'}),sourceId);
      const outgoing=new Headers(response.headers);outgoing.delete('Set-Cookie');outgoing.set('Access-Control-Allow-Origin','*');
      return new Response(response.body,{status:response.status,headers:outgoing});
    }catch{return new Response(request.method==='HEAD'?null:'Design System temporarily unavailable.',{status:503,headers});}
  },
};
