import { bindings, defineConfig, defineContainer, exports, triggers } from 'cf/config';
import process from 'node:process';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

const name=process.env.TIMDS_WORKER_NAME || 'timds-host';
if(!/^[a-z0-9][a-z0-9-]{0,48}$/.test(name))throw new Error('Use a lowercase TIMDS_WORKER_NAME');
const artifactsNamespaces=JSON.parse(process.env.TIMDS_ARTIFACTS_BINDINGS||'{}') as Record<string,string>;
if(!artifactsNamespaces||Array.isArray(artifactsNamespaces)||typeof artifactsNamespaces!=='object'||new Set(Object.values(artifactsNamespaces)).size!==Object.keys(artifactsNamespaces).length)throw new Error('Use an explicit Artifacts namespace to binding map');
for(const [namespace,binding] of Object.entries(artifactsNamespaces))if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(namespace)||typeof binding!=='string'||!/^ARTIFACTS_[A-Z0-9_]+$/.test(binding))throw new Error('Invalid Artifacts namespace binding');
const artifactsBindings=Object.fromEntries(Object.entries(artifactsNamespaces).map(([namespace,binding])=>[binding,bindings.artifacts({namespace,dev:{remote:true}})]));
const mediaLegacy=JSON.parse(process.env.TIMDS_MEDIA_LEGACY_BINDINGS||'{}') as Record<string,string>;
if(!mediaLegacy||Array.isArray(mediaLegacy)||typeof mediaLegacy!=='object'||new Set(Object.values(mediaLegacy)).size!==Object.keys(mediaLegacy).length)throw new Error('Use an explicit legacy R2 bucket to media binding map');
for(const [bucket,binding]of Object.entries(mediaLegacy))if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)||typeof binding!=='string'||!/^MEDIA_LEGACY_[A-Z0-9_]+$/.test(binding))throw new Error('Invalid legacy media bucket binding');
const mediaBindings=Object.fromEntries(Object.entries(mediaLegacy).map(([bucket,binding])=>[binding,bindings.r2({name:bucket})]));
const repository=defineContainer({name:`${name}-repository`,schedulingPolicy:'durable-object',observability:{logs:{enabled:true}},images:{repository:{dockerfile:'./runtime/Repository.Dockerfile'}}});
const live=defineContainer({name:`${name}-live`,schedulingPolicy:'durable-object',observability:{logs:{enabled:true}},images:{agent:{dockerfile:'./runtime/Dockerfile'}}});
const build=defineContainer({name:`${name}-build`,schedulingPolicy:'durable-object',observability:{logs:{enabled:true}},images:{build:{dockerfile:'./runtime/Build.Dockerfile'}}});
const dependencies=defineContainer({name:`${name}-dependencies`,schedulingPolicy:'durable-object',observability:{logs:{enabled:true}},images:{build:{dockerfile:'./runtime/Build.Dockerfile'}}});
const workflow=`${name}-publication`;
export default defineConfig({
  worker: {
    name,
    workersDev:true,
    domains:process.env.TIMDS_STUDIO_ORIGIN?[new URL(process.env.TIMDS_STUDIO_ORIGIN).hostname]:[],
    compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat', 'enable_ctx_exports', 'global_fetch_strictly_public'],
    // Workers Logs for the Worker, its Durable Objects, Workflow and queue consumer.
    // Query strings are redacted: the feed upgrade carries its ticket there.
    observability:{enabled:true,redactQueryString:true,logs:{enabled:true,invocationLogs:true}},
    entrypoint,
    assets:{htmlHandling:'none',runWorkerFirst:true},
    exports:{
      SystemCoordinator:exports.durableObject({storage:'sqlite'}),
      RepositorySandbox:exports.durableObject({storage:'sqlite',container:repository}),
      LiveSession:exports.durableObject({storage:'sqlite',container:live}),
      BuildSandbox:exports.durableObject({storage:'sqlite',container:build}),
      DependencySandbox:exports.durableObject({storage:'sqlite',container:dependencies}),
      PublicationWorkflow:exports.workflow({name:workflow,limits:{steps:2048},concurrency:{limit:10},defaultRetention:{successRetention:'7 days',errorRetention:'30 days'}}),
    },
    env:{
      ...artifactsBindings,
      ...mediaBindings,
      MEDIA:bindings.r2({name:`${name}-media`}),
      TIMDS_MEDIA_LEGACY_BINDINGS:bindings.text(JSON.stringify(mediaLegacy)),
      TIMDS_MEDIA_ALLOWED_ORIGINS:bindings.text(process.env.TIMDS_MEDIA_ALLOWED_ORIGINS || '[]'),
      TIMDS_ARTIFACTS_BINDINGS:bindings.text(JSON.stringify(artifactsNamespaces)),
      TIMDS_ARTIFACTS_REST_FALLBACK:bindings.text(process.env.TIMDS_ARTIFACTS_REST_FALLBACK==='true'?'true':'false'),
      ASSETS:bindings.assets(),
      CATALOG:bindings.d1({name:`${name}-catalog`}),
      SNAPSHOTS:bindings.r2({name:`${name}-snapshots`}),
      RELEASES:bindings.r2({name:`${name}-releases`}),
      OAUTH_KV:bindings.kv(),
      PUSHES:bindings.queue({name:`${name}-events`}),
      PUBLICATION_WORKFLOW:bindings.workflow({name:workflow,worker:name,exportName:'PublicationWorkflow'}),
      HOST_ORIGIN:bindings.text(process.env.TIMDS_HOST_ORIGIN || 'http://127.0.0.1:8787'),
      TIMDS_STUDIO_ORIGIN:bindings.text(process.env.TIMDS_STUDIO_ORIGIN || ''),
      TIMDS_WORKERS_SUBDOMAIN_ALIASES:bindings.text(process.env.TIMDS_WORKERS_SUBDOMAIN_ALIASES || '{}'),
      TIMDS_PUBLIC_ORIGIN:bindings.text(process.env.TIMDS_PUBLIC_ORIGIN || 'http://127.0.0.1:8788'),
      TIMDS_PORTAL_ORIGIN:bindings.text(process.env.TIMDS_PORTAL_ORIGIN || ''),
      TIMDS_STUDIO_FRAME_ORIGINS:bindings.text(process.env.TIMDS_STUDIO_FRAME_ORIGINS || ''),
      TIMDS_ACCESS_INVITATIONS_ENABLED:bindings.text(process.env.TIMDS_ACCESS_INVITATIONS_ENABLED==='true'?'true':'false'),
      TIMDS_LIVE_INSTANCE_TYPE:bindings.text(process.env.TIMDS_LIVE_INSTANCE_TYPE || 'standard-3'),
      TIMDS_BUILD_INSTANCE_TYPE:bindings.text(process.env.TIMDS_BUILD_INSTANCE_TYPE || 'standard-2'),
      TIMDS_REPOSITORY_INSTANCE_TYPE:bindings.text(process.env.TIMDS_REPOSITORY_INSTANCE_TYPE || 'standard-1'),
      TIMDS_REPOSITORY_RETENTION_SECONDS:bindings.text(process.env.TIMDS_REPOSITORY_RETENTION_SECONDS || '0'),
      TIMDS_HOST_WORKER_NAME:bindings.text(name),
      ACCESS_TEAM_DOMAIN:bindings.text(process.env.TIMDS_ACCESS_TEAM_DOMAIN || ''),
      ACCESS_AUD:bindings.text(process.env.TIMDS_ACCESS_AUD || ''),
      CLOUDFLARE_ACCOUNT_ID:bindings.text(process.env.CLOUDFLARE_ACCOUNT_ID || ''),
      TIMDS_AGENT_PUSH_QUEUE_ID:bindings.text(process.env.TIMDS_AGENT_PUSH_QUEUE_ID || ''),
      TIMDS_DESIGNER_PRINCIPAL_ID:bindings.text(process.env.TIMDS_DESIGNER_PRINCIPAL_ID || ''),
      MODEL:bindings.text(process.env.TIMDS_DESIGNER_MODEL || 'gpt-6-sol'),
      CLOUDFLARE_API_TOKEN:bindings.secret(),
      TIMDS_BUILDS_API_TOKEN:bindings.secret(),
      OPENAI_API_KEY:bindings.secret(),
      TIMDS_BOOTSTRAP_SECRET:bindings.secret(),
      TIMDS_PORTAL_TRANSFER_SECRET:bindings.secret(),
    },
    triggers:[triggers.queue({name:`${name}-events`,maxBatchSize:10,maxBatchTimeout:1})],
  },
  containers:[repository,live,build,dependencies],
});
