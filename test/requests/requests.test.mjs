import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sqliteD1,sqliteStorage} from '../sqlite-adapters.mjs';
import {Catalog} from '../../src/store/catalog.mjs';
import {createSqliteCollaborationStore} from '../../src/store/sqlite.mjs';
import {createRequestStore} from '../../src/requests/store.mjs';
import {createDesignerRequests} from '../../src/requests/service.mjs';

const migration=await readFile(new URL('../../migrations/0001_catalog.sql',import.meta.url),'utf8');
const fail=statusCode=>Object.assign(new Error('Rejected fixture operation'),{statusCode});
async function fixture(t) {
  const db=sqliteD1();db.exec(migration);
  let time=Date.parse('2026-10-13T12:00:00Z');const clock=()=>time;
  const catalog=new Catalog(db,{clock}),principal=await catalog.resolveIdentity({issuer:'test',subject:'owner'});
  await catalog.bootstrapAdmin(principal,randomUUID());await catalog.ensureOrganization({id:'requests-org'});
  const actor={...principal,principalId:principal.id,operator:true},storages=[];
  async function makeSource(){
    const sourceId=randomUUID();
    await catalog.reserveSystem({operationId:randomUUID(),actor,source:{id:sourceId,system_id:`timds/${sourceId}`,organization_id:'requests-org',artifacts_namespace:'requests-test',artifacts_repository:sourceId}});
    const storage=sqliteStorage();storages.push(storage);
    const store=createSqliteCollaborationStore({storage,sourceId,catalog,clock});
    await store.initialize(await catalog.source(sourceId));
    await store.mutateAuthority({operationId:randomUUID(),actor,command:{lifecycleStatus:'ready',repositoryId:`repo-${sourceId}`,principalId:actor.id,publish:true,read:true,write:true}});
    const options={storage,sourceId,catalog,store,clock};
    return {sourceId,storage,store,options,requestStore:createRequestStore(options)};
  }
  const a=await makeSource(),calls=[],flags={denied:false,inactive:false,invite:true};
  const authorization={authenticatePrincipal:async id=>{if(flags.inactive || id!==actor.id)throw fail(403);return actor;},authorizeSource:async()=>{if(flags.denied)throw fail(403);}};
  const sessions={status:async(_actor,id)=>{const row=a.store.get(id);if(!row)throw fail(404);return{session:{id,sourceId:row.source_id},canInvite:flags.invite};}};
  const designer={configured:true,principalId:randomUUID(),start:async()=>({started:true}),status:async()=>({state:'ready'})};
  const service=createDesignerRequests({...a,authorization,sessions,designer,schedule:async row=>calls.push(row),clock});
  const post=(requestId,prompt='Make the heading blue',sessionId)=>service.create(actor,a.sourceId,{requestId,prompt,sessionId});
  const lease=requestId=>{const job=a.requestStore.jobForRequest(requestId),leaseToken=randomUUID();assert.ok(a.requestStore.claim({jobId:job.id,leaseToken,leaseOwner:'test',leaseSeconds:30}));return{jobId:job.id,leaseToken};};
  const session=async requestId=>{const row=await a.store.insert({id:randomUUID(),source_id:a.sourceId,owner_principal_id:actor.id,originating_request_id:requestId || null,expires_at:new Date(time+86400000).toISOString()});a.store.updateSession(row.id,{status:'open',base_revision:'a'.repeat(40),fork_repository:`session-${row.id}`});return a.store.get(row.id);};
  const submit=(sessionId,requestId)=>{const token=randomUUID();a.store.claim(sessionId,token);const submission=a.store.reserveSubmission({id:randomUUID(),source_id:a.sourceId,session_id:sessionId,request_hash:randomUUID(),base_revision:'a'.repeat(40),review_branch:`review-${randomUUID()}`});a.store.checkpoint(sessionId,token,{}, {id:submission.id,head_commit:'b'.repeat(40)},{event_type:'submitted',actor_principal_id:actor.id,originating_request_id:requestId,submission_id:submission.id});a.store.release(sessionId,token);return a.store.getSubmission(submission.id);};
  t.after(()=>{for(const storage of storages)storage.close();db.close();});
  return{...a,catalog,actor,service,post,lease,session,submit,flags,designer,calls,makeSource,tick:ms=>time+=ms};
}

test('authorization precedes durable reservation; global Request identity binds source, principal, prompt and target',async t=>{
  const f=await fixture(t),id=randomUUID();f.flags.denied=true;
  await assert.rejects(f.post(id),{statusCode:403});assert.equal(f.requestStore.get(id),null);
  f.flags.denied=false;const first=await f.post(id);assert.deepEqual(await f.post(id),first);
  assert.equal((await f.catalog.resource('request',id)).source_id,f.sourceId);
  for(const patch of [{sourceId:randomUUID()},{requestedBy:randomUUID()},{prompt:'different'},{sessionId:randomUUID()}])await assert.rejects(f.requestStore.reserve({requestId:id,sourceId:f.sourceId,requestedBy:f.actor.id,runnerPrincipalId:f.designer.principalId,prompt:'Make the heading blue',...patch}),error=>[400,409].includes(error.statusCode));
  const other=await f.makeSource();await assert.rejects(other.requestStore.reserve({requestId:id,sourceId:other.sourceId,requestedBy:f.actor.id,runnerPrincipalId:f.designer.principalId,prompt:'Make the heading blue'}),{statusCode:409});
  assert.equal(other.requestStore.get(id),null);
});

