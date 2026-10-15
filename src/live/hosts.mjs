// Owned workers.dev LivePreview bindings from the legacy portal.
import { sessionIdPattern } from '../../runtime/policy.mjs';
import { fail } from '../store/errors.mjs';
import { designSystemPreviewPath } from './preview-path.mjs';
export function liveWorkerName(id) {
  if (!sessionIdPattern.test(id || '')) throw fail(400, 'Invalid live session identity');
  return `live-${id.replaceAll('-', '').toLowerCase()}`;
}
/** Explicitly registers every workers.dev hostname; a hostname pattern alone does not route Workers. */
export function createLivePreviewHosts({ env = {}, fetchImpl = fetch } = {}) {
  const account = env.TIMDS_ARTIFACTS_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  // Reuse the registered Builds deployment credential for Workers Scripts Write.
  // Artifacts binding access does not require a developer OAuth API token.
  const token = env.TIMDS_BUILDS_API_TOKEN || env.CLOUDFLARE_API_TOKEN || env.TIMDS_ARTIFACTS_API_TOKEN;
  const service = env.TIMDS_HOST_WORKER_NAME;
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account || '')}`;
  let subdomain;
  async function call(route, method = 'GET', body, signal, absent = false) {
    if (!account || !token || !service) throw fail(503, 'Live Preview credentials are not configured');
    let response;
    try { response = await fetchImpl(`${base}${route}`, { method, headers:{Authorization:`Bearer ${token}`, ...(body && !(body instanceof FormData) ? {'Content-Type':'application/json'} : {})}, body:body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000) }); }
    catch { throw fail(502, 'Live Preview provisioning failed'); }
    if (response.status === 404 && (method === 'DELETE' || absent)) return null;
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value?.success === false) throw fail(502, `Live Preview provisioning failed (HTTP ${response.status})`);
    if (absent && (!value?.result || typeof value.result !== 'object' || Array.isArray(value.result))) throw fail(502, 'Invalid Live Preview ownership response');
    return value?.result;
  }
  const tags = (session, source) => [`timds-live:${session.id}`, `timds-source:${source.id}`];
  async function owned(session, source, signal) {
    // The script route downloads source; script-settings returns this Worker's
    // ownership tags without listing every script in the account.
    const row = await call(`/workers/scripts/${liveWorkerName(session.id)}/script-settings`,'GET',undefined,signal,true);
    if (row && (!Array.isArray(row.tags) || !tags(session, source).every(tag => row.tags.includes(tag)))) throw fail(409, 'Live Preview ownership does not match this session');
    return row;
  }
  return {
    async ensure(session, source, {signal,authorize = async()=>{},step = (_stage,run)=>run()} = {}) {
      const name = liveWorkerName(session.id);
      if (!await step('live-worker-get',()=>owned(session, source, signal))) {
        const body = new FormData();
        body.set('metadata', JSON.stringify({ main_module:'index.mjs', compatibility_date:'2026-10-12', tags:tags(session,source), bindings:[{type:'service', name:'LIVE', service, entrypoint:'LivePreview'}] }));
        body.set('index.mjs', new Blob([`export default { fetch(request, env) { const headers = new Headers(request.headers); headers.set('x-timds-live-session', ${JSON.stringify(session.id)}); return env.LIVE.fetch(new Request(request, {headers})); } };`], {type:'application/javascript+module'}), 'index.mjs');
        await step('live-worker-put',async()=>{await authorize();return call(`/workers/scripts/${name}`, 'PUT', body,signal);});
      }
      await step('live-subdomain',async()=>{await authorize();return call(`/workers/scripts/${name}/subdomain`, 'POST', {enabled:true, previews_enabled:false},signal);});
      if (!subdomain) subdomain = (await step('live-subdomain-lookup',()=>call('/workers/subdomain','GET',undefined,signal)))?.subdomain;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain || '')) throw fail(502, 'Live Preview hostname is unavailable');
      return `https://${name}.${subdomain}.workers.dev${designSystemPreviewPath(source.manifest_json)}`;
    },
    async close(session, source) { if (await owned(session,source)) await call(`/workers/scripts/${liveWorkerName(session.id)}`, 'DELETE'); },
  };
}
