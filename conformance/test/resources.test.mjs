import assert from 'node:assert/strict';
import test from 'node:test';
import { createConformanceClient } from '../client.mjs';
import { createRunResources, cleanupRunResources } from '../resources.mjs';

const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const sourceId = id('1'), sessionId = id('2'), submissionId = id('3'), publicationId = id('4');
const systemId = 'timds/disposable-fixture';
const session = { id: sessionId, sourceId, systemId };
const submission = { id: submissionId, sessionId };
const publication = { id: publicationId, sourceId, submissionId, status: 'queued', stage: 'preflight' };
const json = (body, status = 202) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const owned = () => {
  const resources = createRunResources({ sourceId, systemId });
  resources.trackedSession({ session });
  resources.trackSubmission(submission, sessionId);
  return resources;
};

test('foreign or invalid session identity fails before cleanup registration', () => {
  const resources = createRunResources({ sourceId, systemId });
  for (const candidate of [
    { ...session, sourceId: id('5') }, { ...session, systemId: 'timds/another-system' },
    { ...session, id: 'not-a-uuid' }, {},
  ]) {
    assert.throws(() => resources.trackedSession({ session: candidate }));
    assert.equal(resources.onCreatedSession(candidate), false);
    assert.equal(resources.sessions.size, 0, 'a rejected result must never be scheduled for close');
  }
  const result = { session };
  assert.equal(resources.trackedSession(result), result);
  resources.onCreatedSession(session);
  assert.deepEqual([...resources.sessions.keys()], [sessionId], 'same-key recovery tracks one session');
  assert.throws(() => resources.trackSubmission({ ...submission, sessionId: id('6') }, sessionId), /requested session/);
  assert.throws(() => resources.trackSubmission(submission, id('6')), /created by this run/);
  assert.equal(resources.onAcceptedPublication(publication, submissionId), false, 'a rejected submission cannot authorize publication cleanup');
});

test('malformed accepted publication is retained before validation, rejected, and drained once', async () => {
  const resources = owned();
  const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication,
    fetchImpl: async () => json({ publication }) }); // Missing apiVersion is intentional.
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(client.publish(submissionId, {}), /apiVersion/);
  assert.deepEqual([...resources.publications.keys()], [publicationId]);
  assert.equal(resources.publicationAttempts.size, 0, 'capturing the accepted identity resolves the transport uncertainty');
  const calls = [];
  const result = await cleanupRunResources(resources, {
    drainPublication: async value => { calls.push(['drain', value]); return { publication: { ...publication, status: 'published' } }; },
    closeSession: async value => calls.push(['close', value]),
  });
  assert.deepEqual(calls, [['drain', publicationId], ['close', sessionId]]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.publicationCleanup, [{ publicationId, drained: true, status: 'published' }]);
});

test('lost or malformed publication response preserves the attempted fork and closes unrelated sessions', async () => {
  const unknownOutcomes = [
    async () => { throw new Error('connection lost after sending request'); },
    async () => new Response('truncated response', { status: 202, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }),
    async () => json({ apiVersion: 1, publication: { ...publication, id: 'invalid' } }),
    async () => json({ publication: {} }),
  ];
  for (const respond of unknownOutcomes) {
    const resources = owned(), unrelatedId = id('6'), closed = [];
    resources.onCreatedSession({ ...session, id: unrelatedId });
    const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication,
      fetchImpl: async () => {
        assert.equal(resources.publicationAttempts.get(submissionId)?.sessionId, sessionId, 'record the attempt before handing it to transport');
        return respond();
      } });
    await assert.rejects(client.publish(submissionId, {}));
    assert.equal(resources.publications.size, 0, 'never guess the identity of an accepted publication');
    const result = await cleanupRunResources(resources, {
      drainPublication: async () => assert.fail('no accepted identity is available to poll'),
      closeSession: async value => closed.push(value),
    });
    assert.deepEqual(closed, [unrelatedId]);
    assert.deepEqual(result.failures, [sessionId]);
    assert.deepEqual(result.publicationAttempts, [{ submissionId, sessionId, confirmed: false, reason: 'publication_acceptance_unconfirmed' }]);
    assert.deepEqual(result.publicationCleanup, []);
    assert.deepEqual(result.cleanup.find(row => row.sessionId === sessionId), { sessionId, closed: false, skipped: true, reason: 'publication_state_unconfirmed' });
  }
});

test('successful response without a publication identity still leaves an unresolved write attempt', async () => {
  const resources = owned();
  const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication,
    fetchImpl: async () => json({ apiVersion: 1 }) });
  const result = await client.publish(submissionId, {}); // The schema also permits preflight-only responses.
  assert.equal(resources.onAcceptedPublication(result.publication, submissionId), false, 'live lifecycle assertion must reject a missing accepted identity');
  const cleanup = await cleanupRunResources(resources, {
    drainPublication: async () => assert.fail('missing publication identity'),
    closeSession: async () => assert.fail('possibly active fork must remain open'),
  });
  assert.deepEqual(cleanup.failures, [sessionId]);
  assert.equal(cleanup.publicationAttempts[0].confirmed, false);
});

