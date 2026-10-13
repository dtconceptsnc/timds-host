import { bindings, defineConfig, defineContainer, exports, triggers } from 'cf/config';
import process from 'node:process';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

const name=process.env.TIMDS_WORKER_NAME || 'timds-host';
if(!/^[a-z0-9][a-z0-9-]{0,48}$/.test(name))throw new Error('Use a lowercase TIMDS_WORKER_NAME');
const repository=defineContainer({name:`${name}-repository`,schedulingPolicy:'durable-object',images:{repository:{dockerfile:'./runtime/Repository.Dockerfile'}}});
const live=defineContainer({name:`${name}-live`,schedulingPolicy:'durable-object',images:{agent:{dockerfile:'./runtime/Dockerfile'}}});
const build=defineContainer({name:`${name}-build`,schedulingPolicy:'durable-object',images:{build:{dockerfile:'./runtime/Build.Dockerfile'}}});
const dependencies=defineContainer({name:`${name}-dependencies`,schedulingPolicy:'durable-object',images:{build:{dockerfile:'./runtime/Build.Dockerfile'}}});
const workflow=`${name}-publication`;
export default defineConfig({
  worker: {
    name,
    compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat', 'enable_ctx_exports', 'global_fetch_strictly_public'],
    entrypoint,
    assets:{htmlHandling:'none',runWorkerFirst:true},
    exports:{
      SystemCoordinator:exports.durableObject({storage:'sqlite'}),
      RepositorySandbox:exports.durableObject({storage:'sqlite',container:repository}),
      LiveSession:exports.durableObject({storage:'sqlite',container:live}),
      BuildSandbox:exports.durableObject({storage:'sqlite',container:build}),
      DependencySandbox:exports.durableObject({storage:'sqlite',container:dependencies}),
      PublicationWorkflow:exports.workflow({name:workflow,limits:{steps:32},concurrency:{limit:10},defaultRetention:{successRetention:'7 days',errorRetention:'30 days'}}),
    },
    env:{
      ASSETS:bindings.assets(),
      CATALOG:bindings.d1({name:`${name}-catalog`}),
      SNAPSHOTS:bindings.r2({name:`${name}-snapshots`}),
      RELEASES:bindings.r2({name:`${name}-releases`}),
      OAUTH_KV:bindings.kv(),
      PUSHES:bindings.queue({name:`${name}-events`}),
      PUBLICATION_WORKFLOW:bindings.workflow({name:workflow,worker:name,exportName:'PublicationWorkflow'}),
      HOST_ORIGIN:bindings.text(process.env.TIMDS_HOST_ORIGIN || 'http://127.0.0.1:8787'),
      TIMDS_PUBLIC_ORIGIN:bindings.text(process.env.TIMDS_PUBLIC_ORIGIN || 'http://127.0.0.1:8788'),
      TIMDS_HOST_WORKER_NAME:bindings.text(name),
      ACCESS_TEAM_DOMAIN:bindings.text(process.env.TIMDS_ACCESS_TEAM_DOMAIN || ''),
      ACCESS_AUD:bindings.text(process.env.TIMDS_ACCESS_AUD || ''),
      CLOUDFLARE_ACCOUNT_ID:bindings.text(process.env.CLOUDFLARE_ACCOUNT_ID || ''),
      TIMDS_AGENT_PUSH_QUEUE_ID:bindings.text(process.env.TIMDS_AGENT_PUSH_QUEUE_ID || ''),
      TIMDS_DESIGNER_PRINCIPAL_ID:bindings.text(process.env.TIMDS_DESIGNER_PRINCIPAL_ID || ''),
      CLOUDFLARE_API_TOKEN:bindings.secret(),
      TIMDS_BUILDS_API_TOKEN:bindings.secret(),
      OPENAI_API_KEY:bindings.secret(),
      TIMDS_BOOTSTRAP_SECRET:bindings.secret(),
    },
    triggers:[triggers.queue({name:`${name}-events`,maxBatchSize:10,maxBatchTimeout:1})],
  },
  containers:[repository,live,build,dependencies],
});
