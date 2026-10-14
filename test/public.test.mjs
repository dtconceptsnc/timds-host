// Smoke: the public (anonymous) origin serves a published design system's
// current and pinned versions and refuses the obvious bad requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicRoots, publicSystemUrls } from '../src/public/index.mjs';
import { publishedFixture } from './public-fixture.mjs';

const config = { hostOrigin: 'https://host.example', publicOrigin: 'https://published.example' };
const root = 'https://published.example/systems/example%2Fcore/';

test('current root redirects to the entry page and serves the published HTML', async () => {
  const fixture = await publishedFixture();
  const handler = createPublicRoots({ ...config, ...fixture });
  const redirect = await handler.fetch(new Request(root));
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), `${root}docs/index.html`);
  const page = await handler.fetch(new Request(redirect.headers.get('Location')));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(await page.text(), /1\.0\.0/);
});

test('the system id may be spelled as path segments; the encoded form keeps working', async () => {
  const fixture = await publishedFixture();
  const handler = createPublicRoots({ ...config, ...fixture });
  const plain = 'https://published.example/systems/example/core/';
  assert.equal(publicSystemUrls(config.publicOrigin, 'example/core').root, plain, 'advertised URLs use the plain form');
  assert.equal(publicSystemUrls(config.publicOrigin, 'a/b/c').root, 'https://published.example/systems/a%2Fb%2Fc/', 'three segments stay encoded');
  const redirect = await handler.fetch(new Request('https://published.example/systems/example/core'));
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), plain);
  const page = await handler.fetch(new Request(`${plain}docs/index.html`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /1\.0\.0/);
  const pinned = await handler.fetch(new Request(`${plain}v/1.0.0/docs/index.html`));
  assert.equal(pinned.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  const css = await (await handler.fetch(new Request(`${root}docs/style.css`))).text();
  assert.match(css, /url\(\.\.\/font\.woff2\)/, 'relative asset URLs are left alone');
  const stamp = await (await handler.fetch(new Request(`${plain}.timds-artifact.json`))).json();
  assert.equal(stamp.entry, 'docs/index.html');
  assert.equal(stamp.files.index, 'docs/index.json', 'remote readers find the derived layer from the stamp');
  assert.equal((await handler.fetch(new Request('https://published.example/systems/nobody/core/'))).status, 404);
});

test('pinned version keeps serving after the current pointer moves', async () => {
  const fixture = await publishedFixture();
  const handler = createPublicRoots({ ...config, ...fixture });
  fixture.publish('2.0.0');
  assert.match(await (await handler.fetch(new Request(`${root}docs/index.html`))).text(), /2\.0\.0/);
  const pinned = await handler.fetch(new Request(`${root}v/1.0.0/docs/index.html`));
  assert.equal(pinned.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.match(await pinned.text(), /1\.0\.0/);
});

test('path escapes, wrong methods and unknown versions are refused', async () => {
  const fixture = await publishedFixture();
  const handler = createPublicRoots({ ...config, ...fixture });
  assert.equal((await handler.fetch(new Request(`${root}docs/%2F..%2Fprivate`))).status, 400);
  assert.equal((await handler.fetch(new Request(root, { method: 'POST' }))).status, 405);
  assert.equal((await handler.fetch(new Request(`${root}v/9.0.0/`))).status, 404);
  assert.equal((await handler.fetch(new Request('https://host.example/systems/example%2Fcore/'))).status, 404, 'never served through the authenticated host');
});
