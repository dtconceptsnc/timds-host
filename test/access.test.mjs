// Smoke: a correctly signed Cloudflare Access token maps to an identity, and
// an obviously wrong one is rejected with 401.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyAccessToken } from '../src/auth/access.mjs';

const env = { ACCESS_TEAM_DOMAIN: 'https://timds-test.cloudflareaccess.com', ACCESS_AUD: 'host-audience' };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const signed = (claims = {}, { issuer = env.ACCESS_TEAM_DOMAIN, audience = env.ACCESS_AUD } = {}) =>
  new SignJWT({ sub: 'human-subject', ...claims }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(privateKey);

test('a valid Access token maps to a user identity', async () => {
  const identity = await verifyAccessToken(await signed({ email: 'person@example.test' }), env, { keys: publicKey });
  assert.equal(identity.type, 'user');
  assert.equal(identity.subject, 'user:human-subject');
  assert.equal(identity.email, 'person@example.test');
});

test('wrong issuer, wrong audience, wrong key and garbage are rejected with 401', async () => {
  const other = await generateKeyPair('RS256');
  const attempts = [
    [await signed({}, { issuer: 'https://attacker.cloudflareaccess.com' }), publicKey],
    [await signed({}, { audience: 'other' }), publicKey],
    [await signed(), other.publicKey],
    ['x.y.z', publicKey],
  ];
  for (const [token, keys] of attempts) await assert.rejects(() => verifyAccessToken(token, env, { keys }), { statusCode: 401 });
});
