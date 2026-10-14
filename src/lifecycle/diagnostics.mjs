const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const statuses=new Set(['starting','open','closing','closed','expired']);
const reasons=new Set(['missing_creation_receipt','fork_identity_changed']);
const actions=new Set(['review_session','operator_review']);
export const DELETION_BLOCKER_LIMIT=50;

// Only source/session UUIDs and host-authored enums cross the error boundary.
// Repository names, opaque provider identities, metadata and tokens never do.
export function safeDeletionBlockers(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.sourceId!=='string'||!uuid.test(value.sourceId)||!Number.isSafeInteger(value.total)||value.total<1||!Array.isArray(value.sessions)||!value.sessions.length||value.sessions.length>DELETION_BLOCKER_LIMIT||value.sessions.length>value.total)return null;
  const sessions=[],seen=new Set();
  for(const row of value.sessions){
    if(!row||typeof row.sessionId!=='string'||!uuid.test(row.sessionId)||seen.has(row.sessionId)||!statuses.has(row.status)||!reasons.has(row.reason)||!actions.has(row.action))return null;
    if(row.action==='review_session'&&(row.reason!=='missing_creation_receipt'||!['open','closing'].includes(row.status)))return null;
    seen.add(row.sessionId);sessions.push({sessionId:row.sessionId,status:row.status,reason:row.reason,action:row.action});
  }
  return {sourceId:value.sourceId,total:value.total,sessions};
}
