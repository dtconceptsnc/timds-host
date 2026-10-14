import {Buffer} from 'node:buffer';
import {fail} from '../store/errors.mjs';
import {starterSourceFiles} from './starter-data.mjs';

export const designSystemStarterVersion=1;
const json=value=>`${JSON.stringify(value,null,2)}\n`;

/** Fixed, reviewed hosted scaffold; no network, filesystem, clock or random input.
 * Revision 1 keeps its baseline release date so interrupted creates produce the
 * same repository bytes. The first publication assigns its actual release. */
export function createDesignSystemStarter({systemId,name,hostOrigin,sourceId,starterVersion=designSystemStarterVersion}={}) {
  if(starterVersion!==designSystemStarterVersion)throw fail(400,'Unsupported Design System starter version');
  if(typeof systemId!=='string'||systemId.length>300||!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(systemId))throw fail(400,'Invalid Design System ID');
  if(typeof name!=='string'||!name.trim()||name.length>200)throw fail(400,'Design System name must contain 1 to 200 characters');
  if(typeof sourceId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId))throw fail(400,'Invalid source ID');
  let origin;
  try {
    const url=new URL(hostOrigin);
    if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error();
    origin=url.origin;
  } catch {throw fail(500,'Host origin is invalid');}
  const workerName=`timds-${sourceId.toLowerCase().replaceAll('-','')}`;
  return starterSourceFiles.map(file=>{
    let content=file.content;
    if(file.path==='timds.json') {
      const manifest=JSON.parse(content);
      manifest.systemId=systemId;manifest.name=name.trim();manifest.provider.url=origin;manifest.media.portalUrl=origin;
      content=json(manifest);
    } else if(file.path==='package.json'||file.path==='package-lock.json') {
      const pkg=JSON.parse(content);pkg.name=workerName;
      if(file.path==='package-lock.json')pkg.packages[''].name=workerName;
      content=json(pkg);
    } else if(file.path==='cloudflare.config.ts') {
      content=content.replace('name:"timds-example"',`name:${JSON.stringify(workerName)}`);
    }
    return{path:file.path,mode:file.mode,encoding:'base64',content:Buffer.from(content).toString('base64')};
  });
}
