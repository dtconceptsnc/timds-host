import { fail } from '../store/errors.mjs';
import { oauthOrigin } from '../http.mjs';
import { createDesignSystemStarter } from './starter.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const slug=/^[a-z0-9][a-z0-9-]{0,62}$/;
// Only explicitly deployed namespace bindings are offered for native creation.
// Namespace management remains an installation operation.
export function provisionNamespaces(env) {
  let bindings;try{bindings=JSON.parse(env.TIMDS_ARTIFACTS_BINDINGS||'{}');}catch{throw fail(503,'Invalid Artifacts binding configuration');}
  if(!bindings||Array.isArray(bindings)||typeof bindings!=='object')throw fail(503,'Invalid Artifacts binding configuration');
  return Object.entries(bindings).filter(([namespace,binding])=>slug.test(namespace)&&typeof binding==='string'&&/^ARTIFACTS_[A-Z0-9_]+$/.test(binding)&&typeof env[binding]?.get==='function'&&typeof env[binding]?.list==='function').map(([namespace])=>namespace).sort();
}

export async function createStarterSystem({input,actor,env,context,catalog,provision}) {
  if(Object.keys(input).some(key=>!['apiVersion','operationId','sourceId','organizationId','systemId','name','namespace','starterVersion'].includes(key)))throw fail(400,'Unsupported Design System creation field');
  if(!uuid.test(input.operationId||'')||!uuid.test(input.sourceId||'')||!uuid.test(input.organizationId||''))throw fail(400,'Operation, source and organization UUIDs are required');
  if(typeof input.systemId!=='string'||input.systemId.length>300||!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(input.systemId))throw fail(400,'Use a lowercase Design System ID with optional slash-separated segments');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200)throw fail(400,'Design System name must be 1–200 characters');
  if(!slug.test(input.namespace||'')||!provisionNamespaces(env).includes(input.namespace))throw fail(400,'Choose a deployed Artifacts namespace');
  if(input.starterVersion!==undefined&&input.starterVersion!==1)throw fail(400,'Unsupported Design System starter version');
  const creationInput={operationId:input.operationId,sourceId:input.sourceId,organizationId:input.organizationId,systemId:input.systemId,name:input.name,namespace:input.namespace,starterVersion:1};
  const files=createDesignSystemStarter({systemId:input.systemId,name:input.name,hostOrigin:oauthOrigin(env),sourceId:input.sourceId});
  return provision({input:{...creationInput,repository:`timds-${input.sourceId.replaceAll('-','').toLowerCase()}`,grantPublisher:true,files},creationInput,actor,env,context,catalog});
}
