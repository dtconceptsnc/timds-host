import {sha256} from '../repository/file-trees.mjs';
export const TOOLKIT_VERSION='0.1.464';
export const INSTALL_FLAGS=['ci','--ignore-scripts','--no-audit','--no-fund'];
export function validateDependencyInputs(packageText,lockText){
 let pkg,lock;try{pkg=JSON.parse(packageText);lock=JSON.parse(lockText);}catch{throw new Error('Dependency inputs must be valid JSON');}
 if(![2,3].includes(lock.lockfileVersion)||!lock.packages||typeof lock.packages!=='object'||Array.isArray(lock.packages))throw new Error('A current npm package lock is required');
 // File/git/workspace dependencies can execute another transport or depend on
 // source bytes omitted from this cache key. Fail explicitly instead.
 if(pkg.workspaces)throw new Error('Workspace dependency caches are not supported');
 for(const [name,entry] of Object.entries(lock.packages)){
  if(name==='')continue;
  if(!name.startsWith('node_modules/')||entry.link||typeof entry.resolved!=='string'||typeof entry.integrity!=='string')throw new Error('Dependency cache requires locked registry packages');
  const url=new URL(entry.resolved);
  if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password||url.port||url.hash||url.search||!/^sha(?:256|384|512)-[a-zA-Z0-9+/=]+$/.test(entry.integrity))throw new Error('Dependency cache requires integrity-pinned npm registry packages');
 }
 return {pkg,lock};
}
export async function dependencyCacheKey({packageText,lockText,image,nodeVersion,nodeAbi,platform,arch}){
 validateDependencyInputs(packageText,lockText);
 if(!image||!nodeVersion||!nodeAbi||!platform||!arch)throw new Error('Dependency cache runtime identity is incomplete');
 return sha256(new TextEncoder().encode(JSON.stringify({schemaVersion:1,package:await sha256(new TextEncoder().encode(packageText)),lock:await sha256(new TextEncoder().encode(lockText)),image,nodeVersion,nodeAbi,platform,arch,toolkit:TOOLKIT_VERSION,flags:INSTALL_FLAGS})));
}
