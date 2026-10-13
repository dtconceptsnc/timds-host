// Session domain adapted from dtconceptsnc/toperator at 74bceaa (domain unchanged since 2b0148c).
// Portal identity/router/Supabase defaults removed; store, repository and authorization are injected.
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { sessionFilePath, parseSessionResolution } from './paths.mjs';

export const TIMDS_HOST_API_VERSION = 1;
export const TIMDS_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const TIMDS_CHANGESET_MAX_BYTES = 10 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function validateTimdsChangeSet(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || !/^[a-f0-9]{40}$/.test(input.baseRevision || '')) throw fail(400, 'baseRevision must be a full source revision');
  if (!Array.isArray(input.changedFiles) || !Array.isArray(input.deletedPaths) || input.changedFiles.length + input.deletedPaths.length > 4000) throw fail(400, 'A change set requires changedFiles and deletedPaths (up to 4,000 paths)');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) throw fail(400, 'A change note may contain up to 2,000 characters');
  if (input.lastUpdateHash !== undefined && (typeof input.lastUpdateHash !== 'string' || (input.lastUpdateHash !== '' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.lastUpdateHash)))) throw fail(400, 'lastUpdateHash must be the current session hash');
  const paths = new Set(); let total = 0;
  const validatePath = sessionFilePath;
  const safePath = value => {
    validatePath(value);
    if (paths.has(value)) throw fail(400, 'Change set contains a duplicate path');
    paths.add(value); return value;
  };
  const changedFiles = input.changedFiles.map(file => {
    const filePath = safePath(file?.path);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw fail(400, 'Changed file content must be base64');
    if (file.content.length > Math.ceil(TIMDS_CHANGESET_MAX_BYTES / 3) * 4) throw fail(413, 'Change set exceeds 10 MB; upload media to the asset store');
    if (Buffer.from(file.content, 'base64').toString('base64') !== file.content) throw fail(400, 'Changed file content must be canonical base64');
    const bytes = Buffer.byteLength(file.content, 'base64'); total += bytes;
    if (total > TIMDS_CHANGESET_MAX_BYTES) throw fail(413, 'Change set exceeds 10 MB; upload media to the asset store');
    const mode = String(file.mode || '100644');
    if (!['100644', '100755', '120000'].includes(mode)) throw fail(400, 'Changed file mode is unsupported');
    if (mode === '120000') {
      const target = Buffer.from(file.content, 'base64').toString('utf8');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), target));
      const segments = target.split('/');
      if (!target || filePath === '.timds' || target.length > 1000 || target.startsWith('/') || /^[A-Za-z]:/.test(target) || /[\\\x00-\x1f\x7f]/.test(target) || segments.includes('.') || segments.includes('') || segments.findIndex(part => part !== '..') < segments.lastIndexOf('..') || resolved === '..' || resolved.startsWith('../')) throw fail(400, 'Changed link must stay inside the source tree with a safe relative target');
      validatePath(resolved);
    }
    return { path: filePath, encoding: 'base64', content: file.content, mode };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const resolvedPaths = input.resolvedPaths || [];
  if (!Array.isArray(resolvedPaths) || resolvedPaths.length > 4000 || new Set(resolvedPaths).size !== resolvedPaths.length) throw fail(400, 'resolvedPaths must contain unique source paths');
  resolvedPaths.forEach(parseSessionResolution);
  if ((input.mainRevision !== undefined || resolvedPaths.length) && !/^[a-f0-9]{40}$/.test(input.mainRevision || '')) throw fail(400, 'Conflict resolution requires the current mainRevision');
  return { baseRevision: input.baseRevision, changedFiles, deletedPaths: input.deletedPaths.map(safePath).sort(), note: (input.note || '').trim(), ...(input.lastUpdateHash !== undefined ? {lastUpdateHash:input.lastUpdateHash} : {}), ...(resolvedPaths.length ? { resolvedPaths: [...resolvedPaths].sort(), mainRevision: input.mainRevision } : {}) };
}

