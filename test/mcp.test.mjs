// Smoke: the public MCP endpoint speaks to the published SDK client, lists its
// read tools, and answers describe_system with the current version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostMcp } from '../src/mcp/index.mjs';
import { publishedFixture } from './public-fixture.mjs';

const config = { hostOrigin: 'https://host.example', publicOrigin: 'https://published.example' };

test('public MCP connects, lists read tools and describes the current version', async t => {
  const fixture = await publishedFixture();
  const handle = createHostMcp({ ...config, ...fixture });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://published.example/mcp'), {
    fetch: (url, options) => {
      const request = new Request(url, options);
      request.headers.set('Host', new URL(request.url).host);
      return handle(request, {}, { waitUntil() {} });
    },
  });
  t.after(() => client.close());
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['describe_system', 'get_tokens', 'read_page']) assert.ok(tools.includes(name), name);
  assert.equal(tools.includes('report_gap'), false, 'anonymous callers get no write tool');

  const describe = await client.callTool({ name: 'describe_system', arguments: { systemId: fixture.source.system_id } });
  assert.equal(describe.structuredContent.system.version, '1.0.0');

  fixture.publish('2.0.0');
  const after = await client.callTool({ name: 'describe_system', arguments: { systemId: fixture.source.system_id } });
  assert.equal(after.structuredContent.system.version, '2.0.0');
});
