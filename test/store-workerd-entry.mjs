// Local Miniflare/workerd fixture. Never part of the host entrypoint or deployed.
import { DurableObject } from 'cloudflare:workers';
import { Catalog } from '../src/store/catalog.mjs';
import { createSqliteCollaborationStore } from '../src/store/sqlite.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const lease = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
export class StoreProof extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.catalog = new Catalog(env.CATALOG);
    this.store = createSqliteCollaborationStore({sourceId,storage:ctx.storage,catalog:this.catalog});
  }
  async run(mode) {
    if (mode === 'initialize') {
      const admin = await this.catalog.resolveIdentity({issuer:'local-fixture',subject:'admin',name:'Fixture administrator'});
      await this.catalog.bootstrapAdmin(admin,operationId);
      await this.catalog.ensureOrganization({id:'test-org',name:'Local proof'});
      const source = {id:sourceId,system_id:'local-proof',organization_id:'test-org',artifacts_namespace:'fixture',artifacts_repository:'proof'};
      await this.catalog.reserveSystem({operationId,actor:admin,source});
      await this.store.initialize(await this.catalog.source(sourceId));
      await this.store.mutateAuthority({operationId:'55555555-5555-4555-8555-555555555555',actor:admin,command:{lifecycleStatus:'ready',repositoryId:'fixture-repository',principalId:admin.id,publish:true}});
      const row = await this.store.insert({id:sessionId,source_id:sourceId,owner_principal_id:admin.id,idempotency_key:'workerd-restart',kind:'draft',name:'shared',expires_at:null});
      this.store.claim(row.id,lease);
      this.store.checkpoint(row.id,lease,{status:'open',base_revision:'a'.repeat(40)},null,{event_type:'updated',actor_principal_id:admin.id});
      this.store.release(row.id,lease);
      await this.store.addMember({session_id:row.id,principal_id:admin.id,role:'owner',invited_by:admin.id});
      return {status:this.store.get(row.id).status,source:(await this.store.getSource(sourceId)).system_id,events:(await this.store.events(sourceId)).length};
    }
    if (mode === 'check') {
      const session = this.store.get(sessionId);
      this.store.claim(sessionId,lease);
      const before = this.store.outboxSize(); let rejected = false;
      try { this.store.checkpoint(sessionId,lease,{status:'closing'},{id:'missing',head_commit:'b'.repeat(40)},{event_type:'submitted'}); }
      catch (error) { rejected = error.statusCode === 409; }
      this.store.release(sessionId,lease);
      return {status:session.status,unchanged:this.store.get(sessionId).status === 'open',rolledBack:rejected && before === this.store.outboxSize(),members:(await this.store.members(sessionId)).length,events:(await this.store.events(sourceId)).length};
    }
    if (mode === 'enqueue') {
      // Deliberately stop before D1 projection and preserve the armed alarm.
      await this.ctx.storage.setAlarm(Date.now()+86_400_000);
      this.store.appendEvent({event_type:'updated',details_json:{restartProof:true}});
      return {pending:this.store.outboxSize()};
    }
    if (mode === 'recover') { await this.alarm(); return {pending:this.store.outboxSize(),events:(await this.store.events(sourceId)).length}; }
    throw new Error('Unknown fixture command');
  }
  async alarm() { await this.store.reconcileAuthority(); await this.store.flushOutbox(); }
}
export default { async fetch(request,env) {
  try { return Response.json(await env.PROOF.getByName(sourceId).run(new URL(request.url).pathname.slice(1))); }
  catch (error) { return Response.json({error:error.message,statusCode:error.statusCode},{status:500}); }
} };
