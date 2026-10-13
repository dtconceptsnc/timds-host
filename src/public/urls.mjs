import { fail } from '../store/errors.mjs';

const artifactOrigin='https://artifact.invalid';
const encodePath=path=>path.split('/').map(encodeURIComponent).join('/');
function artifactPath(value){
  if(typeof value!=='string'||!value||value.length>1000||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..'))throw fail(503,'Published bundle path is invalid');
  return encodePath(value);
}
/** Normalize the authored root before adding the captured source/version base.
 * This keeps dot segments within the artifact and leaves external URLs alone. */
export function publishedRootUrl(value,base){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return value;
  const resolved=new URL(value,artifactOrigin);
  if(resolved.origin!==artifactOrigin)return '#';
  return `${base.replace(/\/$/,'')}${resolved.pathname}${resolved.search}${resolved.hash}`;
}
export function publishedDocumentUrls(document,base){
  if(!document||typeof document!=='object')return document;
  for(const [key,value]of Object.entries(document)){
    if(['url','href','src','poster'].includes(key)&&typeof value==='string')document[key]=publishedRootUrl(value,base);
    else if(value&&typeof value==='object')publishedDocumentUrls(value,base);
  }
  return document;
}
/** Rewrite only manifest location fields. Its file paths, bytes, SHA256 values
 * and all physical bundle objects retain their original immutable identity. */
export function publishedBundle(document,{base,manifestPath,versionBase=null}){
  if(!document||typeof document!=='object'||Array.isArray(document)||!Array.isArray(document.files)||document.files.length>10000)throw fail(503,'Published bundle manifest is invalid');
  const directory=manifestPath.includes('/')?manifestPath.slice(0,manifestPath.lastIndexOf('/')+1):'';
  const prefix=`${base.replace(/\/$/,'')}/`,pathPrefix=directory?artifactPath(directory.slice(0,-1))+'/':'';
  const bundleDirectory=`${prefix}${pathPrefix}bundle`;
  return {...document,url:`${prefix}${artifactPath(manifestPath)}`,base:prefix.replace(/\/$/,''),directory:bundleDirectory,
    versioned:versionBase?`${versionBase.replace(/\/$/,'')}/${pathPrefix}bundle`:null,
    files:document.files.map(file=>({...file,url:`${bundleDirectory}/${artifactPath(file.path)}`}))};
}
export function rewriteNativeBrowser(text,type,prefix){
  const url=value=>{
    if(value.startsWith(prefix+'/'))return value;
    return publishedRootUrl(value,prefix);
  };
  const css=value=>value.replace(/url\(\s*(['"]?)(\/[^)'"\s]*)\1\s*\)/gi,(_m,q,v)=>`url(${q}${url(v)}${q})`)
    .replace(/@import\s+(['"])(\/[^'"]*)\1/gi,(_m,q,v)=>`@import ${q}${url(v)}${q}`);
  if(type.startsWith('text/css'))return css(text);
  return text.replace(/\b(href|src|action|poster)\s*=\s*(['"])([^'"]*)\2/gi,(_m,a,q,v)=>`${a}=${q}${url(v)}${q}`)
    .replace(/\bcontent=(['"])([^'"]*)\1/gi,(_m,q,v)=>`content=${q}${v.replace(/(\burl\s*=\s*)(\/[^\s]*)/gi,(_n,start,value)=>start+url(value))}${q}`)
    .replace(/\bsrcset=(['"])([^'"]+)\1/gi,(_m,q,v)=>`srcset=${q}${v.replace(/(^|,\s*)(\/[^\s,]*)/g,(_n,start,value)=>start+url(value))}${q}`)
    .replace(/\bstyle=(['"])([\s\S]*?)\1/gi,(_m,q,v)=>`style=${q}${css(v)}${q}`)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,(_m,o,v,c)=>o+css(v)+c);
}
