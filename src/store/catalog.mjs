import { randomUUID } from 'node:crypto';
import { decode, fail, json, principalId, storageError } from './errors.mjs';

const materialize = row => row && ({ ...decode(row.source_json), id: row.id, system_id: row.system_id,
  organization_id: row.organization_id, lifecycle_status: row.lifecycle_status, archived_at: row.archived_at,
  artifacts_namespace: row.artifacts_namespace, artifacts_repository: row.artifacts_repository,
  artifacts_repository_id: row.artifacts_repository_id, authority_version: row.authority_version });
const identity = row => row && ({ ...row, admin: Boolean(row.admin) });
export const startFingerprint = row => json([row.source_id, row.kind || 'session', row.name || null,
  row.draft_session_id || null, row.origin_revision || null, row.originating_request_id || null]);

/** D1 catalog. Every read starts at the primary; caller must not pass a cached session.
 * Grant changes are internal coordinator operations, never HTTP route mutations.
 */
export class Catalog {
  constructor(db, { clock = () => Date.now(), ids = randomUUID } = {}) { this.db = db; this.clock = clock; this.ids = ids; }
  primary() { return this.db.withSession ? this.db.withSession('first-primary') : this.db; }
  async first(sql, ...values) { try { return await this.primary().prepare(sql).bind(...values).first(); } catch (error) { storageError(error); } }
  async all(sql, ...values) { try { return (await this.primary().prepare(sql).bind(...values).all()).results; } catch (error) { storageError(error); } }
  async run(sql, ...values) { try { return await this.primary().prepare(sql).bind(...values).run(); } catch (error) { storageError(error); } }
  async batch(statements) { const db = this.primary(); try { return await db.batch(statements.map(([sql, values]) => db.prepare(sql).bind(...values))); } catch (error) { storageError(error); } }
  async principal(id) { return identity(await this.first('SELECT * FROM principals WHERE id=?', id)); }
  async resolveIdentity({ issuer, subject, type = 'user', name = '' }) {
    if (!issuer || !subject || !['user','agent'].includes(type)) throw fail(400, 'A verified identity is required');
    await this.run('INSERT INTO principals(id,type,name,issuer,subject) VALUES(?,?,?,?,?) ON CONFLICT(issuer,subject) DO NOTHING', this.ids(), type, String(name).slice(0, 320), issuer, subject);
    return identity(await this.first('SELECT * FROM principals WHERE issuer=? AND subject=?', issuer, subject));
  }
  async bootstrapAdmin(actor, operationId) {
    const id = principalId(actor);
    if (!id || !operationId) throw fail(403, 'An active verified identity is required');
    await this.batch([
      ['INSERT OR IGNORE INTO installation_bootstrap(singleton,operation_id,principal_id,created_at) SELECT 1,?,?,? WHERE EXISTS(SELECT 1 FROM principals WHERE id=? AND status=\'active\')', [operationId, id, new Date(this.clock()).toISOString(), id]],
      ['UPDATE principals SET admin=1,version=version+CASE WHEN admin=0 THEN 1 ELSE 0 END WHERE id=? AND status=\'active\' AND EXISTS(SELECT 1 FROM installation_bootstrap WHERE singleton=1 AND operation_id=? AND principal_id=?)', [id, operationId, id]],
    ]);
    const receipt = await this.first('SELECT * FROM installation_bootstrap WHERE singleton=1');
    const principal = await this.principal(id);
    if (receipt?.operation_id !== operationId || receipt?.principal_id !== id || principal?.status !== 'active' || !principal.admin) throw fail(403, 'Installation bootstrap was already consumed or identity is inactive');
    return principal;
  }
  async organization(id) { return this.first('SELECT * FROM organizations WHERE id=?', id); }
  async deactivationOperation(operationId) {
    const row = await this.first('SELECT * FROM principal_deactivations WHERE operation_id=?',operationId);
    return row && {...row,targets:await this.all('SELECT source_id,fenced FROM principal_fences WHERE operation_id=? ORDER BY source_id',operationId)};
  }
  async beginPrincipalDeactivation({principalId:id,actor,operationId}) {
    const actorId = principalId(actor), admin = await this.principal(actorId);
    if (admin?.status !== 'active' || !admin.admin) throw fail(403, 'An active administrator is required');
    const prior = await this.deactivationOperation(operationId);
    if (prior) { if (prior.principal_id !== id || prior.actor_id !== actorId) throw fail(409, 'Deactivation operation belongs to another identity'); return prior; }
    await this.batch([
      ["INSERT INTO principal_deactivations(operation_id,principal_id,actor_id,version,status,created_at) SELECT ?,id,?,version+1,'pending',? FROM principals WHERE id=? AND status='active'",[operationId,actorId,new Date(this.clock()).toISOString(),id]],
      ["UPDATE principals SET status='deactivating',version=version+1 WHERE id=? AND status='active' AND EXISTS(SELECT 1 FROM principal_deactivations WHERE operation_id=? AND principal_id=principals.id AND version=principals.version+1)",[id,operationId]],
      // Fence every extant coordinator, not only lagging membership projections.
      ['INSERT INTO principal_fences(operation_id,source_id) SELECT ?,id FROM systems WHERE EXISTS(SELECT 1 FROM principal_deactivations WHERE operation_id=?)',[operationId,operationId]],
    ]);
    const receipt = await this.deactivationOperation(operationId);
    if (!receipt) throw fail(409, 'Principal is not available for deactivation');
    return receipt;
  }
  async acknowledgePrincipalFence({operationId,sourceId,principalId:id,version}) {
    await this.run(`UPDATE principal_fences SET fenced=1 WHERE operation_id=? AND source_id=? AND EXISTS(
      SELECT 1 FROM principal_deactivations d JOIN principals p ON p.id=d.principal_id WHERE d.operation_id=? AND d.principal_id=? AND d.version=? AND p.version=d.version AND p.status IN ('deactivating','inactive'))`,operationId,sourceId,operationId,id,version);
    const row = await this.first('SELECT fenced FROM principal_fences WHERE operation_id=? AND source_id=?',operationId,sourceId);
    if (!row?.fenced) throw fail(409, 'Principal fence does not match the deactivation barrier');
    return {operationId,sourceId,principalId:id,version,fenced:true};
  }
  async finalizePrincipalDeactivation({operationId,actor}) {
    const operation = await this.deactivationOperation(operationId);
    if (!operation || operation.actor_id !== principalId(actor)) throw fail(403, 'Deactivation operation belongs to another administrator');
    const admin = await this.principal(principalId(actor));
    // The original admin may finish its own deactivation after the barrier has
    // removed its ordinary request authority. This endpoint needs the original
    // verified identity and operation receipt; it cannot change other targets.
    if (!admin?.admin || admin.status !== 'active' && admin.id !== operation.principal_id) throw fail(403, 'Deactivation administrator is inactive');
    if (operation.targets.some(target => !target.fenced)) throw fail(409, 'Principal deactivation is waiting for coordinator fences');
    await this.batch([
      ["UPDATE principals SET status='inactive' WHERE id=? AND version=? AND status='deactivating' AND NOT EXISTS(SELECT 1 FROM principal_fences WHERE operation_id=? AND fenced=0)",[operation.principal_id,operation.version,operationId]],
      ["UPDATE principal_deactivations SET status='completed' WHERE operation_id=? AND EXISTS(SELECT 1 FROM principals WHERE id=? AND version=? AND status='inactive')",[operationId,operation.principal_id,operation.version]],
    ]);
    const receipt = await this.deactivationOperation(operationId);
    if (receipt.status !== 'completed') throw fail(409, 'Principal deactivation did not complete');
    return receipt;
  }
  async ensureOrganization({ id, name = '' }) {
    await this.run('INSERT INTO organizations(id,name) VALUES(?,?) ON CONFLICT(id) DO NOTHING', id, name);
    return this.organization(id);
  }
  async source(reference) { return materialize(await this.first('SELECT * FROM systems WHERE id=? OR system_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1', reference, reference, reference)); }
  async resource(kind, id) { const row = await this.first('SELECT source_id,tombstone FROM resource_index WHERE kind=? AND id=?', kind, id); return row && { ...row, tombstone: Boolean(row.tombstone) }; }
  async sourcesForPrincipal(id) {
    const now = new Date(this.clock()).toISOString();
    return (await this.all(`SELECT s.* FROM systems s JOIN principals p ON p.id=? AND p.status='active'
      WHERE p.admin=1 OR EXISTS(SELECT 1 FROM system_access a WHERE a.source_id=s.id AND a.principal_id=p.id AND (a.can_read=1 OR a.can_write=1))
      OR EXISTS(SELECT 1 FROM publishers g WHERE g.source_id=s.id AND g.principal_id=p.id)
      OR EXISTS(SELECT 1 FROM session_visibility v WHERE v.source_id=s.id AND v.principal_id=p.id AND v.status='open' AND (v.expires_at IS NULL OR v.expires_at>?))
      ORDER BY s.system_id`, id, now)).map(materialize);
  }
  async readAuthority(sourceId, id) {
    // One primary snapshot contains all authority inputs (not parallel reads).
    const row = await this.first(`SELECT s.*,o.status AS organization_status,
      p.id AS p_id,p.type AS p_type,p.name AS p_name,p.issuer AS p_issuer,p.subject AS p_subject,p.status AS p_status,p.admin AS p_admin,p.version AS p_version,
      COALESCE(a.can_read,0) AS can_read,COALESCE(a.can_write,0) AS can_write,
      EXISTS(SELECT 1 FROM publishers g WHERE g.source_id=s.id AND g.principal_id=?) AS publisher
      FROM systems s LEFT JOIN organizations o ON o.id=s.organization_id LEFT JOIN principals p ON p.id=?
      LEFT JOIN system_access a ON a.source_id=s.id AND a.principal_id=p.id WHERE s.id=?`, id, id, sourceId);
    if (!row) return { principal: await this.principal(id), source: null, organizationStatus: null, access: { read: false, write: false }, publisher: false, authorityVersion: 0, principalVersion: 0 };
    const principal = row.p_id ? { id: row.p_id, type: row.p_type, name: row.p_name, issuer: row.p_issuer, subject: row.p_subject, status: row.p_status, admin: Boolean(row.p_admin), version: row.p_version } : null;
    return { principal, source: materialize(row), organizationStatus: row.organization_status,
      access: { read: Boolean(row.can_read), write: Boolean(row.can_write) }, publisher: Boolean(row.publisher),
      authorityVersion: row.authority_version, principalVersion: row.p_version || 0 };
  }
  async reserveSystem({ operationId, actor, source, provisionInput = null }) {
    const actorId = principalId(actor), principal = await this.principal(actorId);
    if (!principal?.admin || principal.status !== 'active') throw fail(403, 'An active administrator is required');
    const organization = await this.organization(source.organization_id);
    if (organization?.status !== 'active') throw fail(409, 'Organization is unavailable');
    const safe = { ...source, lifecycle_status: 'provisioning', archived_at: null };
    if(provisionInput!==null&&(!/^[a-f0-9]{64}$/.test(provisionInput.fileTreeDigest||'')||typeof provisionInput.grantPublisher!=='boolean'||Object.keys(provisionInput).some(key=>!['fileTreeDigest','grantPublisher'].includes(key))))throw fail(400,'Provision input must identify the exact file tree and requested grant');
    const fingerprint = json([safe.id,safe.system_id,safe.organization_id,safe.artifacts_namespace,safe.artifacts_repository,actorId,safe.name??null,safe.manifest_json??null,provisionInput]);
    const prior = await this.first('SELECT * FROM provision_operations WHERE id=?', operationId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw fail(409, 'Provision operation belongs to different source inputs'); return decode(prior.receipt_json); }
    const receipt = { operationId, sourceId: safe.id, actorId, status: 'reserved',provisionInput };
    await this.batch([
      ['INSERT INTO systems(id,system_id,organization_id,lifecycle_status,archived_at,artifacts_namespace,artifacts_repository,artifacts_repository_id,source_json) VALUES(?,?,?,?,?,?,?,?,?)', [safe.id,safe.system_id,safe.organization_id,'provisioning',null,safe.artifacts_namespace,safe.artifacts_repository,safe.artifacts_repository_id || null,json(safe)]],
      ['INSERT INTO provision_operations(id,source_id,actor_id,fingerprint,receipt_json) VALUES(?,?,?,?,?)', [operationId,safe.id,actorId,fingerprint,json(receipt)]],
    ]);
    return receipt;
  }
  async provisionReceipt(id) { const row = await this.first('SELECT receipt_json FROM provision_operations WHERE id=?', id); return row && decode(row.receipt_json); }
  async startReservation(id, key) { const row = await this.first('SELECT * FROM start_reservations WHERE principal_id=? AND idempotency_key=?', id, key); return row && { ...row, session: decode(row.session_json) }; }
  async reserveStart(row) {
    const fingerprint = startFingerprint(row);
    await this.run('INSERT INTO start_reservations(principal_id,idempotency_key,source_id,session_id,fingerprint,session_json) VALUES(?,?,?,?,?,?) ON CONFLICT(principal_id,idempotency_key) DO NOTHING', row.owner_principal_id, row.idempotency_key, row.source_id, row.id, fingerprint, json(row));
    const receipt = await this.startReservation(row.owner_principal_id, row.idempotency_key);
    if (receipt.source_id !== row.source_id) throw fail(409, 'This idempotency key belongs to another Design System');
    if (receipt.fingerprint !== fingerprint) throw fail(409, 'This idempotency key belongs to different session origins');
    return receipt;
  }
  async reserveRequest({request,job}) {
    const id = request.id, sourceId = request.source_id;
    const fingerprint = json([sourceId,request.requested_by,request.prompt,request.session_id || null]);
    const receipt = {request,job};
    await this.run('INSERT INTO request_reservations(request_id,source_id,fingerprint,receipt_json) VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING',id,sourceId,fingerprint,json(receipt));
    const saved = await this.first('SELECT * FROM request_reservations WHERE request_id=?',id);
    if (saved.fingerprint !== fingerprint || saved.source_id !== sourceId) throw fail(409, 'Request ID belongs to a different source, identity, or instruction');
    return decode(saved.receipt_json);
  }
  async authorityOperation(operationId) { const row = await this.first('SELECT * FROM authority_operations WHERE id=?', operationId); return row && { ...row, command: decode(row.command_json) }; }
  async applyAuthorityOperation({ operationId, sourceId, actorId, expectedVersion, command }) {
    const commandJson = json(command), now = new Date(this.clock()).toISOString();
    const prior = await this.authorityOperation(operationId);
    if (prior) {
      if (prior.source_id !== sourceId || prior.actor_id !== actorId || prior.expected_version !== expectedVersion || prior.command_json !== commandJson) throw fail(409, 'Authority operation receipt does not match');
      return prior;
    }
    const allowed = ['principalId','read','write','publish','lifecycleStatus','archivedAt','repositoryId','sourcePatch'];
    if (Object.keys(command).some(key => !allowed.includes(key))) throw fail(400, 'Unsupported authority mutation');
    if (['read','write','publish'].some(key => key in command && typeof command[key] !== 'boolean')) throw fail(400, 'Grant values must be booleans');
    if (command.repositoryId) { const source = await this.source(sourceId); if (source?.artifacts_repository_id && source.artifacts_repository_id !== command.repositoryId) throw fail(409, 'Source repository identity is immutable'); }
    if (['read','write','publish'].some(key => key in command)) {
      const target = await this.principal(command.principalId);
      if (!target) throw fail(404, 'Principal not found');
      if (['read','write','publish'].some(key => command[key] === true) && target.status !== 'active') throw fail(403, 'Cannot grant access to an inactive identity');
    }
    const gate = 'EXISTS(SELECT 1 FROM authority_operations WHERE id=? AND source_id=? AND command_json=?) AND EXISTS(SELECT 1 FROM systems WHERE id=? AND authority_version=?)';
    const guard = [operationId,sourceId,commandJson,sourceId,expectedVersion];
    const grant = ['read','write','publish'].some(key => command[key] === true);
    const statements = [[`INSERT INTO authority_operations(id,source_id,actor_id,expected_version,confirmed_version,command_json,created_at)
      SELECT ?,id,?,authority_version,authority_version+1,?,? FROM systems WHERE id=? AND authority_version=?
      ${grant ? "AND EXISTS(SELECT 1 FROM principals WHERE id=? AND status='active')" : ''} ON CONFLICT(id) DO NOTHING`, [operationId,actorId,commandJson,now,sourceId,expectedVersion,...(grant ? [command.principalId] : [])]]];
    if ('read' in command || 'write' in command) {
      const existing = await this.first('SELECT can_read,can_write FROM system_access WHERE source_id=? AND principal_id=?',sourceId,command.principalId);
      const write = command.write ?? Boolean(existing?.can_write), read = (command.read ?? Boolean(existing?.can_read)) || write;
      statements.push([`INSERT INTO system_access(source_id,principal_id,can_read,can_write) SELECT ?,?,?,? WHERE ${gate}
        ON CONFLICT(source_id,principal_id) DO UPDATE SET can_read=excluded.can_read,can_write=excluded.can_write`, [sourceId,command.principalId,Number(read),Number(write),...guard]]);
    }
    if ('publish' in command) statements.push(command.publish ?
      [`INSERT INTO publishers(source_id,principal_id) SELECT ?,? WHERE ${gate} ON CONFLICT DO NOTHING`, [sourceId,command.principalId,...guard]] :
      [`DELETE FROM publishers WHERE source_id=? AND principal_id=? AND ${gate}`, [sourceId,command.principalId,...guard]]);
    const sets = ['authority_version=authority_version+1'], values = [];
    for (const [input,column] of [['lifecycleStatus','lifecycle_status'],['archivedAt','archived_at'],['repositoryId','artifacts_repository_id']]) if (input in command) { sets.push(`${column}=?`); values.push(command[input]); }
    if (command.sourcePatch) { sets.push('source_json=json_patch(source_json,?)'); values.push(json(command.sourcePatch)); }
    statements.push([`UPDATE systems SET ${sets.join(',')} WHERE id=? AND authority_version=? AND ${gate}`, [...values,sourceId,expectedVersion,...guard]]);
    await this.batch(statements);
    const receipt = await this.authorityOperation(operationId);
    if (!receipt || receipt.command_json !== commandJson || receipt.source_id !== sourceId) throw fail(409, 'Source authority changed; retry with current version');
    return receipt;
  }
  async publicationEventsForSources(ids) {
    if (!ids.length) return [];
    return (await this.all(`SELECT row_json FROM audit_events WHERE kind='publication' AND source_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC,sequence DESC`, ...ids)).map(row => decode(row.row_json));
  }
  /** Idempotent projection. DO outbox sequence orders retries and stale delivery. */
  async project({ sequence, kind, sourceId, row }) {
    if (kind === 'event' || kind === 'publication' || kind === 'authority') {
      await this.run('INSERT INTO audit_events(id,source_id,kind,sequence,created_at,row_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', row.id,sourceId,kind,sequence,row.created_at,json(row));
      const saved = await this.first('SELECT row_json FROM audit_events WHERE id=?', row.id);
      if (saved.row_json !== json(row)) throw fail(409, 'Audit receipt collision');
    } else if (kind === 'resource') {
      await this.run(`INSERT INTO resource_index(kind,id,source_id,tombstone,sequence) VALUES(?,?,?,?,?)
        ON CONFLICT(kind,id) DO UPDATE SET tombstone=excluded.tombstone,sequence=excluded.sequence WHERE resource_index.source_id=excluded.source_id AND resource_index.sequence<excluded.sequence`, row.kind,row.id,sourceId,Number(Boolean(row.tombstone)),sequence);
      const saved = await this.resource(row.kind,row.id);
      if (saved?.source_id !== sourceId) throw fail(409, 'Resource locator collision');
    } else if (kind === 'session') {
      await this.batch([
        ['UPDATE session_visibility SET status=?,expires_at=?,sequence=? WHERE session_id=? AND sequence<?', [row.status,row.expires_at,sequence,row.id,sequence]],
        ['UPDATE start_reservations SET session_json=?,tombstone=? WHERE session_id=?', [json(row),Number(['closed','expired'].includes(row.status)),row.id]],
      ]);
    } else if (kind === 'member') {
      await this.run(`INSERT INTO session_visibility(source_id,session_id,principal_id,status,expires_at,sequence) VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id,principal_id) DO UPDATE SET status=excluded.status,expires_at=excluded.expires_at,sequence=excluded.sequence WHERE session_visibility.sequence<excluded.sequence`, sourceId,row.session_id,row.principal_id,row.status,row.expires_at,sequence);
    } else if (kind === 'pointer') {
      await this.run('UPDATE systems SET source_json=json_patch(source_json,?),projection_seq=? WHERE id=? AND projection_seq<?', json(row),sequence,sourceId,sequence);
    } else throw fail(500, 'Unknown outbox projection');
  }
}
