import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConformanceClient } from './client.mjs';
import { createMcpConformanceClient } from './mcp.mjs';
import { readConfiguration } from './config.mjs';
import { assertConsecutiveVersions, readPublicStamp, readPreview } from './assertions.mjs';
import { createRunResources, cleanupRunResources, terminalPublicationStatuses } from './resources.mjs';
import { waitForPublication } from './publication.mjs';

const encoded = (path, value) => ({ path, encoding: 'base64', mode: '100644', content: Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`).toString('base64') });
const jsonFile = (snapshot, path) => {
  const file = snapshot.files?.find(file => file.path === path);
  assert.ok(file, `snapshot contains ${path}`);
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
};
const change = (snapshot, files, note, extra = {}) => ({ baseRevision: snapshot.session.baseRevision, lastUpdateHash: snapshot.session.lastUpdateHash || '', changedFiles: files, deletedPaths: [], note, ...extra });
const clean = result => { assert.notEqual(result.stale, true, 'write must not be stale'); assert.deepEqual(result.conflicts || [], [], 'write must merge without conflict'); return result; };
const PUBLICATION_STAGES = ['preflight', 'merge', 'build', 'prepare', 'release', 'flip', 'close'];
// Event types must appear in this relative order; other rows may interleave.
const assertOrdered = (rows, types, message) => {
  let position = -1;
  for (const type of types) {
    const next = rows.findIndex((row, index) => index > position && row.event_type === type);
    assert.ok(next > position, `${message}: ${type} missing or out of order`);
    position = next;
  }
};

test('TimDS v1 complete disposable-host conformance', { timeout: 3_600_000 }, async t => {
  // Fail, rather than skip or silently select a real system, when unconfigured.
  const config = readConfiguration();
  const runId = randomUUID(), short = runId.slice(0, 8), resources = createRunResources(config);
  const evidence = { suiteVersion: 1, toolkitVersion: '0.1.464', host: config.url, sourceId: config.sourceId, runId, startedAt: new Date().toISOString(), passed: false, operations: {}, publications: [], publicationRetries: [], checks: [], cleanup: [] };
  const onResponse = ({ operationId, status }) => { const key = `${operationId}:${status}`; evidence.operations[key] = (evidence.operations[key] || 0) + 1; };
  const client = createConformanceClient({ url: config.url, token: config.token, onResponse, onCreatedSession: resources.onCreatedSession, onPublicationAttempt: resources.onPublicationAttempt, onAcceptedPublication: resources.onAcceptedPublication });
  const member = createConformanceClient({ url: config.url, token: config.memberToken, onResponse });
  const mcp = createMcpConformanceClient({ url: config.url, token: config.token, onResponse, onCreatedSession: resources.onCreatedSession });
  const memberMcp = createMcpConformanceClient({ url: config.url, token: config.memberToken, onResponse });
  const tracked = resources.trackedSession;
  const phase = name => { t.diagnostic(name); evidence.checks.push(name); };
  const waitFor = async (name, read, accepted, failed) => {
    const deadline = Date.now() + config.timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (failed(value)) throw new Error(`${name} failed (see host's named check or Request error)`);
      if (accepted(value)) return value;
      await sleep(2_000);
    }
    throw new Error(`${name} did not finish within ${config.timeoutMs}ms`);
  };
  const publicationDone = id => waitForPublication(id, () => client.publication(id), { timeoutMs: config.timeoutMs, onRetry: event => evidence.publicationRetries.push(event) });
  // Walk the feed from a cursor; seq must be consecutive (no gaps, no repeats),
  // and a second walk from the same cursor must replay the same rows.
  const readFeed = async after => {
    const events = []; let cursor = after, page;
    do {
      page = await client.events(config.sourceId, cursor, 500);
      events.push(...page.events); cursor = page.events.at(-1)?.seq ?? cursor;
    } while (page.hasMore && page.events.length);
    events.forEach((row, index) => assert.equal(row.seq, after + 1 + index, 'event feed seq is gapless and ascending'));
    assert.ok(page.latestSeq >= cursor, 'latestSeq covers every returned event');
    const replay = [];
    for (cursor = after; replay.length < events.length;) {
      const again = await client.events(config.sourceId, cursor, 500);
      if (!again.events.length) break;
      replay.push(...again.events); cursor = again.events.at(-1).seq;
    }
    assert.deepEqual(replay.slice(0, events.length).map(row => row.id), events.map(row => row.id), 'events?after= replays the same rows exactly once');
    return events;
  };
  t.after(async () => {
    // Only settled publications are safe to close; failed ones may still retry.
    const { cleanup, publicationCleanup, publicationAttempts, failures } = await cleanupRunResources(resources, {
      drainPublication: id => waitFor(`publication cleanup ${id}`, () => client.publication(id), value => terminalPublicationStatuses.has(value.publication.status), () => false),
      closeSession: id => client.close(id),
    });
    evidence.cleanup = cleanup;
    evidence.publicationCleanup = publicationCleanup;
    evidence.publicationAttempts = publicationAttempts;
    evidence.finishedAt = new Date().toISOString();
    if (failures.length) evidence.passed = false;
    await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
    await writeFile(new URL(`./artifacts/${runId}.json`, import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
    assert.deepEqual(failures, [], 'cleanup incomplete; unconfirmed publications preserve their sessions; inspect the redacted evidence for IDs');
  });

  phase('Verify explicit disposable source and publisher access');
  const before = await client.activeWork(config.sourceId);
  assert.equal(before.sourceId, config.sourceId);
  assert.equal(before.canPublish, true, 'the fixture caller must have a publisher grant');
  assert.equal(before.sessions.length, 0, 'fixture must have no active sessions from another run');
  assert.equal(before.drafts.length, 0, 'fixture must have no active drafts from another run');
  const feedStart = (await client.events(config.sourceId, 0, 1)).latestSeq;
  assert.ok(Number.isInteger(feedStart) && feedStart >= 0, 'event feed exposes latestSeq');
  await assert.rejects(client.events(config.sourceId, -1), /HTTP 400/, 'a negative cursor is rejected');
  await assert.rejects(client.events(config.sourceId, 0, 0), /HTTP 400/, 'a zero limit is rejected');
  phase('Authenticated MCP discovery and session receipts');
  await assert.rejects(createMcpConformanceClient({ url: config.url }).initialize(), error => error.status === 401, 'private MCP requires an OAuth bearer');
  await mcp.initialize();
  const designerTools = ['list_systems', 'get_system', 'get_active_work', 'list_submissions', 'list_drafts', 'start_session', 'get_session', 'get_session_history', 'list_session_files', 'read_session_file', 'update_session', 'submit_session', 'close_session', 'join_session', 'claim_session', 'create_draft', 'create_request', 'get_request', 'get_events'];
  const availableTools = await mcp.listTools();
  for (const name of designerTools) assert.ok(availableTools.some(tool => tool.name === name), `authenticated MCP advertises ${name}`);
  const systems = await mcp.call('list_systems');
  assert.ok(systems.systems.some(system => system.id === config.sourceId && system.systemId === config.systemId), 'MCP discovery returns the selected accessible system');
  await mcp.call('get_system', { systemId: config.sourceId });
  assert.equal((await mcp.call('get_active_work', { systemId: config.systemId })).sourceId, config.sourceId);
  assert.equal((await mcp.call('get_events', { systemId: config.systemId, after: 0, limit: 1 })).latestSeq, feedStart);
  const input = { systemId: config.systemId, idempotencyKey: `conformance:${runId}:start`, note: `Conformance ${short}: inspect disposable fixture` };
  const started = tracked(await mcp.call('start_session', input));
  assert.equal(started.files, undefined, 'MCP session receipts do not dump source files');
  const initial = await client.pull(started.session.id);
  assert.match(jsonFile(initial, 'timds.json').name, /^TimDS conformance\b/i, 'fixture manifest name must begin "TimDS conformance"; refuse production-source changes');
  assert.equal(jsonFile(initial, 'timds.json').systemId, config.systemId);
  assert.equal(jsonFile(initial, '.timds/contract-layout.json').schemaVersion, 1, 'fixture requires grouped token contracts');
  assert.equal((await client.start(input)).session.id, initial.session.id, 'same start key recovers the same session');
  assert.equal((await mcp.call('start_session', input)).session.id, initial.session.id, 'MCP retries reuse the same session as the CLI HTTP client');
  assert.equal((await mcp.call('get_session', { sessionId: initial.session.id })).session.baseRevision, initial.session.baseRevision);
  assert.equal((await client.pull(initial.session.id)).session.baseRevision, initial.session.baseRevision);
  const filePage = await mcp.call('list_session_files', { sessionId: initial.session.id, limit: 1 });
  assert.equal(filePage.returned, 1); assert.equal(filePage.files.length, 1);
  assert.equal(filePage.files[0].content, undefined, 'file directory contains metadata without file content');
  assert.ok(filePage.nextAfter, 'fixture source has more than one file');
  const nextPage = await mcp.call('list_session_files', { sessionId: initial.session.id, after: filePage.nextAfter, limit: 1 });
  assert.ok(nextPage.files[0].path > filePage.files[0].path, 'file pagination advances through stable source paths');
  const manifestFile = initial.files.find(file => file.path === 'timds.json'), manifestBytes = Buffer.from(manifestFile.content, 'base64');
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
  const chunks = []; let offset = 0;
  do {
    const page = await mcp.call('read_session_file', { sessionId: initial.session.id, path: 'timds.json', offset, limit: 31 });
    assert.equal(page.session.baseRevision, initial.session.baseRevision);
    assert.equal(page.session.lastUpdateHash, initial.session.lastUpdateHash);
    assert.equal(page.file.sha256, manifestHash); assert.equal(page.file.offset, offset);
    const chunk = Buffer.from(page.file.content, page.file.encoding);
    assert.equal(chunk.length, page.file.length); assert.ok(chunk.length <= 31);
    chunks.push(chunk); offset = page.file.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), manifestBytes, 'bounded MCP reads reconstruct the exact source bytes');
  await assert.rejects(mcp.call('read_session_file', { sessionId: initial.session.id, path: '../timds.json' }), error => error.status === 400, 'MCP source reads reject traversal');
  await mcp.call('close_session', { sessionId: initial.session.id });

  phase('Draft lifecycle, invitations, member identity, advisory overlaps and shared CAS');
  const draftName = `conformance-${short}`;
  let draft = tracked(await mcp.call('create_draft', { systemId: config.systemId, name: draftName, from: 'main', idempotencyKey: `conformance:${runId}:draft` }));
  assert.equal(draft.session.kind, 'draft'); assert.equal(draft.session.expiresAt, null);
  const tokenPath = `tokens/color.conformance-${short}.json`;
  const baseTokens = { primary: { value: '#101010' }, secondary: { value: '#202020' } };
  draft = clean(await mcp.call('update_session', { sessionId: draft.session.id, ...change(draft, [{ path: tokenPath, encoding: 'utf8', content: `${JSON.stringify(baseTokens, null, 2)}\n` }], `Conformance ${short}: seed draft token keys`) }));
  assert.deepEqual(jsonFile(await client.pull(draft.session.id), tokenPath), baseTokens, 'MCP UTF-8 writes preserve source content');
  assert.ok((await client.draftList(config.sourceId)).drafts.some(row => row.id === draft.session.id));
  assert.ok((await mcp.call('list_drafts', { systemId: config.systemId })).drafts.some(row => row.id === draft.session.id));
  assert.equal((await client.draftSnapshot(config.sourceId, draftName)).session.id, draft.session.id);
  assert.notEqual(draft.session.ownerPrincipalId, config.memberPrincipalId, 'member must be a distinct principal');
  await client.join(draft.session.id, { principalId: config.memberPrincipalId });
  await memberMcp.initialize();
  const joined = await memberMcp.call('join_session', { sessionId: draft.session.id });
  assert.ok(joined.members.some(row => row.principalId === config.memberPrincipalId));
  await client.claim(draft.session.id, { patterns: ['tokens/**'], note: `Conformance ${short}: owner intent` });
  const claimed = await memberMcp.call('claim_session', { sessionId: draft.session.id, patterns: [tokenPath], note: `Conformance ${short}: member intent` });
  assert.ok(claimed.overlaps.some(claim => claim.note === `Conformance ${short}: owner intent`));
  const old = await member.pull(draft.session.id);
  const ownerChange = { ...baseTokens, secondary: { value: '#212121' } };
  draft = clean(await client.update(draft.session.id, change(draft, [encoded(tokenPath, ownerChange)], `Conformance ${short}: advance shared revision`)));
  const stale = await memberMcp.call('update_session', { sessionId: draft.session.id, ...change(old, [encoded(tokenPath, { ...baseTokens, primary: { value: '#111111' } })], `Conformance ${short}: reject stale shared write`) });
  assert.equal(stale.stale, true); assert.equal(stale.rebasedChanges, undefined);
  assert.equal(stale.rebasedChangesOmitted, true); assert.equal(stale.rereadRequired, true, 'MCP stale receipts require an explicit source reread');
  const httpStale = await member.update(draft.session.id, change(old, [encoded(tokenPath, { ...baseTokens, primary: { value: '#111111' } })], `Conformance ${short}: reject stale shared write`));
  assert.equal(httpStale.stale, true); assert.ok(httpStale.rebasedChanges, 'HTTP stale response still provides changes to reapply');
  assert.deepEqual(jsonFile(await client.pull(draft.session.id), tokenPath), ownerChange, 'stale CAS cannot overwrite shared head');
  const staleHash = await memberMcp.call('update_session', { sessionId: draft.session.id, ...change(draft, [], `Conformance ${short}: reject stale hash on the current revision`, { lastUpdateHash: '0'.repeat(64) }) });
  assert.equal(staleHash.stale, true, 'a current baseRevision does not override a stale explicit CAS hash');
  assert.equal((await member.update(draft.session.id, change(draft, [], `Conformance ${short}: reject stale hash on the current revision`, { lastUpdateHash: '0'.repeat(64) }))).stale, true, 'the HTTP client enforces the same explicit CAS hash');
  assert.deepEqual(jsonFile(await client.pull(draft.session.id), tokenPath), ownerChange);

  phase('Different-key merge, same-key conflict and revision-bound resolution');
  const openChild = suffix => client.start({ systemId: config.systemId, draft: draftName, idempotencyKey: `conformance:${runId}:${suffix}`, note: `Conformance ${short}: ${suffix}` }).then(tracked);
  const a = await openChild('draft-a'), b = await openChild('draft-b'), c = await openChild('draft-c');
  const upstreamTokens = { ...ownerChange, primary: { value: '#121212' } };
  const integrated = clean(await client.submit(a.session.id, change(a, [encoded(tokenPath, upstreamTokens)], `Conformance ${short}: integrate upstream primary`)));
  assert.equal(integrated.submission.targetDraftSessionId, draft.session.id);
  const bUpdate = clean(await client.update(b.session.id, change(b, [encoded(tokenPath, { ...ownerChange, secondary: { value: '#222222' } })], `Conformance ${short}: independent secondary key`)));
  assert.deepEqual(jsonFile(bUpdate, tokenPath), { ...upstreamTokens, secondary: { value: '#222222' } });
  const conflictingChange = change(c, [encoded(tokenPath, { ...ownerChange, primary: { value: '#131313' } })], `Conformance ${short}: conflicting primary key`);
  const conflict = await client.update(c.session.id, conflictingChange);
  assert.deepEqual(conflict.conflicts, [{ path: tokenPath, key: 'primary.value', base: '#101010', mine: '#131313', theirs: '#121212' }], 'same-key conflict identifies the exact base, local and upstream token values');
  assert.deepEqual(jsonFile(await client.pull(c.session.id), tokenPath), ownerChange, 'conflicted update leaves the fork unchanged');
  const resolution = conflict.conflicts.filter(item => item.path === tokenPath).map(item => `${item.path}#${item.key}=theirs`);
  await assert.rejects(client.update(c.session.id, { ...conflictingChange, mainRevision: '0'.repeat(40), resolvedPaths: resolution }), error => error.status === 409, 'a resolution against an obsolete upstream revision must be rejected');
  assert.deepEqual(jsonFile(await client.pull(c.session.id), tokenPath), ownerChange, 'rejected resolution leaves the fork unchanged');
  const resolved = clean(await client.update(c.session.id, { ...conflictingChange, mainRevision: conflict.mainRevision, resolvedPaths: resolution }));
  assert.equal(jsonFile(resolved, tokenPath).primary.value, '#121212');
  clean(await client.submit(b.session.id, change(bUpdate, [], `Conformance ${short}: integrate independent secondary`)));
  const draftHead = await client.draftSnapshot(config.sourceId, draftName);
  assert.deepEqual(jsonFile(draftHead, tokenPath), { ...upstreamTokens, secondary: { value: '#222222' } });

  phase('Public CSS, status and principal/intent history');
  const css = await client.previewTokens(config.sourceId, draftName);
  assert.equal(css.status, 200); assert.match(await css.text(), /#121212/);
  assert.equal((await client.previewTokens(config.sourceId, draftName, 'HEAD')).status, 200);
  const status = await client.status(draft.session.id);
  assert.ok(status.members.some(row => row.principalId === config.memberPrincipalId));
  const history = await client.history(draft.session.id);
  assert.ok(history.events.some(row => row.actor_principal_id === config.memberPrincipalId && row.note === `Conformance ${short}: reject stale shared write`));
  assert.ok((await mcp.call('get_session_history', { sessionId: draft.session.id })).events.some(row => row.actor_principal_id === config.memberPrincipalId && row.note === `Conformance ${short}: reject stale shared write`));
  const closedDraft = await client.draftClose(config.sourceId, draftName);
  assert.equal(closedDraft.session.status, 'closed');
  assert.equal((await client.previewTokens(config.sourceId, draft.session.id)).status, 404);
  assert.equal((await client.previewTokens(config.sourceId, draft.session.id, 'HEAD')).status, 404);

  phase('FIFO publication of two submissions, immutable versions and rollback');
  const first = tracked(await client.start({ systemId: config.systemId, idempotencyKey: `conformance:${runId}:publish-a`, note: `Conformance ${short}: first publication` }));
  const second = tracked(await client.start({ systemId: config.systemId, idempotencyKey: `conformance:${runId}:publish-b`, note: `Conformance ${short}: second publication` }));
  const submitted = [];
  for (const [index, snapshot] of [first, second].entries()) {
    const note = `Conformance ${short}: FIFO publication ${index + 1}`;
    const body = change(snapshot, [encoded(`docs/conformance-${short}-${index}.md`, `${note}\n`)], note);
    const result = clean(index === 0 ? await mcp.call('submit_session', { sessionId: snapshot.session.id, ...body }) : await client.submit(snapshot.session.id, body));
    resources.trackSubmission(result.submission, snapshot.session.id);
    assert.equal((await client.submit(snapshot.session.id, body)).submission.id, result.submission.id, 'retry must reuse the frozen submission');
    if (index === 0) assert.equal((await mcp.call('submit_session', { sessionId: snapshot.session.id, ...body })).submission.id, result.submission.id, 'MCP submit retries preserve the frozen submission');
    submitted.push(result.submission);
  }
  await Promise.all(submitted.map(submission => waitFor(`submission Preview ${submission.id}`, () => readPreview(submission.previewUrl), result => result.ready, result => [401, 403].includes(result.status))));
  const dry = await client.publish(submitted[0].id, { dryRun: true });
  assert.equal(dry.preflight.dryRun, true); assert.equal(dry.preflight.buildChecked, true); assert.equal(dry.preflight.currency, 'clean');
  assert.equal((await client.status(first.session.id)).session.status, 'open', 'dry run cannot close the source session');
  for (const submission of submitted) {
    const result = await client.publish(submission.id, {});
    assert.ok(resources.onAcceptedPublication(result.publication, submission.id), 'accepted publication must belong to this run');
  }
  assert.equal(resources.publications.size, submitted.length, 'each submission has its own publication');
  const [one, two] = await Promise.all([...resources.publications.keys()].map(publicationDone));
  const p1 = one.publication, p2 = two.publication;
  assert.ok(Number.isInteger(p1.queuePosition) && Number.isInteger(p2.queuePosition), 'publications expose FIFO positions');
  assert.ok(p1.queuePosition < p2.queuePosition, 'acceptance order is queue order');
  assert.ok(Date.parse(p1.completedAt) <= Date.parse(p2.completedAt), 'second publication cannot finish before the first');
  const v1 = p1.result.version, v2 = p2.result.version;
  assertConsecutiveVersions(v1, v2, { startedAt: evidence.startedAt, finishedAt: new Date().toISOString() });
  evidence.publications = [p1, p2].map(row => ({ id: row.id, version: row.result.version, queuePosition: row.queuePosition }));
  const listed = await client.submissions(config.sourceId);
  for (const submission of submitted) assert.equal(listed.submissions.find(row => row.id === submission.id)?.status, 'published');
  const mcpSubmissions = await mcp.call('list_submissions', { systemId: config.systemId });
  for (const submission of submitted) assert.equal(mcpSubmissions.submissions.find(row => row.id === submission.id)?.status, 'published');
  for (const id of [first.session.id, second.session.id]) assert.equal((await client.history(id)).session.status, 'closed');
  const publicRoot = new URL(p2.result.publicRoot);
  const publicMcp = createMcpConformanceClient({ url: publicRoot.origin, publicRead: true, onResponse });
  await publicMcp.initialize();
  const publicTools = await publicMcp.listTools();
  assert.ok(publicTools.some(tool => tool.name === 'describe_system'));
  for (const name of [...designerTools, 'report_gap']) assert.ok(!publicTools.some(tool => tool.name === name), `anonymous MCP cannot advertise ${name}`);
  const currentStampUrl = new URL('.timds-artifact.json', publicRoot);
  const pinnedOne = await readPublicStamp(p1.result.versionedUrls.artifact, { systemId: config.systemId, version: v1 });
  const pinnedTwo = await readPublicStamp(p2.result.versionedUrls.artifact, { systemId: config.systemId, version: v2 });
  const currentVersion = expected => waitFor(`public pointer ${expected}`, () => readPublicStamp(currentStampUrl, { systemId: config.systemId }), stamp => stamp.version === expected, () => false);
  assert.deepEqual(await currentVersion(v2), pinnedTwo, 'current pointer initially serves the second immutable publication');
  assert.equal((await client.rollback(config.sourceId, { version: v1, dryRun: true })).dryRun, true);
  assert.deepEqual(await readPublicStamp(currentStampUrl, { systemId: config.systemId }), pinnedTwo, 'rollback dry run does not move the public pointer');
  assert.equal((await client.rollback(config.sourceId, { version: v1 })).action, 'rollback');
  assert.deepEqual(await currentVersion(v1), pinnedOne, 'rollback actually selects the first immutable publication');
  assert.deepEqual(await readPublicStamp(p2.result.versionedUrls.artifact, { systemId: config.systemId, version: v2 }), pinnedTwo, 'rollback does not change the newer pinned artifact');
  assert.equal((await client.rollback(config.sourceId, { version: v2 })).action, 'rollback', 'restore the newest fixture publication after proving rollback');
  assert.deepEqual(await currentVersion(v2), pinnedTwo);

  phase('Event feed replays sessions, members, claims and every publication stage');
  const runFeed = await readFeed(feedStart);
  assertOrdered(runFeed.filter(row => row.session_id === draft.session.id), ['draft_created', 'member_joined', 'claimed', 'updated', 'closed'], 'draft lifecycle feed');
  assert.ok(runFeed.some(row => row.event_type === 'member_joined' && row.session_id === draft.session.id && row.details_json?.principalId === config.memberPrincipalId), 'invited member join is in the feed');
  assert.ok(runFeed.some(row => row.event_type === 'session_started' && row.session_id === first.session.id), 'session start is in the feed');
  for (const publication of [p1, p2]) {
    const rows = runFeed.filter(row => row.details_json?.publicationId === publication.id);
    assert.equal(rows[0]?.event_type, 'publication_queued', 'publication feed begins when the publication is queued');
    assert.deepEqual([...new Set(rows.filter(row => row.event_type === 'publication_stage').map(row => row.details_json.stage))], PUBLICATION_STAGES, 'one publication_stage per Workflow stage, in order');
    assertOrdered(rows, ['publication_queued', 'publication_stage', 'published'], `publication ${publication.id} feed`);
    const flip = rows.find(row => row.event_type === 'publication_stage' && row.details_json.stage === 'flip');
    assert.ok(rows.find(row => row.event_type === 'published').seq > flip.seq, 'published commits during the flip stage');
  }

  phase('Designer Request completes with a frozen submission');
  const requestSession = tracked(await client.start({ systemId: config.systemId, idempotencyKey: `conformance:${runId}:request`, note: `Conformance ${short}: Request fixture` }));
  const requestId = randomUUID();
  const requestFeedStart = (await client.events(config.sourceId, 0, 1)).latestSeq;
  const request = { requestId, sessionId: requestSession.session.id, prompt: `This is disposable TimDS host conformance ${short}. Create only docs/conformance-request-${short}.md containing exactly "TimDS host conformance ${short} passed." followed by a newline. Submit this change with the note "Conformance ${short}: designer Request". Do not publish.` };
  const requested = await mcp.call('create_request', { systemId: config.systemId, ...request });
  assert.equal(requested.requestId, requestId);
  assert.equal((await client.startRequest(config.sourceId, request)).executionJobId, requested.executionJobId, 'Request retries preserve execution identity');
  assert.equal((await mcp.call('create_request', { systemId: config.sourceId, ...request })).executionJobId, requested.executionJobId, 'MCP Request retries share the HTTP Request identity');
  const complete = await waitFor(`Request ${requestId}`, () => mcp.call('get_request', { systemId: config.systemId, requestId }), result => Boolean(result.submissionId), result => ['failed', 'dead_letter', 'cancelled'].includes(result.status) || ['failed', 'error', 'conflicted'].includes(result.runner?.state));
  assert.equal((await client.requestStatus(config.sourceId, requestId)).submissionId, complete.submissionId);
  assert.equal(complete.sessionId, requestSession.session.id);
  const requestSnapshot = await client.pull(requestSession.session.id);
  const written = requestSnapshot.files.find(file => file.path === `docs/conformance-request-${short}.md`);
  assert.ok(written, 'Request actually changed the requested source file');
  assert.equal(Buffer.from(written.content, 'base64').toString(), `TimDS host conformance ${short} passed.\n`);
  const requestSubmission = (await client.submissions(config.sourceId)).submissions.find(row => row.id === complete.submissionId);
  assert.ok(requestSubmission, 'Request completion identifies a persisted frozen submission');
  assert.equal(requestSubmission.sessionId, requestSession.session.id);
  assert.equal(requestSubmission.status, 'submitted');
  assert.equal(requestSubmission.headCommit, requestSnapshot.session.baseRevision);
  assert.equal(requestSubmission.note, request.prompt, 'the original human instruction is the submission audit note');
  assert.equal(requestSubmission.publication, null, 'a Request must not start publication');
  assert.deepEqual(await readPublicStamp(currentStampUrl, { systemId: config.systemId }), pinnedTwo, 'the Request cannot move the public pointer');
  const requestFeed = (await readFeed(requestFeedStart)).filter(row => row.originating_request_id === requestId);
  assert.equal(requestFeed.filter(row => row.event_type === 'request_received').length, 1, 'a retried Request is received once');
  assertOrdered(requestFeed, ['request_received', 'member_joined', 'request_started', 'request_submitted', 'submitted'], 'designer Request feed');
  assert.equal(requestFeed.find(row => row.event_type === 'request_submitted').details_json.submissionId, complete.submissionId);
  assert.ok(!requestFeed.some(row => row.event_type === 'request_failed'), 'a completed Request records no failure');
  assert.ok((await client.activeWork(config.sourceId)).events.every(row => Number.isInteger(row.seq)), 'active-work events carry seq');
  await client.close(requestSession.session.id);
  assert.equal((await client.close(requestSession.session.id)).session.status, 'closed', 'close is idempotent');
  assert.equal((await client.history(requestSession.session.id)).session.status, 'closed', 'history survives fork cleanup');
  evidence.passed = true;
});