export const timdsSessionView = (row, source) => ({ id: row.id, systemId: source.system_id, sourceId: row.source_id, baseRevision: row.base_revision, status: row.status, expiresAt: row.expires_at, kind: row.kind || 'session', name: row.name || null, draftSessionId: row.draft_session_id || null, lastUpdateHash: row.last_update_hash || '', ownerPrincipalId: row.owner_principal_id, liveUrl: row.live_url || '', sandboxId: row.sandbox_id || '', liveState: row.live_state || 'stopped' });
export const timdsSubmissionView = row => row && ({ id: row.id, sessionId: row.session_id, baseRevision: row.base_revision, headCommit: row.head_commit, reviewBranch: row.review_branch, previewUrl: row.preview_url, status: row.status, diff: row.diff_json, note: row.note, targetDraftSessionId: row.target_draft_session_id || null, publishedAt: row.published_at, publishedBy: row.published_by, createdAt: row.created_at });

export function createDesignSystemSessions({ repository, authorization, cleanupAgentSession, onSessionReserved, onSessionStarted, store, now = () => Date.now() }) {
  const ready = (source, actor, { closing = false } = {}) => {
    if (!source) throw fail(404, 'Design System not found');
    if (!closing && (source.archived_at || source.lifecycle_status !== 'ready')) throw fail(409, 'Design System is archived or deleting');
    if (!source.artifacts_namespace || !source.artifacts_repository) throw fail(409, 'This Design System has not moved to hosted authoring yet');
  };
  const output = (session, source, extra = {}) => ({ apiVersion: TIMDS_HOST_API_VERSION, session: timdsSessionView(session, source), ...extra });
  const event = (actor, event_type, extra = {}) => ({ event_type, actor_user_id: actor.userId || null, actor_token_id: actor.tokenId || null, actor_principal_id: actor.principalId || null, originating_request_id: actor.requestId || null, ...extra });
  async function owned(id, actor, closing = false) {
    if (!uuid.test(id)) throw fail(404, 'Session not found');
    const session = await store.get(id);
    const member = session && actor.principalId && store.member ? await store.member(id, actor.principalId) : null;
    if (!session || (!actor.operator && session.owner_principal_id !== actor.principalId && !member && !await canPublish(await store.getSource(session.source_id), actor))) throw fail(404, 'Session not found');
    const source = await store.getSource(session.source_id); ready(source, actor, { closing });
    if (actor.principalId && !actor.system) await authorization.authorizeSource(source, { ...actor, sessionOwned: session.owner_principal_id === actor.principalId || Boolean(member) });
    else if (!actor.operator) throw fail(403, 'A TimDS identity is required');
    if (!closing && store.eligible && !await store.eligible(source)) throw fail(409, 'Design System organization, project, or repository is inactive');
    if (!closing && (['closing','closed','expired'].includes(session.status) || (session.expires_at && Date.parse(session.expires_at) <= now()))) throw fail(410, 'Session is closed or expired; start a new session');
    return { session, source };
  }
  async function leased(id, task, publicationId = null) {
    const lease = randomUUID(); const session = await store.claim(id, lease, publicationId);
    try { return await task(session, (patch, submission, audit) => store.checkpoint(id, lease, patch, submission, audit ? { ...audit, originating_request_id: audit.originating_request_id || session.originating_request_id || null } : null)); }
    finally { await store.release(id, lease); }
  }
  const canPublish = async (source, actor) => { try { if (!authorization.authorizePublish) return false; await authorization.authorizePublish(source, actor); return true; } catch (error) { if (![403,404].includes(error.statusCode)) throw error; return false; } };
  const requireNote = (actor, changes) => { if (actor.type === 'agent' && !changes.note) throw fail(400, 'Agent changes require the human instruction in note'); };
  const memberView = row => ({ principalId: row.principal_id, role: row.role, invitedBy: row.invited_by, name: row.principal?.name || row.principal_id, type: row.principal?.type || 'user' });
  const claimView = row => ({ id: row.id, principalId: row.principal_id, name: row.principal?.name || row.principal_id, patterns: row.patterns, note: row.note, expiresAt: row.expires_at, kind: row.kind || 'advisory' });
  async function details(actor, session, source) {
    const [members, claims, submissions, publisher] = await Promise.all([store.members ? store.members(session.id) : [], store.claims ? store.claims(session.id) : [], store.submissions(session.id), canPublish(source, actor)]);
    return { members: members.map(memberView), claims: claims.map(claimView), submissions: submissions.map(timdsSubmissionView), canManage: session.owner_principal_id === actor.principalId || publisher || actor.operator === true, canInvite: session.owner_principal_id === actor.principalId || publisher };
  }
  async function sourceFor(actor, id) {
    const source = uuid.test(id) ? await store.getSource(id) : await store.source(id); ready(source, actor);
    await authorization.authorizeSource(source, actor); return source;
  }
  async function activeWork(actor, id) {
    const source = await sourceFor(actor, id);
    const rows = (await store.sessions(source.id)).filter(row => !row.expires_at || Date.parse(row.expires_at) > now());
    const sessions = await Promise.all(rows.map(async row => ({ ...timdsSessionView(row, source), ...await details(actor, row, source) })));
    return { apiVersion: TIMDS_HOST_API_VERSION, sourceId: source.id, canPublish: await canPublish(source, actor), sessions, drafts: sessions.filter(row => row.kind === 'draft'), events: await store.events(source.id), publicationEvents: store.publications ? await store.publications(source.id) : [] };
  }
  async function join(actor, id, input = {}) {
    const { session, source } = await owned(id, actor);
    const principalId = input.principalId || actor.principalId;
    if (!uuid.test(principalId || '')) throw fail(400, 'principalId is required');
    if (principalId !== actor.principalId && session.owner_principal_id !== actor.principalId && !await canPublish(source, actor)) throw fail(403, 'Only the session owner or a publisher may invite members');
    if (authorization.authenticatePrincipal) await authorization.authenticatePrincipal(principalId);
    await store.addMember({ session_id: id, principal_id: principalId, role: session.owner_principal_id === principalId ? 'owner' : 'member', invited_by: actor.principalId });
    return status(actor, id);
  }
  async function claim(actor, id, input = {}) {
    const { session, source } = await owned(id, actor);
    const patterns = input.patterns;
    if (!Array.isArray(patterns) || !patterns.length || patterns.length > 100 || patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern.length > 500 || pattern.startsWith('/') || pattern.includes('..') || /[\\\x00-\x1f]/.test(pattern))) throw fail(400, 'Claims require 1–100 safe relative patterns');
    if (typeof (input.note || '') !== 'string' || (input.note || '').length > 2000) throw fail(400, 'Claim note is too long');
    const row = await store.putClaim({ session_id: id, principal_id: actor.principalId, patterns: [...new Set(patterns)], note: (input.note || '').trim(), kind: 'advisory', expires_at: session.expires_at || new Date(now() + TIMDS_SESSION_TTL_MS).toISOString() });
    const work = await activeWork(actor, source.id);
    // Advisory glob overlap deliberately errs toward warning, never exclusion.
    const prefix = value => value.split(/[?*[{]/)[0];
    const overlaps = work.sessions.flatMap(other => other.claims.filter(value => value.principalId !== actor.principalId && value.patterns.some(a => patterns.some(b => prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a))))).map(value => ({ ...value, sessionId: other.id })));
    return output(session, source, { claim: claimView(row), overlaps });
  }
  async function changeClaim(actor, session, changes) {
    const patterns = [...changes.changedFiles.map(file => file.path), ...changes.deletedPaths];
    if (patterns.length && store.putClaim) await store.putClaim({ session_id: session.id, principal_id: actor.principalId, patterns, note: changes.note, kind: 'changes', expires_at: session.expires_at || new Date(now() + TIMDS_SESSION_TTL_MS).toISOString() });
  }
  async function conflictResult(actor, source, session, changes, result, checkpoint) {
    await changeClaim(actor, session, changes);
    const saved = await checkpoint(result.stale && result.baseRevision && result.baseRevision !== session.base_revision ? { base_revision: result.baseRevision, last_update_hash: '' } : {}, null, event(actor, 'updated', { note: changes.note, conflicted_keys: result.conflicts || [], merged_keys: result.mergedKeys || [], details_json: { rejected: true, stale: Boolean(result.stale) } }));
    return output(saved, source, { files: result.files, conflicts: result.conflicts || [], mainRevision: result.mainRevision, stale: Boolean(result.stale), ...(result.rebasedChanges ? { rebasedChanges: result.rebasedChanges } : {}) });
  }
  async function staleResult(actor, source, session, changes, checkpoint) {
    if (!repository.stale) throw fail(409, 'Session changed; pull before retrying');
    return conflictResult(actor, source, session, changes, await repository.stale(source, session, changes), checkpoint);
  }
  async function createDraft(actor, id, input) { const source = await sourceFor(actor, id); return start(actor, { ...input, systemId: source.system_id, kind: 'draft' }); }
  async function listDrafts(actor, id) { const work = await activeWork(actor, id); return { apiVersion: TIMDS_HOST_API_VERSION, drafts: work.drafts }; }
  async function draftSnapshot(actor, id, name) { const source = await sourceFor(actor, id); const draft = uuid.test(name) ? await store.get(name) : await store.draft(source.id, name); if (!draft || draft.source_id !== source.id || draft.kind !== 'draft') throw fail(404, 'Draft not found'); const result = await repository.snapshot(source, draft); return output({ ...draft, base_revision: result.baseRevision || draft.base_revision }, source, { files: result.files, conflicts: [] }); }
  async function closeDraft(actor, id, name) { const source = await sourceFor(actor, id); const draft = uuid.test(name) ? await store.get(name) : await store.draft(source.id, name); if (!draft || draft.source_id !== source.id || draft.kind !== 'draft') throw fail(404, 'Draft not found'); return close(actor, draft.id); }
  async function previewTokens(id, name) {
    const source = uuid.test(id) ? await store.getSource(id) : await store.source(id); ready(source, {});
    const session = uuid.test(name) ? await store.get(name) : await store.draft(source.id, name);
    if (!session || session.source_id !== source.id || session.status !== 'open' || session.expires_at && Date.parse(session.expires_at) <= now()) throw fail(404, 'Preview not found');
    return tokensCssFromSnapshot(repository.tokenFiles ? await repository.tokenFiles(source, session) : (await repository.snapshot(source, session)).files);
  }
  async function start(actor, input) {
    if (!input || typeof input.systemId !== 'string' || !input.systemId.trim() || input.systemId.length > 300) throw fail(400, 'systemId is required');
    const key = input.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) throw fail(400, 'idempotencyKey must be 1–200 characters');
    const source = await store.source(input.systemId); ready(source, actor);
    if (!actor.principalId) throw fail(403, 'A TimDS identity is required');
    await authorization.authorizeSource(source, actor, { starting: true });
    if (store.eligible && !await store.eligible(source)) throw fail(409, 'Design System organization, project, or repository is inactive');
    const kind = input.kind === 'draft' ? 'draft' : 'session';
    const name = kind === 'draft' ? String(input.name || '').trim() : null;
    if (kind === 'draft' && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw fail(400, 'Draft name must be a lowercase name with letters, numbers and hyphens');
    const draft = input.draft ? await store.draft(source.id, input.draft) : null;
    if (input.draft && (!draft || draft.status !== 'open')) throw fail(404, 'Open draft not found');
    if (draft) await owned(draft.id, actor);
    let fromRevision = null;
    if (input.from && input.from !== 'main') {
      const version = await store.version(source.id, input.from); fromRevision = version?.source_commit;
      if (!/^[a-f0-9]{40}$/.test(fromRevision || '')) throw fail(404, 'Published version source is unavailable');
    }
    let session = key ? await store.byKey(actor.principalId, key) : null;
    if (session && session.source_id !== source.id) throw fail(409, 'This idempotency key belongs to another Design System');
    if (session && ((session.kind || 'session') !== kind || (session.name || null) !== name || (session.draft_session_id || null) !== (draft?.id || null) || (session.origin_revision || null) !== fromRevision)) throw fail(409, 'This idempotency key belongs to different session origins');
    if (!session) session = await store.insert({ id: randomUUID(), source_id: source.id, owner_principal_id: actor.principalId, owner_user_id: actor.userId || null, owner_token_id: actor.tokenId || null, originating_request_id: actor.requestId || null, idempotency_key: key || null, status: 'starting', kind, name, draft_session_id: draft?.id || null, origin_revision: fromRevision, expires_at: kind === 'draft' ? null : new Date(now() + TIMDS_SESSION_TTL_MS).toISOString() });
    if (onSessionReserved && ['starting','open'].includes(session.status)) await onSessionReserved(session, source);
    if (store.addMember) await store.addMember({ session_id: session.id, principal_id: actor.principalId, role: 'owner', invited_by: actor.principalId });
    if (session.status !== 'starting') { if (onSessionStarted) await leased(session.id, async (row, checkpoint) => checkpoint(await onSessionStarted(row, source))); return snapshot(actor, session.id); }
    return leased(session.id, async (row, checkpoint) => {
      if (row.status !== 'starting') {
        const result = await repository.snapshot(source, row);
        let saved = result.baseRevision && result.baseRevision !== row.base_revision ? await checkpoint({ base_revision: result.baseRevision, last_update_hash: '' }) : row;
        if (onSessionStarted) saved = await checkpoint(await onSessionStarted(saved, source));
        return output(saved, source, { files: result.files, conflicts: [] });
      }
      const originDraft = row.draft_session_id ? await store.get(row.draft_session_id) : null;
      if (row.draft_session_id && (!originDraft || originDraft.source_id !== source.id || originDraft.status !== 'open')) throw fail(409, 'The session’s draft origin is no longer open');
      const result = await repository.start(source, { sessionId: row.id, fromRepository: originDraft?.fork_repository || source.artifacts_repository, fromRevision: row.origin_revision });
      let saved = await checkpoint({ fork_repository: result.forkRepository, token_id: result.tokenId || '', base_revision: result.baseRevision, expires_at: row.kind === 'draft' ? null : result.expiresAt || row.expires_at, status: 'open' });
      if (onSessionStarted) saved = await checkpoint(await onSessionStarted(saved, source));
      if (input.on?.length || input.patterns?.length) await claim(actor, saved.id, { patterns: input.on || input.patterns, note: input.note || '' });
      return output(saved, source, { files: result.files, conflicts: [] });
    });
  }
  async function snapshot(actor, id) {
    const { source } = await owned(id, actor);
    return leased(id, async (session, checkpoint) => {
      if (session.status !== 'open') throw fail(409, 'Session is still starting; retry start with the same idempotency key');
      const result = await repository.snapshot(source, session);
      const saved = result.baseRevision && result.baseRevision !== session.base_revision ? await checkpoint({ base_revision: result.baseRevision, last_update_hash: '' }) : session;
      return output(saved, source, { files: result.files, conflicts: [] });
    });
  }
  async function submit(actor, id, input) {
    const changes = validateTimdsChangeSet(input); requireNote(actor, changes);
    const { source } = await owned(id, actor);
    const hash = createHash('sha256').update(JSON.stringify(changes)).digest('hex');
    return leased(id, async (session, checkpoint) => {
      if (session.status !== 'open') throw fail(409, 'Session is not open');
      let submission = await store.submissionByHash(id, hash);
      if (submission && submission.status !== 'preparing') return output(session, source, { submission: timdsSubmissionView(submission) });
      if (!submission) {
        if (changes.baseRevision !== session.base_revision || (changes.lastUpdateHash !== undefined && changes.lastUpdateHash !== (session.last_update_hash || ''))) return staleResult(actor, source, session, changes, checkpoint);
        const submissionId = randomUUID();
        submission = await store.reserveSubmission({ id: submissionId, source_id: source.id, session_id: id, request_hash: hash, base_revision: changes.baseRevision, review_branch: `review-${submissionId.replaceAll('-', '').slice(0, 16)}`, note: changes.note, target_draft_session_id: session.draft_session_id || null });
      }
      const target = session.draft_session_id ? (await owned(session.draft_session_id, actor)).session : null;
      const result = await repository.submit(source, session, changes, { submissionId: submission.id, reviewBranch: submission.review_branch, targetRepository: target?.fork_repository || source.artifacts_repository });
      if (result.stale || result.conflicts?.length) return conflictResult(actor, source, session, changes, result, checkpoint);
      if (target) {
        const integrated = await leased(target.id, async (draft, saveDraft) => { const merged = await repository.mergeIntoDraft(source, draft, { ...submission, head_commit: result.headCommit }); if (!merged.conflicts?.length) await saveDraft({ base_revision: merged.headCommit }, null, event(actor, 'updated', { note: changes.note, merged_keys: merged.mergedKeys || [], details_json: { integratedSubmissionId: submission.id } })); return merged; });
        if (integrated.conflicts?.length) return conflictResult(actor, source, session, changes, { ...integrated, files: result.files, baseRevision: result.baseRevision }, checkpoint);
      }
      const patch = { id: submission.id, head_commit: result.headCommit, preview_url: result.previewUrl || '', diff_json: result.diff || [] };
      const saved = await checkpoint({ base_revision: result.baseRevision || result.headCommit, last_update_hash: '' }, patch, event(actor, 'submitted', { submission_id: submission.id, note: changes.note, merged_keys: result.mergedKeys || [], conflicted_keys: result.conflictedKeys || [] }));
      if (store.removeChangeClaim) await store.removeChangeClaim(id, actor.principalId);
      if (target && store.markIntegrated) await store.markIntegrated(submission.id, result.headCommit);
      return output(saved, source, { files: result.files, submission: timdsSubmissionView({ ...submission, ...patch, status: target ? 'closed' : 'submitted' }), conflicts: [] });
    });
  }
  async function update(actor, id, input) {
    const changes = validateTimdsChangeSet(input); requireNote(actor, changes); const { source } = await owned(id, actor);
    const hash = createHash('sha256').update(JSON.stringify(changes)).digest('hex');
    return leased(id, async (session, checkpoint) => {
      if (session.status === 'open' && session.last_update_hash === hash) return output(session, source, { files: (await repository.snapshot(source, session)).files, conflicts: [] });
      if (session.status !== 'open') throw fail(409, 'Session is not open');
      if (changes.baseRevision !== session.base_revision || (changes.lastUpdateHash !== undefined && changes.lastUpdateHash !== (session.last_update_hash || ''))) return staleResult(actor, source, session, changes, checkpoint);
      const target = session.draft_session_id ? (await owned(session.draft_session_id, actor)).session : null;
      const result = await repository.update(source, session, changes, { targetRepository: target?.fork_repository || source.artifacts_repository });
      if (result.stale || result.conflicts?.length) return conflictResult(actor, source, session, changes, result, checkpoint);
      const saved = await checkpoint({ base_revision: result.baseRevision, last_update_hash: hash }, null, event(actor, 'updated', { note: changes.note, merged_keys: result.mergedKeys || [], conflicted_keys: result.conflictedKeys || [] }));
      await changeClaim(actor, saved, changes);
      return output(saved, source, { files: result.files, conflicts: [] });
    });
  }
  async function status(actor, id) {
    const { session, source } = await owned(id, actor, true);
    return output(session, source, await details(actor, session, source));
  }
  async function history(actor, id) {
    const { session, source } = await owned(id, actor, true);
    return output(session, source, { ...(await repository.history(source, session)), events: await store.events(source.id), publicationEvents: store.publications ? await store.publications(source.id) : [] });
  }
  async function close(actor, id, expired = false, publicationId = null) {
    const { session, source } = await owned(id, actor, true);
    if (!actor.system && !actor.operator && session.owner_principal_id !== actor.principalId && !await canPublish(source, actor)) throw fail(403, 'Only the session owner or a publisher may close a session');
    if (['closed','expired'].includes(session.status)) return output(session, source);
    if (session.kind === 'draft' && store.sessions) for (const child of (await store.sessions(source.id)).filter(row => row.draft_session_id === id && ['starting','open','closing'].includes(row.status))) await close({ ...actor, system: true, operator: true }, child.id, expired);
    return leased(id, async (row, checkpoint) => {
      if (['closed','expired'].includes(row.status)) return output(row, source);
      const closing = await checkpoint({ status: 'closing' });
      const submissions = await store.submissions(id);
      if (submissions.some(item => item.status === 'publishing')) throw fail(409, 'Publication is in progress; close after it finishes');
      if (cleanupAgentSession) await cleanupAgentSession(closing, source);
      await repository.close(source, closing, { reviewBranches: submissions.map(item => item.review_branch) });
      await store.closeSubmissions(id);
      const saved = await checkpoint({ status: expired ? 'expired' : 'closed' }, null, event(actor, 'closed', { details_json: { expired } }));
      return output(saved, source);
    }, publicationId);
  }
  async function cleanupExpired({ dryRun = false, limit = 5 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(400, 'Cleanup limit must be 1–100');
    const results = [];
    for (const session of (await store.expired(new Date(now()).toISOString())).slice(0, limit)) {
      if (dryRun) { results.push({ id: session.id, status: 'due' }); continue; }
      try { await close({ userId: null, tokenId: null, clientId: null, operator: true }, session.id, true); results.push({ id: session.id, status: 'expired' }); }
      catch (error) { results.push({ id: session.id, status: 'failed', error: error.message }); }
    }
    return results;
  }
  async function closeForPublication(sessionId, publicationId) {
    const [publication, session] = await Promise.all([store.publication(publicationId), store.get(sessionId)]);
    if (!publication || publication.status !== 'closing' || !session || publication.source_id !== session.source_id || !(await store.submissions(sessionId)).some(row => row.id === publication.submission_id)) throw fail(409, 'Publication cleanup does not match this session');
    return close({ operator: true, system: true, userId: publication.actor_user_id, principalId: publication.actor_principal_id, requestId: publication.originating_request_id, tokenId: null }, sessionId, false, publicationId);
  }
  return { activeWork, join, claim, createDraft, listDrafts, draftSnapshot, closeDraft, previewTokens, start, snapshot, submit, update, status, history, close, closeForPublication, cleanupExpired };
}

