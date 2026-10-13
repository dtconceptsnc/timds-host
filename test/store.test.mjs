import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Catalog } from '../src/store/catalog.mjs';
import { createSqliteCollaborationStore } from '../src/store/sqlite.mjs';
import { createCoordinator } from '../src/coordinator/coordinator.mjs';
import { sqliteD1, sqliteStorage } from './sqlite-adapters.mjs';

const migration = await readFile(new URL('../migrations/0001_catalog.sql',import.meta.url),'utf8');
const revision = 'a'.repeat(40), digest = 'b'.repeat(64);
async function fixture(t,{disk = false} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'timds-store-'));
  const db = sqliteD1(disk ? path.join(directory,'catalog.sqlite') : ':memory:'); db.exec(migration);
  let now = Date.parse('2026-10-13T00:00:00Z'); const clock = () => now;
  const catalog = new Catalog(db,{clock});
  const admin = await catalog.resolveIdentity({issuer:'test',subject:'admin',name:'Admin'});
  await catalog.bootstrapAdmin(admin,randomUUID());
  const actor = {principalId:admin.id,operator:true,type:'user'};
  const member = await catalog.resolveIdentity({issuer:'test',subject:'member',name:'Member'});
  await catalog.ensureOrganization({id:'test-org',name:'Test'});
  const stores = [], storages = [];
  async function makeSource(label = 'one') {
    const sourceId = randomUUID();
    const source = {id:sourceId,system_id:label,organization_id:'test-org',artifacts_namespace:'test',artifacts_repository:label,manifest_json:{systemId:label}};
    await catalog.reserveSystem({operationId:randomUUID(),actor,source});
    const file = disk ? path.join(directory,`${label}.sqlite`) : ':memory:';
    let storage = sqliteStorage(file); storages.push(storage);
    let store = createSqliteCollaborationStore({sourceId,storage,catalog,clock}); stores.push(store);
    await store.initialize(await catalog.source(sourceId));
    await store.mutateAuthority({operationId:randomUUID(),actor,command:{lifecycleStatus:'ready',repositoryId:`repo-${label}`,principalId:admin.id,publish:true,read:true,write:true}});
    return {sourceId,file,get storage() { return storage; },get store() { return store; },
      restart() { storage.close(); storages.splice(storages.indexOf(storage),1); storage = sqliteStorage(file); storages.push(storage); store = createSqliteCollaborationStore({sourceId,storage,catalog,clock}); return store; }};
  }
  t.after(async () => { for (const storage of storages) storage.close(); db.close(); await rm(directory,{recursive:true,force:true}); });
  return {catalog,db,actor,admin,member,clock,tick:ms => { now += ms; },makeSource};
}
const newSession = (f,source,extra = {}) => ({id:randomUUID(),source_id:source.sourceId,owner_principal_id:f.admin.id,
  expires_at:new Date(f.clock()+86_400_000).toISOString(),...extra});
async function submitted(f,source,key) {
  const row = await source.store.insert(newSession(f,source,{idempotency_key:key}));
  const lease = randomUUID(); source.store.claim(row.id,lease);
  const submission = source.store.reserveSubmission({id:randomUUID(),source_id:source.sourceId,session_id:row.id,request_hash:randomUUID(),base_revision:revision,review_branch:`review-${randomUUID()}`});
  source.store.checkpoint(row.id,lease,{status:'open',base_revision:revision},{id:submission.id,head_commit:revision},{event_type:'submitted',actor_principal_id:f.admin.id,submission_id:submission.id});
  source.store.release(row.id,lease); return {session:row,submission};
}
async function running(f,source,input) {
  const publication = await source.store.reservePublication(source.sourceId,input.submission.id,f.actor);
  const jobId = randomUUID(), leaseToken = randomUUID();
  source.store.attachPublicationJob(publication.id,jobId);
  assert.ok(source.store.claimPublicationJob({jobId,leaseToken,leaseOwner:'test'}));
  const lease = {jobId,leaseToken};
  await source.store.checkpointPublication(publication.id,lease,{status:'running',checkpoints_json:{sourceCommit:revision}});
  return {publication,lease};
}

