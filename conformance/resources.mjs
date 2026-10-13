import assert from 'node:assert/strict';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
// A failed portal publication can retain staged writes and a retryable job.
export const terminalPublicationStatuses = new Set(['published', 'superseded']);

/** Only identities created/accepted by this run may enter its cleanup inventory. */
export function createRunResources({ sourceId, systemId }) {
  const sessions = new Map(), submissions = new Map(), publications = new Map(), publicationAttempts = new Map();
  const onCreatedSession = session => {
    if (!uuid(session?.id) || session.sourceId !== sourceId || session.systemId !== systemId) return false;
    // A malformed same-key receipt must not erase an already known parent.
    sessions.set(session.id, { draftSessionId: uuid(session.draftSessionId) ? session.draftSessionId : sessions.get(session.id)?.draftSessionId || null });
    return true;
  };
  const trackedSession = result => {
    assert.equal(result?.session?.sourceId, sourceId, 'session must belong to the explicitly selected fixture');
    assert.equal(result.session.systemId, systemId, 'session must belong to the explicitly selected system');
    assert.ok(onCreatedSession(result.session), 'session must have a valid cleanup identity');
    return result;
  };
  const trackSubmission = (submission, sessionId) => {
    assert.ok(sessions.has(sessionId), 'submission must originate from a session created by this run');
    assert.equal(submission?.sessionId, sessionId, 'submission must belong to its requested session');
    assert.ok(uuid(submission.id), 'submission must have a valid identity');
    assert.ok(!submissions.has(submission.id) || submissions.get(submission.id) === sessionId, 'submission cannot change sessions');
    submissions.set(submission.id, sessionId);
  };
  const onAcceptedPublication = (publication, requestedSubmissionId) => {
    if (!uuid(publication?.id) || publication.sourceId !== sourceId || publication.submissionId !== requestedSubmissionId || !submissions.has(publication.submissionId)) return false;
    const existing = publications.get(publication.id);
    if (existing && existing.submissionId !== publication.submissionId) return false;
    publications.set(publication.id, { sourceId, submissionId: publication.submissionId, sessionId: submissions.get(publication.submissionId) });
    publicationAttempts.delete(publication.submissionId);
    return true;
  };
  const onPublicationAttempt = submissionId => {
    if (!submissions.has(submissionId)) return false;
    publicationAttempts.set(submissionId, { submissionId, sessionId: submissions.get(submissionId) });
    return true;
  };
  return { sessions, publications, publicationAttempts, onCreatedSession, trackedSession, trackSubmission, onPublicationAttempt, onAcceptedPublication };
}

/** An uncertain publication may still be using its fork. Preserve it for inspection. */
export async function cleanupRunResources(resources, { drainPublication, closeSession }) {
  const publicationCleanup = [], cleanup = [], failures = [], blockedSessions = new Set();
  const unresolvedAttempts = new Map(resources.publicationAttempts);
  for (const [id, owned] of resources.publications) {
    try {
      const { publication } = await drainPublication(id);
      assert.equal(publication.id, id);
      assert.equal(publication.sourceId, owned.sourceId);
      assert.equal(publication.submissionId, owned.submissionId);
      assert.ok(terminalPublicationStatuses.has(publication.status));
      publicationCleanup.push({ publicationId: id, drained: true, status: publication.status });
      unresolvedAttempts.delete(owned.submissionId);
    } catch {
      publicationCleanup.push({ publicationId: id, drained: false, reason: 'publication_state_unconfirmed' });
      blockedSessions.add(owned.sessionId);
    }
  }
  const publicationAttempts = [...unresolvedAttempts.values()].map(attempt => ({ ...attempt, confirmed: false, reason: 'publication_acceptance_unconfirmed' }));
  for (const attempt of publicationAttempts) blockedSessions.add(attempt.sessionId);
  // Closing a draft also closes its children; protect tracked ancestors too.
  for (const id of blockedSessions) {
    const parent = resources.sessions.get(id)?.draftSessionId;
    if (parent) blockedSessions.add(parent);
  }
  for (const id of [...resources.sessions.keys()].reverse()) {
    if (blockedSessions.has(id)) {
      cleanup.push({ sessionId: id, closed: false, skipped: true, reason: 'publication_state_unconfirmed' });
      failures.push(id);
      continue;
    }
    try { await closeSession(id); cleanup.push({ sessionId: id, closed: true }); }
    catch { cleanup.push({ sessionId: id, closed: false }); failures.push(id); }
  }
  return { publicationCleanup, publicationAttempts, cleanup, failures };
}
