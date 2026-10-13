import { fail } from '../store/errors.mjs';
import { accessConfiguration,verifyAccessToken } from '../auth/access.mjs';
import { AccessInvitations,normalizedEmail } from './catalog.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const invitationsEnabled=env=>env.TIMDS_ACCESS_INVITATIONS_ENABLED==='true';
export function createSourceInvitations({sourceId,catalog,store,env}){
  const invitations=new AccessInvitations(catalog);
  const enabled=()=>{if(!invitationsEnabled(env))throw fail(503,'Access invitations are not enabled');};
  return {
    async admin({operation,actor,input}){
      enabled();await invitations.admin(actor);
      if(operation==='list'){
        if(input.after&&!uuid.test(input.after))throw fail(400,'An invitation cursor UUID is required');
        return {apiVersion:1,sourceId,...await invitations.page(sourceId,input.after||'')};
      }
      if(!uuid.test(input.invitationId||''))throw fail(400,'A stable invitation UUID is required');
      if(operation==='revoke')return invitations.revoke({sourceId,actor,invitationId:input.invitationId});
      if(operation!=='reserve')throw fail(404,'Unknown invitation operation');
      if(store.deletionFence())throw fail(409,'A deleting source cannot receive invitations');
      if(Object.keys(input).some(key=>!['invitationId','email','issuer','read','write','publish'].includes(key))||['read','write','publish'].some(key=>typeof input[key]!=='boolean')||![input.read,input.write,input.publish].includes(true)||input.write&&!input.read)throw fail(400,'Specify only the invitation identity and explicit source permissions (write also requires read)');
      const {issuer}=accessConfiguration(env);if(input.issuer!==issuer)throw fail(400,'Invitation issuer must be the configured Access organization');
      return invitations.reserve({sourceId,actor,input,issuer});
    },
    async claim({invitationId,assertion}){
      enabled();if(!uuid.test(invitationId||''))throw fail(400,'An invitation UUID is required');
      // Binding-only method, also revalidates the signed assertion inside this
      // source coordinator. Never accepts a caller's verified/email boolean.
      const identity=await verifyAccessToken(assertion,env);
      if(identity.type!=='user'||!identity.email)throw fail(403,'A verified human Access email is required');
      identity.email=normalizedEmail(identity.email);
      const principal=await catalog.resolveIdentity(identity);
      if(principal.status!=='active')throw fail(403,'This TimDS identity is inactive');
      return store.claimAccessInvitation({invitationId,identity,principalId:principal.id});
    },
  };
}

/** Called after approval of real Access-authenticated OAuth consent. Claims do
 * not change OAuth scopes and send no email. */
export async function claimLoginInvitations({request,env,catalog,getCoordinator}){
  if(!invitationsEnabled(env))return;
  const assertion=request.headers.get('Cf-Access-Jwt-Assertion'),identity=await verifyAccessToken(assertion,env);
  if(identity.type!=='user'||!identity.email)return;
  try{identity.email=normalizedEmail(identity.email);}catch{return;}
  for(const row of await new AccessInvitations(catalog).pending(identity)){
    const result=await getCoordinator(row.source_id).claimAccessInvitation({invitationId:row.id,assertion});
    if(!result.ok)throw fail(result.error.statusCode,result.error.message);
  }
}
