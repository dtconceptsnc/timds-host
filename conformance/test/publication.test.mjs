import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForPublication } from '../publication.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const receipt = (status, stage = 'release', error = null) => ({ apiVersion: 1, publication: { id, status, stage, error } });
const clock = () => {
  let elapsed = 0;
  return { now: () => elapsed, wait: async ms => { elapsed += ms; }, timeoutMs: 30, intervalMs: 10 };
};

test('publication polling records transient failures and closing errors but requires eventual published', async () => {
  const recovered = receipt('published', 'close'), retries = [];
  const responses = [receipt('failed', 'release', 'private host error'), receipt('closing', 'close', 'private cleanup error'), recovered];
  const result = await waitForPublication(id, async () => responses.shift(), { ...clock(), onRetry: event => retries.push(event) });
  assert.equal(result, recovered);
  assert.deepEqual(retries, [
    { publicationId: id, status: 'failed', stage: 'release', errorReported: true, observedAt: '1970-01-01T00:00:00.000Z' },
    { publicationId: id, status: 'closing', stage: 'close', errorReported: true, observedAt: '1970-01-01T00:00:00.010Z' },
  ]);
  assert.doesNotMatch(JSON.stringify(retries), /private/);
});

test('permanently failed publication times out without passing or silently dropping failure evidence', async () => {
  const timing = clock(), retries = [];
  let reads = 0;
  await assert.rejects(waitForPublication(id, async () => { reads++; return receipt('failed', 'build', 'build failed'); }, { ...timing, onRetry: event => retries.push(event) }), /did not finish within 30ms/);
  assert.equal(timing.now(), 30);
  assert.equal(reads, 3);
  assert.equal(retries.length, 1, 'repeated identical failure polls retain one evidence record');
  assert.equal(retries[0].status, 'failed');
  assert.equal(retries[0].stage, 'build');
});

test('a superseded publication or mismatched published identity cannot satisfy completion', async () => {
  await assert.rejects(waitForPublication(id, async () => receipt('superseded'), clock()), /ended as superseded/);
  await assert.rejects(waitForPublication(id, async () => ({ publication: { ...receipt('published').publication, id: '22222222-2222-4222-8222-222222222222' } }), clock()), /requested identity/);
});
