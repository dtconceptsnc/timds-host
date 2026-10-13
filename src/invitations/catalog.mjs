import { fail,json,principalId } from '../store/errors.mjs';

export const invitationOperation=id=>`access-invitation:${id}`;
export function normalizedEmail(value){
  if(typeof value!=='string'||value.length>254||!/^[\x21-\x7e]+$/.test(value)||!/^([^@]+)@([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,})$/.test(value))throw fail(400,'An explicit valid invitation email is required');
  return value.toLowerCase();
}
const permissions=row=>({read:Boolean(row.can_read),write:Boolean(row.can_write),publish:Boolean(row.can_publish)});
export const invitationView=row=>({id:row.id,sourceId:row.source_id,issuer:row.issuer,email:row.email,permissions:permissions(row),status:row.status,requestedBy:row.requested_by,createdAt:row.created_at,claimedPrincipalId:row.claimed_principal_id,claimedAt:row.claimed_at,revokedAt:row.revoked_at});
export class AccessInvitations {
  constructor(catalog){this.catalog=catalog;}
  read(id){return this.catalog.first('SELECT * FROM source_access_invitations WHERE id=?',id);}
  async admin(actor){const principal=await this.catalog.principal(principalId(actor));if(principal?.status!=='active'||!principal.admin)throw fail(403,'An active administrator is required');return principal;}
  async page(sourceId,after=''){
    const rows=await this.catalog.all('SELECT * FROM source_access_invitations WHERE source_id=? AND id>? ORDER BY id LIMIT 101',sourceId,after);
    return {invitations:rows.slice(0,100).map(invitationView),nextCursor:rows.length>100?rows[99].id:null};
  }
  async pending(identity){
    // A login may finish up to 100 independent source reservations. Remaining
    // pending sources are handled on the next fresh Access authorization.
    return this.catalog.all(`SELECT i.id,i.source_id FROM source_access_invitations i
      JOIN systems s ON s.id=i.source_id JOIN organizations o ON o.id=s.organization_id
      WHERE i.issuer=? AND i.email=? AND i.status='pending' AND s.lifecycle_status='ready'
      AND s.archived_at IS NULL AND o.status='active' ORDER BY i.id LIMIT 100`,identity.issuer,identity.email);
  }
  async reserve({sourceId,actor,input,issuer}){
    const principal=await this.admin(actor),email=normalizedEmail(input.email);
    const fingerprint=json([sourceId,issuer,email,input.read,input.write,input.publish,principal.id]);
    const prior=await this.read(input.invitationId);
    if(prior){if(prior.fingerprint!==fingerprint)throw fail(409,'Invitation ID belongs to different immutable inputs');return invitationView(prior);}
    await this.catalog.run(`INSERT INTO source_access_invitations(id,source_id,issuer,email,requested_by,can_read,can_write,can_publish,fingerprint,created_at)
      SELECT ?,s.id,?,?,?,?,?,?,?,? FROM systems s JOIN organizations o ON o.id=s.organization_id
      WHERE s.id=? AND s.lifecycle_status IN ('ready','importing') AND s.archived_at IS NULL AND o.status='active'
      AND EXISTS(SELECT 1 FROM principals WHERE id=? AND status='active' AND admin=1)`,input.invitationId,issuer,email,principal.id,Number(input.read),Number(input.write),Number(input.publish),fingerprint,new Date().toISOString(),sourceId,principal.id);
    const row=await this.read(input.invitationId);if(!row||row.fingerprint!==fingerprint)throw fail(409,'Source is unavailable for an invitation');return invitationView(row);
  }
  async revoke({sourceId,actor,invitationId}){
    const principal=await this.admin(actor),row=await this.read(invitationId);
    if(!row||row.source_id!==sourceId)throw fail(404,'Invitation not found');
    if(row.status==='claimed')throw fail(409,'Invitation was already claimed; change the principal’s source grants explicitly');
    if(row.status==='pending')await this.catalog.run("UPDATE source_access_invitations SET status='revoked',revoked_by=?,revoked_at=? WHERE id=? AND source_id=? AND status='pending'",principal.id,new Date().toISOString(),invitationId,sourceId);
    return invitationView(await this.read(invitationId));
  }
}

/** Executed only by the owning source's durable authority journal. The verified
 * identity facts are persisted for recovery, but never the Access assertion.
 * The invite CAS, authority receipt, grants and authority version are one D1
 * batch. Unknown response recovery reads the same authority receipt. */
