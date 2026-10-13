import { createHmac,timingSafeEqual } from 'node:crypto';
import { fail } from '../store/errors.mjs';
import { canonical,digest,sameFence } from './contract.mjs';

/** Server-to-server proof from the cutover operator after reading the durable
 * portal journal. Never accept a browser's `verified` field. Shared secret is
 * deployment-only, independent of OAuth/Access and never returned in receipts. */
export function createPortalReceiptVerifier(env,{clock=()=>Date.now()}={}) {
  return async ({action,proof,row})=>{
    const secret=env.TIMDS_PORTAL_TRANSFER_SECRET,issuer=env.TIMDS_PORTAL_ORIGIN;
    if(typeof secret!=='string'||secret.length<32||!issuer)throw fail(503,'Portal transfer proof verification is not configured');
    if(typeof proof!=='string'||proof.length>16384)throw fail(403,'A signed portal journal proof is required');
    const parts=proof.split('.');if(parts.length!==2)throw fail(403,'Invalid portal journal proof');
    const signature=createHmac('sha256',secret).update(parts[0]).digest(),provided=Buffer.from(parts[1],'base64url');
    if(provided.length!==signature.length||!timingSafeEqual(signature,provided))throw fail(403,'Invalid portal journal proof');
    let claims;try{claims=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw fail(403,'Invalid portal journal proof');}
    const now=Math.floor(clock()/1000);
    if(claims.iss!==issuer||claims.aud!==row.input.origin||claims.action!==action||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)||claims.iat>now+30||claims.exp<=now||claims.exp-claims.iat>300||claims.exp<=claims.iat)throw fail(403,'Portal journal proof is expired or bound to another operation');
    if(action==='prepare'){
      for(const key of ['operationId','portalSourceId','sourceId','origin','epoch','snapshotDigest','exportDigest'])if(claims.receipt?.[key]!==row.input[key])throw fail(409,'Portal prepare proof binding differs');
      if(row.input.manifest.portalOrigin!==issuer)throw fail(409,'Historical identity issuer differs from the verified portal');
    }else if(action==='tombstone'){
      for(const key of ['operationId','portalSourceId','sourceId','origin','exportDigest'])if(claims.receipt?.[key]!==row.input[key])throw fail(409,'Deleted-source proof binding differs');
      const manifest=row.input.manifest;
      if(manifest.portalOrigin!==issuer||claims.receipt.capturedAt!==manifest.capturedAt||claims.receipt.identityDigest!==digest(manifest.identity)||claims.receipt.deletionDigest!==digest(manifest.deletion)||claims.receipt.originalDeletionOperationId!==manifest.deletion.id||claims.receipt.sourceAbsent!==true||claims.receipt.repositoryAbsent!==true)throw fail(409,'Completed portal deletion proof differs');
    }else if(action==='abort-unprepared'){
      for(const key of ['operationId','portalSourceId','sourceId','origin','epoch'])if(claims.receipt?.[key]!==row.input[key])throw fail(409,'Portal abort proof binding differs');
    }else sameFence(row,claims.receipt,{activation:action==='activate'});
    const phases=action==='tombstone'?['deleted']:action==='prepare'?['frozen','imported']:action==='abort-unprepared'?['freezing','frozen']:[action==='activate'?'activating':'frozen'];
    if(!phases.includes(claims.receipt.phase))throw fail(409,'Portal journal is not in the required phase');
    return claims.receipt;
  };
}
// Used only by the trusted operator driver, after actual portal SQL readback.
export function signPortalReceipt({secret,issuer,origin,action,receipt,now=Date.now()}) {
  if(typeof secret!=='string'||secret.length<32)throw new Error('Transfer signing is not configured');
  const iat=Math.floor(now/1000),body=Buffer.from(canonical({iss:issuer,aud:origin,action,receipt,iat,exp:iat+120})).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
