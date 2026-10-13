import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parsePreviewBuildEvent,createPreviewBuildHandler} from '../../src/preview/events.mjs';
import {createPreviews,designSystemPreviewWorker} from '../../src/preview/index.mjs';

const source={id:'11111111-2222-4333-8444-555555555555',lifecycle_status:'ready',artifacts_namespace:'test',artifacts_repository:'source',artifacts_repository_id:'repo-id'};
const branch='review-abc123',head='a'.repeat(40),workerName=designSystemPreviewWorker(source);
const event=()=>({type:'cf.workersBuilds.worker.build.succeeded',source:{type:'workersBuilds.worker',workerName},payload:{buildUuid:randomUUID(),status:'stopped',buildOutcome:'success',buildTriggerMetadata:{branch,commitHash:head}}});

test('only exact observed build-success events correlate with a frozen source, branch and commit',async()=>{
  const submission={id:randomUUID(),source_id:source.id,review_branch:branch,head_commit:head,status:'submitted'},records=[];
  let probes=0;
  const handler=createPreviewBuildHandler({sourceId:source.id,getSource:async()=>source,submissions:async()=>[submission],recordPreviewBuild:async row=>{records.push(row);return{applied:true};},previews:{readyPreview:async()=>{probes++;return{url:`https://${branch}-${workerName}.test.workers.dev/`,workerTag:'owned-tag'};}}});
  for(const mutate of [value=>value.type='cf.workersBuilds.worker.build.failed',value=>value.payload.status='success',value=>value.payload.buildOutcome='failure',value=>value.payload.buildUuid='not-a-uuid',value=>value.payload.buildTriggerMetadata.branch='main',value=>value.payload.buildTriggerMetadata.commitHash='b'.repeat(40),value=>value.source.workerName=`timds-${'1'.repeat(32)}`]){
    const value=event();mutate(value);assert.deepEqual(await handler(value),{ignored:true});
  }
  assert.equal(probes,0);assert.equal(records.length,0);
  const value=event();assert.equal(parsePreviewBuildEvent(JSON.stringify(value)).sourceId,source.id);assert.deepEqual(await handler(value),{applied:true});
  assert.deepEqual(records[0],{sourceId:source.id,submissionId:submission.id,branch,headCommit:head,buildId:value.payload.buildUuid,url:`https://${branch}-${workerName}.test.workers.dev/`,workerTag:'owned-tag'});
  assert(!Object.hasOwn(records[0],'published'));assert(!Object.hasOwn(records[0],'pointer'));
});

test('a closed submission is ignored and a close during Preview reads is resolved by the durable checkpoint',async()=>{
  const submission={id:randomUUID(),source_id:source.id,review_branch:branch,head_commit:head,status:'closed'};
  let reads=0,records=0;
  const handler=createPreviewBuildHandler({sourceId:source.id,getSource:async()=>source,submissions:async()=>[submission],previews:{readyPreview:async()=>{reads++;submission.status='closed';return{url:'https://preview.test/',workerTag:'tag'};}},recordPreviewBuild:async()=>{records++;assert.equal(submission.status,'closed');return{applied:false,reason:'stale_or_closed'};}});
  assert.deepEqual(await handler(event()),{ignored:true});assert.equal(reads,0);
  submission.status='submitted';assert.deepEqual(await handler(event()),{applied:false,reason:'stale_or_closed'});assert.equal(records,1);
});

test('Preview readiness uses actual owned-worker metadata and an anonymous nonredirecting HTML response',async()=>{
  const calls=[];let html=true;
  const gitRepository={provider_type:'cloudflare_artifacts',provider_account_id:'test',provider_account_name:'test',repo_name:'source',repo_id:'repo-id'};
  const adapter=createPreviews({env:{CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'test-worker-token',TIMDS_BUILDS_API_TOKEN:'test-build-token'},fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.startsWith('https://review-')){assert.equal(options.headers,undefined);assert.equal(options.redirect,'manual');return new Response('Preview',{status:html?200:503,headers:{'Content-Type':'text/html'}});}
    const path=new URL(url).pathname;let result;
    if(path.endsWith('/workers/scripts'))result=[{id:workerName,tag:'owned-tag',tags:[`timds-source:${source.id}`]}];
    else if(path.endsWith('/builds/workers/owned-tag'))result={git_repository:gitRepository};
    else if(path.endsWith('/builds/workers/owned-tag/previews'))result=[{preview_id:'2ba8d3da342f4c7c97b831b74ce44668',branch,auto_delete:true,auto_build:true}];
    else if(path.endsWith('/workers/subdomain'))result={subdomain:'test'};
    else assert.fail(`Unexpected metadata route ${path}`);
    return Response.json({success:true,result});
  }});
  assert.deepEqual(await adapter.readyPreview(source,branch),{url:`https://${branch}-${workerName}.test.workers.dev/`,workerTag:'owned-tag',previewId:'2ba8d3da342f4c7c97b831b74ce44668'});
  html=false;await assert.rejects(adapter.readyPreview(source,branch),{statusCode:503});
  assert(calls.some(call=>call.url.includes('/previews?page=1&per_page=100')));
});
