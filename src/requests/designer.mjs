import { sessionIdPattern, agentPushEvent } from '../../runtime/policy.mjs';
const fail = (statusCode,message) => Object.assign(new Error(message),{statusCode});

/** Native live DO dispatch. The model can submit bounded changes, never publish. */
export function createDesigner({designerPrincipalId, authorization, sessions, store, live, getRequestBinding, reconcilePush, ensurePreview = async()=>{}, runMutation = task=>task()}) {
  const configured=Boolean(sessionIdPattern.test(designerPrincipalId || '') && live?.configured);
  async function actorFor(sourceId,requestId,runnerPrincipalId) {
    if(!sessionIdPattern.test(runnerPrincipalId || ''))throw fail(403,'Request designer identity is unavailable');
    const principal=await authorization.authenticatePrincipal(runnerPrincipalId);
    if(principal?.type!=='agent')throw fail(503,'Configure an active designer agent principal');
    return {principalId:principal.principalId || principal.id,type:'agent',userId:null,tokenId:null,clientId:null,operator:false,requestId,sourceId};
  }
  return {
    configured,principalId:designerPrincipalId,
    async start(source,request,prompt,{sessionId,caller}={}) {
      if(!configured)throw fail(503,'The designer runner is not configured');
      if(!sessionIdPattern.test(request?.id || '') || request.source_id!==source.id || !source.system_id)throw fail(409,'Designer Request must belong to the Design System');
      if(typeof prompt!=='string' || !prompt.trim() || Buffer.byteLength(prompt)>32*1024)throw fail(400,'Designer Request must be 1–32 KiB');
      const actor=await actorFor(source.id,request.id,request.runner_principal_id);
      await ensurePreview(source);
      let started;
      if(sessionId){
        if(!caller)throw fail(403,'A session owner must authorize the Request');
        await runMutation(()=>sessions.join(caller,sessionId,{principalId:actor.principalId}));
        started=await runMutation(()=>sessions.status(actor,sessionId));
        if(started.session.status!=='open' || started.session.expiresAt && Date.parse(started.session.expiresAt)<=Date.now())throw fail(410,'The target session is closed or expired');
      }else started=await runMutation(()=>sessions.start(actor,{systemId:source.system_id,idempotencyKey:`designer:${request.id}`}));
      const session=await store.get(started.session.id);
      if(session.source_id!==source.id || (!sessionId && (session.owner_principal_id!==actor.principalId || session.originating_request_id!==request.id)))throw fail(409,'Designer session Request identity mismatch');
      const activeWork=sessions.activeWork?await sessions.activeWork(actor,source.id):null;
      const claims=activeWork?.claims || activeWork?.sessions?.flatMap(item=>item.claims || []) || [];
      const taskPrompt=claims.length?`${prompt}\n\nActive advisory work claims (coordinate with these intentions; overlap does not forbid your task):\n${Buffer.from(JSON.stringify(claims.map(claim=>({sessionId:claim.sessionId || claim.session_id,principalId:claim.principalId || claim.principal_id,patterns:claim.patterns,note:claim.note})))).subarray(0,12000).toString('utf8')}`:prompt;
      const state=await live.runner(session.id);
      if(state.runner?.requestId===request.id)return {requestId:request.id,session:started.session,runner:state.runner};
      const credential=await live.credentials({sessionId:session.id});
      const run=await live.runner(session.id,'run','POST',{...credential,prompt:taskPrompt,note:prompt.slice(0,2000),requestId:request.id});
      return {requestId:request.id,session:started.session,runner:run.runner || run};
    },
    async status(id){const result=await live.runner(id);return result.runner || {state:result.state};},
    async complete({sessionId,requestId,changeSet}) {
      if(!sessionIdPattern.test(sessionId || '') || !sessionIdPattern.test(requestId || ''))throw fail(404,'Agent Request session not found');
      const session=await store.get(sessionId),binding=await getRequestBinding(requestId);
      if(!binding || binding.sourceId!==session?.source_id || (binding.sessionId?binding.sessionId!==session.id:session.originating_request_id!==requestId))throw fail(403,'Request does not belong to this live session');
      // The configured runner may rotate. Only the agent frozen into this
      // Request can finish it, while its original human authority stays valid.
      const source=await store.getSource(session.source_id);
      const caller=await authorization.authenticatePrincipal(binding.principalId);
      await authorization.authorizeSource(source,caller);
      if(binding.sessionId){const view=await sessions.status({...caller,principalId:caller.id || caller.principalId},sessionId);if(view.session.sourceId!==source.id || view.canInvite!==true)throw fail(403,'Only the owner or a publisher can complete this Request in this session');}
      const actor=await actorFor(session.source_id,requestId,binding.agentPrincipalId);
      changeSet={...changeSet,note:binding.note || changeSet?.note};
      let result=await sessions.submit(actor,sessionId,changeSet);
      for(let retry=0;retry<3 && result.stale && !result.conflicts?.length && result.rebasedChanges;retry++)result=await sessions.submit(actor,sessionId,{...result.rebasedChanges,note:changeSet.note});
      if(!result.submission)return {state:'conflicted',conflicts:result.conflicts || [],mainRevision:result.mainRevision};
      return {submissionId:result.submission.id};
    },
    async pushed(event) {
      if(!agentPushEvent(event))return {ignored:true};
      const session=await store.findFork(event.source.repoName);
      if(!session)return {ignored:true};
      const source=await store.getSource(session.source_id);
      if(source?.artifacts_namespace!==event.source.namespace || session.fork_repository!==event.source.repoName || session.status!=='open')return {ignored:true};
      await live.pushed(session,{revision:event.payload.after});
      if(session.base_revision===event.payload.after)return {ignored:true};
      const binding=session.originating_request_id?await getRequestBinding(session.originating_request_id):null;
      const actor=session.originating_request_id?await actorFor(session.source_id,session.originating_request_id,binding?.agentPrincipalId):{principalId:session.owner_principal_id};
      return reconcilePush(source,session,event.payload.after,actor);
    },
    close:(session,source)=>live.close(session,source),
  };
}