export async function applyInvitationClaim(catalog,pending){
  const {operationId,sourceId,actorId,expectedVersion,command,invitationClaim:claim}=pending;
  if(!claim||operationId!==invitationOperation(claim.id)||claim.principalId!==command.principalId||Object.keys(command).some(key=>!['principalId','read','write','publish'].includes(key)))throw fail(409,'Invalid invitation authority journal');
  const commandJson=json(command),prior=await catalog.authorityOperation(operationId),invitation=await new AccessInvitations(catalog).read(claim.id);
  if(!invitation||invitation.source_id!==sourceId||invitation.requested_by!==actorId||invitation.issuer!==claim.issuer||invitation.email!==claim.email)throw fail(409,'Invitation authority binding differs');
  if(prior){
    if(prior.source_id!==sourceId||prior.actor_id!==actorId||prior.expected_version!==expectedVersion||prior.command_json!==commandJson||invitation.status!=='claimed'||invitation.claimed_principal_id!==claim.principalId||invitation.claimed_subject!==claim.subject)throw fail(409,'Invitation claim receipt differs');return prior;
  }
  if(invitation.status!=='pending')throw fail(409,'Invitation is no longer pending');
  if(['read','write','publish'].some(key=>typeof command[key]!=='boolean'||permissions(invitation)[key]&&!command[key]))throw fail(409,'Invitation permissions differ');
  const current=await catalog.readAuthority(sourceId,claim.principalId),expected={read:Boolean(invitation.can_read||current.access.read||current.access.write),write:Boolean(invitation.can_write||current.access.write),publish:Boolean(invitation.can_publish||current.publisher)};
  if(['read','write','publish'].some(key=>command[key]!==expected[key]))throw fail(409,'Invitation authority changed while awaiting its receipt');
  const now=new Date().toISOString();
  const claimed="EXISTS(SELECT 1 FROM source_access_invitations WHERE id=? AND source_id=? AND status='claimed' AND claimed_principal_id=? AND claimed_subject=?)";
  const claimArgs=[claim.id,sourceId,claim.principalId,claim.subject];
  const gate='EXISTS(SELECT 1 FROM authority_operations WHERE id=? AND source_id=? AND command_json=?) AND EXISTS(SELECT 1 FROM systems WHERE id=? AND authority_version=?)';
  const guard=[operationId,sourceId,commandJson,sourceId,expectedVersion];
  await catalog.batch([
    [`UPDATE source_access_invitations SET status='claimed',claimed_principal_id=?,claimed_subject=?,claimed_at=?
      WHERE id=? AND source_id=? AND status='pending' AND issuer=? AND email=? AND requested_by=?
      AND EXISTS(SELECT 1 FROM systems s JOIN organizations o ON o.id=s.organization_id WHERE s.id=? AND s.authority_version=? AND s.lifecycle_status='ready' AND s.archived_at IS NULL AND o.status='active')
      AND EXISTS(SELECT 1 FROM principals WHERE id=? AND type='user' AND status='active' AND issuer=? AND subject=?)
      AND EXISTS(SELECT 1 FROM principals WHERE id=? AND status='active' AND admin=1)`,[claim.principalId,claim.subject,now,claim.id,sourceId,claim.issuer,claim.email,actorId,sourceId,expectedVersion,claim.principalId,claim.issuer,claim.subject,actorId]],
    [`INSERT INTO authority_operations(id,source_id,actor_id,expected_version,confirmed_version,command_json,created_at)
      SELECT ?,id,?,authority_version,authority_version+1,?,? FROM systems WHERE id=? AND authority_version=? AND ${claimed}`,[operationId,actorId,commandJson,now,sourceId,expectedVersion,...claimArgs]],
    [`INSERT INTO system_access(source_id,principal_id,can_read,can_write) SELECT ?,?,?,? WHERE ${gate}
      ON CONFLICT(source_id,principal_id) DO UPDATE SET can_read=excluded.can_read,can_write=excluded.can_write`,[sourceId,claim.principalId,Number(command.read||command.write),Number(command.write),...guard]],
    ...(command.publish?[[`INSERT INTO publishers(source_id,principal_id) SELECT ?,? WHERE ${gate} ON CONFLICT DO NOTHING`,[sourceId,claim.principalId,...guard]]]:[]),
    [`UPDATE systems SET authority_version=authority_version+1 WHERE id=? AND authority_version=? AND ${gate}`,[sourceId,expectedVersion,...guard]],
  ]);
  const receipt=await catalog.authorityOperation(operationId);
  if(!receipt||receipt.command_json!==commandJson||receipt.source_id!==sourceId)throw fail(409,'Invitation claim is waiting for a ready source and active identities');return receipt;
}
