import assert from 'node:assert/strict';
import test from 'node:test';
import { assertConsecutiveVersions, readPublicStamp, readPreview } from '../assertions.mjs';

test('publication sequence follows pinned toolkit dated releases, including UTC rollover', () => {
  const bounds = { startedAt: '2026-10-12T23:59:00Z', finishedAt: '2026-10-13T00:01:00Z' };
  assertConsecutiveVersions('2026.10.12-1', '2026.10.12-2', bounds);
  assertConsecutiveVersions('2026.10.12-9', '2026.10.13-1', bounds);
  for (const [first, second] of [['1.2.3', '1.2.4'], ['2026.10.12-1', '2026.10.12-3'], ['2026.10.12-2', '2026.10.12-1'], ['2026.10.12-9', '2026.10.13-2'], ['2026.10.12-1', '2026.10.14-1']]) assert.throws(() => assertConsecutiveVersions(first, second, bounds));
});

test('public immutable stamp checks real identity and never sends credentials', async () => {
  const stamp = { schemaVersion: 1, systemId: 'timds/fixture', version: '2026.10.13-1', sourceCommit: 'a'.repeat(40), contentDigest: 'b'.repeat(64) };
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return Response.json(stamp, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }); };
  assert.deepEqual(await readPublicStamp('https://public.example/.timds-artifact.json', { fetchImpl, systemId: stamp.systemId, version: stamp.version }), stamp);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(readPublicStamp('https://public.example/.timds-artifact.json', { fetchImpl, systemId: 'wrong' }));
  await assert.rejects(readPublicStamp('https://user:secret@public.example/', { fetchImpl, systemId: stamp.systemId }), /credentials/);
});

test('submission Preview readiness rejects placeholders and non-HTML responses', async () => {
  const url = 'https://preview.example/';
  const result = (body, status = 200, contentType = 'text/html') => readPreview(url, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return new Response(body, { status, headers: { 'Content-Type': contentType } });
  } });
  assert.equal((await result('<!doctype html><html>Published preview</html>')).ready, true);
  assert.equal((await result('TimDS Preview is awaiting its first submission.', 503)).ready, false);
  assert.equal((await result('{}', 200, 'application/json')).ready, false);
});
