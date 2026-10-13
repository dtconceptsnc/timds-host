import {bindings,defineConfig} from 'cf/config';
import process from 'node:process';
import * as entrypoint from './src/index.ts' with {type:'cf-worker'};
import {legacyHostRoutes} from '../src/public/host-routes.mjs';
const host=process.env.TIMDS_WORKER_NAME || 'timds-host';
const legacyHosts=JSON.stringify(legacyHostRoutes(process.env.TIMDS_LEGACY_PUBLIC_HOSTS || '{}'));
export default defineConfig({worker:{name:`${host}-public`,compatibilityDate:'2026-10-12',entrypoint,env:{
  PUBLIC_ROOTS:bindings.worker({worker:host,exportName:'PublicRoots'}),
  PUBLIC_ORIGIN:bindings.text(process.env.TIMDS_PUBLIC_ORIGIN || 'http://127.0.0.1:8788'),
  LEGACY_PUBLIC_HOSTS:bindings.text(legacyHosts),
}}});
