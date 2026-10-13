const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** No defaults can select production data, identity, or a write target. */
export function readConfiguration(env = process.env) {
  const required = name => { if (!env[name]?.trim()) throw new Error(`${name} is required; see README.md`); return env[name].trim(); };
  const url = new URL(required('TIMDS_HOST_URL'));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('TIMDS_HOST_URL must be an origin without credentials or path');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('The host must use HTTPS, except a localhost development host');
  const sourceId = required('TIMDS_FIXTURE_SOURCE_ID');
  if (!uuid.test(sourceId)) throw new Error('TIMDS_FIXTURE_SOURCE_ID must be a UUID');
  const systemId = required('TIMDS_FIXTURE_SYSTEM_ID');
  if (required('TIMDS_ALLOW_DISPOSABLE_WRITES') !== `${sourceId}:${systemId}`) throw new Error('Write acknowledgement must exactly match the explicit disposable source and system');
  const memberPrincipalId = required('TIMDS_MEMBER_PRINCIPAL_ID');
  if (!uuid.test(memberPrincipalId)) throw new Error('TIMDS_MEMBER_PRINCIPAL_ID must be a UUID');
  const token = required('TIMDS_ACCESS_TOKEN'), memberToken = required('TIMDS_MEMBER_ACCESS_TOKEN');
  if (token === memberToken) throw new Error('Conformance requires two distinct principals and credentials');
  const timeoutMs = Number(env.TIMDS_CONFORMANCE_TIMEOUT_MS || 900_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) throw new Error('TIMDS_CONFORMANCE_TIMEOUT_MS must be 10000–3600000');
  return { url: url.origin, sourceId, systemId, token, memberToken, memberPrincipalId, timeoutMs };
}