test('global start key cannot cross sources or change origins; reservation recovers before local insert',async t => {
  const f = await fixture(t), a = await f.makeSource('a'), b = await f.makeSource('b');
  const key = 'global-key'; const first = await a.store.insert(newSession(f,a,{idempotency_key:key}));
  assert.equal((await b.store.byKey(f.admin.id,key)).source_id,a.sourceId);
  await assert.rejects(b.store.insert(newSession(f,b,{idempotency_key:key})),error => error.statusCode === 409);
  await assert.rejects(a.store.insert(newSession(f,a,{idempotency_key:key,origin_revision:revision})),error => error.statusCode === 409);
  assert.equal((await a.store.insert(newSession(f,a,{idempotency_key:key}))).id,first.id);
  const reserved = {...newSession(f,a,{idempotency_key:'crash'}),status:'starting',kind:'session',name:null,draft_session_id:null,origin_revision:null,originating_request_id:null,created_at:new Date(f.clock()).toISOString()};
  await f.catalog.reserveStart(reserved);
  assert.equal((await a.store.byKey(f.admin.id,'crash')).id,reserved.id);
  assert.equal(a.store.get(reserved.id).id,reserved.id);
});

test('closing draft keeps its unique name; null draft expiry survives checkpoints',async t => {
  const f = await fixture(t), a = await f.makeSource();
  const draft = await a.store.insert(newSession(f,a,{kind:'draft',name:'shared',expires_at:null}));
  const lease = randomUUID(); a.store.claim(draft.id,lease);
  a.store.checkpoint(draft.id,lease,{status:'closing',expires_at:null});
  assert.equal(a.store.draft(a.sourceId,'shared'),null);
  await assert.rejects(a.store.insert(newSession(f,a,{kind:'draft',name:'shared',expires_at:null})),error => error.statusCode === 409);
  assert.equal(a.store.get(draft.id).expires_at,null);
  a.store.checkpoint(draft.id,lease,{status:'closed'});
  assert.notEqual((await a.store.insert(newSession(f,a,{kind:'draft',name:'shared',expires_at:null}))).id,draft.id);
});

test('checkpoint rolls back session, audit and outbox when preparing submission changed',async t => {
  const f = await fixture(t), a = await f.makeSource();
  const row = await a.store.insert(newSession(f,a)), lease = randomUUID(); a.store.claim(row.id,lease);
  const before = a.store.get(row.id), pending = a.store.outboxSize();
  assert.throws(() => a.store.checkpoint(row.id,lease,{base_revision:revision},{id:randomUUID(),head_commit:revision},{event_type:'submitted'}),error => error.statusCode === 409);
  assert.deepEqual(a.store.get(row.id),before);
  assert.equal(a.store.outboxSize(),pending); assert.equal((await a.store.events(a.sourceId)).length,0);
  f.tick(900_001);
  assert.throws(() => a.store.checkpoint(row.id,lease,{status:'open'}),error => error.statusCode === 409);
});

test('SQLite restart preserves leases, then rejects a stale lease after takeover',async t => {
  const f = await fixture(t,{disk:true}), a = await f.makeSource();
  const row = await a.store.insert(newSession(f,a)), oldLease = randomUUID(); a.store.claim(row.id,oldLease);
  a.restart(); assert.throws(() => a.store.claim(row.id,randomUUID()),error => error.statusCode === 409);
  f.tick(900_001); const newLease = randomUUID(); a.store.claim(row.id,newLease);
  a.store.release(row.id,oldLease); assert.equal(a.store.get(row.id).lease_token,newLease);
  assert.throws(() => a.store.checkpoint(row.id,oldLease,{status:'open'}),error => error.statusCode === 409);
  a.store.checkpoint(row.id,newLease,{status:'open'});
});

