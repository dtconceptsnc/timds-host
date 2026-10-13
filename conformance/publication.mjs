import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

/** Failed/closing receipts may recover through the host's normal execution queue. */
export async function waitForPublication(id, read, { timeoutMs, intervalMs = 2_000, now = Date.now, wait = sleep, onRetry = () => {} }) {
  const deadline = now() + timeoutMs, observed = new Set();
  while (now() < deadline) {
    const value = await read(), publication = value.publication;
    assert.equal(publication.id, id, 'publication read must return the requested identity');
    if (publication.status === 'published') return value;
    if (['cancelled', 'dead_letter', 'superseded'].includes(publication.status)) throw new Error(`publication ${id} ended as ${publication.status}`);
    if (publication.status === 'failed' || publication.status === 'closing' && publication.error) {
      // Record state, not the host's free-text error or response body.
      const state = { publicationId: id, status: publication.status, stage: publication.stage, errorReported: Boolean(publication.error) };
      const key = JSON.stringify(state);
      if (!observed.has(key)) {
        observed.add(key);
        onRetry({ ...state, observedAt: new Date(now()).toISOString() });
      }
    }
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`publication ${id} did not finish within ${timeoutMs}ms`);
}
