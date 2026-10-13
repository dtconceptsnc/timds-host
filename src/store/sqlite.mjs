import { randomUUID } from 'node:crypto';
import { decode, fail, json, principalId, storageError } from './errors.mjs';
import { AccessInvitations,applyInvitationClaim,invitationOperation } from '../invitations/catalog.mjs';

const schema = `
CREATE TABLE IF NOT EXISTS coordinator_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 source_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.source_id')) STORED,
 owner_principal_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.owner_principal_id')) STORED,
 idempotency_key TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.idempotency_key')) STORED,
 status TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.status')) STORED CHECK(status IN ('starting','open','closing','closed','expired')),
 kind TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.kind')) STORED CHECK(kind IN ('session','draft')),
 name TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.name')) STORED,
 expires_at TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.expires_at')) STORED,
 CHECK(json_extract(row_json,'$.id')=id),
 CHECK((kind='draft' AND name IS NOT NULL AND expires_at IS NULL) OR (kind='session' AND expires_at IS NOT NULL)),
 UNIQUE(owner_principal_id,idempotency_key));
CREATE UNIQUE INDEX IF NOT EXISTS live_draft_name ON sessions(source_id,name) WHERE kind='draft' AND status IN ('starting','open','closing');
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 session_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.session_id')) STORED REFERENCES sessions(id),
 principal_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.principal_id')) STORED,
 UNIQUE(session_id,principal_id),CHECK(json_extract(row_json,'$.role') IN ('owner','member')));
CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 session_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.session_id')) STORED REFERENCES sessions(id),
 principal_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.principal_id')) STORED,
 kind TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.kind')) STORED CHECK(kind IN ('advisory','changes')),
 expires_at TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.expires_at')) STORED,
 UNIQUE(session_id,principal_id,kind), CHECK(json_array_length(row_json,'$.patterns') BETWEEN 1 AND 4000),
 CHECK(length(json_extract(row_json,'$.note'))<=2000));
CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 source_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.source_id')) STORED,
 session_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.session_id')) STORED REFERENCES sessions(id),
 request_hash TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.request_hash')) STORED,
 review_branch TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.review_branch')) STORED,
 status TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.status')) STORED CHECK(status IN ('preparing','submitted','publishing','published','closed')),
 CHECK(json_extract(row_json,'$.id')=id),UNIQUE(session_id,request_hash),UNIQUE(source_id,review_branch));
CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 source_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.source_id')) STORED,
 submission_id TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.submission_id')) STORED UNIQUE,
 queue_position INTEGER GENERATED ALWAYS AS(json_extract(row_json,'$.queue_position')) STORED UNIQUE,
 status TEXT GENERATED ALWAYS AS(json_extract(row_json,'$.status')) STORED CHECK(status IN ('queued','running','closing','published','failed','superseded')),
 CHECK(json_extract(row_json,'$.id')=id));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
CREATE TABLE IF NOT EXISTS lifecycle_operations(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
CREATE TABLE IF NOT EXISTS session_repositories(session_id TEXT PRIMARY KEY REFERENCES sessions(id),namespace TEXT NOT NULL,repository TEXT NOT NULL,repository_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preview_builds(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
CREATE TABLE IF NOT EXISTS publication_events(id TEXT PRIMARY KEY,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,row_json TEXT NOT NULL CHECK(json_valid(row_json)));
`;
const sessionPatchFields = ['fork_repository','token_id','base_revision','last_update_hash','status','expires_at','live_url','sandbox_id','live_state'];
const blockingPublication = row => !['published','superseded'].includes(row.status) &&
  (row.status !== 'failed' || Object.hasOwn(row.checkpoints_json, 'sourceCommit') || row.checkpoints_json.staged === true);
const busy = () => fail(409, 'This session is busy; retry when its current operation finishes');

/** Real synchronous DO SQLite transactions, asynchronous D1 receipts outside them.
 * The coordinator serializes public operations across every awaited authority read.
 */
