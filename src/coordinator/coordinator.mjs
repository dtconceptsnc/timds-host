import { randomUUID } from 'node:crypto';
import { createDesignSystemSessions } from '../domain/sessions.mjs';
import { createSqliteCollaborationStore } from '../store/sqlite.mjs';
import { fail, principalId } from '../store/errors.mjs';
import { readSourceView } from '../source-view.mjs';
import { requestDiagnostic } from '../requests/diagnostics.mjs';

const domainOperations = new Set(['activeWork','sourceEvents','join','claim','createDraft','listDrafts','draftSnapshot','closeDraft','start','snapshot','submit','update','status','history','close']);
// These domain methods read committed rows and current D1 authority only.
// Git snapshots/history can acquire repository capabilities and stay serialized.
// sourceEvents is the event feed: committed SQLite rows after the activeWork read check.
const metadataOperations = new Set(['activeWork','sourceEvents','listDrafts','status']);
const publicationOperations = new Set(['getSource','get','getSubmission','submissions','submissionsForSource','publicationsForSource','publication','publicationBySubmission','reservePublication','attachPublicationJob','publicationReadiness','claimPublicationJob','renewPublicationLease','yieldPublicationLease','authorizePublication','checkpointPublication','recordPublicationStage','releasePublicationVersion','getExecutionJob','getLifecycleOperation','resolveRollbackVersion','publishedRelease','publicationEventsForSources']);
const sameProvisionInput = (left, right) => left == null && right == null ||
  left != null && right != null && left.fileTreeDigest === right.fileTreeDigest && left.grantPublisher === right.grantPublisher;

/** Binding-only coordinator engine. The owning Durable Object supplies actual
 * ctx.storage and adapters; an explicit serial queue spans asynchronous D1 and
 * repository calls. Durable Object event delivery alone is not a mutex.
 */