test('D1-only reservation interruption recovers exactly the original job, including after store reconstruction',async t=>{
  const f=await fixture(t),id=randomUUID(),reserve=f.catalog.reserveRequest.bind(f.catalog);let original;
  f.catalog.reserveRequest=async input=>{original=await reserve(input);throw new Error('Lost D1 response');};
  await assert.rejects(f.post(id),/Lost D1/);assert.equal(f.requestStore.get(id),null);
  f.catalog.reserveRequest=reserve;
  const response=await f.post(id);assert.equal(response.executionJobId,original.job.id);
  const restarted=createRequestStore(f.options);assert.deepEqual(restarted.get(id),original.request);assert.equal(restarted.jobForRequest(id).id,original.job.id);
});

test('configuration rotation cannot rebind an existing Request to a replacement model principal',async t=>{
  const f=await fixture(t),id=randomUUID(),original=f.designer.principalId;await f.post(id);
  f.designer.principalId=randomUUID();await f.post(id);
  assert.equal((await f.service.binding(id)).agentPrincipalId,original);
  const next=randomUUID();await f.post(next);assert.equal((await f.service.binding(next)).agentPrincipalId,f.designer.principalId);
});

test('expired Request lease can be taken over; stale finish and fail cannot mutate the replacement job',async t=>{
  const f=await fixture(t),id=randomUUID();await f.post(id);const old=f.lease(id);
  assert.equal(f.requestStore.due().length,0);f.tick(30_001);assert.equal(f.requestStore.due().length,1);
  const fresh=f.lease(id);
  assert.throws(()=>f.requestStore.finish(old),{statusCode:409});assert.throws(()=>f.requestStore.fail(old),{statusCode:409});
  assert.equal(f.requestStore.getJob(old.jobId).lease_token,fresh.leaseToken);
  f.requestStore.finish({...fresh,result:{accepted:true}});assert.equal(f.requestStore.get(id).status,'processed');assert.equal(f.requestStore.due().length,0);
});

test('bounded failures retain no provider secrets and explicit same-identity retry requeues the existing job',async t=>{
  const f=await fixture(t),id=randomUUID();const response=await f.post(id);
  for(let attempt=1;attempt<=3;attempt++){const leased=f.lease(id);const job=f.requestStore.fail({...leased,error:new Error('Bearer SECRET')});assert.equal(job.status,attempt===3?'dead_letter':'queued');assert(!JSON.stringify(job).includes('SECRET'));f.tick(60_001);}
  assert.equal(f.requestStore.due().length,0);assert.equal((await f.post(id)).executionJobId,response.executionJobId);assert.equal(f.requestStore.due().length,1);
});

test('lost native start response recovers frozen submission after fork closure without another model run',async t=>{
  const f=await fixture(t),id=randomUUID(),session=await f.session();await f.post(id,'Blue',session.id);let forwards=0,submission;
  f.designer.start=async()=>{forwards++;submission=f.submit(session.id,id);throw fail(502);};
  const old=f.lease(id);await assert.rejects(f.service.execute(id,old),{statusCode:502});f.requestStore.fail(old);
  f.store.updateSession(session.id,{status:'closed'});f.tick(60_001);
  f.designer.start=async()=>assert.fail('must not restart the model');
  const result=await f.service.execute(id,f.lease(id));
  assert.equal(forwards,1);assert.deepEqual(result.runner,{state:'submitted',requestId:id,submissionId:submission.id});assert.equal(result.session.status,'closed');assert.equal(f.requestStore.jobForRequest(id).status,'succeeded');
});

test('closed-fork receipt recovery still checks active identity, source access, owner invitation and exact Request',async t=>{
  const f=await fixture(t),id=randomUUID(),session=await f.session();await f.post(id,'Blue',session.id);f.submit(session.id,id);f.store.updateSession(session.id,{status:'closed'});const lease=f.lease(id);
  f.designer.start=async()=>assert.fail('matching receipt does not dispatch');
  for(const [flag,value] of [['inactive',true],['denied',true],['invite',false]]){const prior=f.flags[flag];f.flags[flag]=value;await assert.rejects(f.service.execute(id,lease),{statusCode:403});f.flags[flag]=prior;}
  await assert.rejects(f.service.execute(randomUUID(),lease),{statusCode:409});
  const other=randomUUID();await f.post(other,'Another',session.id);f.designer.start=async()=>{throw fail(410);};
  await assert.rejects(f.service.execute(other,f.lease(other)),{statusCode:410});assert.equal(f.requestStore.get(other).status,'new');
  assert.equal((await f.service.execute(id,lease)).runner.state,'submitted');
});

test('shared Request progress uses its own audit receipt and never reports another task or dev readiness',async t=>{
  const f=await fixture(t),id=randomUUID(),session=await f.session();await f.post(id,'Blue',session.id);
  const read=()=>f.service.read(f.actor,f.sourceId,id);
  for(const runner of [{state:'ready'},{state:'sleeping'},{state:'submitted',requestId:randomUUID(),submissionId:randomUUID()}]){f.designer.status=async()=>runner;assert.equal((await read()).runner,null);assert.equal((await read()).submissionId,null);}
  const submission=f.submit(session.id,id);assert.equal((await read()).submissionId,submission.id);
  const result=await read();for(const key of ['lease_token','fork_repository','token_id','idempotency_key'])assert(!JSON.stringify(result).includes(key));
  assert.equal((await f.service.binding(id)).note,'Blue');
});