// Serve only CSS values, never source text or executable rules from a fork.
export function tokensCssFromSnapshot(files) {
  const groups = files.filter(file => /^tokens\/.+\.json$/.test(file.path));
  const tokens = Object.create(null);
  if (groups.length) for (const file of groups) tokens[file.path.slice(7, -5).replaceAll('/', '.')] = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  else { const file = files.find(file => file.path === 'tokens.json'); if (file) Object.assign(tokens, JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))); }
  const declarations = [];
  const visit = (value, keys) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.hasOwn(value, 'value') || Object.hasOwn(value, '$value')) return visit(value.value ?? value.$value, keys);
      for (const [key, item] of Object.entries(value)) if (!key.startsWith('$')) visit(item, [...keys, key]);
    } else if (typeof value === 'string' || typeof value === 'number') {
      const name = keys.join('-').replaceAll('.', '-');
      const css = String(value).replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, ref) => `var(--${ref.replaceAll('.', '-')})`);
      if (/^[a-zA-Z0-9_-]+$/.test(name) && css.length < 2000 && !/[;{}<>\x00-\x1f]/.test(css) && !/url\s*\(|@import|expression\s*\(/i.test(css)) declarations.push(`  --${name}: ${css};`);
    }
  };
  visit(tokens, []); return `:root {\n${declarations.sort().join('\n')}\n}\n`;
}
