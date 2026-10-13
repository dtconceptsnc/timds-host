import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviews, designSystemPreviewWorker, designSystemPreviewPath, STATIC_PREVIEW_DEPLOY_COMMAND, STATIC_CHECKED_PREVIEW_BUILD_COMMAND } from '../../src/preview/index.mjs';

const source = { id:'11111111-2222-4333-8444-555555555555', artifacts_namespace:'timds-org', artifacts_repository:'source', artifacts_repository_id:'repo-id' };
const name = designSystemPreviewWorker(source);
const env = { CLOUDFLARE_ACCOUNT_ID:'account', CLOUDFLARE_API_TOKEN:'account-secret', TIMDS_BUILDS_API_TOKEN:'builds-secret' };

function fixture({ existing = false, connected = false, owned = true, shared = false, connectionRepo = source.artifacts_repository_id, failConnectionDelete = false, lostCreateResponse = false, failCreate = false, tokenStatus = 'active', registrations = [{ cloudflare_token_id:'server-token', build_token_uuid:'registered-token' }] } = {}) {
  const calls = [], commands = [];
  let found = existing ? { id:name, tag:'worker-tag', tags:owned ? [`timds-source:${source.id}`] : [] } : null;
  const gitRepository = { provider_type:'cloudflare_artifacts', branch:'main', repo_name:source.artifacts_repository, repo_id:source.artifacts_repository_id, provider_account_id:source.artifacts_namespace, provider_account_name:source.artifacts_namespace };
  const buildSettings = { build_command:'npm run build:preview', root_directory:'/', build_token_uuid:'registered-token', path_includes:['*'], path_excludes:[] };
  const defaultConfig = { git_repository:gitRepository, previews_enabled:true, auto_build_enabled:true,
    production_settings:{ ...buildSettings, deploy_command:'npx cf deploy' }, previews_base_config:{ ...buildSettings, deploy_command:'npx cf previews deploy' } };
  let config = connected ? structuredClone(defaultConfig) : null;
  let repoConnection = connected ? { ...gitRepository, repo_connection_uuid:'connection-id', repo_id:connectionRepo } : null;
  const adapter = createPreviews({ env, fetchImpl:async (url, options) => {
    const route = new URL(url).pathname.replace(/^\/client\/v4(?:\/accounts\/account)?/, '');
    calls.push({ route, ...options });
    let result = null;
    if (route === '/workers/scripts') result = [...found ? [found] : [], ...shared ? [{ id:'other-worker', tag:'other-tag' }] : []];
    else if (route === `/workers/scripts/${name}` && options.method === 'PUT') {
      assert(options.body instanceof FormData);
      const metadata = JSON.parse(options.body.get('metadata'));
      assert.deepEqual(metadata.tags, [`timds-source:${source.id}`]);
      found = { id:name, tag:'worker-tag', tags:metadata.tags }; result = found;
    } else if (route === `/workers/scripts/${name}` && options.method === 'DELETE') found = null;
    else if (route === '/user/tokens/verify') {
      assert.equal(options.headers.Authorization, 'Bearer builds-secret');
      result = { id:'server-token', status:tokenStatus };
    } else if (route === '/builds/tokens') result = registrations;
    else if (route === '/builds/workers' && options.method === 'POST') {
      assert.equal(options.headers.Authorization, 'Bearer builds-secret');
      if (failCreate) { failCreate = false; return Response.json({ success:false }, { status:503 }); }
      const body = JSON.parse(options.body);
      assert.equal(body.script_tag, found.tag);
      config = { ...body, auto_build_enabled:true };
      repoConnection = { ...body.git_repository, repo_connection_uuid:'connection-id' };
      if (lostCreateResponse) { lostCreateResponse = false; throw new Error('response lost'); }
      result = config;
    }
    else if (route === '/builds/workers/worker-tag') {
      assert.equal(options.headers.Authorization, 'Bearer builds-secret');
      if (!config) return new Response('{}', { status:404 });
      if (options.method === 'DELETE') config = null;
      else result = config;
    } else if (route === '/builds/workers/worker-tag/triggers' || route === '/builds/workers/other-tag/triggers') result = repoConnection ? [{ repo_connection:repoConnection }] : [];
    else if (route === '/builds/repos/connections/connection-id' && options.method === 'DELETE') {
      if (failConnectionDelete) { failConnectionDelete = false; return Response.json({ success:false }, { status:503 }); }
      repoConnection = null; config = null;
    } else if (route === '/builds/workers/worker-tag/migrate_to_previews') { assert.equal(JSON.parse(options.body).deploy_command,'npx cf previews deploy');config.previews_enabled=true;result=config; }
    else if (route === `/workers/workers/${name}/previews/review-abc123` && options.method==='DELETE')result={};
    else if (route === '/workers/subdomain') result = { subdomain:'studio' };
    else if (route === `/workers/scripts/${name}/subdomain`) result = options.body;
    else throw new Error(`Unexpected route ${route}`);
    return Response.json({ success:true, result });
  } });
  return { adapter, calls, commands, setConfig:value => { config = value; }, defaultConfig };
}

