import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostMcp } from '../src/mcp/index.mjs';
import { publishedFixture } from './public-fixture.mjs';

const config={hostOrigin:'https://host.example',publicOrigin:'https://published.example'};
async function clientFixture(t,{actor,createRequest}={}) {
  const fixture=await publishedFixture(),handle=createHostMcp({...config,...fixture,createRequest});
  const client=new Client({name:'host-proof',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(actor?'https://host.example/api/timds/mcp':'https://published.example/mcp'),{fetch:(url,options)=>{const request=new Request(url,options);request.headers.set('Host',new URL(request.url).host);return handle(request,{},{waitUntil(){}},actor);}});
  t.after(()=>client.close());await client.connect(transport);
  const call=async(name,args={})=>client.callTool({name,arguments:{systemId:fixture.source.system_id,...args}});
  return {...fixture,handle,client,call};
}
test('actual Agents MCP handler works with published SDK client and public read tools track the current pointer',async t=>{
  const f=await clientFixture(t);
  assert.deepEqual((await f.client.listTools()).tools.map(tool=>tool.name),['describe_system','get_tokens','read_page']);
  assert.equal((await f.call('describe_system')).structuredContent.system.version,'1.0.0');
  const tokens=(await f.call('get_tokens',{kind:'color',baseOnly:true})).structuredContent;assert.equal(tokens.total,1);assert.equal(tokens.tokens[0].resolved,'#aabbcc');
  assert.match((await f.call('read_page',{page:'brand/voice',block:'tone'})).structuredContent.markdown,/Guidance 1\.0\.0/);
  f.publish('2.0.0');assert.equal((await f.call('describe_system')).structuredContent.system.version,'2.0.0');
  assert.match((await f.call('read_page',{page:'brand/voice',version:'1.0.0'})).structuredContent.markdown,/Guidance 1\.0\.0/);
  assert.equal((await f.call('describe_system')).structuredContent.system.version,'2.0.0');
  f.unavailable(true);const failed=await f.call('describe_system');assert.equal(failed.isError,true);assert.doesNotMatch(failed.content[0].text,/secret|1\.0\.0|2\.0\.0/);
});
test('authenticated gap reports preserve caller and observed release, deduplicate, and recheck Request authorization',async t=>{
  const actor={principalId:'human-one',accessMode:'read',scopes:['timds:read','timds:write']},calls=[];
  let denied=false;
  const f=await clientFixture(t,{actor,createRequest:async input=>{if(denied)throw Object.assign(new Error('Write access was revoked'),{statusCode:403});calls.push(input);return {apiVersion:1,requestId:input.input.requestId,executionJobId:'job'};}});
  assert.ok((await f.client.listTools()).tools.some(tool=>tool.name==='report_gap'));
  const gap={kind:'missing-token',title:'Need success color',detail:'There is no success token.',reference:'--success'};
  const first=(await f.call('report_gap',gap)).structuredContent,second=(await f.call('report_gap',gap)).structuredContent;
  assert.equal(first.filed,true);assert.equal(first.requestId,second.requestId);assert.equal(calls[0].actor.principalId,actor.principalId);assert.equal(calls[0].actor.accessMode,'write');assert.equal(calls[0].sourceId,f.source.id);
  assert.match(calls[0].input.prompt,/Reporter principal: human-one/);assert.match(calls[0].input.prompt,/Observed version: 1\.0\.0/);
  f.publish('2.0.0');assert.notEqual((await f.call('report_gap',gap)).structuredContent.requestId,first.requestId);
  denied=true;assert.equal((await f.call('report_gap',gap)).isError,true);
});
test('read-only bearer has no write tool and public MCP rejects cross-origin browser requests',async t=>{
  const f=await clientFixture(t,{actor:{principalId:'human-read',accessMode:'read',scopes:['timds:read']},createRequest:()=>{throw new Error('must not run');}});
  assert.equal((await f.client.listTools()).tools.some(tool=>tool.name==='report_gap'),false);
  const response=await f.handle(new Request('https://published.example/mcp',{method:'POST',headers:{Origin:'https://host.example','Content-Type':'application/json'},body:'{}'}),{},{});
  assert.equal(response.status,403);
});