test('outbox retries a projected-but-unacknowledged event after SQLite restart exactly once',async t => {
  const f = await fixture(t,{disk:true}), a = await f.makeSource();
  const event = a.store.appendEvent({event_type:'updated',actor_principal_id:f.admin.id});
  const project = f.catalog.project.bind(f.catalog); let failAfterCommit = true;
  f.catalog.project = async value => { await project(value); if (failAfterCommit) {failAfterCommit = false; throw new Error('simulated lost D1 response');} };
  await assert.rejects(a.store.flushOutbox()); assert.equal(a.store.outboxSize(),1);
  a.restart(); await a.store.flushOutbox(); assert.equal(a.store.outboxSize(),0);
  assert.equal((await f.catalog.all('SELECT id FROM audit_events WHERE id=?',event.id)).length,1);
  assert.equal((await a.store.events(a.sourceId))[0].actor_name,'Admin');
});

test('global idempotency tombstone survives session closure and projection',async t => {
  const f = await fixture(t), a = await f.makeSource(); const row = await a.store.insert(newSession(f,a,{idempotency_key:'closed'}));
  const lease = randomUUID(); a.store.claim(row.id,lease); a.store.checkpoint(row.id,lease,{status:'closed'}); await a.store.flushOutbox();
  const receipt = await f.catalog.startReservation(f.admin.id,'closed');
  assert.equal(receipt.tombstone,1); assert.equal(receipt.session.status,'closed');
  assert.equal((await a.store.insert(newSession(f,a,{idempotency_key:'closed'}))).id,row.id);
});

test('member visibility projects before acknowledgment and expires without granting publication',async t => {
  const f = await fixture(t), a = await f.makeSource(); const row = await a.store.insert(newSession(f,a));
  const lease = randomUUID(); a.store.claim(row.id,lease); a.store.checkpoint(row.id,lease,{status:'open'});
  await a.store.addMember({session_id:row.id,principal_id:f.member.id,role:'member',invited_by:f.admin.id});
  assert.equal((await a.store.members(row.id))[0].principal.name,'Member');
  assert.equal((await f.catalog.sourcesForPrincipal(f.member.id)).length,1);
  assert.equal((await f.catalog.readAuthority(a.sourceId,f.member.id)).publisher,false);
  f.tick(86_400_001); assert.equal(a.store.hasSessionAccess(f.member.id,a.sourceId),false);
  assert.equal((await f.catalog.sourcesForPrincipal(f.member.id)).length,0);
});

test('publication FIFO blocks later claims and stale job lease cannot checkpoint',async t => {
  const f = await fixture(t), a = await f.makeSource();
  const one = await submitted(f,a,'one'), two = await submitted(f,a,'two');
  const p1 = await a.store.reservePublication(a.sourceId,one.submission.id,f.actor), p2 = await a.store.reservePublication(a.sourceId,two.submission.id,f.actor);
  assert.equal(p2.queue_position,p1.queue_position+1);
  const j1 = randomUUID(), j2 = randomUUID(), l1 = randomUUID(); a.store.attachPublicationJob(p1.id,j1); a.store.attachPublicationJob(p2.id,j2);
  assert.equal(a.store.claimPublicationJob({jobId:j2,leaseToken:randomUUID(),leaseOwner:'test'}),null);
  assert.ok(a.store.claimPublicationJob({jobId:j1,leaseToken:l1,leaseOwner:'test'}));
  f.tick(301_000); const l2 = randomUUID(); assert.ok(a.store.claimPublicationJob({jobId:j1,leaseToken:l2,leaseOwner:'retry'}));
  await assert.rejects(a.store.checkpointPublication(p1.id,{jobId:j1,leaseToken:l1},{status:'running'}),error => error.statusCode === 409);
  await a.store.checkpointPublication(p1.id,{jobId:j1,leaseToken:l2},{status:'failed'});
  assert.ok(a.store.claimPublicationJob({jobId:j2,leaseToken:randomUUID(),leaseOwner:'test'}));
});

