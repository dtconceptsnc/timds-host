import {bindings,defineConfig} from 'cf/config';
import process from 'node:process';
import * as entrypoint from './src/index.ts' with {type:'cf-worker'};
const host=process.env.TIMDS_WORKER_NAME || 'timds-host';
export default defineConfig({worker:{name:`${host}-public`,compatibilityDate:'2026-10-12',entrypoint,env:{PUBLIC_ROOTS:bindings.worker({worker:host,exportName:'PublicRoots'})}}});
