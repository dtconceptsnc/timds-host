import assert from 'node:assert/strict';
import { createContractValidator } from './contract.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const repositoryName = sourceId => `timds-${sourceId.replaceAll('-', '')}`;
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

/** Separate acknowledgements prevent an ordinary host run selecting a teardown target. */
export function readLifecycleConfiguration(env = process.env) {
  const required = name => { if (!env[name]?.trim()) throw new Error(`${name} is required; see README.md`); return env[name].trim(); };
  const url = new URL(required('TIMDS_HOST_URL'));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('TIMDS_HOST_URL must be an origin without credentials or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('The host must use HTTPS, except a localhost development host');
  const sourceId = required('TIMDS_LIFECYCLE_SOURCE_ID'), systemId = required('TIMDS_LIFECYCLE_SYSTEM_ID');
  if (!uuid(sourceId)) throw new Error('TIMDS_LIFECYCLE_SOURCE_ID must be a new lowercase UUID');
  if (systemId.length > 300 || !/^timds-conformance\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(systemId)) throw new Error('TIMDS_LIFECYCLE_SYSTEM_ID must be a new timds-conformance/... identity');
  if (required('TIMDS_ALLOW_LIFECYCLE_TEARDOWN') !== `${sourceId}:${systemId}`) throw new Error('Lifecycle acknowledgement must exactly match the new source and system');
  const organizationId = required('TIMDS_LIFECYCLE_ORGANIZATION_ID'), namespace = required('TIMDS_LIFECYCLE_NAMESPACE');
  if (!uuid(organizationId)) throw new Error('TIMDS_LIFECYCLE_ORGANIZATION_ID must be a lowercase UUID');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) throw new Error('TIMDS_LIFECYCLE_NAMESPACE must be an explicitly deployed namespace');
  const token = required('TIMDS_ADMIN_ACCESS_TOKEN');
  const timeoutMs = Number(env.TIMDS_CONFORMANCE_TIMEOUT_MS || 900_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) throw new Error('TIMDS_CONFORMANCE_TIMEOUT_MS must be 10000–3600000');
  return { url: url.origin, sourceId, systemId, organizationId, namespace, token, timeoutMs };
}

/** Walk every admin page, including tombstones; an ordinary catalogue is insufficient. */
export async function readAdminPages(read, { collection, cursor }) {
  const rows = [], seen = new Set(); let after = '', namespaces = null;
  for (let page = 0; page < 10_000; page++) {
    const value = await read(after);
    assert.ok(Array.isArray(value?.[collection]), 'administrator collection must be an array');
    rows.push(...value[collection]);
    if (value.namespaces) {
      if (namespaces === null) namespaces = value.namespaces;
      else assert.deepEqual(value.namespaces, namespaces, 'namespace configuration changed during enumeration');
    }
    const next = value[cursor];
    if (next === null) return { rows, namespaces };
    assert.ok(uuid(next) && next > after && !seen.has(next), 'administrator cursor must advance');
    seen.add(next); after = next;
  }
  throw new Error('Administrator enumeration exceeded its safe bound');
}

export async function assertNewLifecycleFixture(client, config) {
  const { principal } = await client.me();
  assert.ok(uuid(principal?.id) && principal.admin === true, 'an active host administrator is required');
  const organizations = await readAdminPages(client.organizations, { collection: 'organizations', cursor: 'nextOrganizationCursor' });
  assert.ok(organizations.rows.some(row => row.id === config.organizationId), 'the explicit organization must already be active');
  const systems = await readAdminPages(client.systems, { collection: 'systems', cursor: 'nextSystemCursor' });
  assert.ok(systems.namespaces?.includes(config.namespace), 'the explicit namespace must already be deployed');
  assert.ok(!systems.rows.some(row => row.id === config.sourceId || row.systemId === config.systemId), 'refusing an existing or retired source or system identity');
  return principal.id;
}