test('dry runs, preflight and submissions outside this run never create pending write attempts', async () => {
  const resources = owned();
  const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication,
    fetchImpl: async () => { throw new Error('response lost'); } });
  for (const body of [{ dryRun: true }, { preflight: true }]) await assert.rejects(client.publish(submissionId, body), /response lost/);
  await assert.rejects(client.publish(id('7'), {}), /response lost/);
  assert.equal(resources.publicationAttempts.size, 0);
  const closed = [];
  const cleanup = await cleanupRunResources(resources, { drainPublication: async () => assert.fail('no publication'), closeSession: async value => closed.push(value) });
  assert.deepEqual(closed, [sessionId]);
  assert.deepEqual(cleanup.failures, []);
});

test('a known accepted publication can resolve a lost idempotent retry only after verified settlement', async () => {
  const resources = owned();
  resources.onAcceptedPublication(publication, submissionId);
  const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication,
    fetchImpl: async () => { throw new Error('retry response lost'); } });
  await assert.rejects(client.publish(submissionId, {}), /retry response lost/);
  assert.equal(resources.publicationAttempts.size, 1);
  const calls = [];
  const result = await cleanupRunResources(resources, {
    drainPublication: async value => { calls.push(['drain', value]); return { publication: { ...publication, status: 'published' } }; },
    closeSession: async value => calls.push(['close', value]),
  });
  assert.deepEqual(calls, [['drain', publicationId], ['close', sessionId]]);
  assert.deepEqual(result.publicationAttempts, []);
  assert.deepEqual(result.failures, []);
});

test('publication capture rejects foreign sources, unowned submissions, path mismatches and invalid IDs', async () => {
  const resources = owned();
  const secondSubmissionId = id('7');
  resources.trackSubmission({ ...submission, id: secondSubmissionId }, sessionId);
  for (const candidate of [
    { ...publication, sourceId: id('5') }, { ...publication, submissionId: id('6') },
    { ...publication, submissionId: secondSubmissionId }, { ...publication, id: 'invalid-publication' }, {},
  ]) {
    const client = createConformanceClient({ url: 'https://host.example', token: 'test-only', onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication,
      fetchImpl: async () => json({ publication: candidate }) });
    await assert.rejects(client.publish(submissionId, {}), /apiVersion/);
    assert.equal(resources.publications.size, 0);
    assert.equal(resources.publicationAttempts.size, 1, 'a foreign or malformed receipt cannot clear write uncertainty');
  }
  const rejected = createConformanceClient({ url: 'https://host.example', token: 'test-only', onAcceptedPublication: resources.onAcceptedPublication,
    fetchImpl: async () => json({ error: 'Publish rejected', publication }, 403) });
  await assert.rejects(rejected.publish(submissionId, {}), error => error.status === 403);
  assert.equal(resources.publications.size, 0, 'a rejected response is not an accepted publication');
  assert.equal(resources.onAcceptedPublication(publication, submissionId), true);
  assert.equal(resources.onAcceptedPublication({ ...publication, submissionId: secondSubmissionId }, secondSubmissionId), false, 'an accepted publication cannot switch submissions');
  assert.equal(resources.publications.get(publicationId).submissionId, submissionId);
});

test('unconfirmed publication keeps its session and draft ancestors open while unrelated owned sessions close', async () => {
  const resources = owned(), draftId = id('5'), unrelatedId = id('6');
  resources.onCreatedSession({ ...session, id: draftId, kind: 'draft' });
  resources.onCreatedSession({ ...session, draftSessionId: draftId });
  resources.onCreatedSession(session); // A later minimal receipt omits the parent.
  resources.onCreatedSession({ ...session, id: unrelatedId });
  resources.onAcceptedPublication(publication, submissionId);
  const closed = [];
  const result = await cleanupRunResources(resources, {
    drainPublication: async () => { throw new Error('polling deadline exceeded'); },
    closeSession: async value => closed.push(value),
  });
  assert.deepEqual(closed, [unrelatedId]);
  assert.deepEqual(new Set(result.failures), new Set([sessionId, draftId]));
  assert.deepEqual(result.publicationCleanup, [{ publicationId, drained: false, reason: 'publication_state_unconfirmed' }]);
  assert.ok(result.cleanup.filter(row => row.sessionId !== unrelatedId).every(row => row.skipped === true && row.closed === false));
});

test('retryable, nonterminal or foreign publication readback cannot authorize session close; settled supersession can', async () => {
  for (const readback of [publication, { ...publication, status: 'failed' }, { ...publication, status: 'closing' }, { ...publication, status: 'published', sourceId: id('5') }, { ...publication, status: 'published', submissionId: id('6') }]) {
    const resources = owned(), closed = [];
    resources.onAcceptedPublication(publication, submissionId);
    const result = await cleanupRunResources(resources, { drainPublication: async () => ({ publication: readback }), closeSession: async value => closed.push(value) });
    assert.deepEqual(closed, []);
    assert.deepEqual(result.failures, [sessionId]);
  }
  const resources = owned(), closed = [];
  resources.onAcceptedPublication(publication, submissionId);
  const result = await cleanupRunResources(resources, { drainPublication: async () => ({ publication: { ...publication, status: 'superseded' } }), closeSession: async value => closed.push(value) });
  assert.deepEqual(closed, [sessionId]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.publicationCleanup[0].status, 'superseded');
});
