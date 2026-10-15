import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createContractValidator } from '../contract.mjs';
import { createConformanceClient } from '../client.mjs';
import { readConfiguration } from '../config.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const session = { id: sessionId, sourceId, systemId: 'timds/conformance', baseRevision: 'a'.repeat(40), kind: 'session', status: 'open', expiresAt: '2026-10-14T12:00:00Z' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const result = () => ({ apiVersion: 1, session: structuredClone(session) });

test('Ajv validates nested OpenAPI refs, formats, conflicts, API versions and forward fields', async () => {
  const validate = createContractValidator();
  const url = `https://host.example/api/timds/sessions/${sessionId}`;
  assert.equal(await validate(url, {}, json({ ...result(), futureField: true })), 'snapshotSession');
  await assert.rejects(validate(url, {}, json({ ...result(), apiVersion: 2 })), /apiVersion/);
  await assert.rejects(validate(url, {}, json({ ...result(), session: { ...session, sourceId: 'broken' } })), /sourceId/);
  await assert.rejects(validate(url, {}, json({ ...result(), conflicts: [{ path: 'tokens/color.json' }] })), /required property/);
  await assert.rejects(validate(url, {}, json({ ...result(), files: [{ path: 'readme', encoding: 'utf8', content: '' }] })), /encoding/);
  await assert.rejects(validate(url, {}, json(result(), 201)), /undocumented response status/);
  assert.equal(await validate(url, {}, json({ error: 'not found' }, 404)), 'snapshotSession');
  await assert.rejects(validate(url, {}, json({ message: 'not found' }, 404)), /required property/);
});

test('start telemetry is optional while present headers and mandatory cache policy are validated', async () => {
  const validate = createContractValidator();
  const timing = 'reserve;dur=3, fork;dur=0, live;dur=0, claim;dur=1, stream;dur=8';
  for (const [path, operation, kind] of [
    ['/api/timds/sessions', 'startSession', 'session'],
    [`/api/timds/design-systems/${sourceId}/drafts`, 'createDraft', 'draft'],
  ]) {
    const url = `https://host.example${path}`, init = { method: 'POST' };
    const response = () => json({ ...result(), session: { ...session, status: 'starting', kind, liveUrl: '', ...(kind === 'draft' ? { name: 'timing-check', expiresAt: null } : {}) }, files: [] });
    assert.equal(await validate(url, init, response()), operation, 'older v1 hosts may omit telemetry');
    const timed = response(); timed.headers.set('Server-Timing', timing);
    assert.equal(await validate(url, init, timed), operation);
    const empty = response(); empty.headers.set('Server-Timing', '');
    await assert.rejects(validate(url, init, empty), /Server-Timing/, 'a present optional header still satisfies its schema');
    const uncached = response(); uncached.headers.delete('Cache-Control');
    await assert.rejects(validate(url, init, uncached), /Cache-Control/, 'mandatory inherited headers remain enforced');
  }
});

test('deletion blockers validate bounded recovery actions without provider metadata', async () => {
  const validate = createContractValidator();
  const url = `https://host.example/api/timds/admin/systems/${sourceId}/deletion`;
  const blocked = deletionBlockers => validate(url, { method: 'POST' }, json({ apiVersion: 1, error: 'Session repositories require review', deletionBlockers }, 409));
  const item = (index, status = 'open', reason = 'missing_creation_receipt', action = 'review_session') => ({ sessionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, status, reason, action });
  const valid = () => ({ sourceId, total: 4, sessions: [item(0), item(1, 'closed', 'missing_creation_receipt', 'operator_review'), item(2, 'open', 'fork_identity_changed', 'operator_review'), item(3, 'starting', 'missing_creation_receipt', 'operator_review')] });
  assert.equal(await blocked(valid()), 'prepareSourceDeletion');
  assert.equal(await blocked({ sourceId, total: 1, sessions: [item(0, 'closing')] }), 'prepareSourceDeletion');
  assert.equal(await blocked({ sourceId, total: 51, sessions: Array.from({ length: 50 }, (_, index) => item(index)) }), 'prepareSourceDeletion', 'a bounded page retains the full blocker count');
  assert.equal(await validate(url, { method: 'POST' }, json({ error: 'Deletion is unavailable' }, 409)), 'prepareSourceDeletion', 'older errors without blockers remain valid');
  for (const mutate of [
    value => { value.sourceId = 'not-a-source'; },
    value => { value.sessions[0].sessionId = 'not-a-session'; },
    value => { value.total = 0; },
    value => { value.total = 1.5; },
    value => { value.sessions = []; },
    value => { value.total = 51; value.sessions = Array.from({ length: 51 }, (_, index) => item(index)); },
    value => { value.sessions[0].status = 'unknown'; },
    value => { value.sessions[0].reason = 'unverified'; },
    value => { value.sessions[0].action = 'delete_repository'; },
    value => { value.sessions[0].status = 'closed'; },
    value => { value.sessions[0].status = 'expired'; },
    value => { value.sessions[0].status = 'starting'; },
    value => { value.sessions[0].reason = 'fork_identity_changed'; },
    value => { value.repositoryName = 'fixture-repository'; },
    value => { value.sessions[0].providerId = 'fixture-provider-id'; },
    value => { value.sessions[0].token = 'test-only'; },
    ...['sourceId', 'total', 'sessions'].map(key => value => { delete value[key]; }),
    ...['sessionId', 'status', 'reason', 'action'].map(key => value => { delete value.sessions[0][key]; }),
  ]) {
    const value = valid(); mutate(value);
    await assert.rejects(blocked(value), /deletionBlockers/);
  }
});

