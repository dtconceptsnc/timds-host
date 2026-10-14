import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConformanceClient } from './client.mjs';
import { readPreview } from './assertions.mjs';
import { readLifecycleConfiguration, assertNewLifecycleFixture, createLifecycleClient, createLifecycleResources, readAdminPages } from './lifecycle.mjs';

test('new native Design System creation and reviewed teardown', { timeout: 3_600_000 }, async t => {
  const config = readLifecycleConfiguration(), runId = randomUUID(), operationId = randomUUID();
  const evidence = { suiteVersion: 1, runId, operationId, sourceId: config.sourceId, startedAt: new Date().toISOString(), passed: false, phases: [], operations: {}, deletion: null, cleanup: null };
  const onResponse = ({ operationId, status }) => { const key = `${operationId}:${status}`; evidence.operations[key] = (evidence.operations[key] || 0) + 1; };
  const admin = createLifecycleClient(config, { onResponse });
  const work = createConformanceClient({ url: config.url, token: config.token, onResponse, onCreatedSession: session => resources?.trackSession({ session }) });
  const phase = name => { t.diagnostic(name); evidence.phases.push(name); };
  const waitFor = async (label, read, done) => {
    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) { const value = await read(); if (done(value)) return value; await sleep(2_000); }
    throw new Error(`${label} did not finish within the configured timeout`);
  };
  let resources, createAttempted = false, deletionId = null, completed = false;
  const deleteFixture = async ({ rejectMismatch = false } = {}) => {
    deletionId = randomUUID();
    const impact = await admin.prepareDeletion(deletionId);
    const reviewed = resources.reviewDeletion(impact, deletionId);
    evidence.deletion = { operationId: deletionId, status: impact.status, counts: impact.counts, retention: impact.retention };
    if (rejectMismatch) {
      await admin.confirmDeletion(reviewed, resources, { mismatchedName: true });
      assert.equal((await admin.deletion(deletionId)).status, 'awaiting_confirmation', 'a typed-name mismatch leaves deletion inert');
    }
    const queued = await admin.confirmDeletion(reviewed, resources);
    assert.equal(queued.sourceId, config.sourceId); assert.equal(queued.operationId, deletionId);
    const final = await waitFor('Deletion', () => admin.deletion(deletionId), row => {
      assert.equal(row.sourceId, config.sourceId); assert.equal(row.operationId, deletionId);
      evidence.deletion.status = row.status; evidence.deletion.phase = row.phase;
      assert.ok(!['failed', 'awaiting_consumer_proof'].includes(row.status), 'deletion paused; retain its receipt for operator review');
      return row.status === 'completed';
    });
    completed = true; evidence.deletion.completedAt = final.completedAt;
    assert.equal((await admin.confirmDeletion(reviewed, resources)).status, 'completed', 'completed confirmation retries are idempotent');
  };
  t.after(async () => {
    let failed = false;
    if (createAttempted && !completed) {
      try {
        resources.acceptProvision(await admin.provision(operationId));
        // Never bypass an already confirmed fence, or invent a new review after
        // a paused destructive step. The original receipt remains inspectable.
        if (deletionId) {
          const prior = await admin.deletion(deletionId);
          if (prior.status === 'completed') completed = true;
          else if (prior.status !== 'awaiting_confirmation') throw new Error('Deletion needs operator review');
        }
        if (!completed) await deleteFixture();
        evidence.cleanup = { completed: true, operationId: deletionId };
      } catch { failed = true; evidence.cleanup = { completed: false, operationId: deletionId, reason: 'ownership_or_cleanup_unconfirmed' }; }
    }
    evidence.finishedAt = new Date().toISOString();
    if (failed) evidence.passed = false;
    await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
    await writeFile(new URL(`./artifacts/lifecycle-${runId}.json`, import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    assert.equal(failed, false, 'cleanup remains unconfirmed; use the exact redacted operation IDs for operator review');
  });

  phase('Refuse existing identities and verify administrator, organization and namespace');
  const actorPrincipalId = await assertNewLifecycleFixture(admin, config);
  resources = createLifecycleResources(config, { operationId, actorPrincipalId });
  const input = { operationId, sourceId: config.sourceId, organizationId: config.organizationId, systemId: config.systemId, name: `TimDS conformance lifecycle ${runId.slice(0, 8)}`, namespace: config.namespace, starterVersion: 1 };

  phase('Create the pinned starter, retry exactly and reject changed creation input');
  createAttempted = true;
  const created = await admin.create(input);
  assert.equal(created.source.id, config.sourceId); assert.equal(created.source.system_id, config.systemId);
  assert.equal(created.source.lifecycle_status, 'ready');
  const proof = resources.acceptProvision(await admin.provision(operationId));
  assert.equal(proof.provision.status, 'completed'); assert.equal(proof.source.lifecycleStatus, 'ready');
  assert.equal((await admin.create(input)).source.id, config.sourceId);
  const replay = resources.acceptProvision(await admin.provision(operationId));
  assert.equal(replay.provision.fileTreeDigest, proof.provision.fileTreeDigest); assert.equal(replay.source.sourceCommit, proof.source.sourceCommit);
  await admin.create({ ...input, name: `${input.name} changed` }, [409]);
  assert.ok((await admin.catalogue()).systems.some(row => row.id === config.sourceId && row.systemId === config.systemId));

  phase('Start a main session and draft, submit authored work and require working Preview HTML');
  const session = resources.trackSession(await work.start({ systemId: config.systemId, idempotencyKey: `lifecycle:${runId}:session` }));
  const snapshot = await work.pull(session.session.id);
  const manifest = JSON.parse(Buffer.from(snapshot.files.find(file => file.path === 'timds.json').content, 'base64').toString('utf8'));
  assert.equal(manifest.systemId, config.systemId); assert.equal(manifest.name, input.name);
  const draft = resources.trackSession(await work.draftCreate(config.sourceId, { name: `lifecycle-${runId.slice(0, 8)}`, from: 'main', idempotencyKey: `lifecycle:${runId}:draft` }));
  assert.equal((await work.previewTokens(config.sourceId, draft.session.id)).status, 200, 'draft public CSS exists before deletion');
  const submission = await work.submit(session.session.id, { baseRevision: snapshot.session.baseRevision, lastUpdateHash: snapshot.session.lastUpdateHash || '', changedFiles: [{ path: 'src/pages/index.html', mode: '100644', encoding: 'base64', content: Buffer.from(`<section class="block"><h1>Lifecycle conformance</h1><p>This new disposable system proves creation and teardown.</p><p>Fixture ${runId}</p></section>\n`).toString('base64') }], deletedPaths: [], note: 'Lifecycle conformance: prove hosted starter authoring' });
  assert.equal(submission.submission.sessionId, session.session.id); assert.ok(submission.submission.id);
  const previewUrl = submission.submission.previewUrl;
  await waitFor('Frozen submission Preview', () => readPreview(previewUrl), result => result.ready);
  const preview = await fetch(previewUrl, { headers: { Accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(preview.status, 200); assert.ok((await preview.text()).includes(`Fixture ${runId}`), 'the anonymous Preview contains this run\'s authored bytes');

  phase('Review exact native deletion impact, reject a typed mismatch and complete teardown');
  await deleteFixture({ rejectMismatch: true });

  phase('Retain administrative history and permanently retire source authority');
  const history = await admin.deletionHistory(deletionId);
  assert.equal(history.operation.status, 'completed');
  for (const id of resources.sessions) assert.ok(history.sessions.some(row => row.id === id && ['closed', 'expired'].includes(row.status)), 'all created session histories remain closed');
  assert.ok(history.events.length > 0, 'audit history remains available to administrators');
  const systems = await readAdminPages(admin.systems, { collection: 'systems', cursor: 'nextSystemCursor' });
  const tombstone = systems.rows.find(row => row.id === config.sourceId);
  assert.equal(tombstone?.lifecycleStatus, 'deleted'); assert.equal(tombstone.systemId, config.systemId);
  assert.ok(!(await admin.catalogue()).systems.some(row => row.id === config.sourceId), 'ordinary catalog omits deleted identity');
  await admin.create({ ...input, operationId: randomUUID() }, [409]);
  await admin.create(input, [409]);
  await assert.rejects(work.start({ systemId: config.systemId, idempotencyKey: `lifecycle:${runId}:retired` }), error => [403, 404, 409, 410].includes(error.status));
  for (const id of resources.sessions) await assert.rejects(work.pull(id), error => [403, 404, 409, 410].includes(error.status));
  await admin.retiredDraftCss(draft.session.id);
  const afterPreview = await readPreview(previewUrl).catch(() => ({ ready: false }));
  assert.equal(afterPreview.ready, false, 'the removed Preview no longer serves this submission');
  evidence.passed = true;
});