test('revocation denies pointer flip; committed pointer replays after revocation without second event',async t => {
  const f = await fixture(t), a = await f.makeSource(); const input = await submitted(f,a,'publish'), {publication,lease} = await running(f,a,input);
  const version = {id:randomUUID(),source_id:a.sourceId,publication_id:publication.id,version_label:'0.1.1',source_commit:revision,content_digest:digest,artifact_ref:'artifact',source_ref:'source',stamp:'test',created_at:new Date(f.clock()).toISOString()};
  a.store.stageVersion({publicationId:publication.id,lease,version});
  await a.store.mutateAuthority({operationId:randomUUID(),actor:f.actor,command:{principalId:f.admin.id,publish:false}});
  await assert.rejects(a.store.releasePublicationVersion({publicationId:publication.id,versionId:version.id,...lease}),error => error.statusCode === 403);
  assert.equal((await a.store.publications(a.sourceId)).length,0);
  await a.store.mutateAuthority({operationId:randomUUID(),actor:f.actor,command:{principalId:f.admin.id,publish:true}});
  const receipt = await a.store.releasePublicationVersion({publicationId:publication.id,versionId:version.id,...lease});
  await a.store.mutateAuthority({operationId:randomUUID(),actor:f.actor,command:{principalId:f.admin.id,publish:false}});
  assert.deepEqual(await a.store.releasePublicationVersion({publicationId:publication.id,versionId:version.id,...lease}),receipt);
  assert.equal((await a.store.publications(a.sourceId)).length,1);
  await a.store.checkpointPublication(publication.id,lease,{status:'closing'});
  assert.equal(a.store.getSubmission(input.submission.id).status,'published');
});

test('unknown D1 authority outcome remains pending and reconciles from durable receipt on restart',async t => {
  const f = await fixture(t,{disk:true}), a = await f.makeSource();
  const apply = f.catalog.applyAuthorityOperation.bind(f.catalog); let failAfterCommit = true;
  f.catalog.applyAuthorityOperation = async input => { const receipt = await apply(input); if (failAfterCommit) {failAfterCommit = false; throw new Error('simulated lost response');} return receipt; };
  const operationId = randomUUID();
  await assert.rejects(a.store.mutateAuthority({operationId,actor:f.actor,command:{principalId:f.admin.id,publish:false}}));
  assert.ok(a.store.authorityPending()); a.restart(); await a.store.reconcileAuthority();
  assert.equal(a.store.authorityPending(),null);
  assert.equal((await f.catalog.readAuthority(a.sourceId,f.admin.id)).publisher,false);
  assert.equal((await f.catalog.all('SELECT id FROM authority_operations WHERE id=?',operationId)).length,1);
});

test('bootstrap is one-time across identities and immutable for inactive principals',async t => {
  const f = await fixture(t);
  await assert.rejects(f.catalog.bootstrapAdmin(f.member,randomUUID()),error => error.statusCode === 403);
  assert.equal((await f.catalog.principal(f.member.id)).admin,false);
  await f.catalog.run("UPDATE principals SET status='inactive' WHERE id=?",f.admin.id);
  assert.equal((await f.catalog.resolveIdentity({issuer:'test',subject:'admin',name:'New name'})).status,'inactive');
});

test('coordinator serializes authority mutation across asynchronous publication reads and pointer commit',async t => {
  const f = await fixture(t), a = await f.makeSource(); const input = await submitted(f,a,'serialized'), {publication,lease} = await running(f,a,input);
  const version = {id:randomUUID(),source_id:a.sourceId,publication_id:publication.id,version_label:'0.1.2',source_commit:revision,content_digest:digest};
  a.store.stageVersion({publicationId:publication.id,lease,version});
  const engine = createCoordinator({sourceId:a.sourceId,storage:a.storage,catalog:f.catalog,repository:{},authorization:{},clock:f.clock});
  const read = f.catalog.readAuthority.bind(f.catalog); let release, entered;
  const inside = new Promise(resolve => {entered = resolve;}); const paused = new Promise(resolve => {release = resolve;}); let pause = true;
  f.catalog.readAuthority = async (...args) => { const facts = await read(...args); if (pause) {pause = false; entered(); await paused;} return facts; };
  const commit = engine.publicationStore('releasePublicationVersion',[{publicationId:publication.id,versionId:version.id,...lease}]);
  await inside;
  let revoked = false;
  const revoke = engine.mutateAuthority({operationId:randomUUID(),actor:f.actor,command:{principalId:f.admin.id,publish:false}}).then(() => {revoked = true;});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(revoked,false);
  release(); await commit; await revoke;
  assert.equal((await f.catalog.readAuthority(a.sourceId,f.admin.id)).publisher,false);
  assert.equal((await engine.currentSource()).published_version,'0.1.2');
  assert.ok(await a.storage.getAlarm());
});

