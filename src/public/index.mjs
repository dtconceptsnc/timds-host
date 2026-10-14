import { readPublishedArtifactFile } from '../publication/artifacts.mjs';
import { fail } from '../store/errors.mjs';
import { nativeViewerFile } from './native-base.mjs';
import { publicSystemPath } from './urls.mjs';

const mime = new Map(Object.entries({html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8',txt:'text/plain; charset=utf-8',md:'text/markdown; charset=utf-8',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',pdf:'application/pdf',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',xml:'application/xml; charset=utf-8',webmanifest:'application/manifest+json'}));
export const publicContentType = path => mime.get(path.split('.').at(-1)?.toLowerCase()) || 'application/octet-stream';
const local = hostname => ['localhost','127.0.0.1','[::1]'].includes(hostname);
function origin(value) {
  let url; try { url = new URL(value); } catch { throw fail(503,'Public hosting is not configured'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local(url.hostname))) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw fail(503,'Public hosting is not configured');
  return url.origin;
}
export function publicOrigins({hostOrigin,publicOrigin}) {
  const host = origin(hostOrigin), published = origin(publicOrigin);
  // Published HTML is authored by system members and must never inherit the
  // OAuth/Studio origin. Separate ports are sufficient only for local tests.
  if (host === published || (!local(new URL(host).hostname) && new URL(host).hostname === new URL(published).hostname)) throw fail(503,'Published files require a separate public origin');
  return {host,published};
}
const idSegment=/^[a-z0-9][a-z0-9._-]*$/;
export function publicSystemUrls(publicOrigin,systemId,label) {
  const root = `${origin(publicOrigin)}${publicSystemPath(systemId)}/`;
  return {root,current:root,latest:`${root}v/latest/`,...(label?{version:`${root}v/${encodeURIComponent(label)}/`}:{})};
}
function decode(value) { try { return decodeURIComponent(value); } catch { throw fail(400,'Invalid public path'); } }
export function safePublicPath(path) {
  if (typeof path !== 'string' || path.length>1000 || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git')) throw fail(400,'Invalid public path');
  return path;
}
/** Routes for one public path, most specific first. An id with an encoded
 * slash is one candidate. Otherwise `/systems/a/b/...` names system `a/b`
 * when it exists and system `a` with file `b/...` when it does not. */
export function publicRoutes(pathname) {
  const match = /^\/systems\/([^/]+)(?:\/([^/]*)(?:\/(.*))?)?$/.exec(pathname);
  if (!match) return null;
  const first=decode(match[1]);
  const single=publicRoute(pathname);
  if (!match[2] || first.includes('/') || !idSegment.test(first) || !idSegment.test(match[2]) || match[2]==='v') return [single];
  const rest=match[3],pair=`${first}/${match[2]}`;
  return [{systemId:pair,...route(rest,pathname)},single];
}
export function publicRoute(pathname) {
  const match = /^\/systems\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  const systemId=decode(match[1]);
  if (!systemId || systemId.length>300 || /[\\\x00-\x1f\x7f]/.test(systemId)) throw fail(400,'Invalid system id');
  return {systemId,...route(match[2],pathname)};
}
function route(rest,pathname) {
  let file=rest ?? '',label=null;
  if (file.startsWith('v/')) {
    const pinned=/^v\/([^/]+)(?:\/(.*))?$/.exec(file);
    if (!pinned) throw fail(404,'Published version not found');
    label=decode(pinned[1]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(label)) throw fail(400,'Invalid version');
    file=pinned[2] ?? '';
  }
  file=file.split('/').map(decode).join('/');
  // `latest` is a tag, never a release label: it names the current pointer,
  // which publish moves forward and rollback moves back.
  if (label==='latest') return {label:null,tag:'latest',file,needsSlash:!pathname.endsWith('/') && !file};
  return {label,file,needsSlash:!pathname.endsWith('/') && !file};
}
export async function publishedFile(readFile,bucket,version,path) {
  const result=await readFile(bucket,version,safePublicPath(path));
  if (!result) return null;
  // The virtual stamp and artifact files have one byte-preserving interface.
  return result instanceof Response ? {body:result.body,size:Number(result.headers.get('Content-Length'))||undefined,sha256:null} : result;
}
export function createPublicRoots({resolvePublished,bucket,hostOrigin,publicOrigin,readFile=readPublishedArtifactFile}) {
  const {published}=publicOrigins({hostOrigin,publicOrigin});
  return {
    async fetch(request) {
      try {
        const url=new URL(request.url);
        if (url.origin!==published) throw fail(404,'Public route not found');
        if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD','Cache-Control':'no-store'}});
        const routes=publicRoutes(url.pathname);
        if (!routes) throw fail(404,'Public route not found');
        let route,source,version;
        for (const [index,candidate] of routes.entries()) {
          try { ({source,version}=await resolvePublished(candidate.systemId,candidate.label)); route=candidate; break; }
          catch(error) { if (error?.statusCode!==404 || index===routes.length-1) throw error; }
        }
        if (source.system_id!==route.systemId || version.source_id!==source.id || route.label && version.version_label!==route.label) throw fail(404,'Published version not found');
        // A tag answers with the immutable address it resolved to, so a page and
        // every asset it then loads come from one release, and the consumer
        // learns which version it received.
        if (route.tag) return new Response(null,{status:307,headers:{Location:`${published}${publicSystemPath(route.systemId,version.version_label)}/${(route.file?safePublicPath(route.file):'').split('/').map(encodeURIComponent).join('/')}${url.search}`,'Cache-Control':'public, max-age=300, must-revalidate','X-TimDS-Version':version.version_label,'Access-Control-Allow-Origin':'*'}});
        if (route.needsSlash) return Response.redirect(`${published}${url.pathname}/${url.search}`,308);
        let path=route.file || version.artifact?.entryPath || 'index.html';
        // An entry below the artifact root needs its real directory as the
        // browser base, including for ../ fonts and images. Redirecting retains
        // the original HTML bytes and its authored relative URLs.
        if (!route.file && path.includes('/')) {
          const location=`${published}${url.pathname}${safePublicPath(path).split('/').map(encodeURIComponent).join('/')}${url.search}`;
          return new Response(null,{status:308,headers:{Location:location,'Cache-Control':route.label?'public, max-age=31536000, immutable':'public, max-age=300, must-revalidate'}});
        }
        if (path.endsWith('/')) path+='index.html';
        let stored=await publishedFile(readFile,bucket,version,path);
        // Derived page URLs may omit the slash or .html extension. Resolve
        // against the same captured release, preserving the browser base for
        // directory pages and the exact current/pinned source prefix.
        if(!stored&&!route.file.endsWith('/')&&!path.split('/').at(-1).includes('.')) {
          const directory=await publishedFile(readFile,bucket,version,`${path}/index.html`);
          if(directory){await directory.body?.cancel();return new Response(null,{status:308,headers:{Location:`${published}${url.pathname}/${url.search}`,'Cache-Control':route.label?'public, max-age=31536000, immutable':'public, max-age=300, must-revalidate'}});}
          stored=await publishedFile(readFile,bucket,version,`${path}.html`);if(stored)path+='.html';
        }
        // `timds consumer sync` reads <root>/v/<label>/bundle.json. A system whose
        // entry sits below the artifact root keeps the manifest beside that entry;
        // answer the root path with it, projected from its real directory so the
        // file URLs stay correct.
        if(!stored&&path==='bundle.json'){const entry=version.artifact?.entryPath||'';const directory=entry.includes('/')?entry.slice(0,entry.lastIndexOf('/')+1):'';if(directory){path=`${directory}bundle.json`;stored=await publishedFile(readFile,bucket,version,path);}}
        if (!stored) throw fail(404,'Published file not found');
        const type=publicContentType(path);
        const file=await nativeViewerFile(stored,{path,type,systemId:route.systemId,label:route.label,publicOrigin:published});
        const etag=`"${file.sha256 || `${version.id}:${version.content_digest}`}"`;
        const headers=new Headers({'Content-Type':type,'Cache-Control':route.label?'public, max-age=31536000, immutable':'public, max-age=300, must-revalidate','ETag':etag,'X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*','Referrer-Policy':'no-referrer'});
        if (Number.isSafeInteger(file.size)) headers.set('Content-Length',String(file.size));
        if (request.headers.get('If-None-Match')?.split(',').some(value=>value.trim()===etag||value.trim()==='*')) {
          await file.body?.cancel(); headers.delete('Content-Length'); return new Response(null,{status:304,headers});
        }
        if (request.method==='HEAD') {await file.body?.cancel();return new Response(null,{headers});}
        return new Response(file.body,{headers});
      } catch(error) {
        const status=error?.statusCode>=400&&error.statusCode<500?error.statusCode:503;
        return new Response(status===503?'Published files are temporarily unavailable':error.message,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
    },
  };
}
