import assert from 'node:assert/strict';
import test from 'node:test';
import { readLifecycleConfiguration, readAdminPages, assertNewLifecycleFixture, createLifecycleResources, createLifecycleClient } from '../lifecycle.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111', organizationId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333', actorPrincipalId = '44444444-4444-4444-8444-444444444444';
const deletionId = '55555555-5555-4555-8555-555555555555', sessionId = '66666666-6666-4666-8666-666666666666';
const systemId = 'timds-conformance/lifecycle', namespace = 'timds-example', repository = `timds-${sourceId.replaceAll('-', '')}`;
const configured = () => ({ TIMDS_HOST_URL: 'https://host.example.com', TIMDS_LIFECYCLE_SOURCE_ID: sourceId, TIMDS_LIFECYCLE_SYSTEM_ID: systemId, TIMDS_LIFECYCLE_ORGANIZATION_ID: organizationId, TIMDS_LIFECYCLE_NAMESPACE: namespace, TIMDS_ALLOW_LIFECYCLE_TEARDOWN: `${sourceId}:${systemId}`, TIMDS_ADMIN_ACCESS_TOKEN: 'test-only' });
const config = () => readLifecycleConfiguration(configured());
const proof = () => ({ apiVersion: 1, provision: { operationId, sourceId, actorPrincipalId, status: 'completed', fileTreeDigest: 'a'.repeat(64), grantPublisher: true }, source: { id: sourceId, systemId, organizationId, namespace, repository, repositoryId: 'fixture-repository', lifecycleStatus: 'ready' } });
const impact = () => ({ apiVersion: 1, operationId: deletionId, sourceId, status: 'awaiting_confirmation', phase: 'inspect', repository: { id: 'fixture-repository', namespace, name: repository }, impactHash: 'b'.repeat(64), counts: { sessions: 0, forks: 0, publishers: 1, requests: 0, mediaAssets: 0, mediaUploads: 0 }, retention: { immutableReleaseBytes: 'retained_inaccessible', mediaOriginals: 'removed_scoped', audit: 'retained' }, requiresConsumerProof: false, awaitingConsumerProof: false });
const resources = () => createLifecycleResources(config(), { operationId, actorPrincipalId });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-TimDS-API-Version': '1' } });
const input = () => ({ operationId, sourceId, systemId, organizationId, namespace, name: 'TimDS conformance lifecycle', starterVersion: 1 });

test('lifecycle configuration requires a separate exact destructive acknowledgement and new-fixture namespace', () => {
  assert.throws(() => readLifecycleConfiguration({}), /TIMDS_HOST_URL/);
  assert.equal(config().sourceId, sourceId);
  for (const [key, value] of [
    ['TIMDS_ALLOW_LIFECYCLE_TEARDOWN', 'true'], ['TIMDS_ALLOW_LIFECYCLE_TEARDOWN', `${sourceId}:other`],
    ['TIMDS_LIFECYCLE_SOURCE_ID', 'existing'], ['TIMDS_LIFECYCLE_SYSTEM_ID', 'customer/core'],
    ['TIMDS_LIFECYCLE_SYSTEM_ID', 'timds-conformance/../customer'], ['TIMDS_LIFECYCLE_ORGANIZATION_ID', 'organization'],
    ['TIMDS_LIFECYCLE_NAMESPACE', '../namespace'], ['TIMDS_ADMIN_ACCESS_TOKEN', ''],
    ['TIMDS_HOST_URL', 'http://host.example.com'], ['TIMDS_HOST_URL', 'https://user:pass@host.example.com'],
    ['TIMDS_HOST_URL', 'https://host.example.com/api'], ['TIMDS_CONFORMANCE_TIMEOUT_MS', 'Infinity'],
  ]) assert.throws(() => readLifecycleConfiguration({ ...configured(), [key]: value }));
  const ordinary = { TIMDS_HOST_URL: 'https://host.example.com', TIMDS_ACCESS_TOKEN: 'test-only', TIMDS_FIXTURE_SOURCE_ID: sourceId, TIMDS_FIXTURE_SYSTEM_ID: systemId, TIMDS_ALLOW_DISPOSABLE_WRITES: `${sourceId}:${systemId}` };
  assert.throws(() => readLifecycleConfiguration(ordinary), /TIMDS_LIFECYCLE_SOURCE_ID/);
  assert.equal(readLifecycleConfiguration({ ...configured(), TIMDS_HOST_URL: 'http://127.0.0.1:8787' }).url, 'http://127.0.0.1:8787');
});

test('administrator enumeration rejects bad cursors instead of overlooking later existing identities', async () => {
  const calls = [];
  const pages = await readAdminPages(async after => { calls.push(after); return after ? { systems: [{ id: sourceId }], namespaces: [namespace], nextSystemCursor: null } : { systems: [], namespaces: [namespace], nextSystemCursor: organizationId }; }, { collection: 'systems', cursor: 'nextSystemCursor' });
  assert.equal(pages.rows[0].id, sourceId); assert.deepEqual(calls, ['', organizationId]);
  await assert.rejects(readAdminPages(async () => ({ systems: [], nextSystemCursor: organizationId }), { collection: 'systems', cursor: 'nextSystemCursor' }), /cursor must advance/);
  await assert.rejects(readAdminPages(async () => ({ systems: [] }), { collection: 'systems', cursor: 'nextSystemCursor' }), /cursor must advance/);
});

