#!/usr/bin/env node
// Produces reviewable configuration only. No Cloudflare write or credential
// generation occurs here. Apply after selecting the deployed host origin.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function createAccessPlan({hostOrigin,name,email,identityProviderId,serviceTokenId}) {
  const url=new URL(hostOrigin);
  if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.port||url.username||url.password)throw new Error('Use the exact HTTPS host origin');
  if(typeof name!=='string'||!name.trim()||name.length>100)throw new Error('A distinct Access application name is required');
  if(typeof email!=='string'||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('One exact human email is required');
  if(!uuid.test(identityProviderId)||!uuid.test(serviceTokenId))throw new Error('The existing IdP and a new host-only service token UUID are required');
  const paths=['/authorize','/bootstrap','/service-auth'];
  return {type:'self_hosted',name:name.trim(),domain:`${url.hostname}/authorize`,destinations:paths.map(path=>({type:'public',uri:`${url.hostname}${path}`})),allowed_idps:[identityProviderId],auto_redirect_to_identity:true,app_launcher_visible:false,session_duration:'8h',http_only_cookie_attribute:true,enable_binding_cookie:true,same_site_cookie_attribute:'lax',path_cookie_attribute:false,
    policies:[
      {name:'TimDS host human sign-in',decision:'allow',precedence:1,include:[{email:{email}}],require:[],exclude:[]},
      {name:'TimDS host service identity',decision:'non_identity',precedence:2,include:[{service_token:{token_id:serviceTokenId}}],require:[],exclude:[]},
    ]};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  try{const {values}=parseArgs({options:{'host-origin':{type:'string'},name:{type:'string'},email:{type:'string'},'identity-provider-id':{type:'string'},'service-token-id':{type:'string'}}});
    process.stdout.write(JSON.stringify(createAccessPlan({hostOrigin:values['host-origin'],name:values.name,email:values.email,identityProviderId:values['identity-provider-id'],serviceTokenId:values['service-token-id']}),null,2)+'\n');
  }catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
