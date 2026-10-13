import { sessionIdPattern, agentPushEvent } from '../../runtime/policy.mjs';
import { requestDiagnostic } from './diagnostics.mjs';
const fail = (statusCode,message) => Object.assign(new Error(message),{statusCode});
const busy = 'This session is busy; retry when its current operation finishes';
const conflicted = 'This Request overlaps a newer edit. Start a follow-up Request to resolve it.';
// The runtime's single-task guard. Request execution re-queues on it, never fails.
export const runnerBusy = 'Another Request is running in this session';
export const isRunnerBusy = error => error?.message === runnerBusy;
// Advisory scope of a designer Request: the paths its session last submitted,
// otherwise the token and source trees a designer change normally touches.
export const DESIGNER_CLAIM_DEFAULT = ['tokens.json','tokens/**','src/**'];
const safeClaimPath = value => typeof value === 'string' && value.trim() && value.length <= 500 && !value.startsWith('/') && !value.includes('..') && !/[\\\x00-\x1f]/.test(value);
async function designerClaimPatterns(store,sessionId) {
  const latest=(await store.submissions(sessionId)).filter(row=>typeof row.diff_json==='string').sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
  const paths=[...new Set([...(latest?.diff_json || '').matchAll(/^diff --git a\/(\S+) b\//gm)].map(match=>match[1]))];
  return paths.length && paths.length<=100 && paths.every(safeClaimPath)?paths.sort():DESIGNER_CLAIM_DEFAULT;
}

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
      let stage='configuration',waking=null;
      try {
        if(!configured)throw fail(503,'The designer runner is not configured');
        stage='identity';
        if(!sessionIdPattern.test(request?.id || '') || request.source_id!==source.id || !source.system_id)throw fail(409,'Designer Request must belong to the Design System');
        stage='input';
        if(typeof prompt!=='string' || !prompt.trim() || Buffer.byteLength(prompt)>32*1024)throw fail(400,'Designer Request must be 1–32 KiB');
        stage='principal';
        const actor=await actorFor(source.id,request.id,request.runner_principal_id);
        stage='preview';
        await ensurePreview(source);
        stage='session';
        let started;
        if(sessionId){
          if(!caller)throw fail(403,'A session owner must authorize the Request');
          // The requester's own Request binding attributes the designer's membership to it.
          await runMutation(()=>sessions.join({...caller,requestId:request.id},sessionId,{principalId:actor.principalId}));
          started=await runMutation(()=>sessions.status(actor,sessionId));
          if(started.session.status!=='open' || started.session.expiresAt && Date.parse(started.session.expiresAt)<=Date.now())throw fail(410,'The target session is closed or expired');
        }else started=await runMutation(()=>sessions.start(actor,{systemId:source.system_id,idempotencyKey:`designer:${request.id}`}));
        stage='session-identity';
        const session=await store.get(started.session.id);
        if(session.source_id!==source.id || (!sessionId && (session.owner_principal_id!==actor.principalId || session.originating_request_id!==request.id)))throw fail(409,'Designer session Request identity mismatch');
        // One runner per session: a busy session is reported before this Request claims it.
        stage='runtime-status';
        const current=await live.runner(session.id);
        if(current.runner?.requestId!==request.id && ['starting','running','submitting'].includes(current.runner?.state))throw fail(409,runnerBusy);
        // A Request to a stopped container is visibly waking from here; the runtime's
        // starting/ready reports follow. A start that never reaches it reverts to sleeping.
        if(current.state==='sleeping' && current.runner?.requestId!==request.id && live.waking){await live.waking(session.id);waking=session.id;}
        // The designer declares its intent once per Request; a retry with the same claim writes nothing.
        stage='claim';
        const claimNote=prompt.trim().slice(0,200).trim(),claimPatterns=await designerClaimPatterns(store,session.id);
        const priorClaim=(await store.claims(session.id)).find(row=>row.principal_id===actor.principalId && (row.kind || 'advisory')==='advisory');
        if(!priorClaim || priorClaim.note!==claimNote || JSON.stringify(priorClaim.patterns)!==JSON.stringify(claimPatterns))await runMutation(()=>sessions.claim(actor,session.id,{patterns:claimPatterns,note:claimNote}));
        stage='claims';
        const activeWork=sessions.activeWork?await sessions.activeWork(actor,source.id):null;
        const claims=activeWork?.claims || activeWork?.sessions?.flatMap(item=>item.claims || []) || [];
        const taskPrompt=claims.length?`${prompt}\n\nActive advisory work claims (coordinate with these intentions; overlap does not forbid your task):\n${Buffer.from(JSON.stringify(claims.map(claim=>({sessionId:claim.sessionId || claim.session_id,principalId:claim.principalId || claim.principal_id,patterns:claim.patterns,note:claim.note})))).subarray(0,12000).toString('utf8')}`:prompt;
        // Execution start is recorded once, after the runner accepts this Request.
        const recordStart=runner=>runMutation(()=>store.appendEventOnce({event_type:'request_started',session_id:session.id,actor_principal_id:actor.principalId,originating_request_id:request.id,note:prompt.slice(0,2000),details_json:{requestId:request.id,...(runner?.state?{runnerState:runner.state}:{})}}));
        stage='runtime-status';
        const state=await live.runner(session.id);
        if(state.runner?.requestId===request.id){await recordStart(state.runner);return {requestId:request.id,session:started.session,runner:state.runner};}
        stage='credentials';
        const credential=await live.credentials({sessionId:session.id});
        stage='runtime-start';
        const run=await live.runner(session.id,'run','POST',{...credential,prompt:taskPrompt,note:prompt.slice(0,2000),requestId:request.id});
        await recordStart(run.runner || run);
        return {requestId:request.id,session:started.session,runner:run.runner || run};
      } catch(error) {
        if(waking && stage!=='runtime-start' && live.slept)await live.slept(waking);
        throw requestDiagnostic(error,stage,'designer-start');
      }
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
      // Runs inside the coordinator queue: append directly, never through runMutation.
      const failed=(error,details={})=>store.appendEventOnce({event_type:'request_failed',session_id:sessionId,actor_principal_id:actor.principalId,originating_request_id:requestId,note:changeSet.note || '',details_json:{requestId,state:'conflicted',error,...details}});
      let result;
      try {
        result=await sessions.submit(actor,sessionId,changeSet);
        for(let retry=0;retry<3 && result.stale && !result.conflicts?.length && result.rebasedChanges;retry++)result=await sessions.submit(actor,sessionId,{...result.rebasedChanges,note:changeSet.note});
      } catch(error) {
        // The runner treats every other 409 as a final conflict; busy is retried.
        if(error?.statusCode===409 && error.message!==busy)try{failed(error.message);}catch{}
        throw error;
      }
      if(!result.submission){failed(conflicted,{conflicts:(result.conflicts || []).length});return {state:'conflicted',conflicts:result.conflicts || [],mainRevision:result.mainRevision};}
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
