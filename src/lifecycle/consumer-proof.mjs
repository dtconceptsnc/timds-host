import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../store/errors.mjs';

/** Portal relationships remain canonical for an imported source. Only the
 * authenticated portal backend signs these facts after its own live DB read. */
export function verifyDeletionConsumers({env,origin,proof,operation,clock=()=>Date.now()}) {
  const secret=env.TIMDS_PORTAL_TRANSFER_SECRET,issuer=env.TIMDS_PORTAL_ORIGIN;
  if(typeof secret!=='string'||secret.length<32||!issuer)throw fail(503,'Portal consumer verification is not configured');
  if(typeof proof!=='string'||proof.length>16384)throw fail(403,'A fresh portal consumer check is required');
  const parts=proof.split('.');
  if(parts.length!==2)throw fail(403,'Invalid portal consumer check');
  const actual=createHmac('sha256',secret).update(parts[0]).digest(),provided=Buffer.from(parts[1],'base64url');
  if(actual.length!==provided.length||!timingSafeEqual(actual,provided))throw fail(403,'Invalid portal consumer check');
  let claims;try{claims=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw fail(403,'Invalid portal consumer check');}
  const now=Math.floor(clock()/1000),receipt=claims.receipt;
  if(claims.iss!==issuer||claims.iss!==operation.portal_origin||claims.aud!==origin||claims.action!=='delete-consumers'||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)||claims.iat>now+30||claims.exp<=now||claims.exp<=claims.iat||claims.exp-claims.iat>120)throw fail(403,'Portal consumer check is expired or bound to another host');
  if(receipt?.sourceId!==operation.source_id||receipt.operationId!==operation.id||receipt.impactHash!==operation.impact_hash||receipt.consumerFenceId!==operation.id||receipt.consumerFenceEpoch!==operation.portal_epoch||receipt.activeConsumers!==0||!/^[a-f0-9]{64}$/.test(receipt.consumerDigest||''))throw fail(409,'The portal consumer check does not permit this deletion');
  // Persist verified facts, never the transferable proof itself.
  return {issuer,checkedAt:claims.iat,expiresAt:claims.exp,consumerDigest:receipt.consumerDigest,consumerFenceId:receipt.consumerFenceId,consumerFenceEpoch:receipt.consumerFenceEpoch,activeConsumers:0};
}