test('provisions a complete owned Artifacts Builds connection once without dashboard setup', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.prepareSource(source), { workerName:name, workerTag:'worker-tag' });
  await f.adapter.prepareSource(source);
  await f.adapter.ensureSource(source);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  const creates = f.calls.filter(c => c.route === '/builds/workers' && c.method === 'POST');
  assert.equal(creates.length, 1);
  const body = JSON.parse(creates[0].body);
  assert.deepEqual(body.git_repository, f.defaultConfig.git_repository);
  assert.equal(body.previews_enabled, true);
  assert.equal(body.production_settings.build_token_uuid, 'registered-token');
  assert.equal(body.previews_base_config.build_token_uuid, 'registered-token');
  assert.equal(body.production_settings.build_command, 'npm run build:preview');
  assert.equal(body.production_settings.deploy_command, 'npx cf deploy');
  assert.equal(body.previews_base_config.deploy_command, 'npx cf previews deploy');
  assert.deepEqual(body.production_settings.path_includes, ['*']);
  assert.equal(f.calls.filter(c => c.route === '/user/tokens/verify').length, 1);
});

test('unknown connection-create outcome is recovered by readback without a duplicate POST', async () => {
  const f = fixture({ lostCreateResponse:true });
  await f.adapter.prepareSource(source);
  await f.adapter.prepareSource(source);
  assert.equal(f.calls.filter(c => c.route === '/builds/workers' && c.method === 'POST').length, 1);
});

test('failed connection setup remains retryable on the same owned Worker', async () => {
  const f = fixture({ failCreate:true });
  await assert.rejects(f.adapter.prepareSource(source), error => error.requestDiagnostic?.providerStatus === 503);
  await f.adapter.prepareSource(source);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(f.calls.filter(c => c.route === '/builds/workers' && c.method === 'POST').length, 2);
});

test('deployment credential must be active and registered exactly once for that token ID', async () => {
  for (const options of [{ tokenStatus:'expired' }, { registrations:[] }, { registrations:[{ cloudflare_token_id:'other-token', build_token_uuid:'foreign' }] }, { registrations:[{ cloudflare_token_id:'server-token', build_token_uuid:'one' }, { cloudflare_token_id:'server-token', build_token_uuid:'two' }] }]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.prepareSource(source), /credential/);
    assert.equal(f.calls.some(c => c.route === '/builds/workers' && c.method === 'POST'), false);
  }
});

test('existing connections cannot adopt another provider or namespace and must support automatic previews', async () => {
  for (const change of [
    config => { config.git_repository.provider_type = 'github'; },
    config => { config.git_repository.provider_account_id = 'another-namespace'; },
    config => { config.git_repository.branch = 'other'; },
    config => { config.auto_build_enabled = false; },
    config => { config.previews_base_config.deploy_command = 'npx cf deploy'; },
    config => { config.previews_base_config.deploy_command = 'npx cf previews deploy --prebuilt'; },
    config => { config.production_settings.deploy_command = STATIC_PREVIEW_DEPLOY_COMMAND; },
    config => { config.production_settings.build_token_uuid = 'another-registration'; },
    config => { config.previews_base_config.build_token_uuid = 'another-registration'; },
    config => { config.previews_base_config.path_excludes = ['*']; },
    config => { config.production_settings.path_includes = ['src/*']; },
  ]) {
    const f = fixture({ existing:true, connected:true });
    const config = structuredClone(f.defaultConfig); change(config); f.setConfig(config);
    await assert.rejects(f.adapter.prepareSource(source), /does not match|must enable|incompatible/);
    await assert.rejects(f.adapter.prepareSource(source), /does not match|must enable|incompatible/, 'retry must not accept the incompatible configuration');
    assert.equal(f.calls.some(c => c.method !== 'GET'), false);
  }
});

test('reviewed static preview packaging is preserved while the full source check remains required',async()=>{
  const f=fixture({existing:true,connected:true}),config=structuredClone(f.defaultConfig);
  config.previews_base_config.deploy_command=STATIC_PREVIEW_DEPLOY_COMMAND;f.setConfig(config);
  await f.adapter.prepareSource(source);
  assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
  config.previews_base_config.build_command='npm run timds -- check --skip-build';f.setConfig(config);
  await assert.rejects(f.adapter.prepareSource(source),/incompatible/);
});

test('reviewed build containing the workspace check requires static Preview packaging',async()=>{
  const f=fixture({existing:true,connected:true}),config=structuredClone(f.defaultConfig);
  config.previews_base_config.build_command=STATIC_CHECKED_PREVIEW_BUILD_COMMAND;f.setConfig(config);
  await assert.rejects(f.adapter.prepareSource(source),/incompatible/);
  config.previews_base_config.deploy_command=STATIC_PREVIEW_DEPLOY_COMMAND;f.setConfig(config);
  await f.adapter.prepareSource(source);
  config.production_settings.build_command=STATIC_CHECKED_PREVIEW_BUILD_COMMAND;f.setConfig(config);
  await assert.rejects(f.adapter.prepareSource(source),/incompatible/);
});