export function createCoordinator({ sourceId, storage, catalog, repository, authorization, publication, requests,
  clock = () => Date.now(), ids = randomUUID, onSessionReserved, onSessionStarted, cleanupAgentSession, nextLifecycleAlarm=()=>null }) {
  const store = createSqliteCollaborationStore({sourceId,storage,catalog,clock,ids});
  let tail = Promise.resolve();
  const serialized = task => {
    const result = tail.then(async () => {
      // Pre-arm before committing local writes: an isolate crash after a SQL
      // commit cannot strand an outbox that never got its first alarm.
      await storage.setAlarm(clock()+5_000);
      try {
        await store.reconcileAuthority();
        const source = await catalog.source(sourceId);
        if (source) await store.initialize(source);
        return await task();
      } catch(error) { throw requestDiagnostic(error,'mutation-prepare','host-boundary'); }
      finally {
        try { const times=[requestService?.requestStore?.nextAlarm?.(),nextLifecycleAlarm()].filter(value=>value!=null);await store.scheduleAlarm({extraAt:times.length?Math.min(...times):null}); }
        catch(error) { throw requestDiagnostic(error,'mutation-cleanup','host-boundary'); }
      }
    });
    tail = result.catch(() => {});
    return result;
  };
  const repositoryContext = () => ({
    getSource: store.getSource, get: store.get, getSubmission: store.getSubmission,
    submissions: store.submissions, getLifecycleOperation: store.getLifecycleOperation,
    getExecutionJob: store.getExecutionJob, findFork: store.findFork, updateSession: store.updateSession,
    sessionRepository:store.sessionRepository,recordSessionRepository:store.recordSessionRepository,
    sessionForRequest: store.sessionForRequest, requestReceipt: store.requestReceipt,
    appendEvent: store.appendEvent, eventForHead: store.eventForHead,
  });
  // A factory may capture this direct facade. It must not call a coordinator RPC
  // back into its own held serial queue while a repository operation is running.
  const repo = typeof repository === 'function' ? repository(repositoryContext()) : repository;
  const auth = typeof authorization === 'function' ? authorization({store,catalog,sourceId}) : authorization;
  const sessions = createDesignSystemSessions({store,repository:repo,authorization:auth,now:clock,onSessionReserved,onSessionStarted,cleanupAgentSession});
  const publisher = typeof publication === 'function' ? publication({store,sourceId,catalog}) : publication;
  const requestService = typeof requests === 'function' ? requests({storage,sourceId,store,sessions,catalog,authorization:auth,clock,runMutation:serialized}) : requests;
  const activeActor = async actor => {
    const principal = await catalog.principal(principalId(actor));
    if (principal?.status !== 'active') throw fail(403, 'An active TimDS identity is required');
    return {...actor,principalId:principal.id,type:principal.type,operator:principal.admin,system:false};
  };
  const engine = {
    invoke: ({operation,actor,args = []}) => {
      if(store.deletionFence())throw fail(409,'This Design System is deleting or deleted');
      if (!domainOperations.has(operation)) throw fail(404, 'Unknown coordinator operation');
      if (metadataOperations.has(operation)) return activeActor(actor).then(verified => sessions[operation](verified,...args));
      return serialized(async () => {
        if(store.deletionFence())throw fail(409,'This Design System is deleting or deleted');
        const result = await sessions[operation](await activeActor(actor),...args);
        // A success response has durable locators/audit; lost projection is safe
        // to retry because the SQL event and outbox committed together.
        await store.flushOutbox();
        return result;
      });
    },
    previewTokens: (...args) => serialized(() => sessions.previewTokens(...args)),
    currentSource: () => store.getSource(sourceId),
    provisionReceipt: async (actor,operationId) => {
      const verified=await activeActor(actor);
      if(!verified.operator)throw fail(403,'An active administrator is required');
      const reservation=await catalog.provisionReceipt(operationId);
      if(!reservation||reservation.sourceId!==sourceId||reservation.actorId!==verified.principalId)throw fail(404,'Provision operation not found');
      const operation=store.getLifecycleOperation(operationId),source=await store.getSource(sourceId);
      if(!operation||operation.source_id!==sourceId||operation.actor_principal_id!==reservation.actorId||!source)throw fail(409,'Provision operation has not been initialized');
      const input=reservation.provisionInput;
      if(!input||!sameProvisionInput(input,operation.checkpoints_json?.provisionInput))throw fail(409,'Provision input receipt is unavailable');
      const repository=operation.repository_receipt||operation.checkpoints_json?.repositoryReceipt;
      if(operation.status==='completed'&&(!repository||repository.id!==source.artifacts_repository_id||repository.namespace!==source.artifacts_namespace||repository.repository!==source.artifacts_repository))throw fail(409,'Completed provision identity does not match the source');
      return {apiVersion:1,provision:{operationId,sourceId,actorPrincipalId:reservation.actorId,status:operation.status,fileTreeDigest:input.fileTreeDigest,grantPublisher:input.grantPublisher},source:{id:source.id,systemId:source.system_id,organizationId:source.organization_id,name:source.name||source.system_id,namespace:source.artifacts_namespace,repository:source.artifacts_repository,repositoryId:source.artifacts_repository_id||null,lifecycleStatus:source.lifecycle_status,archivedAt:source.archived_at||null,sourceCommit:source.source_commit||null,manifest:source.manifest_json}};
    },
    sourceView: async actor => {
      const verified=await activeActor(actor),source=await store.getSource(sourceId);
      const facts=verified.operator?await catalog.readAuthority(sourceId,verified.principalId):await auth.authorizeSource(source,{...verified,accessMode:'read'});
      if(facts.principal?.status!=='active'||verified.operator&&!facts.principal.admin)throw fail(403,'An active TimDS identity is required');
      if(!facts.source||facts.organizationStatus!=='active'||!(verified.operator?['ready','deleting','deleted']:['ready']).includes(facts.source.lifecycle_status))throw fail(409,'Design System is unavailable');
      return readSourceView({storage,source,canAdmin:facts.principal.admin,canRollback:facts.publisher&&!facts.source.archived_at});
    },
    resource: async (kind,id) => {
      if (kind === 'session') return store.get(id);
      if (kind === 'submission') return store.getSubmission(id);
      if (kind === 'publication') return store.publication(id);
      if (kind === 'version') return store.getVersion(id);
      throw fail(404, 'Unknown coordinator resource');
    },
    hasSessionAccess: async principal => store.hasSessionAccess(principal,sourceId),
    requestBinding: async requestId => {
      if (requestService?.binding) return requestService.binding(requestId);
      const session = store.sessionForRequest(sourceId,requestId);
      return session && {sourceId,requestId,sessionId:session.id,principalId:session.owner_principal_id,status:session.status};
    },
    requestStore: (operation,args = []) => serialized(async () => {
      if(store.deletionFence()){if(operation==='due')return [];if(['reserve','claim','retry'].includes(operation))throw fail(409,'Designer Requests are disabled by deletion');}
      if (!requestService || !['reserve','get','getJob','jobForRequest','claim','finish','fail','retry','due','validateLease','nextAlarm'].includes(operation)) throw fail(404, 'Unknown Request store operation');
      const result = await (requestService.requestStore || requestService)[operation](...args);
      await store.flushOutbox(); return result;
    }),
    requestsInvoke: ({operation,actor,args = []}) => {
      if (!requestService || !['create','read'].includes(operation)) throw fail(404, 'Unknown Request operation');
      if (operation === 'read') return activeActor(actor).then(verified => requestService.read(verified,...args));
      return serialized(async () => {
        if(store.deletionFence())throw fail(409,'Designer Requests are disabled by deletion');
        const result = await requestService.create(await activeActor(actor),...args);
        await store.flushOutbox(); return result;
      });
    },
    executeRequest: (requestId,lease) => {
      if (!requestService) throw fail(503, 'Designer Requests are not configured');
      // Native model execution stays outside the coordinator queue. The service
      // uses its injected runMutation for session reservations and completion.
      return requestService.execute(requestId,lease);
    },
    runtimeCallback: (operation,body) => {
      if(store.deletionFence()&&!(operation==='live-state'&&body?.state==='closed'))throw fail(410,'This Design System is deleting or deleted');
      if (!requestService?.callback) throw fail(503, 'Live callbacks are not configured');
      if (['live-credentials','live-state'].includes(operation)) return requestService.callback(operation,body);
      if (!['complete','expired','pushed'].includes(operation)) throw fail(404, 'Unknown live callback');
      return serialized(async () => {const result = await requestService.callback(operation,body); await store.flushOutbox(); return result;});
    },
    publicationStore: (operation,args = []) => {
      if (!publicationOperations.has(operation)) throw fail(404, 'Unknown publication store operation');
      // Queue polling reads committed SQLite rows without entering the mutation
      // queue, reconciling authority, or scheduling/flushing outbox work.
      if (operation === 'publicationReadiness') return store[operation](...args);
      return serialized(async () => {
        const result = await store[operation](...args);
        await store.flushOutbox(); return result;
      });
    },
    stageVersion: input => serialized(async () => { const result = store.stageVersion(input); await store.flushOutbox(); return result; }),
    recordPreviewBuild: input => serialized(() => store.recordPreviewBuild(input)),
    closeForPublication: (sessionId,publicationId) => serialized(async () => { const result = await sessions.closeForPublication(sessionId,publicationId); await store.flushOutbox(); return result; }),
    mutateAuthority: command => serialized(() => store.mutateAuthority(command)),
    setArchived: ({actor,operationId,restore=false}) => serialized(async () => {
      const verified=await activeActor(actor),source=await store.getSource(sourceId);
      if(!verified.operator)throw fail(403,'An active administrator is required');
      if(!source||source.lifecycle_status!=='ready')throw fail(409,'Only an initialized Design System can be archived or restored');
      const prior=await catalog.authorityOperation(operationId);
      if(prior&&(prior.source_id!==sourceId||prior.actor_id!==verified.principalId||!Object.hasOwn(prior.command,'archivedAt')||(prior.command.archivedAt===null)!==restore))throw fail(409,'Lifecycle operation belongs to a different action');
      const now=new Date(clock()).toISOString();
      const command=prior?.command||{archivedAt:restore?null:now,sourcePatch:{archived_by_principal_id:restore?null:verified.principalId,updated_at:now}};
      const receipt=await store.mutateAuthority({operationId,actor:verified,command});
      const current=await store.getSource(sourceId);
      return {apiVersion:1,action:restore?'restore':'archive',operationId:receipt.id,source:{id:sourceId,systemId:current.system_id,archivedAt:current.archived_at||null,lifecycleStatus:current.lifecycle_status}};
    }),
    fencePrincipal: input => serialized(() => store.fencePrincipal(input)),
    rollbackVersion: ({actor,input,operationId}) => serialized(async () => {
      const verified = await activeActor(actor);
      if (!input || Array.isArray(input) || typeof input !== 'object' || input.apiVersion !== undefined && input.apiVersion !== 1) throw fail(400, 'A compatible rollback version is required');
      if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 2000)) throw fail(400, 'Rollback reason must be at most 2,000 characters');
      if (input.operationId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.operationId)) throw fail(400, 'A stable rollback operation UUID is required');
      if (input.expectedCurrentVersionId !== undefined && input.expectedCurrentVersionId !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.expectedCurrentVersionId)) throw fail(400, 'The expected current version must be a UUID or null');
      const source = await store.getSource(sourceId);
      if (!source?.artifacts_namespace || source.lifecycle_status !== 'ready' || source.archived_at) throw fail(404, 'Active hosted Design System not found');
      await auth.authorizePublish(source,verified);
      const versionId = input.versionId || (typeof input.version === 'string' && input.version.length <= 100 ? store.resolveRollbackVersion(sourceId,input.version) : null);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(versionId || '')) throw fail(400, 'Select a previously published version');
      const result = await store.rollbackVersion({versionId,actor:verified,operationId:input.operationId??operationId,reason:input.reason || '',dryRun:input.dryRun === true,expectedCurrentVersionId:input.expectedCurrentVersionId,verifyArtifact:publisher?.verifyArtifact?version=>publisher.verifyArtifact(version):undefined});
      await store.flushOutbox(); return result;
    }),
    initializeSource: ({operationId,source,reservation}) => serialized(async () => {
      const receipt = await catalog.provisionReceipt(operationId);
      if (!receipt || receipt.sourceId !== sourceId || source.id !== sourceId || reservation?.operationId !== operationId || reservation?.sourceId !== sourceId) throw fail(409, 'Provision reservation does not match the coordinator');
      const provisionInput = receipt.provisionInput ?? null;
      if (!sameProvisionInput(provisionInput,reservation.provisionInput)) throw fail(409, 'Provision input does not match its reservation');
      const existing = store.getLifecycleOperation(operationId);
      if (existing) {
        const checkpoints = existing.checkpoints_json || {};
        if (sameProvisionInput(checkpoints.provisionInput,provisionInput)) return existing;
        // An older isolate may have reserved the local operation immediately
        // before the input checkpoint. Only that untouched operation can adopt
        // the already-frozen D1 receipt; never replace input after external work.
        if (existing.status !== 'running' || Object.keys(checkpoints).length) throw fail(409, 'Provision lifecycle belongs to different source inputs');
        return store.saveLifecycle({...existing,checkpoints_json:{provisionInput}});
      }
      return store.saveLifecycle({id:operationId,source_id:sourceId,actor_principal_id:receipt.actorId,status:'running',lease:ids(),checkpoints_json:{provisionInput},created_at:new Date(clock()).toISOString()});
    }),
    checkpointProvision: ({operationId,lease,patch}) => serialized(() => {
      const row = store.getLifecycleOperation(operationId);
      if (!row || row.lease !== lease || row.status !== 'running') throw fail(409, 'Provision lease is unavailable');
      if (Object.hasOwn(patch,'provisionInput') && !sameProvisionInput(row.checkpoints_json?.provisionInput,patch.provisionInput)) throw fail(409, 'Provision input is immutable');
      return store.saveLifecycle({...row,checkpoints_json:{...row.checkpoints_json,...patch}});
    }),
    completeProvision: ({operationId,lease,repositoryReceipt,sourceCommit,manifest}) => serialized(async () => {
      const operation = store.getLifecycleOperation(operationId), source = await catalog.source(sourceId);
      if (!operation || operation.lease !== lease) throw fail(409, 'Provision lease is unavailable');
      if (operation.status === 'completed') return store.getSource(sourceId);
      if (!repositoryReceipt?.id || repositoryReceipt.namespace !== source.artifacts_namespace || repositoryReceipt.repository !== source.artifacts_repository || !/^[a-f0-9]{40}$/.test(sourceCommit || '') || manifest?.systemId !== source.system_id) throw fail(409, 'Provision repository receipt does not match the source');
      await store.mutateAuthority({operationId:`${operationId}:complete`,actor:{principalId:operation.actor_principal_id},command:{lifecycleStatus:'ready',repositoryId:repositoryReceipt.id,sourcePatch:{source_commit:sourceCommit,manifest_json:manifest}}});
      store.saveLifecycle({...operation,status:'completed',repository_receipt:repositoryReceipt});
      return store.getSource(sourceId);
    }),
    // Called by DO alarm(), without a caller-supplied actor. Idempotent projection
    // and lease-fenced cleanup can resume after eviction and process restart.
    alarm: () => serialized(async () => {
      const projection = await store.flushOutbox(100,{requireDrained:false});
      if(store.deletionFence())return {projection,expired:[],publications:0,deleting:true};
      const expired = await sessions.cleanupExpired({limit:5});
      const queued = store.pendingPublications();
      if (publisher?.recover) for (const row of queued.sort((a,b) => a.queue_position-b.queue_position)) await publisher.recover(row);
      await store.flushOutbox(100,{requireDrained:false});
      return {projection,expired,publications:queued.length};
    }),
    repositoryContext,
    // Local capability for injected services, never exposed as an RPC method.
    runMutation: serialized,
    // Trusted local metadata capability: callers still execute the domain's
    // source/member/grant checks. It never reconciles authority, arms an alarm,
    // projects an outbox or waits behind an external repository operation.
    runRead: async (actor,read) => read(await activeActor(actor)),
  };
  return engine;
}