test('write preflight refuses existing and retired source or system identities across every page', async () => {
  const client = {
    me: async () => ({ principal: { id: actorPrincipalId, admin: true } }),
    organizations: async () => ({ organizations: [{ id: organizationId }], nextOrganizationCursor: null }),
    systems: async () => ({ systems: [], namespaces: [namespace], nextSystemCursor: null }),
  };
  assert.equal(await assertNewLifecycleFixture(client, config()), actorPrincipalId);
  for (const existing of [{ id: sourceId, systemId: 'other', lifecycleStatus: 'deleted' }, { id: sessionId, systemId, lifecycleStatus: 'ready' }]) {
    await assert.rejects(assertNewLifecycleFixture({ ...client, systems: async after => after ? { systems: [existing], namespaces: [namespace], nextSystemCursor: null } : { systems: [], namespaces: [namespace], nextSystemCursor: organizationId } }, config()), /existing or retired/);
  }
  await assert.rejects(assertNewLifecycleFixture({ ...client, me: async () => ({ principal: { id: actorPrincipalId, admin: false } }) }, config()), /administrator/);
  await assert.rejects(assertNewLifecycleFixture({ ...client, organizations: async () => ({ organizations: [], nextOrganizationCursor: null }) }, config()), /organization/);
});

test('cleanup ownership requires this run operation, actor, fixture and exact provider identity', () => {
  const guard = resources();
  assert.throws(() => guard.reviewDeletion(impact(), deletionId), /provision ownership/);
  for (const mutate of [
    value => value.provision.operationId = deletionId, value => value.provision.actorPrincipalId = sessionId,
    value => value.provision.sourceId = sessionId, value => value.source.id = sessionId,
    value => value.source.systemId = 'other/core', value => value.source.organizationId = sessionId,
    value => value.source.namespace = 'other', value => value.source.repository = 'other',
    value => value.source.repositoryId = null, value => value.provision.fileTreeDigest = 'unknown',
  ]) { const value = proof(); mutate(value); assert.throws(() => guard.acceptProvision(value)); }
  const stored = guard.acceptProvision(proof());
  assert.throws(() => { stored.source.repositoryId = 'changed'; });
  const changed = proof(); changed.source.repositoryId = 'replaced';
  assert.throws(() => guard.acceptProvision(changed), /ownership changed/);
});

test('deletion only confirms the exact reviewed native receipt and rejects untracked work', () => {
  const guard = resources(); guard.acceptProvision(proof());
  for (const mutate of [
    value => value.sourceId = sessionId, value => value.operationId = operationId,
    value => value.repository.id = 'replacement', value => value.repository.name = 'other',
    value => value.requiresConsumerProof = true, value => value.status = 'running',
    value => value.impactHash = 'invalid', value => value.counts.sessions = 1,
    value => value.counts.forks = 1, value => value.counts.publishers = 2,
    value => value.counts.requests = 1, value => value.counts.mediaAssets = 1,
  ]) { const value = impact(); mutate(value); assert.throws(() => guard.reviewDeletion(value, deletionId)); }
  guard.trackSession({ session: { id: sessionId, sourceId, systemId } });
  const value = impact(); value.counts.sessions = 1; value.counts.forks = 1;
  const review = guard.reviewDeletion(value, deletionId);
  assert.deepEqual(guard.confirmation(review), { impactHash: value.impactHash, typedRepository: repository });
  assert.throws(() => guard.confirmation({ ...review }), /reviewed receipt/);
  assert.throws(() => { review.typedRepository = 'other'; });
  assert.throws(() => resources().confirmation(review), /reviewed receipt/);
});

test('lifecycle transport validates nested contract, keeps credentials at the host and redacts provider errors', async () => {
  const calls = [];
  const client = createLifecycleClient(config(), { fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ apiVersion: 1, source: { id: sourceId, system_id: systemId, organization_id: organizationId, lifecycle_status: 'ready', artifacts_namespace: namespace, artifacts_repository: repository, artifacts_repository_id: 'fixture-repository' } }); } });
  await client.create(input());
  assert.equal(calls[0].url, 'https://host.example.com/api/timds/admin/systems/create');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only'); assert.equal(calls[0].init.headers['X-TimDS-API-Version'], '1');
  assert.equal(calls[0].init.redirect, 'error'); assert.ok(calls[0].init.signal);
  assert.equal(JSON.parse(calls[0].init.body).sourceId, sourceId);
  assert.throws(() => client.create({ ...input(), sourceId: sessionId }));
  const malformed = createLifecycleClient(config(), { fetchImpl: async () => json({ apiVersion: 1, source: { id: 'not-a-uuid' } }) });
  await assert.rejects(malformed.create(input()), /required property|format/);
  const failure = createLifecycleClient(config(), { fetchImpl: async () => json({ apiVersion: 1, error: 'untrusted provider content' }, 503) });
  await assert.rejects(failure.create(input()), error => error.status === 503 && !error.message.includes('untrusted'));
});

test('confirmation transport uses reviewed hash/name and anonymous retired CSS sends no credential', async () => {
  const calls = [], guard = resources(); guard.acceptProvision(proof());
  const review = guard.reviewDeletion(impact(), deletionId);
  const client = createLifecycleClient(config(), { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('tokens.css')) return json({ apiVersion: 1, error: 'Not found' }, 404);
    const body = JSON.parse(init.body);
    return body.typedRepository.endsWith('-mismatch') ? json({ apiVersion: 1, error: 'Type the reviewed repository' }, 409) : json({ ...impact(), status: 'queued', phase: 'stop_work' }, 202);
  } });
  await client.confirmDeletion(review, guard);
  assert.deepEqual(JSON.parse(calls[0].init.body), { impactHash: impact().impactHash, typedRepository: repository, apiVersion: 1 });
  await client.confirmDeletion(review, guard, { mismatchedName: true });
  assert.equal(guard.confirmation(review).typedRepository, repository, 'mismatch probe cannot change the reviewed input');
  await client.retiredDraftCss(sessionId);
  assert.deepEqual(calls.at(-1).init.headers, {});
  assert.throws(() => client.confirmDeletion({ ...review }, guard));
});