test('connected source gets bounded workers.dev URLs and scoped Preview cleanup', async () => {
  const f = fixture({ existing:true, connected:true });
  assert.deepEqual(await f.adapter.ensureSource(source), { workerName:name, workerTag:'worker-tag' });
  assert.equal(await f.adapter.previewUrl(source, 'review-abc123'), `https://review-abc123-${name}.studio.workers.dev/`);
  assert.equal(await f.adapter.previewUrl({ ...source, manifest_json:{ artifact:{ entry:'design-system/index.html' } } }, 'review-abc123'), `https://review-abc123-${name}.studio.workers.dev/design-system/`);
  await f.adapter.deletePreview(source, 'review-abc123');
  assert.equal(f.calls.filter(row=>row.method==='DELETE')[0].route,`/workers/workers/${name}/previews/review-abc123`);
  await assert.rejects(f.adapter.deletePreview(source, 'main'), /Invalid TimDS Preview/);
  await assert.rejects(f.adapter.previewUrl(source, `review-${'a'.repeat(40)}`), /Invalid TimDS Preview/);
});

test('deletion verifies source identity, removes Builds before Worker, and is retry safe', async () => {
  const f = fixture({ existing:true, connected:true });
  await f.adapter.deleteSourcePreview(source);
  await f.adapter.deleteSourcePreview(source);
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.route), ['/builds/repos/connections/connection-id', '/builds/workers/worker-tag', `/workers/scripts/${name}`]);
  const other = fixture({ existing:true, connected:true });
  await assert.rejects(other.adapter.deleteSourcePreview({ ...source, artifacts_repository:'other' }), /does not match/);
  assert.equal(other.calls.some(c => c.method === 'DELETE'), false);
  const unowned = fixture({ existing:true, owned:false });
  await assert.rejects(unowned.adapter.ensureSource(source), /ownership marker/);
  await assert.rejects(unowned.adapter.deleteSourcePreview(source), /ownership marker/);
});

test('connection cleanup refuses another repository or a connection used by another Worker', async () => {
  for (const options of [{ shared:true }, { connectionRepo:'another-repository' }]) {
    const f = fixture({ existing:true, connected:true, ...options });
    await assert.rejects(f.adapter.deleteSourcePreview(source), /another Worker|does not match/);
    assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
  }
});

test('failed connection cleanup preserves discoverable triggers and succeeds on retry without deleting tokens', async () => {
  const f = fixture({ existing:true, connected:true, failConnectionDelete:true });
  await assert.rejects(f.adapter.deleteSourcePreview(source), error => error.requestDiagnostic?.providerStatus === 503);
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.route), ['/builds/repos/connections/connection-id']);
  await f.adapter.deleteSourcePreview(source);
  assert.equal(f.calls.some(c => c.route.includes('/tokens')), false);
});

test('Preview entries support starter and nested artifacts while rejecting escaped URL paths', () => {
  assert.equal(designSystemPreviewPath({}), '/');
  assert.equal(designSystemPreviewPath({ artifact:{ entry:'design-system/index.html' } }), '/design-system/');
  assert.equal(designSystemPreviewPath({ artifact:{ entry:'preview/example.html' } }), '/preview/example.html');
  for (const entry of ['/index.html', '../index.html', 'https://example.com', 'a/%2e%2e/index.html', 'index.html?q=x']) assert.throws(() => designSystemPreviewPath({ artifact:{ entry } }), /Invalid/);
});

test('unconfigured credentials prevent mutation and provider error messages cannot expose secrets', async () => {
  const empty = createPreviews({ env:{}, fetchImpl:async () => { throw new Error('must not fetch'); } });
  await assert.rejects(empty.ensureSource(source), /requires the server Workers Builds credential/);
  const bad = createPreviews({ env, fetchImpl:async () => Response.json({ success:false, errors:[{ code:10000, message:'account-secret builds-secret' }] }, { status:403 }) });
  await assert.rejects(bad.ensureSource(source), error => error.requestDiagnostic?.providerCodes?.includes(10000) && !error.message.includes('secret'));
});

test('owned exact-source legacy trigger is migrated and read back before readiness',async()=>{const f=fixture({existing:true,connected:true}),config=structuredClone(f.defaultConfig);config.previews_enabled=false;f.setConfig(config);await f.adapter.ensure(source);assert.equal(f.calls.filter(row=>row.route.endsWith('/migrate_to_previews') && row.method==='POST').length,1);await f.adapter.ensure(source);assert.equal(f.calls.filter(row=>row.route.endsWith('/migrate_to_previews') && row.method==='POST').length,1);});