test('rollback dry-run is read-only and actual replay keeps one immutable pointer receipt',async t => {
  const f = await fixture(t), a = await f.makeSource();
  const input = await submitted(f,a,'rollback'), {publication,lease} = await running(f,a,input);
  const version = {id:randomUUID(),source_id:a.sourceId,publication_id:publication.id,version_label:'0.1.3',source_commit:revision,content_digest:digest,artifact_ref:'artifact',artifact:{entryPath:'index.html',fileCount:2,totalBytes:10}};
  a.store.stageVersion({publicationId:publication.id,lease,version});
  await a.store.releasePublicationVersion({publicationId:publication.id,versionId:version.id,...lease});
  await a.store.checkpointPublication(publication.id,lease,{status:'closing'});
  await a.store.checkpointPublication(publication.id,lease,{status:'published'});
  const engine = createCoordinator({sourceId:a.sourceId,storage:a.storage,catalog:f.catalog,repository:{},authorization:{authorizePublish:async () => {}},clock:f.clock});
  const operationId = randomUUID(), args = {actor:f.actor,operationId,input:{version:'0.1.3',reason:'Restore accepted version'}};
  assert.deepEqual(await engine.rollbackVersion({...args,input:{...args.input,dryRun:true}}),{apiVersion:1,dryRun:true,sourceId:a.sourceId,versionId:version.id});
  assert.equal((await a.store.publications(a.sourceId)).length,1);
  const result = await engine.rollbackVersion(args);
  assert.equal(result.action,'rollback'); assert.equal(result.result.version.id,version.id);
  assert.deepEqual(result.result.artifact,version.artifact);
  assert.deepEqual(await engine.rollbackVersion(args),result);
  assert.equal((await a.store.publications(a.sourceId)).length,2);
  assert.equal((await a.store.publications(a.sourceId)).find(row => row.action === 'rollback').reason,'Restore accepted version');
});

test('a published label cannot acquire new bytes or provenance before an external release',async t => {
  const f=await fixture(t),a=await f.makeSource(),input=await submitted(f,a,'first-label'),first=await running(f,a,input);
  const version={id:randomUUID(),source_id:a.sourceId,publication_id:first.publication.id,version_label:'1.0.0',source_commit:revision,content_digest:digest,stamp:{version:'1.0.0',sourceCommit:revision,contentDigest:digest}};
  a.store.stageVersion({publicationId:first.publication.id,lease:first.lease,version});
  await a.store.releasePublicationVersion({publicationId:first.publication.id,versionId:version.id,...first.lease});
  await a.store.checkpointPublication(first.publication.id,first.lease,{status:'closing'});await a.store.checkpointPublication(first.publication.id,first.lease,{status:'published'});
  const next=await running(f,a,await submitted(f,a,'duplicate-label'));
  const changed={...version,id:randomUUID(),publication_id:next.publication.id,content_digest:'c'.repeat(64)};
  assert.throws(()=>a.store.stageVersion({publicationId:next.publication.id,lease:next.lease,version:changed}),error=>error.statusCode===409);
  assert.equal(a.store.getVersion(changed.id),null);assert.equal(a.store.resolveRollbackVersion(a.sourceId,'1.0.0'),version.id);
});

