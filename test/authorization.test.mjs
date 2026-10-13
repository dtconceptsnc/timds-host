import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { accessConfiguration, verifyAccessToken, verifyBootstrapSecret } from '../src/auth/access.mjs';
import { createAuthorization } from '../src/auth/authorization.mjs';

const env = { ACCESS_TEAM_DOMAIN: 'https://timds-test.cloudflareaccess.com', ACCESS_AUD: 'host-audience' };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const signed = (claims = {}, options = {}) => new SignJWT({ sub:'human-subject', ...claims }).setProtectedHeader({alg:'RS256'}).setIssuer(options.issuer || env.ACCESS_TEAM_DOMAIN).setAudience(options.audience || env.ACCESS_AUD).setIssuedAt().setExpirationTime(options.expires || '1h').sign(privateKey);
test('Access verifies signature, pinned issuer, audience and expiration before mapping identity', async () => {
  assert.deepEqual(await verifyAccessToken(await signed({email:'display@example.test'}), env, {keys:publicKey}), {issuer:env.ACCESS_TEAM_DOMAIN, subject:'user:human-subject',type:'user',name:'display@example.test',email:'display@example.test'});
  for (const token of [await signed({}, {issuer:'https://attacker.cloudflareaccess.com'}), await signed({}, {audience:'other'}), await signed({}, {expires:'1 minute ago'}), 'x.y.z']) await assert.rejects(verifyAccessToken(token, env, {keys:publicKey}), {statusCode:401});
  const other = await generateKeyPair('RS256');
  await assert.rejects(verifyAccessToken(await signed(),env,{keys:other.publicKey}),{statusCode:401});
});
test('Access service identity uses signed common_name and cannot collide with a human subject', async () => {
  const service = await verifyAccessToken(await signed({sub:'',common_name:'client.access'}),env,{keys:publicKey});
  assert.equal(service.subject,'service:client.access'); assert.equal(service.type,'agent');
  await assert.rejects(verifyAccessToken(await signed({sub:'',email:'admin@example.test'}),env,{keys:publicKey}),{statusCode:401});
  await assert.rejects(verifyAccessToken(await signed({common_name:'client.access'}),env,{keys:publicKey}),{statusCode:401});
});
test('Access config refuses attacker JWKS paths and bootstrap secret has no empty fallback', () => {
  for (const domain of ['http://timds-test.cloudflareaccess.com','https://evil.test','https://timds-test.cloudflareaccess.com/certs','https://user@timds-test.cloudflareaccess.com','https://timds-test.cloudflareaccess.com/?foo=bar']) assert.throws(()=>accessConfiguration({...env,ACCESS_TEAM_DOMAIN:domain}),{statusCode:503});
  assert.equal(verifyBootstrapSecret(undefined,undefined),false);
  assert.equal(verifyBootstrapSecret('short','short'),false);
  const secret='synthetic-test-bootstrap-credential-32-characters';
  assert.equal(verifyBootstrapSecret(secret,secret),true);
  assert.equal(verifyBootstrapSecret(secret+'x',secret),false);
});

function fixture() {
  const source = {id:'source', lifecycle_status:'ready',artifacts_namespace:'org',artifacts_repository:'repo'};
  const current = {principal:{id:'actor',type:'user',status:'active',admin:false},source,organizationStatus:'active',access:{read:false,write:false},publisher:false};
  let membership=false, binding=null;
  const auth=createAuthorization({catalog:{principal:async()=>current.principal,readAuthority:async()=>structuredClone(current)},hasSessionAccess:async()=>membership,requestBinding:async()=>binding});
  return {source,current,auth,actor:{principalId:'actor'},member:()=>membership=true,bind:value=>binding=value};
}
test('read scope, session membership and administrator rights never manufacture a publisher grant', async()=>{
  const f=fixture(); f.current.access.read=true;
  await f.auth.authorizeSource(f.source,{...f.actor,accessMode:'read'});
  await assert.rejects(f.auth.authorizeSource(f.source,f.actor),{statusCode:403});
  f.member(); await f.auth.authorizeSource(f.source,f.actor);
  f.current.principal.admin=true;
  await assert.rejects(f.auth.authorizePublish(f.source,f.actor),{statusCode:403});
  f.current.publisher=true; await f.auth.authorizePublish(f.source,f.actor);
});
test('authority is re-read for revoked grants, deactivated principals and archived organizations', async()=>{
  const f=fixture(); f.current.publisher=true;
  await f.auth.authorizePublish(f.source,f.actor);
  f.current.publisher=false; await assert.rejects(f.auth.authorizePublish(f.source,f.actor),{statusCode:403});
  f.current.principal.admin=true; f.current.principal.status='deactivating';
  await assert.rejects(f.auth.authorizeSource(f.source,{...f.actor,sessionOwned:true}),{statusCode:403});
  f.current.principal.status='active'; f.current.organizationStatus='archived';
  await assert.rejects(f.auth.authorizeSource(f.source,f.actor),{statusCode:409});
});
test('Request-bound authority cannot cross source or principal identity',async()=>{
  const f=fixture(); f.current.access.write=true;
  const actor={...f.actor,requestId:'request'};
  await assert.rejects(f.auth.authorizeSource(f.source,actor),{statusCode:403});
  f.bind({sourceId:'other',principalId:'actor'}); await assert.rejects(f.auth.authorizeSource(f.source,actor),{statusCode:403});
  f.bind({sourceId:'source',principalId:'other'}); await assert.rejects(f.auth.authorizeSource(f.source,actor),{statusCode:403});
  f.bind({sourceId:'source',principalId:'actor'}); await f.auth.authorizeSource(f.source,actor);
});
