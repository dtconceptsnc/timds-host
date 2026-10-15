import {bindings,defineConfig} from 'cf/config';
import process from 'node:process';
import * as entrypoint from './src/index.ts' with {type:'cf-worker'};
import {legacyHostRoutes} from '../src/public/host-routes.mjs';
const host=process.env.TIMDS_WORKER_NAME || 'timds-host';
const publicOrigin=process.env.TIMDS_PUBLIC_ORIGIN || 'http://127.0.0.1:8788';
const publicUrl=new URL(publicOrigin),local=['localhost','127.0.0.1','[::1]'].includes(publicUrl.hostname);
if((publicUrl.protocol!=='https:'&&!(local&&publicUrl.protocol==='http:'))||publicUrl.pathname!=='/'||publicUrl.search||publicUrl.hash||publicUrl.username||publicUrl.password||publicUrl.hostname.endsWith('.')||(!local&&publicUrl.port))throw new Error('TIMDS_PUBLIC_ORIGIN must be an exact HTTPS origin without a path or credentials');
for(const privateOrigin of [process.env.TIMDS_HOST_ORIGIN,process.env.TIMDS_STUDIO_ORIGIN])if(privateOrigin){const privateUrl=new URL(privateOrigin);if(privateUrl.origin===publicUrl.origin||!local&&privateUrl.hostname===publicUrl.hostname)throw new Error('Published files require a separate domain from the authenticated host and Studio');}
// Attach the advertised public address to the read-only companion. Provider
// addresses remain useful for disposable development, but are not custom domains.
const domains=local||/(^|\.)(workers\.dev|pages\.dev|r2\.dev)$/.test(publicUrl.hostname)?[]:[publicUrl.hostname];
const legacyRoutes=legacyHostRoutes(process.env.TIMDS_LEGACY_PUBLIC_HOSTS || '{}');
if(Object.hasOwn(legacyRoutes,publicUrl.hostname))throw new Error('The canonical public domain cannot also be a legacy source alias');
const legacyHosts=JSON.stringify(legacyRoutes);
export default defineConfig({worker:{name:`${host}-public`,domains,compatibilityDate:'2026-10-12',observability:{enabled:true,redactQueryString:true,logs:{enabled:true,invocationLogs:true}},entrypoint,env:{
  PUBLIC_ROOTS:bindings.worker({worker:host,exportName:'PublicRoots'}),
  PUBLIC_ORIGIN:bindings.text(publicUrl.origin),
  LEGACY_PUBLIC_HOSTS:bindings.text(legacyHosts),
}}});
