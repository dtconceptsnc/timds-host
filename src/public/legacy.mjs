// Compatibility for explicitly imported portal roots. Version selection stays
// in the coordinator; this module never discovers authority through R2 listing.
import path from 'node:path';
import { loadRelease } from '../publication/releases.mjs';
import { sha256 } from '../repository/file-trees.mjs';
import { fail } from '../store/errors.mjs';
import { legacySourceRoots, UUID } from './host-routes.mjs';

export const LEGACY_BEHAVIOR='portal-public-roots-v1';
export const LEGACY_CURRENT_CACHE='public, max-age=300, must-revalidate';
export const LEGACY_VERSION_CACHE='public, max-age=31536000, immutable';
export const LEGACY_CSP=["default-src 'self' data: blob: https:","script-src 'self' 'unsafe-inline'","style-src 'self' 'unsafe-inline' https://fonts.googleapis.com","font-src 'self' data: https://fonts.gstatic.com","img-src 'self' data: blob: https:","media-src 'self' data: blob: https:","connect-src 'none'","frame-ancestors 'self'","base-uri 'none'","object-src 'none'",'sandbox allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts'].join('; ');
const encoder=new TextEncoder(),decoder=new TextDecoder();
const mime={avif:'image/avif',css:'text/css; charset=utf-8',gif:'image/gif',html:'text/html; charset=utf-8',ico:'image/x-icon',jpeg:'image/jpeg',jpg:'image/jpeg',js:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8',map:'application/json; charset=utf-8',mjs:'text/javascript; charset=utf-8',md:'text/markdown; charset=utf-8',mp4:'video/mp4',pdf:'application/pdf',png:'image/png',svg:'image/svg+xml',ttf:'font/ttf',txt:'text/plain; charset=utf-8',webm:'video/webm',webp:'image/webp',woff:'font/woff',woff2:'font/woff2'};
export const legacyContentType=file=>mime[path.posix.extname(file).slice(1).toLowerCase()]||'application/octet-stream';
const consumer=file=>/(?:^|\/)bundle(?:\/|\.json$)/.test(file);
const unavailable=()=>fail(404,'Design System file unavailable.');
const validPath=value=>typeof value==='string'&&value.length>0&&value.length<=1000&&!/[\\\x00-\x1f\x7f%?#]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(p=>!p||p==='.'||p==='..');

export function parseLegacyPath(value) {
  let decoded;try{decoded=decodeURIComponent(String(value||''));}catch{throw unavailable();}
  if(/[\\\x00-\x1f\x7f%?#]/.test(decoded))throw unavailable();
  const match=/^(?:v|releases)\/([^/]+)(?:\/(.*))?$/.exec(decoded);
  if(match&&!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,119}$/.test(match[1]))throw unavailable();
  const file=match?match[2]||'':decoded;
  if(file.split('/').some(part=>part==='.'||part==='..'||part.startsWith('.')&&file!=='.timds-artifact.json'))throw unavailable();
  return {label:match?.[1]||null,file};
}

export function rewriteLegacyArtifact(body,type,prefix) {
  if(!prefix||!/^(text\/(html|css|plain|markdown)|application\/json)/.test(type))return body;
  let text=decoder.decode(body);
  if(type.startsWith('text/html'))text=text
    .replace(/\b(href|src|action|poster|value)=(['"])\/(?!\/)/gi,`$1=$2${prefix}/`)
    .replace(/\bcontent=(['"])([^'"]*)\1/gi,(_m,q,v)=>`content=${q}${v.replace(/(\burl\s*=\s*)\/(?!\/)/gi,`$1${prefix}/`)}${q}`)
    .replace(/\b(srcset)=(['"])([^'"]+)\2/gi,(_m,a,q,v)=>`${a}=${q}${v.replace(/(^|,\s*)\/(?!\/)/g,`$1${prefix}/`)}${q}`)
    .replace(/\bstyle=(['"])([\s\S]*?)\1/gi,(_m,q,v)=>`style=${q}${v.replace(/url\(\s*(['"]?)\/(?!\/)/gi,`url($1${prefix}/`)}${q}`)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,(_m,o,v,c)=>`${o}${v.replace(/url\(\s*(['"]?)\/(?!\/)/gi,`url($1${prefix}/`)}${c}`);
  else if(type.startsWith('text/css'))text=text.replace(/url\(\s*(['"]?)\/(?!\/)/gi,`url($1${prefix}/`).replace(/@import\s+(['"])\/(?!\/)/gi,`@import $1${prefix}/`);
  else if(type.startsWith('application/json')){
    const walk=value=>typeof value==='string'?(value.startsWith('/')&&!value.startsWith('//')?`${prefix}${value}`:value):Array.isArray(value)?value.map(walk):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)])):value;
    text=JSON.stringify(walk(JSON.parse(text)),null,2);
  }else text=text.replace(/(^|[\s("'])\/(?!\/)/gm,`$1${prefix}/`);
  return encoder.encode(text);
}

/** Called by both import verification and public reads. The reviewed export
 * separates local files from bundle-only R2 fallbacks; no content is guessed. */
export function validateLegacyReleaseMetadata(version,{manifest,manifestDigest,firstPublicationEventId}={}) {
  const metadata=version.legacy_public;
  if(!metadata)return null;
  if(metadata.schemaVersion!==1||metadata.behavior!==LEGACY_BEHAVIOR||!UUID.test(metadata.firstPublicationEventId||'')||!/^[a-f0-9]{64}$/.test(metadata.artifactManifestDigest||'')||!validPath(metadata.entryPath)||metadata.entryPath!==version.artifact?.entryPath||!Array.isArray(metadata.localPaths)||!Array.isArray(metadata.bundleFallbacks)||metadata.localPaths.length>2000||metadata.bundleFallbacks.length>2000)throw fail(409,'Legacy serving provenance is invalid');
  const local=new Set(metadata.localPaths),fallbacks=new Map();
  if(local.size!==metadata.localPaths.length||!local.has(metadata.entryPath)||metadata.localPaths.some(p=>!validPath(p)))throw fail(409,'Legacy local file map is invalid');
  for(const file of metadata.bundleFallbacks){if(!validPath(file?.path)||!(file.path==='bundle.json'||file.path.startsWith('bundle/'))||local.has(file.path)||fallbacks.has(file.path)||typeof file.contentType!=='string'||!file.contentType||file.contentType.length>200||/[\r\n\x00]/.test(file.contentType))throw fail(409,'Legacy bundle fallback is invalid');fallbacks.set(file.path,file.contentType);}
  if(manifest){const paths=new Set(manifest.files.map(file=>file.path));if(paths.size!==local.size+fallbacks.size||[...local,...fallbacks.keys()].some(p=>!paths.has(p)))throw fail(409,'Legacy serving map differs from immutable files');}
  if(manifestDigest&&metadata.artifactManifestDigest!==manifestDigest||firstPublicationEventId&&metadata.firstPublicationEventId!==firstPublicationEventId)throw fail(409,'Legacy serving authority changed');
  return {local,fallbacks,entryPath:metadata.entryPath};
}

function htmlText(html){return html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<[^>]+>/g,'\n').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n\n').trim();}
async function legacyReference(tree,directory,full){
  const base=directory==='.'?'':`${directory}/`,files=extension=>[...tree.local].filter(p=>p.startsWith(base)&&p.endsWith(extension)).sort();
  const intro=tree.local.has(base+'llms.txt')?decoder.decode(await tree.read(base+'llms.txt')):'';
  const markdown=files('.md');
  if(intro&&full&&markdown.length){const pieces=[intro];for(const file of markdown)pieces.push(decoder.decode(await tree.read(file)));return pieces.join('\n\n---\n\n');}
  const pages=[];for(const file of files('.html')){const html=decoder.decode(await tree.read(file));pages.push({html,title:htmlText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]||file.slice(base.length)),url:`/${file.split('/').map(encodeURIComponent).join('/')}`});}
  const index=intro||`# Design System reference\n\nThis release predates the machine-readable layer. Use these published viewer pages as the source of truth.\n\n${pages.map(page=>`- [${page.title.replace(/[\[\]]/g,'')}](${page.url})`).join('\n')}\n`;
  return full?[index,...pages.map(page=>`# ${page.title}\n\nSource: ${page.url}\n\n${htmlText(page.html)}`)].join('\n\n---\n\n'):index;
}
function resolveFile(tree,requested){
  const normalized=requested.replace(/^\/+/, '').replace(/\/{2,}/g,'/').replace(/\/+$/,'');
  if(!validPath(normalized))return null;
  const candidates=[normalized,...(!path.posix.extname(normalized)?[`${normalized}.html`,`${normalized}/index.html`]:[])];
  return candidates.find(file=>tree.local.has(file))||null;
}
async function landing(tree,initial){
  let file=initial;const visited=new Set();
  for(let hop=0;hop<8;hop++){
    if(visited.has(file))return null;visited.add(file);
    const body=await tree.read(file),type=legacyContentType(file);if(!type.startsWith('text/html'))return null;
    const html=decoder.decode(body);let target=null;
    for(const tag of html.match(/<meta\b[^>]*>/gi)||[]){const attributes=Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(m=>[m[1].toLowerCase(),m[3]]));if(attributes['http-equiv']?.toLowerCase()!=='refresh')continue;target=/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.*?)\s*$/i.exec(attributes.content||'')?.[1];if(!target)return null;target=target.replace(/^['"]|['"]$/g,'');break;}
    if(target===null){if(file===initial)return {body,type};const rebased=html.replace(/\b(href|src|action|poster)=(['"])([^'"<>]*)\2/gi,(match,attribute,quote,value)=>{if(!value||/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(value))return match;const url=new URL(value,`https://artifact.invalid/${file}`);return `${attribute}=${quote}${url.pathname}${url.search}${url.hash}${quote}`;});return {body:encoder.encode(rebased),type};}
    if(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)||/[\\\0%?#]/.test(target))return null;
    const requestPath=target.startsWith('/')?target.slice(1):path.posix.join(path.posix.dirname(file),target);
    try{parseLegacyPath(requestPath);}catch{return null;}
    file=resolveFile(tree,requestPath);if(!file)return null;
  }
  return null;
}

export async function loadLegacyTree(storage,version,firstPublicationEventId){
  const {bucket,root,receipt,manifestDigest}=await loadRelease(storage,version);
  if(version.legacy_public&&!/^[a-f0-9]{64}$/.test(manifestDigest||''))throw fail(409,'Legacy release digest is unavailable');
  const declared=validateLegacyReleaseMetadata(version,{manifest:receipt.manifest,manifestDigest,firstPublicationEventId});
  const local=declared?.local||new Set(receipt.manifest.files.map(file=>file.path)),fallbacks=declared?.fallbacks||new Map(),entryPath=declared?.entryPath||version.artifact?.entryPath;
  if(!validPath(entryPath)||!local.has(entryPath)||receipt.manifest.files.some(file=>file.mode==='120000'))throw fail(409,'Legacy entry is unavailable');
  const files=new Map(receipt.manifest.files.map(file=>[file.path,file]));
  return {entryPath,local,fallbacks,async read(file){const expected=files.get(file);if(!expected)throw unavailable();const object=await bucket.get(root+file);if(!object||object.size!==expected.size||object.size>12_000_000||object.customMetadata?.sha256!==expected.sha256)throw fail(503,'Legacy file is unavailable');const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==expected.size||await sha256(bytes)!==expected.sha256)throw fail(503,'Legacy file verification failed');return bytes;}};
}

/** The companion passes a source UUID only from its explicit hostname map.
 * Recheck that hostname in the current source row before reading any bytes. */
export function createLegacyPublicRoots({resolvePublished,bucket,hostOrigin,loadTree=loadLegacyTree}) {
  return {async fetch(request,sourceId){
    const error=(status,text='Design System file unavailable.')=>new Response(request.method==='HEAD'?null:text,{status,headers:{'Cache-Control':'no-store','Content-Type':'text/plain','Access-Control-Allow-Origin':'*'}});
    try{
      const url=new URL(request.url);if(url.protocol!=='https:'||url.origin===hostOrigin||!UUID.test(sourceId||''))return error(404);
      if(!['GET','HEAD'].includes(request.method))return error(405,'Method not allowed.');
      const route=parseLegacyPath(url.pathname.slice(1)),resolved=await resolvePublished(sourceId,route.label);
      const {source,version,firstPublicationEventId}=resolved||{};
      if(source?.id!==sourceId||!legacySourceRoots(source.legacy_public_roots).includes(url.hostname)||version?.source_id!==sourceId||route.label&&version.version_label!==route.label||!UUID.test(firstPublicationEventId||''))return error(404);
      const tree=await loadTree(bucket,version,firstPublicationEventId),directory=path.posix.dirname(tree.entryPath),relative=route.file.replace(/\/+$/,'')||'index.html';
      let preserve=consumer(relative),body,type;
      if(['timds-artifact.json','.timds-artifact.json'].includes(relative)){body=encoder.encode(JSON.stringify({schemaVersion:1,systemId:source.system_id,version:version.version_label,sourceCommit:version.source_commit,contentDigest:version.content_digest,entry:'index.html'}));type='application/json; charset=utf-8';}
      else{
        const candidates=[...new Set([directory==='.'?relative:`${directory}/${relative}`,relative])];let file=null;
        for(const candidate of candidates){file=resolveFile(tree,candidate);if(file)break;}
        if(file){preserve ||= consumer(file);if(!preserve&&!route.label&&file===tree.entryPath){const result=await landing(tree,file);if(!result)return error(404);({body,type}=result);}else{body=await tree.read(file);type=legacyContentType(file);}}
        else if(['llms.txt','llms-full.txt'].includes(relative)){body=encoder.encode(await legacyReference(tree,directory,relative==='llms-full.txt'));type='text/plain; charset=utf-8';}
        else if(tree.fallbacks.has(relative)){body=await tree.read(relative);type=tree.fallbacks.get(relative);}
      }
      if(!body)return error(404);
      if(!preserve)body=rewriteLegacyArtifact(body,type,route.label?`/v/${encodeURIComponent(route.label)}`:'');
      const etag=`"${await sha256(body)}"`,headers=new Headers({'Access-Control-Allow-Origin':'*','Cache-Control':route.label?LEGACY_VERSION_CACHE:LEGACY_CURRENT_CACHE,'Content-Type':type,'Content-Length':String(body.length),ETag:etag,'X-Content-Type-Options':'nosniff','Content-Security-Policy':LEGACY_CSP,'Referrer-Policy':'no-referrer'});
      if(request.headers.get('If-None-Match')===etag){headers.delete('Content-Length');return new Response(null,{status:304,headers});}
      return new Response(request.method==='HEAD'?null:body,{headers});
    }catch(caught){return error(caught?.statusCode===404?404:503);}
  }};
}
