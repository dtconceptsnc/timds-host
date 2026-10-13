import { createRemoteJWKSet, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import { fail } from '../store/errors.mjs';

const keySets = new Map();
export function accessConfiguration(env) {
  let issuer;
  try { issuer = new URL(env.ACCESS_TEAM_DOMAIN); } catch { throw fail(503, 'Access identity is not configured'); }
  if (issuer.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) || issuer.port || issuer.username || issuer.password || issuer.pathname !== '/' || issuer.search || issuer.hash || !env.ACCESS_AUD) throw fail(503, 'Access identity is not configured');
  return { issuer: issuer.origin, audience: env.ACCESS_AUD };
}

/** The JWKS origin is installation configuration, never an unverified JWT claim. */
export async function verifyAccessToken(token, env, { keys } = {}) {
  const { issuer, audience } = accessConfiguration(env);
  if (typeof token !== 'string' || !token || token.length > 16384) throw fail(401, 'A verified Access identity is required');
  if (!keys) {
    if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }));
    keys = keySets.get(issuer);
  }
  let payload;
  try { ({ payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp','iat','iss','aud'], maxTokenAge: '24h', clockTolerance: 5 })); }
  catch { throw fail(401, 'Access identity could not be verified'); }
  // Access service tokens have an empty sub and a signed common_name (client ID).
  // Distinct namespaces prevent any user/service identity collision.
  if (payload.sub === '' && typeof payload.common_name === 'string' && payload.common_name) {
    return { issuer, subject: `service:${payload.common_name}`, type: 'agent', name: payload.common_name };
  }
  if (typeof payload.sub !== 'string' || !payload.sub || payload.common_name) throw fail(401, 'Access identity has no stable subject');
  return { issuer, subject: `user:${payload.sub}`, type: 'user', name: typeof payload.email === 'string' ? payload.email : payload.sub };
}

export async function authenticateAccess(request, env, catalog) {
  const identity = await verifyAccessToken(request.headers.get('Cf-Access-Jwt-Assertion'), env);
  const principal = await catalog.resolveIdentity(identity);
  if (principal?.status !== 'active') throw fail(403, 'This TimDS identity is inactive');
  return principal;
}

export function verifyBootstrapSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length < 32 || actual.length > 1024) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
