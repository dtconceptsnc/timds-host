// API v1 semantics extracted from toperator 74bceaa plus durable closed-fork
// Request receipt recovery. Identity and Fetch routing belong to the host edge.
import { timdsSessionView } from '../domain/sessions.mjs';

const fail = (statusCode,message) => Object.assign(new Error(message),{statusCode});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const principalId = actor => actor?.principalId || actor?.id;
const sessionActor = actor => ({...actor,principalId:principalId(actor),userId:actor.userId || null,clientId:actor.clientId || null,operator:actor.operator === true});

export function createDesignerRequests({sourceId, store, requestStore, authorization, sessions, designer, schedule, runMutation = task=>task()}) {
  async function source(id) {
    if(id!==sourceId)throw fail(404,'Design System not found');
    const system=await store.getSource(id);
    if(!system?.artifacts_namespace || system.archived_at || system.lifecycle_status!=='ready' || store.eligible && !await store.eligible(system))throw fail(409,'An active hosted Design System is required');
    return system;
  }
  async function target(actor,system,sessionId) {
    if(!sessionId)return;
    if(!uuid.test(sessionId))throw fail(400,'Invalid target session');
    const view=await sessions.status(sessionActor(actor),sessionId);
    if(view.session.sourceId!==system.id)throw fail(404,'Session not found in this Design System');
    if(view.canInvite!==true)throw fail(403,'Only the owner or a publisher can start a Request in this session');
  }
  async function boundSession(system,request) {
    const session=request.session_id ? await store.get(request.session_id) : await store.sessionForRequest(system.id,request.id);
    if(session && (session.source_id!==system.id || (request.session_id ? session.id!==request.session_id : session.originating_request_id!==request.id)))throw fail(409,'Designer session Request identity mismatch');
    return session;
  }
  async function completed(system,request) {
    const session=await boundSession(system,request);
    if(!session)return null;
    const receipt=await store.requestReceipt(session.id,request.id);
    if(!receipt?.submission_id)return null;
    const submission=await store.getSubmission(receipt.submission_id);
    if(!submission || submission.id!==receipt.submission_id || submission.session_id!==session.id || submission.source_id!==system.id || !['submitted','publishing','published','closed'].includes(submission.status))throw fail(409,'Designer Request submission receipt does not match its source and session');
    return {requestId:request.id,session:timdsSessionView(session,system),runner:{state:'submitted',requestId:request.id,submissionId:submission.id}};
  }
  return {
    requestStore,
    async create(actor,id,body) {
      if(body?.apiVersion!==undefined && body.apiVersion!==1)throw fail(400,'Unsupported TimDS API version');
      const system=await source(id);
      await authorization.authorizeSource(system,actor);
      if(!designer.configured)throw fail(503,'The designer runner is not configured');
      if(typeof body?.prompt!=='string' || !body.prompt.trim() || Buffer.byteLength(body.prompt)>32*1024)throw fail(400,'Describe the change in 1–32 KiB');
      if(!uuid.test(body.requestId || ''))throw fail(400,'A requestId is required for safe retries');
      await target(actor,system,body.sessionId);
      const {request,job}=await requestStore.reserve({requestId:body.requestId,sourceId:system.id,requestedBy:principalId(actor),runnerPrincipalId:designer.principalId,prompt:body.prompt.trim(),sessionId:body.sessionId});
      const current=['failed','dead_letter','cancelled'].includes(job.status)?await requestStore.retry(job.id):job;
      // Resource locators must be visible before acknowledging durable work.
      await store.flushOutbox();
      if(current.status!=='succeeded')await schedule({requestId:request.id,jobId:job.id});
      return {apiVersion:1,requestId:request.id,executionJobId:job.id};
    },
    async read(actor,id,requestId) {
      const system=await source(id);
      await authorization.authorizeSource(system,actor);
      const request=await requestStore.get(requestId),job=await requestStore.jobForRequest(requestId);
      if(!request || request.source_id!==system.id || !job || job.payload_json.sourceId!==system.id)throw fail(404,'Designer Request not found');
      const session=await boundSession(system,request);
      const runner=session?.status==='open' ? await designer.status(session.id) : null;
      const boundRunner=runner && (runner.requestId===requestId || (!runner.requestId && session?.originating_request_id===requestId))?runner:null;
      const receipt=!boundRunner?.submissionId && session?await store.requestReceipt(session.id,requestId):null;
      const error=boundRunner?.error || (!boundRunner && !receipt?.submission_id && ['failed','dead_letter','cancelled'].includes(job.status)?job.error_message:null);
      return {apiVersion:1,requestId,status:job.status,error:error || null,session:session?timdsSessionView(session,system):null,sessionId:session?.id || null,submissionId:boundRunner?.submissionId || receipt?.submission_id || null,runner:boundRunner};
    },
    async execute(requestId,lease) {
      const job=await requestStore.validateLease(lease);
      if(job.job_type!=='timds_designer_request' || job.payload_json?.requestId!==requestId)throw fail(409,'Designer Request execution lease is unavailable');
      const request=await requestStore.get(requestId),system=await source(job.payload_json.sourceId);
      if(!request || request.source_id!==system.id || request.requested_by!==job.payload_json.requestedBy || (request.session_id || null)!==(job.payload_json.sessionId || null))throw fail(409,'Designer Request no longer matches its source');
      const caller=await authorization.authenticatePrincipal(request.requested_by);
      await authorization.authorizeSource(system,caller);
      await target(caller,system,request.session_id);
      // Recovery follows current authority checks, before join requires an open
      // fork. A lost forwarding response cannot cause another model execution.
      const result=await completed(system,request) || await designer.start(system,request,request.prompt,{sessionId:request.session_id,caller:sessionActor(caller)});
      await runMutation(()=>requestStore.finish({...lease,result}));
      return result;
    },
    async binding(requestId) {
      const request=await requestStore.get(requestId);
      if(!request || request.source_id!==sourceId)return null;
      return {sourceId,requestId:request.id,sessionId:request.session_id,principalId:request.requested_by,agentPrincipalId:request.runner_principal_id,status:request.status,note:request.prompt.slice(0,2000)};
    },
  };
}
