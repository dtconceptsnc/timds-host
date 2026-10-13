// Portable Workers Builds controller adapted from toperator 74bceaa.
// cf beta.14 commands/migration/delete route proved in docs/evidence/cf-preview-builds.md.
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
export function designSystemPreviewWorker(source) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source?.id || '')) throw fail(409, 'Design System identity is unavailable');
  return `timds-${source.id.replaceAll('-', '').toLowerCase()}`;
}
export function designSystemPreviewPath(manifest = {}) {
  const entry = manifest.artifact?.entry || manifest.viewer?.entry || manifest.artifactEntry || 'index.html';
  if (typeof entry !== 'string' || entry.length > 500 || /[\\\x00-\x1f\x7f?#%:]/.test(entry) || entry.split('/').some(part => !part || part === '.' || part === '..')) throw fail(400, 'Invalid Design System Preview entry');
  return `/${entry.split('/').map(encodeURIComponent).join('/')}`.replace(/\/index\.html$/, '/');
}
function previewBranch(source, branch) {
  if (!/^review-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch || '') || `${branch}-${designSystemPreviewWorker(source)}`.length > 63) throw fail(400, 'Invalid TimDS Preview branch');
  return branch;
}
/** One source-owned Worker and Artifacts Builds connection. The provider value
 * is verified against the live API, whose published enum still omits it.
 */
export function createPreviews({ env = {}, fetchImpl = fetch } = {}) {
  const account = env.TIMDS_ARTIFACTS_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const buildsToken = env.TIMDS_BUILDS_API_TOKEN;
  const workerToken = env.CLOUDFLARE_API_TOKEN || env.TIMDS_ARTIFACTS_API_TOKEN || buildsToken;
  const configured = Boolean(account && workerToken && buildsToken);
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account || '')}`;
  const marker = source => `timds-source:${source.id.toLowerCase()}`;
  let subdomain, deploymentTokenUuid;
  async function request(route, { method = 'GET', body, missing = false, builds = false, accountScoped = true } = {}) {
    if (!account || !(builds ? buildsToken : workerToken)) throw fail(503, 'Cloudflare Preview credentials are not configured');
    const headers = { Authorization:`Bearer ${builds ? buildsToken : workerToken}` };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await fetchImpl(`${accountScoped ? base : 'https://api.cloudflare.com/client/v4'}${route}`, { method, headers, body:body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(30_000),redirect:'error' }); }
    catch { throw fail(502, 'Cloudflare Preview request failed'); }
    if (missing && response.status === 404) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const codes = (payload.errors || []).map(x => Number(x.code)).filter(Number.isFinite);
      throw fail(502, `Cloudflare Preview request failed (HTTP ${response.status}${codes.length ? `; codes ${codes.join(',')}` : ''})`);
    }
    return payload.result ?? null;
  }
  async function registeredDeploymentToken() {
    if (deploymentTokenUuid) return deploymentTokenUuid;
    const verified = await request('/user/tokens/verify', { builds:true, accountScoped:false });
    if (!verified?.id || verified.status !== 'active') throw fail(503, 'The server Workers Builds credential is not active');
    const tokens = await request('/builds/tokens', { builds:true });
    const matches = Array.isArray(tokens) ? tokens.filter(token => token.cloudflare_token_id === verified.id) : [];
    if (matches.length !== 1 || !matches[0].build_token_uuid) throw fail(503, 'Register the server Workers Builds credential exactly once with Workers Builds');
    return deploymentTokenUuid = matches[0].build_token_uuid;
  }
  async function worker(source) {
    const name = designSystemPreviewWorker(source);
    const rows = await request('/workers/scripts');
    const found = (rows || []).find(row => row.id === name);
    if (found && (!found.tag || !found.tags?.includes(marker(source)))) throw fail(409, 'The Preview Worker ownership marker does not match this Design System');
    return found || null;
  }
  async function connection(source, found) {
    const config = await request(`/builds/workers/${encodeURIComponent(found.tag)}`, { builds:true, missing:true });
    if (!config) return null;
    const repo = config.git_repository;
    if (!repo || repo.provider_type !== 'cloudflare_artifacts' || repo.provider_account_id !== source.artifacts_namespace || repo.repo_name !== source.artifacts_repository || repo.provider_account_name !== source.artifacts_namespace || String(repo.repo_id) !== String(source.artifacts_repository_id)) throw fail(409, 'The Preview build connection does not match this Design System');
    return config;
  }
  async function deleteConnection(source, found) {
    const triggers = await request(`/builds/workers/${encodeURIComponent(found.tag)}/triggers`, { builds:true, missing:true }) || [];
    if (!Array.isArray(triggers)) throw fail(502, 'Cloudflare returned an invalid Preview trigger list');
    const connections = new Set();
    for (const trigger of triggers) {
      const repo = trigger.repo_connection;
      if (!repo?.repo_connection_uuid || repo.provider_type !== 'cloudflare_artifacts' || repo.provider_account_id !== source.artifacts_namespace || repo.repo_name !== source.artifacts_repository || repo.provider_account_name !== source.artifacts_namespace || String(repo.repo_id) !== String(source.artifacts_repository_id)) throw fail(409, 'The Preview repository connection does not match this Design System');
      connections.add(repo.repo_connection_uuid);
    }
    if (!connections.size) return;
    // A repository connection may be reused by another Worker. Check all
    // current scripts before removing this source's connection; tokens are shared.
    for (const other of await request('/workers/scripts')) {
      if (other.tag === found.tag) continue;
      if (!other.tag) throw fail(502, 'Cloudflare returned a Worker without an identity');
      const others = await request(`/builds/workers/${encodeURIComponent(other.tag)}/triggers`, { builds:true, missing:true }) || [];
      if (!Array.isArray(others)) throw fail(502, 'Cloudflare returned an invalid Preview trigger list');
      if (others.some(trigger => connections.has(trigger.repo_connection?.repo_connection_uuid))) throw fail(409, 'The Preview repository connection is used by another Worker');
    }
    // Remove the connection while triggers still identify it, so a failed
    // delete can be retried without losing the cleanup identity.
    for (const id of connections) await request(`/builds/repos/connections/${encodeURIComponent(id)}`, { method:'DELETE', builds:true, missing:true });
  }
  async function prepareSource(source) {
    if (!configured) throw fail(503, 'Cloudflare Preview setup requires the server Workers Builds credential');
    const name = designSystemPreviewWorker(source);
    if (![source.artifacts_namespace, source.artifacts_repository, source.artifacts_repository_id].every(value => typeof value === 'string' && value)) throw fail(409, 'Design System Artifacts identity is unavailable');
    let found = await worker(source);
    if (!found) {
      const body = new FormData();
      body.set('metadata', JSON.stringify({ main_module:'index.mjs', compatibility_date:'2026-10-12', tags:[marker(source)] }));
      body.set('index.mjs', new Blob(['export default { fetch() { return new Response("TimDS Preview is awaiting its first submission.", { status:503 }); } };'], { type:'application/javascript+module' }), 'index.mjs');
      await request(`/workers/scripts/${name}`, { method:'PUT', body });
      found = await worker(source);
      if (!found) throw fail(502, 'Cloudflare did not return the created Preview Worker');
    }
    let config = await connection(source, found);
    const buildTokenUuid = await registeredDeploymentToken();
    if (!config) {
      const settings = { build_caching_enabled:false, build_command:'npm run build:preview', build_token_uuid:buildTokenUuid, root_directory:'/', path_includes:['*'], path_excludes:[] };
      const body = {
        script_tag:found.tag,
        git_repository:{ provider_type:'cloudflare_artifacts', provider_account_id:source.artifacts_namespace, provider_account_name:source.artifacts_namespace, repo_id:source.artifacts_repository_id, repo_name:source.artifacts_repository, branch:'main' },
        production_settings:{ ...settings, deploy_command:'npx cf deploy' },
        previews_base_config:{ ...settings, deploy_command:'npx cf previews deploy' },
        previews_enabled:true,
      };
      try { await request('/builds/workers', { method:'POST', body, builds:true }); }
      catch (error) {
        // A lost response or competing setup may already have created it.
        // Read back the exact identity instead of repeating the create.
        config = await connection(source, found);
        if (!config) throw error;
      }
      config ||= await connection(source, found);
      if (!config) throw fail(502, 'Cloudflare did not return the created Preview build connection');
    }
    if (!config.previews_enabled) {
      // The live beta.14 API accepts enabled=true but creates a legacy trigger.
      // Migrate only this source-owned, exact Artifacts connection and verify it.
      const production=config.production_settings;
      if(config.git_repository.branch!=='main' || production?.build_command!=='npm run build:preview' || production.deploy_command!=='npx cf deploy' || production.build_token_uuid!==buildTokenUuid)throw fail(409,'The existing Preview connection requires explicit migration review');
      await request(`/builds/workers/${encodeURIComponent(found.tag)}/migrate_to_previews`, {method:'POST',body:{deploy_command:'npx cf previews deploy'},builds:true});
      config=await connection(source,found);
      if(!config)throw fail(502,'Cloudflare did not return the migrated Preview connection');
    }
    if (config.git_repository.branch !== 'main' || !config.previews_enabled || config.auto_build_enabled === false) throw fail(409, 'The Design System build connection must enable automatic builds and Previews from main');
    for (const [key, command] of [['production_settings', 'npx cf deploy'], ['previews_base_config', 'npx cf previews deploy']]) {
      const settings = config[key];
      if (settings?.build_command !== 'npm run build:preview' || settings.deploy_command !== command || settings.root_directory !== '/' || settings.build_token_uuid !== buildTokenUuid
        || !Array.isArray(settings.path_includes) || settings.path_includes.length !== 1 || settings.path_includes[0] !== '*'
        || !Array.isArray(settings.path_excludes) || settings.path_excludes.length) throw fail(409, 'The Design System build connection has incompatible build or deploy settings');
    }
    await request(`/workers/scripts/${name}/subdomain`, { method:'POST', body:{ enabled:true, previews_enabled:true } });
    return { workerName:name, workerTag:found.tag };
  }
  const adapter = {
    configured, prepareSource, ensureSource:prepareSource, ensurePreview:prepareSource, ensure:prepareSource,
    async previewUrl(source, branch) {
      previewBranch(source, branch);
      if (!subdomain) subdomain = (await request('/workers/subdomain'))?.subdomain;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain || '')) throw fail(502, 'Cloudflare workers.dev subdomain is unavailable');
      return `https://${branch}-${designSystemPreviewWorker(source)}.${subdomain}.workers.dev${designSystemPreviewPath(source.manifest_json)}`;
    },
    async deletePreview(source, branch) {
      previewBranch(source, branch);
      if (!await worker(source)) return;
      await request(`/workers/workers/${designSystemPreviewWorker(source)}/previews/${encodeURIComponent(branch)}`, {method:'DELETE',missing:true});
    },
    async readyPreview(source,branch) {
      previewBranch(source,branch);
      const found=await worker(source);
      if(!found || !await connection(source,found))throw fail(409,'The Preview Worker is not owned by this Design System');
      let matches=[];
      for(let page=1;page<=100;page++){
        const previews=await request(`/builds/workers/${encodeURIComponent(found.tag)}/previews?page=${page}&per_page=100`,{builds:true});
        if(!Array.isArray(previews))throw fail(502,'Cloudflare returned an invalid Preview list');
        matches.push(...previews.filter(row=>row.branch===branch));
        if(previews.length<100)break;
        if(page===100)throw fail(502,'Cloudflare Preview pagination limit reached');
      }
      if(matches.length!==1 || !/^[a-f0-9]{32}$/.test(matches[0].preview_id || ''))throw fail(503,'The exact Preview metadata is not ready');
      const url=await adapter.previewUrl(source,branch);
      let response;
      try{response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30_000)});}
      catch{throw fail(503,'The submitted Preview is not ready');}
      const ready=response.status===200 && /^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '');
      await response.body?.cancel();
      if(!ready)throw fail(503,'The submitted Preview is not ready');
      return {url,workerTag:found.tag,previewId:matches[0].preview_id};
    },
    async deleteSourcePreview(source) {
      const found = await worker(source);
      if (!found) return;
      await connection(source, found);
      await deleteConnection(source, found);
      await request(`/builds/workers/${encodeURIComponent(found.tag)}`, { method:'DELETE', builds:true, missing:true });
      await request(`/workers/scripts/${designSystemPreviewWorker(source)}`, { method:'DELETE', missing:true });
      // The shared Builds deployment token is operator-owned, never source-owned.
    },
  };
  adapter.url=adapter.previewUrl;adapter.remove=adapter.deletePreview;
  return adapter;
}
