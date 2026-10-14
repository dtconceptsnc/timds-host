import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpConformanceClient } from '../mcp.mjs';
import { createRunResources, cleanupRunResources } from '../resources.mjs';

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const initialized = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } };

test('remote MCP handshake, paged tool directory and call use the selected origin and bearer', async () => {
  const calls = [], counts = [];
  const client = createMcpConformanceClient({ url: 'https://host.example', token: 'test-only', onResponse: value => counts.push(value), fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body); calls.push({ url, init, request });
    if (request.method === 'initialize') return json(reply(request.id, initialized));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'tools/list') return json(reply(request.id, request.params.cursor ? { tools: [{ name: 'get_system' }] } : { tools: [{ name: 'list_systems' }], nextCursor: 'next' }));
    return json(reply(request.id, { content: [{ type: 'text', text: 'receipt' }], structuredContent: { apiVersion: 1, systems: [] } }));
  } });
  assert.deepEqual(await client.initialize(), initialized);
  assert.deepEqual((await client.listTools()).map(tool => tool.name), ['list_systems', 'get_system']);
  assert.deepEqual(await client.call('list_systems'), { apiVersion: 1, systems: [] });
  assert.ok(calls.every(({ url, init }) => url === 'https://host.example/api/timds/mcp' && init.redirect === 'error' && init.signal && init.headers.Authorization === 'Bearer test-only'));
  assert.equal(calls[0].init.headers.Accept, 'application/json, text/event-stream');
  assert.equal(calls[0].request.params.protocolVersion, initialized.protocolVersion);
  assert.deepEqual(calls[1].request, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(calls[1].init.headers['MCP-Protocol-Version'], initialized.protocolVersion);
  assert.deepEqual(calls.at(-1).request.params, { name: 'list_systems', arguments: {} });
  assert.deepEqual(counts.at(-1), { operationId: 'mcp:list_systems', status: 200 });
});

test('SSE MCP responses ignore notifications and select the matching request receipt', async () => {
  const client = createMcpConformanceClient({ url: 'https://host.example', token: 'test-only', fetchImpl: async (_url, init) => {
    const { id } = JSON.parse(init.body);
    const body = [
      ': heartbeat',
      'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}',
      `event: message\r\ndata: {"jsonrpc":"2.0","id":${id},\r\ndata: "result":{"structuredContent":{"session":{"id":"fixture"}}}}`,
    ].join('\r\n\r\n');
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } });
  } });
  assert.deepEqual(await client.call('get_session', { sessionId: 'fixture' }), { session: { id: 'fixture' } });
});

test('public MCP never sends a bearer and private failures expose only status or protocol code', async () => {
  const client = createMcpConformanceClient({ url: 'https://public.example', token: 'must-not-be-sent', publicRead: true, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://public.example/mcp'); assert.equal(init.headers.Authorization, undefined);
    return json(reply(JSON.parse(init.body).id, { tools: [] }));
  } });
  assert.deepEqual(await client.listTools(), []);
  const denied = createMcpConformanceClient({ url: 'https://host.example', fetchImpl: async () => new Response('private diagnostic', { status: 401, headers: { 'Cache-Control': 'no-store' } }) });
  await assert.rejects(denied.initialize(), error => error.status === 401 && !error.message.includes('private diagnostic'));
  const protocolError = createMcpConformanceClient({ url: 'https://host.example', fetchImpl: async (_url, init) => json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: -32602, message: 'private diagnostic' } }) });
  await assert.rejects(protocolError.call('missing'), error => error.code === -32602 && !error.message.includes('private diagnostic'));
  const toolError = createMcpConformanceClient({ url: 'https://host.example', fetchImpl: async (_url, init) => json(reply(JSON.parse(init.body).id, { isError: true, structuredContent: { error: { statusCode: 403, message: 'private diagnostic' } } })) });
  await assert.rejects(toolError.call('update_session'), error => error.status === 403 && !error.message.includes('private diagnostic'));
});

