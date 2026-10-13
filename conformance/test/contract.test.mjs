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
