import assert from 'node:assert/strict';

const protocolVersion = '2025-03-26';

/** Exercise the remote MCP boundary without importing the host or its SDK. */
export function createMcpConformanceClient({ url, token, publicRead = false, fetchImpl = fetch, timeoutMs = 120_000, onDispatch = () => {}, onResponse = () => {}, onCreatedSession = () => {}, onPublicationAttempt = () => {}, onAcceptedPublication = () => {} }) {
  const origin = new URL(url).origin, endpoint = `${origin}${publicRead ? '/mcp' : '/api/timds/mcp'}`;
  let sequence = 0, negotiatedVersion = protocolVersion;
  const rpc = async (method, params, notification = false) => {
    const id = notification ? undefined : ++sequence;
    const publishing = method === 'tools/call' && params.name === 'publish_submission';
    if (publishing) await onPublicationAttempt(params.arguments.submissionId);
    onDispatch({ operationId: `mcp:${method === 'tools/call' ? params.name : method}` });
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': negotiatedVersion, ...(!publicRead && token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    await onResponse({ operationId: `mcp:${method === 'tools/call' ? params.name : method}`, status: response.status });
    const checkCache = () => assert.match(response.headers.get('cache-control') || '', /(?:^|,)\s*no-store\s*(?:,|$)/i, 'MCP responses must be no-store');
    if (!response.ok) { checkCache(); throw Object.assign(new Error(`MCP returned HTTP ${response.status}`), { status: response.status }); }
    if (notification) {
      checkCache();
      assert.equal(response.status, 202, 'MCP accepts notifications without a JSON-RPC reply');
      assert.equal(await response.text(), '', 'MCP notification acceptance is bodyless');
      return;
    }
    const type = response.headers.get('content-type')?.split(';')[0];
    const text = await response.text();
    let messages;
    try {
      messages = type !== 'text/event-stream' ? [JSON.parse(text)] : text.replace(/\r\n/g, '\n').split('\n\n').flatMap(event => {
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        return data ? [JSON.parse(data)] : [];
      });
    } catch { checkCache(); throw new Error('MCP returned malformed JSON'); }
    const reply = messages.find(message => message?.id === id);
    // Preserve a created fixture's identity even when later envelope assertions
    // fail, matching the HTTP transport's cleanup capture rule.
    if (method === 'tools/call' && ['start_session', 'create_draft'].includes(params.name) && !reply?.result?.isError && reply?.result?.structuredContent?.session) await onCreatedSession(reply.result.structuredContent.session);
    if (publishing && !reply?.result?.isError && reply?.result?.structuredContent?.publication) await onAcceptedPublication(reply.result.structuredContent.publication, params.arguments.submissionId);
    checkCache();
    assert.ok(['application/json', 'text/event-stream'].includes(type), 'MCP returns JSON or an SSE stream');
    assert.equal(reply?.jsonrpc, '2.0', 'MCP returns a matching JSON-RPC response');
    if (reply.error) throw Object.assign(new Error(`MCP protocol error ${reply.error.code}`), { code: reply.error.code });
    assert.ok(reply.result && typeof reply.result === 'object', 'MCP response contains a result');
    return reply.result;
  };
  return {
    initialize: async () => {
      const result = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'timds-host-conformance', version: '1.0.0' } });
      assert.ok(result.capabilities?.tools, 'MCP advertises tools');
      assert.equal(typeof result.protocolVersion, 'string');
      negotiatedVersion = result.protocolVersion;
      await rpc('notifications/initialized', undefined, true);
      return result;
    },
    listTools: async () => {
      const tools = [], cursors = new Set(); let cursor;
      do {
        const result = await rpc('tools/list', cursor ? { cursor } : {});
        assert.ok(Array.isArray(result.tools), 'tools/list returns a tool directory');
        tools.push(...result.tools); cursor = result.nextCursor;
        if (cursor) { assert.ok(!cursors.has(cursor), 'tool pagination must advance'); cursors.add(cursor); }
      } while (cursor);
      return tools;
    },
    call: async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result.isError) throw Object.assign(new Error(`MCP tool ${name} failed`), { status: result.structuredContent?.error?.statusCode });
      assert.ok(result.structuredContent && typeof result.structuredContent === 'object', 'designer tools return structured receipts');
      return result.structuredContent;
    },
  };
}
