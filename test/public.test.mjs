import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicRoots, publicOrigins, publicSystemUrls } from '../src/public/index.mjs';
import { publishedFixture } from './public-fixture.mjs';

const config={hostOrigin:'https://host.example',publicOrigin:'https://published.example'};
const root='https://published.example/systems/example%2Fcore/';
test('published HTML requires a separate origin and never serves through the authenticated host',async()=>{
  assert.throws(()=>publicOrigins({...config,publicOrigin:config.hostOrigin}),error=>error.statusCode===503);
  assert.throws(()=>publicOrigins({...config,publicOrigin:'https://host.example:444'}),error=>error.statusCode===503);
  const f=await publishedFixture(),handler=createPublicRoots({...config,...f});
  assert.equal((await handler.fetch(new Request('https://host.example/systems/example%2Fcore/'))).status,404);
  assert.deepEqual(publicSystemUrls(config.publicOrigin,'example/core','1.0.0'),{root,current:root,version:`${root}v/1.0.0/`});
});
test('current and pinned roots serve exact bytes, MIME, stamp, HEAD and cache validation',async()=>{
  const f=await publishedFixture(),handler=createPublicRoots({...config,...f});
  const nested=await handler.fetch(new Request(root));assert.equal(nested.status,308);assert.equal(nested.headers.get('Location'),`${root}docs/index.html`);
  const first=await handler.fetch(new Request(nested.headers.get('Location')));
  assert.equal(first.status,200);assert.equal(first.headers.get('Cache-Control'),'public, max-age=300, must-revalidate');
  assert.equal(first.headers.get('Content-Type'),'text/html; charset=utf-8');assert.match(await first.text(),/1\.0\.0/);
  const font=await handler.fetch(new Request(`${root}font.woff2`));assert.equal(font.headers.get('Content-Type'),'font/woff2');assert.deepEqual(new Uint8Array(await font.arrayBuffer()),new Uint8Array([0,255,5,6,128,10]));
  const css=await handler.fetch(new Request(`${root}docs/style.css`));assert.equal(await css.text(),'@font-face{font-family:Exact;src:url(../font.woff2)}\n');
  const stamp=await handler.fetch(new Request(`${root}.timds-artifact.json`));assert.equal(await stamp.text(),JSON.stringify(f.versions.get('1.0.0').stamp,null,2)+'\n');
  const pinned=await handler.fetch(new Request(`${root}v/1.0.0/docs/index.html`));assert.equal(pinned.headers.get('Cache-Control'),'public, max-age=31536000, immutable');
  const etag=pinned.headers.get('ETag');await pinned.body.cancel();
  assert.equal((await handler.fetch(new Request(`${root}v/1.0.0/docs/index.html`,{headers:{'If-None-Match':etag}}))).status,304);
  const head=await handler.fetch(new Request(`${root}v/1.0.0/font.woff2`,{method:'HEAD'}));assert.equal(await head.text(),'');assert.equal(head.headers.get('Content-Length'),'6');
  f.publish('2.0.0');assert.match(await(await handler.fetch(new Request(`${root}docs/index.html`))).text(),/2\.0\.0/);assert.match(await(await handler.fetch(new Request(`${root}v/1.0.0/docs/index.html`))).text(),/1\.0\.0/);
});
test('public serving rejects path escapes, invalid methods and unknown versions without stale fallback or internal errors',async()=>{
  const f=await publishedFixture(),handler=createPublicRoots({...config,...f});
  for(const path of ['docs/%2F..%2Fprivate','%5cprivate','.git/config','v/not%2Fa/version','%00'])assert.equal((await handler.fetch(new Request(root+path))).status,400,path);
  assert.equal((await handler.fetch(new Request(root,{method:'POST'}))).status,405);
  assert.equal((await handler.fetch(new Request(`${root}v/9.0.0/`))).status,404);
  const redirect=await handler.fetch(new Request(root.slice(0,-1)));assert.equal(redirect.status,308);assert.equal(redirect.headers.get('Location'),root);
  f.unavailable(true);const response=await handler.fetch(new Request(root));assert.equal(response.status,503);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.doesNotMatch(await response.text(),/secret/);
});
