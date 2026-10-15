// Ownership-checked Artifacts subscriptions from the legacy portal.
import { sessionIdPattern } from '../../runtime/policy.mjs';
import { fail } from '../store/errors.mjs';
export function createAgentForkSubscriptions({ env = {}, fetchImpl = fetch } = {}) {
  const account = env.TIMDS_ARTIFACTS_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  // Reuse the registered Builds deployment credential for Workers Scripts Write.
  // Artifacts binding access does not require a developer OAuth API token.
  const token = env.TIMDS_BUILDS_API_TOKEN || env.CLOUDFLARE_API_TOKEN || env.TIMDS_ARTIFACTS_API_TOKEN;
  const queue = env.TIMDS_AGENT_PUSH_QUEUE_ID;
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account || '')}/event_subscriptions/subscriptions`;
  async function request(suffix, method = 'GET', body, signal) {
    if (!account || !token || !queue) throw fail(503, 'Configure the TimDS agent push queue before running designer Requests');
    let response;
    try { response = await fetchImpl(`${base}${suffix}`, { method, headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body:body === undefined ? undefined : JSON.stringify(body), signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000) }); }
    catch { throw fail(502, 'Agent fork subscription request failed'); }
    if (method === 'DELETE' && response.status === 404) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) throw fail(502, `Agent fork subscription failed (HTTP ${response.status})`);
    return payload.result;
  }
  const identity = (session, source) => {
    if (!sessionIdPattern.test(session.id || '') || session.fork_repository !== `session-${session.id}` || !/^[a-zA-Z0-9._-]+$/.test(source.artifacts_namespace || '')) throw fail(409, 'Invalid agent fork identity');
    return { name:`timds-agent-${session.id}`, source:{ type:'artifacts.repo', namespace:source.artifacts_namespace, repo_name:session.fork_repository } };
  };
  async function matching(session, source, signal) {
    const expected = identity(session, source), found = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await request(`?per_page=100&page=${page}`,'GET',undefined,signal);
      if (!Array.isArray(rows)) throw fail(502, 'Invalid agent subscription list');
      for (const row of rows.filter(item => item.name === expected.name)) {
        if (row.source?.type !== expected.source.type || row.source?.namespace !== expected.source.namespace || row.source?.repo_name !== expected.source.repo_name || row.destination?.queue_id !== queue || row.enabled !== true || row.events?.length !== 1 || row.events[0] !== 'pushed') throw fail(409, 'Agent fork subscription identity mismatch');
        found.push(row);
      }
      if (rows.length < 100) return found;
    }
    throw fail(502, 'Agent subscription pagination limit reached');
  }
  return {
    async ensure(session, source, {signal,authorize = async()=>{},step = (_stage,run)=>run()} = {}) {
      return step('live-subscription',async()=>{
        const rows = await matching(session, source, signal);
        if (rows.length) return rows[0];
        const expected = identity(session, source);
        // Subscription filters are source-relative; delivered event types are fully qualified.
        await authorize();return request('', 'POST', { ...expected, enabled:true, events:['pushed'], destination:{ type:'queues.queue', queue_id:queue } },signal);
      });
    },
    async close(session, source) {
      for (const row of await matching(session, source)) await request(`/${encodeURIComponent(row.id)}`, 'DELETE');
    },
  };
}

