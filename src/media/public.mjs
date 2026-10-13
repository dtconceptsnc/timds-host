import { fail } from '../store/errors.mjs';
import { errorResponse } from '../http.mjs';
import { UUID } from './contract.mjs';

function cors(request,env,upload){
 const origin=request.headers.get('Origin');
 if(!upload)return {'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'ETag, Content-Length, Content-Range, Accept-Ranges'};
 let configured;try{configured=JSON.parse(env.TIMDS_MEDIA_ALLOWED_ORIGINS||'[]');}catch{throw fail(503,'Media origins are not configured');}
 if(!Array.isArray(configured))throw fail(503,'Media origins are not configured');
 const allowed=[env.HOST_ORIGIN,env.TIMDS_PORTAL_ORIGIN,...configured].filter(Boolean);
 if(origin&&!allowed.includes(origin))throw fail(403,'This origin cannot upload media');
 return {...(origin?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{}),'Access-Control-Allow-Methods':'PUT, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Expose-Headers':'ETag','Access-Control-Max-Age':'300'};
}
export function createPublicMedia({env,getCoordinator}){
 return async request=>{
  const url=new URL(request.url);if(!url.pathname.startsWith('/media/'))return null;
  let headers={};
  try{
   if(url.origin!==new URL(env.TIMDS_PUBLIC_ORIGIN).origin)throw fail(404,'Media not found');
   const transfer=url.pathname.match(/^\/media\/uploads\/([^/]+)\/([^/]+)\/(\d{1,5})$/);
   const download=url.pathname.match(/^\/media\/downloads\/([^/]+)\/([^/]+)$/);
   const asset=url.pathname.match(/^\/media\/([^/]+)\/([^/]+)\/([^/]+)$/);
   const match=transfer||download||asset;
   if(!match||!UUID.test(match[1])||!UUID.test(match[2]))throw fail(404,'Media not found');
   headers=cors(request,env,Boolean(transfer));
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
   let response;
   if(transfer){
    if(request.method!=='PUT'||url.search||Number(transfer[3])>10000)throw fail(405,'Use PUT for media parts');
    response=await getCoordinator(match[1]).mediaUpload(request,{uploadId:match[2],part:Number(match[3])});
   }else{
    if(!['GET','HEAD'].includes(request.method))throw fail(405,'Use GET or HEAD for media');
    if(download&&([...url.searchParams.keys()].some(key=>key!=='cap')||url.searchParams.getAll('cap').length!==1)||!download&&url.search)throw fail(400,'Invalid media URL');
    let filename;try{filename=asset&&decodeURIComponent(asset[3]);}catch{throw fail(400,'Invalid media filename');}
    response=await getCoordinator(match[1]).mediaFetch(request,{assetId:match[2],filename,downloadToken:download?url.searchParams.get('cap'):null});
   }
   const result=new Response(response.body,response);for(const [name,value]of Object.entries(headers))result.headers.set(name,value);return result;
  }catch(error){const response=errorResponse(error);for(const [name,value]of Object.entries(headers))response.headers.set(name,value);return response;}
 };
}