export function createSqliteCollaborationStore({ sourceId, storage, catalog, authority, clock = () => Date.now(), ids = randomUUID }) {
  if (!sourceId || !storage?.sql || !storage.transactionSync) throw new Error('A named SQLite coordinator is required');
  const sql = storage.sql;
  sql.exec(schema);
  const rows = (query, ...values) => sql.exec(query, ...values).toArray();
  const scalar = (query, ...values) => rows(query, ...values)[0] || null;
  const get = (table,id) => decode(scalar(`SELECT row_json FROM ${table} WHERE id=?`, id)?.row_json);
  const list = (table,condition = '1',values = [],order = "json_extract(row_json,'$.created_at') DESC,id DESC",limit = '') => rows(`SELECT row_json FROM ${table} WHERE ${condition} ORDER BY ${order} ${limit}`, ...values).map(row => decode(row.row_json));
  const put = (table,row,id = row.id) => { sql.exec(`INSERT INTO ${table}(id,row_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET row_json=excluded.row_json`, id,json(row)); return row; };
  const meta = key => decode(scalar('SELECT value FROM coordinator_meta WHERE key=?',key)?.value);
  const setMeta = (key,value) => sql.exec('INSERT INTO coordinator_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,json(value));
  const timestamp = () => new Date(clock()).toISOString();
  const atomic = task => { try { return storage.transactionSync(task); } catch (error) { storageError(error); } };
  const own = id => { if (id !== sourceId) throw fail(404, 'Design System not found'); };
  const enqueue = (kind,row) => sql.exec('INSERT INTO outbox(kind,row_json) VALUES(?,?)',kind,json(row));
  const locate = (kind,id,tombstone = false) => enqueue('resource',{kind,id,tombstone});
  const session = id => { const row = get('sessions',id); if (!row) throw fail(404, 'Session not found'); return row; };
  const sessionPublications = id => list('publications').filter(row => get('submissions',row.submission_id)?.session_id === id);
  const principalDisplay = async id => { const row = await catalog.principal(id); return row && { id: row.id, name: row.name, type: row.type }; };
  const names = async items => Promise.all(items.map(async row => { const principal = row.actor_principal_id && await principalDisplay(row.actor_principal_id); return { ...row, principal_name: principal?.name || row.actor_principal_id, actor_name: principal?.name || row.actor_principal_id }; }));
  const audit = input => {
    const row = { id: ids(), source_id: sourceId, session_id: null, submission_id: null, actor_user_id: null, actor_token_id: null,
      actor_principal_id: null, originating_request_id: null, details_json: {}, note: '', merged_keys: [], conflicted_keys: [], created_at: timestamp(), ...input };
    own(row.source_id);
    if (get('events',row.id)) throw fail(409, 'Audit event already exists');
    put('events',row); enqueue('event',row); return row;
  };
  const saveSession = row => { put('sessions',row); enqueue('session',row); return row; };
  const patchSession = (row,patch) => {
    if (Object.keys(patch).some(key => !sessionPatchFields.includes(key))) throw fail(400, 'Unsupported session checkpoint field');
    const next = { ...row, updated_at: timestamp() };
    for (const field of sessionPatchFields) if (Object.hasOwn(patch,field) && (field === 'expires_at' || patch[field] != null)) next[field] = patch[field];
    if (next.status !== row.status && ['closing','closed','expired'].includes(next.status)) {
      for (const publication of sessionPublications(row.id)) {
        if (publication.status === 'failed' && !blockingPublication(publication)) put('publications',{ ...publication,status:'superseded',updated_at:timestamp() });
        else if (!['closing','published','superseded'].includes(publication.status)) throw fail(409, 'Finish the active publication before closing its session');
      }
    }
    return saveSession(next);
  };
  const validLease = (id,lease) => { const row = session(id); if (!lease || row.lease_token !== lease || !row.lease_expires_at || Date.parse(row.lease_expires_at) <= clock()) throw fail(409, 'Session lease expired; retry the operation'); return row; };
  const queuedBefore = publication => list('publications').some(row => row.queue_position < publication.queue_position && blockingPublication(row));
  const publicationLease = (id,lease) => {
    const row = get('publications',id), job = get('jobs',lease?.jobId);
    if (!row || !job || row.execution_job_id !== job.id || !lease?.leaseToken || job.lease_token !== lease.leaseToken ||
        !['leased','running'].includes(job.status) || !job.lease_expires_at || Date.parse(job.lease_expires_at) <= clock() ||
        job.job_type !== 'publish_design_system_submission' || job.payload_json.publicationId !== id) throw fail(409, 'Publication execution job lease is unavailable');
    if (queuedBefore(row)) throw fail(409, 'Publication is waiting for an earlier source submission');
    return row;
  };
  const publishAuthority = async publication => {
    if(meta('deletion_fence'))throw fail(409,'Publication is fenced by source deletion');
    const facts = await catalog.readAuthority(sourceId,publication.actor_principal_id);
    if (facts.principal?.status !== 'active' || facts.organizationStatus !== 'active' || !facts.publisher) throw fail(403, 'Publish rights were revoked');
    if (facts.source?.lifecycle_status !== 'ready' || facts.source.archived_at) throw fail(409, 'Hosted Design System is unavailable for publication');
    if (meta('authority_pending')) throw fail(503, 'Source authority confirmation is pending');
    return facts;
  };
  const immutablePublishedLabel = version => {
    const prior = list('publication_events',"json_extract(row_json,'$.version_label')=?",[version.version_label],"json_extract(row_json,'$.created_at'),id",'LIMIT 1')[0];
    if (!prior) return;
    const saved = get('versions',prior.design_system_version_id);
    if (!saved || saved.content_digest !== version.content_digest || saved.source_commit !== version.source_commit || json(saved.stamp) !== json(version.stamp)) throw fail(409, 'A published version label cannot identify different bytes or provenance');
  };

  atomic(() => { const saved = meta('source_id'); if (saved && saved !== sourceId) throw fail(409, 'Coordinator source identity mismatch'); setMeta('source_id',sourceId); });
  const store = {
    async source(reference) { const source = await catalog.source(reference); if (!source || source.id !== sourceId || source.archived_at) throw fail(404, 'Active Design System not found uniquely'); return { ...source,...meta('pointer') }; },
    async getSource(id) { if (id !== sourceId) return null; const source = await catalog.source(id),deletion=meta('deletion_fence'); return source && { ...source,...meta('pointer'),...(deletion?{lifecycle_status:deletion.completed?'deleted':'deleting'}:{}) }; },
    async eligible(source) { return source?.id === sourceId && source.lifecycle_status === 'ready' && !source.archived_at && Boolean(source.artifacts_namespace && source.artifacts_repository && source.artifacts_repository_id) && (await catalog.organization(source.organization_id))?.status === 'active'; },
    async version(id,label) { own(id); const result = await store.publishedRelease({id},label); return result ? {source_commit:result.sourceCommit} : null; },
    async publishedRelease(source,label) {
      own(source.id);
      if (!label) { const pointer = meta('pointer') || source; return {contentDigest:pointer.content_digest,version:pointer.published_version,sourceCommit:pointer.source_commit}; }
      const event = list('publication_events',"json_extract(row_json,'$.version_label')=?",[label],"json_extract(row_json,'$.created_at'),id",'LIMIT 1')[0];
      if (!event) return null;
      return {contentDigest:event.content_digest,version:event.version_label,sourceCommit:get('versions',event.design_system_version_id)?.source_commit || ''};
    },
    resolveRollbackVersion(id,value,byId = false) { own(id); return list('publication_events',`json_extract(row_json,'$.${byId ? 'design_system_version_id' : 'version_label'}')=?`,[value],"json_extract(row_json,'$.created_at'),id",'LIMIT 1')[0]?.design_system_version_id || null; },
    publicationEventsForSources: ids => catalog.publicationEventsForSources(ids),
    get: id => get('sessions',id),
    async byKey(id,key) {
      const local = list('sessions','owner_principal_id=? AND idempotency_key=?',[id,key])[0];
      if (local) return local;
      const receipt = await catalog.startReservation(id,key);
      if (!receipt) return null;
      if (receipt.source_id !== sourceId || receipt.tombstone) return receipt.session;
      // A prior isolate may have stopped after D1 reserved the key but before
      // its local insert. Materialize exactly that receipt, never a fresh UUID.
      return atomic(() => { if (get('sessions',receipt.session_id)) return get('sessions',receipt.session_id); put('sessions',receipt.session); locate('session',receipt.session_id); return receipt.session; });
    },
    async insert(input) {
      own(input.source_id);
      const source = await store.getSource(sourceId);
      if (!await store.eligible(source)) throw fail(409, 'Hosted Design System is unavailable or being deleted');
      let row = { owner_user_id:null,owner_token_id:null,originating_request_id:null,idempotency_key:null,fork_repository:'',token_id:'',base_revision:'',last_update_hash:'',status:'starting',kind:'session',name:null,draft_session_id:null,origin_revision:null,lease_token:null,lease_expires_at:null,live_url:'',sandbox_id:'',live_state:'stopped',created_at:timestamp(),updated_at:timestamp(),...input };
      if (row.idempotency_key) row = (await catalog.reserveStart(row)).session;
      return atomic(() => { const existing = get('sessions',row.id); if (existing) return existing; put('sessions',row); locate('session',row.id); enqueue('session',row); return row; });
    },
    sessions(id) { own(id); return list('sessions',"status IN ('starting','open','closing')",[],"json_extract(row_json,'$.created_at'),id"); },
    draft(id,name) { own(id); return list('sessions',"kind='draft' AND name=? AND status IN ('starting','open')",[name])[0] || null; },
    updateSession: (id,patch,{expectedStatus} = {}) => atomic(() => {
      const row = session(id);
      if (expectedStatus !== undefined && row.status !== expectedStatus) throw fail(409, 'Live session state changed');
      return patchSession(row,patch);
    }),
    findFork: name => list('sessions',"json_extract(row_json,'$.fork_repository')=?",[name])[0] || null,
    sessionForRequest(id,requestId) { own(id); const result = list('sessions',"json_extract(row_json,'$.originating_request_id')=?",[requestId]); if (result.length > 1) throw fail(409, 'Request has more than one session'); return result[0] || null; },
    expired: now => list('sessions',"status IN ('starting','open','closing') AND expires_at IS NOT NULL AND expires_at<=?",[now],'expires_at,id','LIMIT 100'),
    async members(id) { return Promise.all(list('members','session_id=?',[id]).map(async row => ({...row,principal:await principalDisplay(row.principal_id)}))); },
    member: (id,principal) => list('members','session_id=? AND principal_id=?',[id,principal])[0] || null,
    async addMember(input) {
      session(input.session_id);
      if ((await catalog.principal(input.principal_id))?.status !== 'active') throw fail(403, 'An active TimDS identity is required');
      const row = atomic(() => {
        if (store.member(input.session_id,input.principal_id)) return null;
        const member = {created_at:timestamp(),...input}; put('members',member,`${member.session_id}:${member.principal_id}`);
        const parent = session(input.session_id); enqueue('member',{...member,status:parent.status,expires_at:parent.expires_at}); return member;
      });
      // An invitation is not acknowledged until discoverability is projected.
      await store.flushOutbox(); return row;
    },
    async claims(id) { return Promise.all(list('claims','session_id=? AND expires_at>?',[id,timestamp()]).map(async row => ({...row,principal:await principalDisplay(row.principal_id)}))); },
    putClaim: input => atomic(() => {
      session(input.session_id); const prior = list('claims','session_id=? AND principal_id=? AND kind=?',[input.session_id,input.principal_id,input.kind || 'advisory'])[0];
      const row = { id:prior?.id || ids(),created_at:prior?.created_at || timestamp(),kind:'advisory',note:'',...input };
      if (row.kind === 'advisory' && row.patterns.length > 100) throw fail(400, 'Advisory claims accept up to 100 patterns');
      return put('claims',row);
    }),
    removeChangeClaim: (id,principal) => atomic(() => { sql.exec("DELETE FROM claims WHERE session_id=? AND principal_id=? AND kind='changes'",id,principal); }),
    hasSessionAccess: (principal,id) => { own(id); return Boolean(scalar("SELECT 1 FROM members m JOIN sessions s ON s.id=m.session_id WHERE m.principal_id=? AND s.status='open' AND (s.expires_at IS NULL OR s.expires_at>?) LIMIT 1",principal,timestamp())); },
    claim: (id,lease,publicationId = null) => atomic(() => {
      const row = get('sessions',id); if (!row || (row.lease_token && Date.parse(row.lease_expires_at) > clock())) throw busy();
      const publications = sessionPublications(id);
      if (publicationId && !publications.some(item => item.id === publicationId && item.status === 'closing')) throw fail(409, 'Publication cleanup does not match this session');
      if (publications.some(item => item.id !== publicationId && blockingPublication(item))) throw fail(409, 'Publication is in progress; start a new session for further edits');
      return put('sessions',{...row,lease_token:lease,lease_expires_at:new Date(clock()+900_000).toISOString()});
    }),
    release: (id,lease) => atomic(() => { const row = get('sessions',id); if (row?.lease_token === lease) put('sessions',{...row,lease_token:null,lease_expires_at:null}); }),
    checkpoint: (id,lease,patch,submission = null,event = null) => atomic(() => {
      const row = patchSession(validLease(id,lease),patch);
      if (submission) {
        const existing = get('submissions',submission.id);
        if (!existing || existing.session_id !== id || existing.status !== 'preparing') throw fail(409, 'Submission changed; reload before retrying');
        put('submissions',{...existing,head_commit:submission.head_commit,preview_url:submission.preview_url || '',diff_json:submission.diff_json || [],status:'submitted',updated_at:timestamp()});
      }
      if (event) audit({...event,source_id:sourceId,session_id:id});
      return row;
    }),
    getSubmission: id => get('submissions',id),
    submissions: id => list('submissions','session_id=?',[id]),
    submissionsForSource(id) { own(id); return list('submissions','1',[],undefined,'LIMIT 50'); },
    submissionByHash: (id,hash) => list('submissions','session_id=? AND request_hash=?',[id,hash])[0] || null,
    reserveSubmission: input => atomic(() => {
      own(input.source_id); session(input.session_id);
      const row = {head_commit:'',preview_url:'',diff_json:[],note:'',status:'preparing',target_draft_session_id:null,published_by:null,published_at:null,created_at:timestamp(),updated_at:timestamp(),...input};
      if (get('submissions',row.id)) throw fail(409, 'Submission already exists'); put('submissions',row); locate('submission',row.id); return row;
    }),
    markIntegrated: id => atomic(() => { const row = get('submissions',id); if (row) put('submissions',{...row,status:'closed',updated_at:timestamp()}); }),
    closeSubmissions: id => atomic(() => { for (const row of list('submissions',"session_id=? AND status IN ('preparing','submitted')",[id])) put('submissions',{...row,status:'closed',updated_at:timestamp()}); }),
    appendEvent: event => atomic(() => audit(event)),
    events(id) { own(id); return names(list('events','1',[],undefined,'LIMIT 100')); },
    publications(id) { own(id); return names(list('publication_events','1',[],undefined,'LIMIT 100')); },
    eventForHead: (id,revision) => list('events',"json_extract(row_json,'$.session_id')=? AND json_extract(row_json,'$.details_json.outOfBandHead')=?",[id,revision],undefined,'LIMIT 1').map(row => ({id:row.id})),
    requestReceipt: (id,requestId) => { const row = list('events',"json_extract(row_json,'$.session_id')=? AND json_extract(row_json,'$.originating_request_id')=? AND json_extract(row_json,'$.event_type')='submitted'",[id,requestId],undefined,'LIMIT 1')[0]; return row ? {submission_id:row.submission_id} : null; },
    publication: id => get('publications',id),
    publicationBySubmission: id => list('publications','submission_id=?',[id])[0] || null,
    publicationsForSource(id) { own(id); return list('publications','1',[],undefined,'LIMIT 50'); },
    async reservePublication(id,submissionId,actor) {
      if(meta('deletion_fence'))throw fail(409,'Publication is fenced by source deletion');
      own(id); const actorId = principalId(actor); let publication = store.publicationBySubmission(submissionId);
      if (publication && publication.actor_principal_id === actorId && (await catalog.principal(actorId))?.status === 'active' &&
          (['closing','published'].includes(publication.status) || publication.checkpoints_json.pointerEventId) && publication.status !== 'superseded') {
        return atomic(() => put('publications',{...publication,status:publication.status === 'failed' ? 'queued' : publication.status,error_message:null,updated_at:timestamp()}));
      }
      await publishAuthority({actor_principal_id:actorId});
      return atomic(() => {
        publication = store.publicationBySubmission(submissionId);
        const submission = get('submissions',submissionId), parent = submission && get('sessions',submission.session_id);
        if (publication) {
          if (publication.status === 'superseded') throw fail(409, 'This publication was superseded; submit a new change');
          if (publication.status === 'failed') {
            if (!parent || parent.status !== 'open' || parent.lease_token && Date.parse(parent.lease_expires_at)>clock()) throw fail(409, 'Session is busy or closed');
            put('submissions',{...submission,status:'publishing',updated_at:timestamp()});
            publication = put('publications',{...publication,status:'queued',error_message:null,updated_at:timestamp()});
          }
          return publication;
        }
        if (!submission || submission.status !== 'submitted' || !submission.head_commit || submission.target_draft_session_id) throw fail(409, 'A submitted Design System change is required');
        if (!parent || parent.status !== 'open' || parent.lease_token && Date.parse(parent.lease_expires_at)>clock()) throw fail(409, 'Session is busy or closed; retry publication after it finishes');
        for (const prior of sessionPublications(parent.id)) {
          if (prior.status === 'failed' && !blockingPublication(prior)) put('publications',{...prior,status:'superseded',updated_at:timestamp()});
          else if (!['published','superseded'].includes(prior.status)) throw fail(409, 'This session already has a queued publication');
        }
        if ((actor.requestId || null) !== parent.originating_request_id) throw fail(403, 'Publication Request must match its server-owned session');
        const position = scalar('SELECT COALESCE(MAX(queue_position),0)+1 AS n FROM publications').n;
        const row = {id:ids(),source_id:sourceId,submission_id:submissionId,execution_job_id:null,actor_user_id:actor.userId || null,actor_principal_id:actorId,originating_request_id:parent.originating_request_id,actor_email:String(actor.email || '').slice(0,320),status:'queued',stage:'queued',checkpoints_json:{},result_json:{},error_message:null,queue_position:position,conflict_rate:null,auto_rebase_success:null,submit_to_publish_ms:null,created_at:timestamp(),updated_at:timestamp(),completed_at:null};
        put('publications',row); put('submissions',{...submission,status:'publishing',updated_at:timestamp()}); locate('publication',row.id); return row;
      });
    },
    attachPublicationJob: (id,jobId) => atomic(() => {
      const row = get('publications',id); if (!row) throw fail(404, 'Publication not found');
      if (row.execution_job_id && row.execution_job_id !== jobId) throw fail(409, 'Publication already has a workflow');
      const job = get('jobs',jobId);
      if (job && job.payload_json.publicationId !== id) throw fail(409, 'Workflow belongs to another publication');
      if (!job) put('jobs',{id:jobId,job_type:'publish_design_system_submission',payload_json:{publicationId:id},status:'queued',attempt_count:0,lease_token:null,lease_owner:null,lease_expires_at:null,available_at:timestamp(),scheduled_at:timestamp(),created_at:timestamp(),updated_at:timestamp()});
      return put('publications',{...row,execution_job_id:jobId});
    }),
    claimPublicationJob: ({jobId,leaseToken,leaseOwner,leaseSeconds = 300}) => atomic(() => {
      const publication = list('publications',"json_extract(row_json,'$.execution_job_id')=?",[jobId])[0], job = get('jobs',jobId);
      if (!publication || !job || queuedBefore(publication) || (job.lease_token && Date.parse(job.lease_expires_at)>clock())) return null;
      if (list('publications').some(prior => prior.id !== publication.id && get('jobs',prior.execution_job_id)?.lease_expires_at > timestamp())) return null;
      if (job.available_at>timestamp() || job.scheduled_at>timestamp() || publication.status === 'superseded') return null;
      return put('jobs',{...job,status:'leased',attempt_count:job.attempt_count+1,lease_token:leaseToken,lease_owner:leaseOwner,lease_expires_at:new Date(clock()+Math.max(30,Math.min(leaseSeconds,3600))*1000).toISOString(),updated_at:timestamp()});
    }),
    renewPublicationLease: ({publicationId,jobId,leaseToken,leaseSeconds = 3600}) => atomic(() => {
      publicationLease(publicationId,{jobId,leaseToken});
      const job = get('jobs',jobId);
      return put('jobs',{...job,lease_expires_at:new Date(clock()+Math.max(30,Math.min(leaseSeconds,3600))*1000).toISOString(),updated_at:timestamp()});
    }),
    yieldPublicationLease: ({publicationId,jobId,leaseToken}) => atomic(() => {
      const publication = get('publications',publicationId), job = get('jobs',jobId);
      if (!publication || publication.execution_job_id !== jobId || !job || job.payload_json.publicationId !== publicationId) throw fail(409, 'Publication execution job lease is unavailable');
      if (!job.lease_token) return job;
      if (job.lease_token !== leaseToken) throw fail(409, 'Publication execution job lease is unavailable');
      return put('jobs',{...job,status:publication.status === 'published' ? 'completed' : 'queued',lease_token:null,lease_owner:null,lease_expires_at:null,updated_at:timestamp()});
    }),
    async authorizePublication(id,lease) {
      const publication = publicationLease(id,lease);
      if (!publication.checkpoints_json.pointerEventId) await publishAuthority(publication);
      return publication;
    },
    async checkpointPublication(id,lease,patch) {
      let row = publicationLease(id,lease);
      if (row.status === 'published') return row;
      if (row.status === 'superseded') throw fail(409, 'Publication was superseded');
      const advancing = Object.keys(patch).some(key => ['status','checkpoints_json','result_json'].includes(key));
      if (row.status !== 'closing' && advancing && patch.status !== 'failed' && !(patch.status === 'closing' && row.checkpoints_json.pointerEventId)) await publishAuthority(row);
      return atomic(() => {
        row = publicationLease(id,lease);
        const allowed = ['status','stage','checkpoints_json','result_json','error_message','conflict_rate','auto_rebase_success'];
        if (Object.keys(patch).some(key => !allowed.includes(key))) throw fail(400, 'Unsupported publication checkpoint');
        const checkpoints = {...(patch.checkpoints_json || row.checkpoints_json)};
        if (row.checkpoints_json.pointerEventId) Object.assign(checkpoints,{pointerEventId:row.checkpoints_json.pointerEventId,pointerVersionId:row.checkpoints_json.pointerVersionId});
        const next = {...row,...patch,checkpoints_json:checkpoints,updated_at:timestamp()};
        if (['closing','published'].includes(next.status) && !checkpoints.pointerEventId) throw fail(409, 'Publication has no committed pointer receipt');
        if (next.status === 'published') { next.completed_at = timestamp(); next.submit_to_publish_ms = Math.max(0,clock()-Date.parse(get('submissions',row.submission_id).created_at)); }
        put('publications',next);
        const submission = get('submissions',row.submission_id);
        if (['closing','published'].includes(next.status) && !list('events',"json_extract(row_json,'$.event_type')='published' AND json_extract(row_json,'$.details_json.publicationId')=?",[id]).length) {
          put('submissions',{...submission,status:'published',published_by:row.actor_principal_id,published_at:timestamp(),updated_at:timestamp()});
          audit({session_id:submission.session_id,submission_id:submission.id,event_type:'published',actor_user_id:row.actor_user_id,actor_principal_id:row.actor_principal_id,originating_request_id:row.originating_request_id,details_json:{publicationId:id,sourceCommit:checkpoints.sourceCommit,result:next.result_json},note:submission.note,merged_keys:checkpoints.mergedKeys || [],conflicted_keys:checkpoints.conflictedKeys || []});
        } else if (next.status === 'failed' && !Object.hasOwn(checkpoints,'sourceCommit')) put('submissions',{...submission,status:'submitted',updated_at:timestamp()});
        if (['published','failed'].includes(next.status)) { const job = get('jobs',lease.jobId); put('jobs',{...job,status:next.status === 'published' ? 'completed' : 'queued',lease_token:null,lease_expires_at:null,updated_at:timestamp()}); }
        return next;
      });
    },
    async releasePublicationVersion({publicationId,versionId,jobId,leaseToken}) {
      const lease = {jobId,leaseToken}; let publication = publicationLease(publicationId,lease);
      if (publication.checkpoints_json.pointerEventId) {
        if (publication.checkpoints_json.pointerVersionId !== versionId) throw fail(409, 'Publication already selected a different version');
        return pointerReceipt(get('publication_events',publication.checkpoints_json.pointerEventId));
      }
      await publishAuthority(publication);
      return atomic(() => {
        publication = publicationLease(publicationId,lease);
        const version = get('versions',versionId);
        if (publication.status !== 'running' || !version || version.source_id !== sourceId || version.publication_id !== publicationId || version.source_commit !== publication.checkpoints_json.sourceCommit) throw fail(409, 'Publication version does not match its merged source');
        immutablePublishedLabel(version);
        const event = {id:ids(),design_system_source_id:sourceId,design_system_version_id:versionId,action:'publish',actor_user_id:publication.actor_user_id,actor_principal_id:publication.actor_principal_id,originating_request_id:publication.originating_request_id,version_label:version.version_label,content_digest:version.content_digest,created_at:timestamp()};
        put('publication_events',event); enqueue('publication',event);
        const pointer = {published_version:version.version_label,source_commit:version.source_commit,content_digest:version.content_digest,published_version_id:versionId,artifact_ref:version.artifact_ref,source_ref:version.source_ref,initial_publication_required:false};
        setMeta('pointer',pointer); enqueue('pointer',pointer);
        const receipt = pointerReceipt(event);
        put('publications',{...publication,checkpoints_json:{...publication.checkpoints_json,pointerEventId:event.id,pointerVersionId:versionId},result_json:{status:'published',version:version.version_label,systemId:meta('system_id'),sourceId,publication:receipt},updated_at:timestamp()});
        return receipt;
      });
    },
    deletionInventory(id) { own(id); return {sessions:list('sessions').map(({id,status,expires_at}) => ({id,status,expires_at})),submissions:list('submissions').map(({id,status,review_branch,preview_url}) => ({id,status,review_branch,preview_url}))}; },
    getLifecycleOperation: id => get('lifecycle_operations',id),
    sessionRepository: id => scalar('SELECT * FROM session_repositories WHERE session_id=?',id),
    recordSessionRepository: ({sessionId,namespace,repository,repositoryId}) => atomic(()=>{
      const row=session(sessionId);
      if(row.source_id!==sourceId||repository!==`session-${sessionId}`||typeof namespace!=='string'||!namespace||typeof repositoryId!=='string'||!repositoryId||repositoryId.length>200||/[\x00-\x20\x7f]/.test(repositoryId))throw fail(409,'Fork creation receipt does not match this session');
      const prior=store.sessionRepository(sessionId);
      if(prior&&(prior.namespace!==namespace||prior.repository!==repository||prior.repository_id!==repositoryId))throw fail(409,'Immutable fork creation receipt changed');
      if(!prior)sql.exec('INSERT INTO session_repositories(session_id,namespace,repository,repository_id,created_at) VALUES(?,?,?,?,?)',sessionId,namespace,repository,repositoryId,timestamp());
      return store.sessionRepository(sessionId);
    }),
    getExecutionJob: id => get('jobs',id),

    // Internal coordinator functions below are not part of CollaborationStore v1.
    async initialize(source) { own(source.id); atomic(() => { setMeta('system_id',source.system_id); if (meta('authority_version') == null) setMeta('authority_version',source.authority_version || 0); }); },
    async flushOutbox(limit = 100,{requireDrained = true} = {}) {
      let delivered = 0;
      for (const item of rows('SELECT * FROM outbox ORDER BY sequence LIMIT ?',limit)) {
        await catalog.project({sequence:item.sequence,kind:item.kind,sourceId,row:decode(item.row_json)});
        atomic(() => sql.exec('DELETE FROM outbox WHERE sequence=?',item.sequence)); delivered++;
      }
      const pending=scalar('SELECT COUNT(*) AS n FROM outbox').n;
      // HTTP success must not precede a locator/audit receipt stranded behind a
      // large recovered backlog. Alarms may drain bounded batches; callers can
      // retry the durable operation while those projections catch up.
      if (pending && requireDrained) throw fail(503,'Collaboration receipts are still being projected; retry shortly');
      return {delivered,pending};
    },
    async scheduleAlarm({extraAt = null} = {}) {
      const due = store.expired(timestamp()).length || scalar('SELECT COUNT(*) AS n FROM outbox').n || meta('authority_pending');
      const expiry = scalar("SELECT MIN(expires_at) AS next FROM sessions WHERE status IN ('starting','open','closing') AND expires_at IS NOT NULL")?.next;
      const next = due ? clock()+5_000 : expiry ? Math.max(clock()+5_000,Date.parse(expiry)) : clock()+60_000;
      await storage.setAlarm(extraAt == null ? next : Math.min(next,Math.max(clock()+1_000,extraAt)));
    },
    async reconcileAuthority() {
      const pending = meta('authority_pending');
      if (!pending) return;
      let receipt;
      try { receipt = pending.kind==='invitation' ? await applyInvitationClaim(catalog,pending) : await catalog.applyAuthorityOperation(pending); }
      catch (error) {
        // A definite rejection with a primary-confirmed absent receipt made no
        // grant mutation. An unknown storage outcome keeps its durable barrier.
        if ([400,403,404,409].includes(error.statusCode) && !await catalog.authorityOperation(pending.operationId)) atomic(() => setMeta('authority_pending',null));
        throw error;
      }
      atomic(() => { setMeta('authority_version',receipt.confirmed_version); setMeta('authority_pending',null);
        enqueue('authority',{id:receipt.id,source_id:sourceId,event_type:'authority_changed',actor_principal_id:receipt.actor_id,details_json:receipt.command,created_at:receipt.created_at}); });
    },
    async mutateAuthority({operationId,actor,command,deletionOperationId}) {
      await store.reconcileAuthority();
      const facts = await catalog.readAuthority(sourceId,principalId(actor));
      if (facts.principal?.status !== 'active' || !facts.principal.admin) throw fail(403, 'An active administrator is required');
      const deletion=meta('deletion_fence'),internalDelete=deletionOperationId&&deletion?.operationId===deletionOperationId&&get('lifecycle_operations',deletionOperationId)?.kind==='delete';
      if ((deletion || ['deleting','deleted'].includes(facts.source?.lifecycle_status)) && !internalDelete) throw fail(409, 'Source authority is permanently fenced by deletion');
      if(internalDelete&&(['read','write','publish'].some(key=>command[key]===true)||command.lifecycleStatus&&!['deleting','deleted'].includes(command.lifecycleStatus)))throw fail(409,'Deletion cannot restore source authority');
      const prior = await catalog.authorityOperation(operationId);
      if (prior) { if (prior.source_id !== sourceId || prior.actor_id !== facts.principal.id || json(prior.command) !== json(command)) throw fail(409, 'Authority operation receipt does not match'); return prior; }
      if (command.lifecycleStatus === 'deleting' && ((!internalDelete&&store.sessions(sourceId).length) || list('publications').some(blockingPublication))) throw fail(409, 'Finish publications before deleting this Design System');
      const pending = {operationId,sourceId,actorId:facts.principal.id,expectedVersion:facts.authorityVersion,command};
      atomic(() => setMeta('authority_pending',pending));
      await store.reconcileAuthority();
      await store.flushOutbox();
      return catalog.authorityOperation(operationId);
    },
    async claimAccessInvitation({invitationId,identity,principalId:id}) {
      await store.reconcileAuthority();
      const invitation=await new AccessInvitations(catalog).read(invitationId);
      if(!invitation||invitation.source_id!==sourceId||invitation.issuer!==identity.issuer||invitation.email!==identity.email||identity.type!=='user'||!identity.subject.startsWith('user:'))throw fail(403,'Invitation does not match this verified identity');
      if(invitation.status!=='pending')return {invitationId,status:invitation.status,claimed:invitation.status==='claimed'&&invitation.claimed_principal_id===id};
      const facts=await catalog.readAuthority(sourceId,id),inviter=await catalog.principal(invitation.requested_by);
      if(meta('deletion_fence')||facts.source?.lifecycle_status!=='ready'||facts.source.archived_at||facts.organizationStatus!=='active'||inviter?.status!=='active'||!inviter.admin)return {invitationId,status:'pending',claimed:false};
      if(facts.principal?.status!=='active'||facts.principal.type!=='user'||facts.principal.issuer!==identity.issuer||facts.principal.subject!==identity.subject)throw fail(403,'The Access principal is unavailable');
      // Invitations add the reviewed permissions; they never revoke an existing
      // grant, confer administration, or reactivate an archived history actor.
      const command={principalId:id,read:Boolean(invitation.can_read||facts.access.read||facts.access.write),write:Boolean(invitation.can_write||facts.access.write),publish:Boolean(invitation.can_publish||facts.publisher)};
      const pending={kind:'invitation',operationId:invitationOperation(invitationId),sourceId,actorId:invitation.requested_by,expectedVersion:facts.authorityVersion,command,invitationClaim:{id:invitationId,principalId:id,issuer:identity.issuer,email:identity.email,subject:identity.subject}};
      atomic(()=>setMeta('authority_pending',pending));
      await store.reconcileAuthority();await store.flushOutbox();
      return {invitationId,status:'claimed',claimed:true,principalId:id};
    },
    stageVersion: ({publicationId,lease,version}) => atomic(() => {
      const publication = publicationLease(publicationId,lease);
      if (version.source_id !== sourceId || version.publication_id !== publicationId || version.source_commit !== publication.checkpoints_json.sourceCommit || !version.version_label || !/^[a-f0-9]{64}$/.test(version.content_digest || '')) throw fail(409, 'Staged version does not match the publication');
      immutablePublishedLabel(version);
      const prior = get('versions',version.id);
      if (prior && json(prior) !== json(version)) throw fail(409, 'Immutable version receipt changed');
      if (!prior) { put('versions',version); locate('version',version.id); }
      return {versionId:version.id,version:prior || version};
    }),
    getVersion: id => get('versions',id),
    recordPreviewBuild: input => atomic(() => {
      const {submissionId,sourceId:id,branch,headCommit,buildId,url,workerTag} = input;
      own(id);
      if(meta('deletion_fence'))return {applied:false,reason:'source_deleted'};
      if (typeof buildId !== 'string' || !buildId || typeof workerTag !== 'string' || !workerTag || !/^https:\/\//.test(url || '')) throw fail(400, 'Invalid Preview build receipt');
      const prior = get('preview_builds',buildId);
      if (prior) { if (json(prior.input) !== json(input)) throw fail(409, 'Preview build receipt changed'); return prior.result; }
      const submission = get('submissions',submissionId);
      if (!submission || submission.source_id !== id || submission.review_branch !== branch || submission.head_commit !== headCommit || !['submitted','publishing','published'].includes(submission.status)) return {applied:false,reason:'stale_or_closed'};
      const result = {applied:true,submissionId,buildId,previewUrl:url};
      put('submissions',{...submission,preview_url:url,updated_at:timestamp()});
      put('preview_builds',{id:buildId,input,result,created_at:timestamp()});
      return result;
    }),
    async rollbackVersion({versionId,actor,operationId,reason = '',dryRun = false}) {
      const source = await store.getSource(sourceId);
      await publishAuthority({actor_principal_id:principalId(actor)});
      if (list('publications').some(row => ['running','closing'].includes(row.status) || row.status === 'failed' && (Object.hasOwn(row.checkpoints_json,'sourceCommit') || Object.hasOwn(row.checkpoints_json,'staged')))) throw fail(409, 'Wait for the current publication before rolling back');
      const version = get('versions',versionId);
      if (!version || !store.resolveRollbackVersion(sourceId,versionId,true) || !version.artifact_ref) throw fail(409, 'The immutable version is not available for rollback');
      if (dryRun) return {apiVersion:1,dryRun:true,sourceId,versionId};
      if (!operationId) throw fail(400, 'A rollback operation ID is required');
      const fingerprint = json([versionId,principalId(actor),reason]), key = `rollback:${operationId}`;
      const prior = meta(key);
      if (prior) { if (prior.fingerprint !== fingerprint) throw fail(409, 'Rollback operation has different parameters'); return prior.response; }
      return atomic(() => {
        const event = {id:ids(),design_system_source_id:sourceId,design_system_version_id:versionId,action:'rollback',actor_user_id:actor.userId || null,actor_principal_id:principalId(actor),originating_request_id:actor.requestId || null,version_label:version.version_label,content_digest:version.content_digest,reason,created_at:timestamp()};
        put('publication_events',event); enqueue('publication',event);
        const pointer = {published_version:version.version_label,source_commit:version.source_commit,content_digest:version.content_digest,published_version_id:versionId,artifact_ref:version.artifact_ref,source_ref:version.source_ref,initial_publication_required:false};
        setMeta('pointer',pointer); enqueue('pointer',pointer);
        const response = {apiVersion:1,action:'rollback',result:{artifact:version.artifact || {},publication:pointerReceipt(event),version:{contentDigest:version.content_digest,id:versionId,sourceId:source.id,versionLabel:version.version_label}}};
        setMeta(key,{fingerprint,response}); return response;
      });
    },
    async fencePrincipal({operationId,principalId:id,version}) {
      const operation = await catalog.deactivationOperation(operationId);
      if (operation?.principal_id !== id || operation.version !== version || !operation.targets.some(target => target.source_id === sourceId)) throw fail(409, 'Principal fence does not match this coordinator');
      atomic(() => setMeta(`principal_fence:${id}`,{operationId,version}));
      return catalog.acknowledgePrincipalFence({operationId,sourceId,principalId:id,version});
    },
    outboxSize: () => scalar('SELECT COUNT(*) AS n FROM outbox').n,
    pendingPublications: () => list('publications','1',[],'queue_position').filter(row => ['queued','running','closing'].includes(row.status) || row.status === 'failed' && blockingPublication(row)),
    enqueueResource: (kind,id,tombstone = false) => locate(kind,id,tombstone),
    saveLifecycle: row => atomic(() => put('lifecycle_operations',row)),
    deletionFence: () => meta('deletion_fence'),
    activeDeletion: () => {const fence=meta('deletion_fence');return fence&&get('lifecycle_operations',fence.operationId);},
    async beginDeletion({operationId,actor,confirmedOperation}) {
      const operation=confirmedOperation||get('lifecycle_operations',operationId),prior=meta('deletion_fence');
      if(!operation||operation.kind!=='delete'||operation.source_id!==sourceId||!operation.confirmed_at||operation.confirmed_by!==principalId(actor))throw fail(409,'Confirmed deletion intent is required');
      if(prior&&prior.operationId!==operationId)throw fail(409,'Another deletion owns this source');
      const principal=await catalog.principal(principalId(actor));
      if(principal?.status!=='active'||!principal.admin)throw fail(403,'An active administrator is required');
      if(list('publications').some(blockingPublication))throw fail(409,'Finish publications before deleting this Design System');
      atomic(()=>{
        if(confirmedOperation)put('lifecycle_operations',confirmedOperation);
        if(!prior){
          setMeta('deletion_fence',{operationId,at:operation.confirmed_at,completed:false});
          audit({event_type:'source_deletion_fenced',actor_principal_id:principalId(actor),details_json:{operationId,impactHash:operation.impact_hash}});
        }
        for(const row of list('sessions'))if(!['closed','expired'].includes(row.status))saveSession({...row,status:'closing',lease_token:null,lease_expires_at:null,updated_at:timestamp()});
        for(const table of ['requests','request_jobs']){
          if(!scalar("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name=?",table))continue;
          for(const row of list(table))if(table==='request_jobs'?['queued','leased','running'].includes(row.status):row.status==='new')put(table,{...row,status:'cancelled',lease_token:null,lease_owner:null,lease_expires_at:null,updated_at:timestamp()});
        }
      });
      return store.deletionAuthority({operationId,actor,suffix:'fence',command:{lifecycleStatus:'deleting',sourcePatch:{deletion_operation_id:operationId,deletion_confirmed_at:operation.confirmed_at}}});
    },
    async deletionAuthority({operationId,actor,suffix,command}) {
      if(meta('deletion_fence')?.operationId!==operationId)throw fail(409,'Deletion fence changed');
      const principal=await catalog.principal(principalId(actor));
      if(principal?.status!=='active'||!principal.admin)throw fail(403,'An active administrator is required');
      const id=`${operationId}:${suffix}`,prior=await catalog.authorityOperation(id);
      // Another current admin may resume a confirmed deletion after the original
      // administrator is revoked. Immutable completed authority steps remain so.
      if(prior){if(prior.source_id!==sourceId||json(prior.command)!==json(command))throw fail(409,'Deletion authority receipt changed');return prior;}
      return store.mutateAuthority({operationId:id,actor,command,deletionOperationId:operationId});
    },
    finishDeletionSessions: operationId => atomic(()=>{
      if(meta('deletion_fence')?.operationId!==operationId)throw fail(409,'Deletion fence changed');
      for(const row of list('sessions'))if(!['closed','expired'].includes(row.status))saveSession({...row,status:'closed',lease_token:null,lease_expires_at:null,live_state:'closed',live_url:'',sandbox_id:'',updated_at:timestamp()});
      for(const row of list('submissions'))if(row.status!=='published')put('submissions',{...row,status:'closed',preview_url:'',updated_at:timestamp()});
    }),
    completeDeletion: (operationId,actorId) => atomic(()=>{
      const fence=meta('deletion_fence');if(fence?.operationId!==operationId)throw fail(409,'Deletion fence changed');
      if(!fence.completed){setMeta('deletion_fence',{...fence,completed:true});audit({event_type:'source_deleted',actor_principal_id:actorId,details_json:{operationId,immutableHistoryRetained:true}});}
    }),
    authorityPending: () => meta('authority_pending'),
  };
  function pointerReceipt(event) {
    return {event_id:event.id,source_id:sourceId,version_id:event.design_system_version_id,content_digest:event.content_digest,
      version_label:event.version_label,published_at:event.created_at,pointerEventId:event.id,pointerVersionId:event.design_system_version_id};
  }
  return store;
}
