#!/usr/bin/env node
// Operational client: real Requests and optional publication, with durable IDs.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveAccessToken } from '@dtconcepts/timds/auth';

const usage = `Run concurrent TimDS designer Requests against one real system.

Plan (local file only):
  node scripts/run-designer-batch.mjs plan --host https://host.example \\
    --source-id UUID --count 10 --prompt-file /private/prompt.txt --state /private/batch.json

Run/resume the same Requests:
  node scripts/run-designer-batch.mjs run --state /private/batch.json \\
    --credentials /private/timds-credentials.json --yes [--publish]

The prompt must contain {{index}} for independent work areas. Review the saved
plan before running. --publish uses this human's existing publisher grant after
all Requests have submitted, and submits their publications in saved order.
No credentials enter the state file or output. A rerun preserves every Request
and publication identity. Failed Requests are reported, never blindly restarted.
--timeout-minutes 60 bounds this invocation; unfinished server work continues.
`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const safeFailure = (code, details = {}) => Object.assign(new Error(code), { code, details, publicFailure:true });
const publicationTerminal = status => ['published','failed','cancelled','conflicted','superseded'].includes(status);
const together = async tasks => {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
};
const atomicSave = async (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
};
const origin = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw safeFailure('use_exact_https_host_origin');
  return url.origin;
};
async function privateState(file) {
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw safeFailure('state_file_must_be_owned_and_private');
  const state=JSON.parse(await fs.readFile(file,'utf8'));validate(state);return state;
}
function validate(state) {
  if (state.schemaVersion !== 1 || !uuid.test(state.id) || !uuid.test(state.sourceId) || !Array.isArray(state.requests) || state.requests.length < 1 || state.requests.length > 25) throw safeFailure('invalid_saved_batch');
  origin(state.host);
  const ids = new Set();
  for (const row of state.requests) {
    if (!uuid.test(row.requestId) || ids.has(row.requestId) || typeof row.prompt !== 'string' || !row.prompt.trim() || Buffer.byteLength(row.prompt) > 32768 || row.submissionId && !uuid.test(row.submissionId) || row.publicationId && !uuid.test(row.publicationId)) throw safeFailure('invalid_saved_request');
    ids.add(row.requestId);
  }
}
function summary(state) {
  const rows = state.requests;
  const complete = rows.every(row => row.submissionId && (!state.publishRequested || row.publicationStatus === 'published'));
  const reportedConflicts = rows.reduce((count, row) => count + (row.conflictCount || 0), 0);
  return { batchId: state.id, sourceId: state.sourceId, requests: rows.length,
    submitted: rows.filter(row => row.submissionId).length,
    published: rows.filter(row => row.publicationStatus === 'published').length,
    complete, conflicts: complete ? reportedConflicts : null, reportedConflicts,
    versions: rows.filter(row => row.version).map(row => ({ requestId: row.requestId, publicationId: row.publicationId, version: row.version })),
    unfinished: rows.filter(row => !row.submissionId || state.publishRequested && row.publicationStatus !== 'published').map(row => ({ requestId: row.requestId, requestStatus: row.requestStatus || null, publicationId: row.publicationId || null, publicationStatus: row.publicationStatus || null, stage: row.stage || null, error: row.error || null })) };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    host: { type: 'string' }, 'source-id': { type: 'string' }, count: { type: 'string' }, 'prompt-file': { type: 'string' },
    state: { type: 'string' }, credentials: { type: 'string' }, 'timeout-minutes': { type: 'string', default: '60' },
    publish: { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(usage); return; }
  if (positionals.length !== 1 || !['plan', 'run', 'status'].includes(positionals[0]) || !values.state) throw safeFailure('choose_plan_run_or_status_with_state');
  const file = path.resolve(values.state);
  if (positionals[0] === 'plan') {
    const count = Number(values.count), host = origin(values.host);
    if (!uuid.test(values['source-id'] || '') || !Number.isInteger(count) || count < 1 || count > 25 || !values['prompt-file']) throw safeFailure('plan_requires_source_count_1_to_25_and_prompt_file');
    const prompt = await fs.readFile(values['prompt-file'], 'utf8');
    if (!prompt.includes('{{index}}')) throw safeFailure('prompt_requires_index_placeholder');
    const state = { schemaVersion: 1, id: randomUUID(), host, sourceId: values['source-id'], createdAt: new Date().toISOString(), publishRequested: false,
      requests: Array.from({ length: count }, (_, index) => ({ requestId: randomUUID(), prompt: prompt.replaceAll('{{index}}', String(index + 1)) })) };
    validate(state);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    write({ planned: true, stateFile: file, ...summary(state) }); return;
  }
  let state = await privateState(file);
  if (positionals[0] === 'status') { write(summary(state)); return; }
  if (!values.yes) throw safeFailure('review_saved_prompts_then_use_yes_to_create_real_requests');
  const minutes = Number(values['timeout-minutes']);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw safeFailure('timeout_minutes_must_be_1_to_240');
  const lock = `${file}.lock`;
  let lockHandle;
  try { lockHandle = await fs.open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw safeFailure('batch_lock_exists_check_its_pid_before_recovery'); throw error; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(minutes * 60_000)]);
  let saves = Promise.resolve();
  const save = () => { const snapshot = structuredClone(state); saves = saves.then(() => atomicSave(file, snapshot)); return saves; };
  const api = async (method, suffix, input) => {
    const token = await resolveAccessToken(state.host, { credentialsPath: values.credentials, signal });
    if (!token) throw safeFailure('sign_in_to_selected_host_first');
    const response = await fetch(`${state.host}/api/timds/${suffix}`, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'X-TimDS-API-Version': '1' },
      ...(input === undefined ? {} : { body: JSON.stringify({ ...input, apiVersion: 1 }) }) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw safeFailure('host_request_failed', { status: response.status, conflictCount: Array.isArray(body?.conflicts) ? body.conflicts.length : 0 });
    if (body?.apiVersion !== 1) throw safeFailure('incompatible_host_response');
    return body;
  };
  const readRequest = async row => {
    const body = await api('GET', `design-systems/${state.sourceId}/requests/${row.requestId}`);
    if (body.requestId !== row.requestId || body.session?.sourceId && body.session.sourceId !== state.sourceId) throw safeFailure('request_identity_mismatch');
    row.requestStatus = body.runner?.state || body.status;
    if (body.submissionId) { if (!uuid.test(body.submissionId)) throw safeFailure('invalid_submission_receipt'); row.submissionId = body.submissionId; }
    row.conflictCount = Array.isArray(body.runner?.conflicts) ? body.runner.conflicts.length : row.conflictCount || 0;
    row.error = !row.submissionId && [body.status,row.requestStatus].some(status=>['failed', 'dead_letter', 'cancelled', 'conflicted'].includes(status)) ? 'designer_request_needs_review' : null;
    await save();
  };
  const recordPublication = async (row,publication) => {
    if(!uuid.test(publication?.id)||row.publicationId&&publication.id!==row.publicationId||publication.submissionId!==row.submissionId||publication.sourceId!==state.sourceId)throw safeFailure('publication_identity_mismatch');
    row.publicationId=publication.id;row.publicationStatus=publication.status;row.stage=publication.stage;
    if(publication.result?.version)row.version=publication.result.version;
    row.error=publicationTerminal(publication.status)&&publication.status!=='published'?'publication_needs_review':null;
    if(Array.isArray(publication.result?.conflicts))row.conflictCount=publication.result.conflicts.length;
    row.conflictRate=publication.conflictRate??null;await save();
  };
  const readPublication = async row => {const {publication}=await api('GET',`publications/${row.publicationId}`);await recordPublication(row,publication);};
  try {
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // A prior process may have finished between the initial read and lock
    // acquisition. Only the reread under this lock may be mutated/saved.
    state=await privateState(file);
    if(process.env.TIMDS_ACCESS_TOKEN)throw safeFailure('unset_ambient_access_token_use_host_bound_credentials');
    const me=await api('GET','me');
    if(!uuid.test(me.principal?.id)||me.principal.type!=='user')throw safeFailure('human_host_oauth_identity_required');
    if(state.principalId&&state.principalId!==me.principal.id)throw safeFailure('batch_belongs_to_another_human_identity');
    state.principalId=me.principal.id;await save();
    const source = await api('GET', `design-systems/${state.sourceId}`);
    if (source.sourceId !== state.sourceId && source.id !== state.sourceId && source.source?.id !== state.sourceId) throw safeFailure('source_identity_mismatch');
    if (values.publish) { state.publishRequested = true; await save(); }
    // All durable Requests are dispatched before waiting for any designer.
    await together(state.requests.map(async row => {
      try { await readRequest(row); }
      catch (error) {
        if (error.details?.status !== 404) throw error;
        if (row.acceptedAt) throw safeFailure('accepted_request_receipt_missing');
        const accepted=await api('POST', `design-systems/${state.sourceId}/requests`, { requestId: row.requestId, prompt: row.prompt });
        if(accepted.requestId!==row.requestId||!uuid.test(accepted.executionJobId))throw safeFailure('request_creation_identity_mismatch');
        row.acceptedAt = new Date().toISOString(); row.requestStatus = 'queued'; await save();
      }
    }));
    write({ phase: 'requests_dispatched', ...summary(state) });
    while (state.requests.some(row => !row.submissionId && !row.error)) {
      await sleep(5000, undefined, { signal });
      await together(state.requests.filter(row => !row.submissionId && !row.error).map(readRequest));
      write({ phase: 'designing', ...summary(state) });
    }
    if (state.requests.some(row => !row.submissionId)) { process.exitCode = 1; return; }
    if (!state.publishRequested) return;
    // Refresh failed and completed receipts too: Studio may have recovered a
    // failed publication since this invocation last saved it.
    await together(state.requests.filter(row=>row.publicationId).map(readPublication));
    // POSTs return queue receipts. Preserve input order without awaiting builds.
    for (const row of state.requests) {
      if (row.publicationId) continue;
      const { publication } = await api('POST', `submissions/${row.submissionId}/publish`, {});
      await recordPublication(row,publication);
    }
    while (state.requests.some(row => !publicationTerminal(row.publicationStatus))) {
      await together(state.requests.filter(row => !publicationTerminal(row.publicationStatus)).map(readPublication));
      write({ phase: 'publishing', ...summary(state) });
      if (state.requests.some(row => !publicationTerminal(row.publicationStatus))) await sleep(5000, undefined, { signal });
    }
    if (state.requests.some(row => row.publicationStatus !== 'published')) process.exitCode = 1;
  } finally {
    try { await saves; write({ phase: 'stopped', ...summary(state) }); }
    finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      await lockHandle.close(); await fs.rm(lock, { force: true });
    }
  }
}
main().catch(error => { write({ error: error.publicFailure ? error.code : 'batch_interrupted_keep_state_and_inspect_receipts', ...(error.publicFailure ? error.details : {}) }); process.exitCode = 1; });