test('MCP enforces cache policy and matching envelopes while preserving created cleanup identity', async () => {
  const session = { id: '11111111-1111-4111-8111-111111111111' }, created = [];
  const malformed = createMcpConformanceClient({ url: 'https://host.example', onCreatedSession: value => created.push(value), fetchImpl: async (_url, init) => json({ id: JSON.parse(init.body).id, result: { structuredContent: { session } } }) });
  await assert.rejects(malformed.call('start_session'), /matching JSON-RPC/);
  assert.deepEqual(created, [session], 'malformed envelopes retain a successful create identity before failing');
  const cached = createMcpConformanceClient({ url: 'https://host.example', fetchImpl: async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } }) });
  await assert.rejects(cached.listTools(), /no-store/);
  const mismatched = createMcpConformanceClient({ url: 'https://host.example', fetchImpl: async () => json(reply(99, { tools: [] })) });
  await assert.rejects(mismatched.listTools(), /matching JSON-RPC/);
  const looping = createMcpConformanceClient({ url: 'https://host.example', fetchImpl: async (_url, init) => json(reply(JSON.parse(init.body).id, { tools: [], nextCursor: 'same' })) });
  await assert.rejects(looping.listTools(), /pagination must advance/);
});

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const sourceId = id('1'), sessionId = id('2'), submissionId = id('3'), publicationId = id('4');
const systemId = 'timds/disposable-fixture';
const publication = { id: publicationId, sourceId, submissionId, status: 'queued', stage: 'preflight' };
const owned = () => {
  const resources = createRunResources({ sourceId, systemId });
  resources.trackedSession({ session: { id: sessionId, sourceId, systemId } });
  resources.trackSubmission({ id: submissionId, sessionId }, sessionId);
  return resources;
};

test('MCP publication transport captures acceptance before envelope and cache validation', async () => {
  for (const invalid of ['envelope', 'cache']) {
    const resources = owned();
    const client = createMcpConformanceClient({ url: 'https://host.example', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication,
      fetchImpl: async (_url, init) => {
        assert.equal(resources.publicationAttempts.get(submissionId)?.sessionId, sessionId, 'record publication intent before transport');
        const body = { id: JSON.parse(init.body).id, result: { structuredContent: { publication } }, ...(invalid === 'envelope' ? {} : { jsonrpc: '2.0' }) };
        return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': invalid === 'cache' ? 'public' : 'no-store' } });
      } });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(client.call('publish_submission', { submissionId }));
    assert.deepEqual([...resources.publications.keys()], [publicationId]);
    assert.equal(resources.publicationAttempts.size, 0);
    const calls = [];
    const cleaned = await cleanupRunResources(resources, {
      drainPublication: async value => { calls.push(['drain', value]); return { publication: { ...publication, status: 'published' } }; },
      closeSession: async value => calls.push(['close', value]),
    });
    assert.deepEqual(calls, [['drain', publicationId], ['close', sessionId]]); assert.deepEqual(cleaned.failures, []);
  }
});

test('uncertain MCP publication outcomes preserve their fork and foreign receipts cannot resolve them', async () => {
  const outcomes = [
    async () => { throw new Error('response lost'); },
    async () => new Response('private diagnostic', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }),
    async request => json(reply(request.id, { structuredContent: { publication: { ...publication, sourceId: id('5') } } })),
    async request => json(reply(request.id, { isError: true, structuredContent: { publication, error: { statusCode: 403 } } })),
    async request => json(reply(request.id, { structuredContent: {} })),
  ];
  for (const respond of outcomes) {
    const resources = owned();
    const client = createMcpConformanceClient({ url: 'https://host.example', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication, fetchImpl: async (_url, init) => respond(JSON.parse(init.body)) });
    try { await client.call('publish_submission', { submissionId }); } catch (error) { assert.ok(!error.message.includes('private diagnostic')); }
    assert.equal(resources.publications.size, 0); assert.equal(resources.publicationAttempts.size, 1);
    const cleaned = await cleanupRunResources(resources, {
      drainPublication: async () => assert.fail('no accepted publication identity'),
      closeSession: async () => assert.fail('an unconfirmed publication may still need its fork'),
    });
    assert.deepEqual(cleaned.failures, [sessionId]); assert.equal(cleaned.publicationAttempts[0].confirmed, false);
  }
});

test('MCP preflight and build checks never register publication attempts', async () => {
  const resources = owned();
  const client = createMcpConformanceClient({ url: 'https://host.example', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication, fetchImpl: async () => { throw new Error('response lost'); } });
  for (const name of ['preflight_submission', 'check_submission']) await assert.rejects(client.call(name, { submissionId }), /response lost/);
  assert.equal(resources.publicationAttempts.size, 0); assert.equal(resources.publications.size, 0);
});
