import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHostLiveSessions,createLiveCallbacks} from '../../src/live/sessions.mjs';
import {createDesigner} from '../../src/requests/designer.mjs';
import {designSystemPreviewPath} from '../../src/live/preview-path.mjs';

function fixture() {
  const source={id:randomUUID(),system_id:`timds/${randomUUID()}`,lifecycle_status:'ready',artifacts_namespace:'test'},id=randomUUID();
  const session={id,source_id:source.id,owner_principal_id:randomUUID(),fork_repository:`session-${id}`,base_revision:'a'.repeat(40),status:'open',sandbox_id:id,expires_at:null};
  const calls=[],store={get:async key=>key===id?session:null,getSource:async key=>key===source.id?source:null,eligible:async()=>true,updateSession:async(key,patch)=>{assert.equal(key,id);Object.assign(session,patch);}};
  const native={configure:async(...args)=>{calls.push(['configure',...args]);return{state:'sleeping'};},status:async()=>({state:'ready'}),start:async(...args)=>{calls.push(['start',...args]);return{runner:{state:'running',requestId:args[1].requestId}};},pushed:async body=>{calls.push(['push',body]);return{state:'ready'};},close:async key=>{calls.push(['native-close',key]);return{state:'closing'};}};
  const artifacts={getRepository:async(...args)=>{calls.push(['repo',...args]);return{remote:'https://artifacts.example/repo.git'};},mintToken:async(...args)=>{calls.push(['mint',...args]);return{token:'test-runtime-only-token'};}};
  const hosts={ensure:async()=>`https://live.example/`,close:async()=>calls.push(['host-close'])},subscriptions={ensure:async()=>calls.push(['subscription']),close:async()=>calls.push(['subscription-close'])};
  const live=createHostLiveSessions({sourceId:source.id,getLive:key=>{assert.equal(key,id);return native;},artifacts,store,hosts,subscriptions});
  return{source,session,calls,store,native,live};
}

test('native configure persists source identity before any live start; runtime credentials are read-only and finite',async()=>{
  const f=fixture();await f.live.schedule(f.session);
  assert.deepEqual(f.calls[0],['configure',f.session.id,{sourceId:f.source.id,expiresAt:null}]);
  const ensured=await f.live.ensure(f.session,f.source);assert.equal(ensured.sandbox_id,f.session.id);
  const credential=await f.live.credentials({sessionId:f.session.id});assert.equal(credential.baseRevision,'a'.repeat(40));assert.equal(credential.repoToken,'test-runtime-only-token');
  assert.deepEqual(f.calls.find(row=>row[0]==='mint'),['mint','test',f.session.fork_repository,{permission:'read',ttlSeconds:900}]);
  f.session.status='closed';await assert.rejects(f.live.credentials({sessionId:f.session.id}),{statusCode:410});
  assert.equal(f.calls.filter(row=>row[0]==='mint').length,1);
});

test('foreign source/fork, archived source and expired sessions cannot mint live credentials or start runtime work',async()=>{
  for(const kind of ['source','fork','archived','expired']){
    const f=fixture();
    if(kind==='source')f.session.source_id=randomUUID();
    if(kind==='fork')f.session.fork_repository='another-repository';
    if(kind==='archived')f.source.archived_at=new Date().toISOString();
    if(kind==='expired')f.session.expires_at='2020-01-01T00:00:00Z';
    await assert.rejects(f.live.credentials({sessionId:f.session.id}),error=>[404,409,410].includes(error.statusCode));
    await assert.rejects(f.live.runner(f.session.id,'run','POST',{}),error=>[404,409,410].includes(error.statusCode));
    assert.equal(f.calls.length,0);
  }
});

test('live close retains retryable ordering through native cleanup, owned hostname and subscription removal',async()=>{
  const f=fixture();await f.live.close(f.session,f.source);
  assert.deepEqual(f.calls.map(row=>row[0]),['native-close','host-close','subscription-close']);
  assert.equal(f.session.live_state,'closed');assert.equal(f.session.sandbox_id,'');
});

test('delayed runtime state cannot revive a session closed during its authority read',async()=>{
  const f=fixture();
  f.store.get=async id=>id===f.session.id?{...f.session}:null;
  f.store.getSource=async()=>{f.session.status='closed';return f.source;};
  f.store.updateSession=async(_id,patch,guard)=>{assert.equal(guard.expectedStatus,'open');if(f.session.status!==guard.expectedStatus)throw Object.assign(new Error('State changed'),{statusCode:409});Object.assign(f.session,patch);};
  await assert.rejects(f.live.state({sessionId:f.session.id,state:'running'}),{statusCode:409});
  assert.equal(f.session.status,'closed');assert.notEqual(f.session.live_state,'running');
});

test('native callbacks bind source/session and expiry; active sessions cannot be closed through expiry callback',async()=>{
  const f=fixture(),closures=[];
  const callback=createLiveCallbacks({...f,sourceId:f.source.id,sessions:{close:async(...args)=>closures.push(args)},designer:{complete:async body=>body,pushed:async()=>({ignored:true})}});
  await assert.rejects(callback('expired',{sessionId:f.session.id}),{statusCode:409});assert.equal(closures.length,0);
  await assert.rejects(callback('live-credentials',{sessionId:randomUUID()}),{statusCode:404});
  f.session.expires_at='2020-01-01T00:00:00Z';await callback('expired',{sessionId:f.session.id});
  assert.equal(closures[0][0].system,true);assert.equal(closures[0][0].principalId,f.session.owner_principal_id);assert.deepEqual(closures[0].slice(1),[f.session.id,true]);
});