/** The cleanup guard only admits this run's independently reread provision receipt. */
export function createLifecycleResources(config, { operationId, actorPrincipalId }) {
  assert.ok(uuid(operationId) && uuid(actorPrincipalId), 'creation operation and actor must be UUIDs');
  const sessions = new Set(), reviews = new WeakSet(); let provision = null;
  return {
    sessions,
    get provision() { return provision; },
    acceptProvision(value) {
      const row = value?.source, receipt = value?.provision;
      assert.equal(receipt?.operationId, operationId, 'provision operation must belong to this run');
      assert.equal(receipt.sourceId, config.sourceId); assert.equal(receipt.actorPrincipalId, actorPrincipalId);
      assert.equal(row?.id, config.sourceId); assert.equal(row.systemId, config.systemId);
      assert.equal(row.organizationId, config.organizationId); assert.equal(row.namespace, config.namespace);
      assert.equal(row.repository, repositoryName(config.sourceId));
      assert.ok(typeof row.repositoryId === 'string' && row.repositoryId, 'an exact provider repository identity is required for teardown');
      assert.equal(receipt.grantPublisher, true); assert.match(receipt.fileTreeDigest, /^[a-f0-9]{64}$/);
      if (provision) assert.deepEqual([row.repositoryId, receipt.fileTreeDigest], [provision.source.repositoryId, provision.provision.fileTreeDigest], 'creation ownership changed');
      provision = freeze(structuredClone(value)); return provision;
    },
    trackSession(value) {
      const row = value?.session;
      assert.ok(provision, 'verify provision ownership before starting work');
      assert.ok(uuid(row?.id)); assert.equal(row.sourceId, config.sourceId); assert.equal(row.systemId, config.systemId);
      sessions.add(row.id); return value;
    },
    reviewDeletion(value, deletionId) {
      assert.ok(provision, 'verify provision ownership before reviewing deletion');
      assert.ok(uuid(deletionId)); assert.equal(value?.operationId, deletionId); assert.equal(value.sourceId, config.sourceId);
      assert.equal(value.status, 'awaiting_confirmation');
      assert.deepEqual(value.repository, { id: provision.source.repositoryId, namespace: config.namespace, name: repositoryName(config.sourceId) });
      assert.equal(value.requiresConsumerProof, false, 'only this run\'s native source can be deleted');
      assert.equal(value.awaitingConsumerProof, false); assert.match(value.impactHash, /^[a-f0-9]{64}$/);
      for (const field of ['sessions', 'forks', 'publishers', 'requests', 'mediaAssets', 'mediaUploads']) assert.ok(Number.isSafeInteger(value.counts?.[field]) && value.counts[field] >= 0, `deletion ${field} count must be bounded`);
      assert.ok(value.counts.sessions <= sessions.size && value.counts.forks <= sessions.size, 'untracked session work prevents teardown');
      assert.ok(value.counts.publishers <= 1, 'unexpected publisher grants prevent teardown');
      assert.equal(value.counts.requests, 0); assert.equal(value.counts.mediaAssets, 0); assert.equal(value.counts.mediaUploads, 0);
      assert.deepEqual(value.retention, { immutableReleaseBytes: 'retained_inaccessible', mediaOriginals: 'removed_scoped', audit: 'retained' });
      const review = Object.freeze({ operationId: deletionId, sourceId: config.sourceId, impactHash: value.impactHash, typedRepository: value.repository.name });
      reviews.add(review); return review;
    },
    confirmation(review) {
      assert.ok(reviews.has(review), 'confirmation requires a reviewed receipt from this run');
      return { impactHash: review.impactHash, typedRepository: review.typedRepository };
    },
  };
}

/** Administrative methods missing from the pinned toolkit still use the v1 validator. */
export function createLifecycleClient(config, { fetchImpl = fetch, onResponse = () => {}, validate = createContractValidator() } = {}) {
  const origin = new URL(config.url).origin, source = `/api/timds/admin/systems/${encodeURIComponent(config.sourceId)}`;
  const request = async (method, path, body, expected = [200], publicRead = false) => {
    const url = new URL(path, origin); assert.equal(url.origin, origin, 'credentials must stay on the configured host');
    const init = { method, redirect: 'error', signal: AbortSignal.timeout(Math.min(config.timeoutMs, 120_000)), headers: publicRead ? {} : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-TimDS-API-Version': '1', Authorization: `Bearer ${config.token}` }, ...(body ? { body: JSON.stringify({ ...body, apiVersion: 1 }) } : {}) };
    const response = await fetchImpl(url.href, init);
    const operationId = await validate(url.href, init, response);
    await onResponse({ operationId, status: response.status });
    if (!expected.includes(response.status)) throw Object.assign(new Error(`Lifecycle request returned HTTP ${response.status}`), { status: response.status });
    return publicRead ? response : response.json();
  };
  const segment = value => { assert.ok(uuid(value), 'operation ID must be a UUID'); return encodeURIComponent(value); };
  return {
    me: () => request('GET', '/api/timds/me'),
    organizations: after => request('GET', `/api/timds/admin/organizations${after ? `?after=${segment(after)}` : ''}`),
    systems: after => request('GET', `/api/timds/admin/systems${after ? `?after=${segment(after)}` : ''}`),
    catalogue: () => request('GET', '/api/timds/design-systems'),
    create: (input, expected = [200]) => {
      assert.equal(input.sourceId, config.sourceId); assert.equal(input.systemId, config.systemId);
      assert.equal(input.organizationId, config.organizationId); assert.equal(input.namespace, config.namespace);
      return request('POST', '/api/timds/admin/systems/create', input, expected);
    },
    provision: operationId => request('GET', `${source}/provision/${segment(operationId)}`),
    prepareDeletion: operationId => request('POST', `${source}/deletion`, { operationId: segment(operationId) }),
    deletion: operationId => request('GET', `${source}/deletion/${segment(operationId)}`),
    confirmDeletion: (review, resources, { mismatchedName = false } = {}) => {
      assert.equal(review.sourceId, config.sourceId);
      const body = resources.confirmation(review);
      if (mismatchedName) body.typedRepository += '-mismatch';
      return request('POST', `${source}/deletion/${segment(review.operationId)}/confirm`, body, mismatchedName ? [409] : [202]);
    },
    deletionHistory: operationId => request('GET', `${source}/deletion/${segment(operationId)}/history`),
    retiredDraftCss: sessionId => request('GET', `/api/public/design-system-previews/${encodeURIComponent(config.sourceId)}/${segment(sessionId)}/tokens.css`, undefined, [404, 410], true),
  };
}