test('OpenAPI public preview validates CSS headers and bodyless HEAD', async () => {
  const validate = createContractValidator();
  const url = `https://host.example/api/public/design-system-previews/${sourceId}/${sessionId}/tokens.css`;
  const headers = { 'Content-Type': 'text/css', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Access-Control-Allow-Origin': '*' };
  await validate(url, {}, new Response(':root { --color: red; }', { headers }));
  await validate(url, { method: 'HEAD' }, new Response(null, { headers }));
  await assert.rejects(validate(url, { method: 'HEAD' }, new Response(null, { headers: { ...headers, 'Content-Type': 'text/html' } })), /Content-Type/);
  await assert.rejects(validate(url, {}, new Response(':root {}', { headers: { ...headers, 'Cache-Control': 'private' } })), /Cache-Control/);
  for (const method of ['GET', 'HEAD']) await assert.rejects(validate(url, { method }, new Response(method === 'HEAD' ? null : ':root {}', { headers: { ...headers, 'Cache-Control': 'public, max-age=5, must-revalidate' } })), /Cache-Control/, 'stale public caching must not satisfy the current contract');
  await assert.rejects(validate(url, { method: 'HEAD' }, new Response('unexpected body', { headers })), /empty body/);
});

test('pinned toolkit owns version headers, auth, session path, body and conflict transport', async () => {
  const pkg = JSON.parse(await readFile(new URL('../node_modules/@dtconcepts/timds/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.1.464');
  const calls = [];
  const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', fetchImpl: async (url, init) => {
    calls.push({ url, init }); return json(result());
  } });
  await client.start({ systemId: session.systemId, idempotencyKey: 'retry-key' });
  assert.equal(calls[0].url, 'https://host.example/api/timds/sessions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only');
  assert.equal(calls[0].init.headers['X-TimDS-API-Version'], '1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { systemId: session.systemId, idempotencyKey: 'retry-key', apiVersion: 1 });
  assert.equal(calls[0].init.redirect, 'error'); assert.ok(calls[0].init.signal);
  await client.pull(sessionId);
  assert.equal(calls[1].url, `https://host.example/api/timds/sessions/${sessionId}`);
  assert.equal(calls[1].init.method, 'GET');
  const malformed = createConformanceClient({ url: 'https://host.example', token: 'test-only', fetchImpl: async () => json({ apiVersion: 1 }) });
  await assert.rejects(malformed.pull(sessionId), /required property/);
  const denied = createConformanceClient({ url: 'https://host.example', token: 'test-only', fetchImpl: async () => json({ error: 'Access denied' }, 403) });
  await assert.rejects(denied.pull(sessionId), error => error.status === 403);
});

test('schema-invalid create responses still preserve fixture identity for cleanup', async () => {
  const created = [];
  const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', onCreatedSession: value => created.push(value), fetchImpl: async () => json({ session }) });
  await assert.rejects(client.start({ systemId: session.systemId }), /apiVersion/);
  assert.deepEqual(created, [session]);
});

test('public fetch extension sends no credential and Request extension keeps versioned JSON', async () => {
  const calls = [];
  const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('.css')) return new Response(':root {}', { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Access-Control-Allow-Origin': '*' } });
    return json({ apiVersion: 1, requestId: sessionId }, 202);
  } });
  await client.previewTokens(sourceId, sessionId);
  assert.deepEqual(calls[0].init.headers, {});
  await client.startRequest(sourceId, { requestId: sessionId, prompt: 'fixture' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer test-only');
  assert.equal(JSON.parse(calls[1].init.body).apiVersion, 1);
});

const configured = () => ({ TIMDS_HOST_URL: 'https://host.example', TIMDS_FIXTURE_SOURCE_ID: sourceId, TIMDS_FIXTURE_SYSTEM_ID: session.systemId, TIMDS_ALLOW_DISPOSABLE_WRITES: `${sourceId}:${session.systemId}`, TIMDS_ACCESS_TOKEN: 'owner', TIMDS_MEMBER_ACCESS_TOKEN: 'member', TIMDS_MEMBER_PRINCIPAL_ID: sessionId });
test('write guard refuses missing/ambiguous target, leaked URL credentials, insecure origin and duplicate identity', () => {
  assert.throws(() => readConfiguration({}), /TIMDS_HOST_URL/);
  assert.equal(readConfiguration(configured()).sourceId, sourceId);
  for (const [key, value] of [
    ['TIMDS_ALLOW_DISPOSABLE_WRITES', 'true'], ['TIMDS_FIXTURE_SOURCE_ID', 'other'],
    ['TIMDS_HOST_URL', 'https://user:password@host.example'], ['TIMDS_HOST_URL', 'http://host.example'],
    ['TIMDS_HOST_URL', 'https://host.example/private'], ['TIMDS_MEMBER_ACCESS_TOKEN', 'owner'],
    ['TIMDS_CONFORMANCE_TIMEOUT_MS', 'not-a-number'],
  ]) assert.throws(() => readConfiguration({ ...configured(), [key]: value }));
  assert.equal(readConfiguration({ ...configured(), TIMDS_HOST_URL: 'http://127.0.0.1:8787' }).url, 'http://127.0.0.1:8787');
});