test('designer completion binds original Request note and never turns model output into publication',async()=>{
  const f=fixture(),requestId=randomUUID(),principalId=randomUUID(),submissionId=randomUUID(),submitted=[];
  let binding={sourceId:f.source.id,requestId,sessionId:f.session.id,principalId:f.session.owner_principal_id,agentPrincipalId:principalId,note:'Original human prompt'};
  const designer=createDesigner({designerPrincipalId:principalId,authorization:{authenticatePrincipal:async id=>({id,type:id===principalId?'agent':'user'}),authorizeSource:async()=>{}},store:f.store,live:f.live,getRequestBinding:async()=>binding,sessions:{status:async()=>({session:{sourceId:f.source.id},canInvite:true}),submit:async(...args)=>{submitted.push(args);return submitted.length===1?{stale:true,conflicts:[],rebasedChanges:{baseRevision:'b'.repeat(40),changedFiles:[],deletedPaths:[]}}:{submission:{id:submissionId}};}}});
  const result=await designer.complete({sessionId:f.session.id,requestId,changeSet:{baseRevision:'a'.repeat(40),changedFiles:[],deletedPaths:[],note:'Model-supplied replacement'}});
  assert.deepEqual(result,{submissionId});assert.equal(submitted.length,2);
  for(const [actor,,change] of submitted){assert.equal(actor.principalId,principalId);assert.equal(actor.requestId,requestId);assert.equal(actor.sourceId,f.source.id);assert.equal(change.note,'Original human prompt');assert.equal(actor.operator,false);}
  binding={...binding,sessionId:randomUUID()};await assert.rejects(designer.complete({sessionId:f.session.id,requestId,changeSet:{}}),{statusCode:403});
  binding={...binding,sessionId:f.session.id,sourceId:randomUUID()};await assert.rejects(designer.complete({sessionId:f.session.id,requestId,changeSet:{}}),{statusCode:403});
  assert.equal(submitted.length,2);
});

test('completion uses the persisted agent after configuration rotation and rejects revoked original authority',async()=>{
  const f=fixture(),requestId=randomUUID(),originalAgent=randomUUID(),newAgent=randomUUID(),checked=[],submitted=[];
  let allowed=true;
  const binding={sourceId:f.source.id,requestId,sessionId:f.session.id,principalId:f.session.owner_principal_id,agentPrincipalId:originalAgent,note:'Human prompt'};
  const designer=createDesigner({designerPrincipalId:newAgent,authorization:{authenticatePrincipal:async id=>{checked.push(id);return{id,type:id===originalAgent?'agent':'user'};},authorizeSource:async()=>{if(!allowed)throw Object.assign(new Error('Rights revoked'),{statusCode:403});}},store:f.store,live:f.live,getRequestBinding:async()=>binding,sessions:{status:async()=>({session:{sourceId:f.source.id},canInvite:true}),submit:async actor=>{submitted.push(actor);return{submission:{id:randomUUID()}};}}});
  await designer.complete({sessionId:f.session.id,requestId,changeSet:{}});
  assert.deepEqual(checked,[f.session.owner_principal_id,originalAgent]);assert.equal(submitted[0].principalId,originalAgent);
  allowed=false;await assert.rejects(designer.complete({sessionId:f.session.id,requestId,changeSet:{}}),{statusCode:403});assert.equal(submitted.length,1);
});

test('Request setup mutates sessions under the coordinator queue but native start permits a reentrant callback',async()=>{
  const f=fixture(),requestId=randomUUID(),agent=randomUUID();let held=false,starts=0,callbacks=0;
  const runMutation=async task=>{assert.equal(held,false,'a native callback must not wait behind its own caller');held=true;try{return await task();}finally{held=false;}};
  const sessions={join:async()=>assert.equal(held,true),status:async()=>{assert.equal(held,true);return{session:{id:f.session.id,sourceId:f.source.id,status:'open'}};}};
  const live={configured:true,credentials:async()=>({remote:'https://example.test/repo',repoToken:'transient'}),runner:async(_id,action)=>{assert.equal(held,false);if(!action)return{state:'ready',runner:null};starts++;await runMutation(()=>callbacks++);return{runner:{requestId,state:'running'}};}};
  const designer=createDesigner({designerPrincipalId:agent,authorization:{authenticatePrincipal:async()=>({principalId:agent,type:'agent'})},sessions,store:f.store,live,runMutation});
  const result=await designer.start(f.source,{id:requestId,source_id:f.source.id,runner_principal_id:agent},'Blue',{sessionId:f.session.id,caller:{principalId:f.session.owner_principal_id}});
  assert.equal(result.runner.state,'running');assert.equal(starts,1);assert.equal(callbacks,1);
});

test('live Preview path keeps configured entry routing while rejecting escaping or encoded paths',()=>{
  assert.equal(designSystemPreviewPath({artifact:{entry:'gallery/index.html'}}),'/gallery/');
  assert.equal(designSystemPreviewPath({viewer:{entry:'viewer.html'}}),'/viewer.html');
  for(const entry of ['../index.html','/index.html','x//index.html','%2e%2e/index.html','https://example/index.html'])assert.throws(()=>designSystemPreviewPath({artifact:{entry}}),{statusCode:400});
});