test('principal deactivation cannot complete before all durable coordinator fences',async t => {
  const f = await fixture(t), a = await f.makeSource('a'), b = await f.makeSource('b');
  await a.store.mutateAuthority({operationId:randomUUID(),actor:f.actor,command:{principalId:f.member.id,publish:true}});
  const operationId = randomUUID(), receipt = await f.catalog.beginPrincipalDeactivation({principalId:f.member.id,actor:f.actor,operationId});
  assert.equal((await f.catalog.principal(f.member.id)).status,'deactivating');
  assert.equal(receipt.targets.length,2);
  await assert.rejects(f.catalog.finalizePrincipalDeactivation({operationId,actor:f.actor}),error => error.statusCode === 409);
  await a.store.fencePrincipal({operationId,principalId:f.member.id,version:receipt.version});
  await assert.rejects(f.catalog.finalizePrincipalDeactivation({operationId,actor:f.actor}),error => error.statusCode === 409);
  await b.store.fencePrincipal({operationId,principalId:f.member.id,version:receipt.version});
  assert.equal((await f.catalog.finalizePrincipalDeactivation({operationId,actor:f.actor})).status,'completed');
  assert.equal((await f.catalog.principal(f.member.id)).status,'inactive');
  await assert.rejects(b.store.mutateAuthority({operationId:randomUUID(),actor:f.actor,command:{principalId:f.member.id,publish:true}}),error => error.statusCode === 403);
  assert.equal(b.store.authorityPending(),null);
  // A rejected attempt must not strand unrelated future grants behind a barrier.
  await b.store.mutateAuthority({operationId:randomUUID(),actor:f.actor,command:{principalId:f.admin.id,read:true}});
});

test('Workflow stages renew only their lease, yield, and cannot release a newer stage owner',async t => {
  const f = await fixture(t), a = await f.makeSource(); const input = await submitted(f,a,'renew'), {publication,lease} = await running(f,a,input);
  f.tick(250_000);
  const renewed = a.store.renewPublicationLease({publicationId:publication.id,...lease,leaseSeconds:3600});
  assert.equal(Date.parse(renewed.lease_expires_at),f.clock()+3_600_000);
  a.store.yieldPublicationLease({publicationId:publication.id,...lease});
  const nextToken = randomUUID();
  assert.ok(a.store.claimPublicationJob({jobId:lease.jobId,leaseToken:nextToken,leaseOwner:'next',leaseSeconds:3600}));
  assert.throws(() => a.store.yieldPublicationLease({publicationId:publication.id,...lease}),error => error.statusCode === 409);
  assert.throws(() => a.store.renewPublicationLease({publicationId:publication.id,...lease}),error => error.statusCode === 409);
  assert.equal(a.store.getExecutionJob(lease.jobId).lease_token,nextToken);
});

test('Preview build receipts update only exact immutable submission heads; stale live callbacks cannot reopen status',async t => {
  const f = await fixture(t), a = await f.makeSource(), input = await submitted(f,a,'preview');
  const preview = {submissionId:input.submission.id,sourceId:a.sourceId,branch:input.submission.review_branch,headCommit:revision,buildId:randomUUID(),url:'https://preview.example.test/',workerTag:'fixture'};
  const result = a.store.recordPreviewBuild(preview);
  assert.equal(result.applied,true); assert.deepEqual(a.store.recordPreviewBuild(preview),result);
  assert.equal(a.store.getSubmission(input.submission.id).preview_url,preview.url);
  assert.equal((await a.store.publications(a.sourceId)).length,0);
  assert.deepEqual(a.store.recordPreviewBuild({...preview,buildId:randomUUID(),headCommit:'c'.repeat(40)}),{applied:false,reason:'stale_or_closed'});
  assert.throws(() => a.store.recordPreviewBuild({...preview,url:'https://different.example.test/'}),error => error.statusCode === 409);
  a.store.updateSession(input.session.id,{status:'closed'});
  assert.throws(() => a.store.updateSession(input.session.id,{live_state:'running'},{expectedStatus:'open'}),error => error.statusCode === 409);
  assert.equal(a.store.get(input.session.id).status,'closed');
});
