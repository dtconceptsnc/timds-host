import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every HTTP exchange uses the real provider in workerd. Only the browser's
// navigation is automated; no fetch response, OAuth server, or KV is mocked.
const root = fileURLToPath(new URL('..', import.meta.url));
const toolkitRoot = process.argv[2] && path.resolve(process.argv[2]);
const origin = 'http://127.0.0.1:8798';
const resource = `${origin}/api/timds`;
const expectedScopes = ['timds:read', 'timds:write', 'offline_access'];
let stage = 'setup', child, temporary;
const cancelled = new AbortController();
const cancel = () => cancelled.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const checks = [];
class CheckFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckFailure(message);
}
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
async function http(url, options = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(15_000)]), ...options });
}
async function record(credentialsPath) {
  return JSON.parse(await readFile(credentialsPath, 'utf8')).portals[origin];
}
async function probe(token, method = 'GET') {
  return http(`${resource}/probe`, { method, headers: { Authorization: `Bearer ${token}` } });
}
async function verifyClaims(token, credential, expected) {
  const response = await probe(token);
  check(response.status === 200, 'Protected probe rejected token');
  const claims = await response.json();
  check(claims.testOnly === true && claims.principalId === 'fixture-user' && claims.userId === 'fixture-user', 'Synthetic identity mismatch');
  check(claims.audience === resource && claims.clientId === credential.oauth.clientId, 'Audience or client binding mismatch');
  check(JSON.stringify([...claims.scope].sort()) === JSON.stringify([...expected].sort()), 'Granted scope mismatch');
  check(!('token' in claims) && !('accessToken' in claims) && !('refreshToken' in claims), 'Probe exposed credentials');
}

try {
  check(Boolean(toolkitRoot), 'Pass the toolkit OAuth worktree as the first argument');
  check(!process.env.TIMDS_ACCESS_TOKEN, 'Unset TIMDS_ACCESS_TOKEN so saved credentials are tested');
  const toolkitPackage = JSON.parse(await readFile(path.join(toolkitRoot, 'package.json'), 'utf8'));
  const toolkitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: toolkitRoot, encoding: 'utf8' }).trim();
  const { loginWithHost, resolveAccessToken } = await import(pathToFileURL(path.join(toolkitRoot, 'src/auth.mjs')));
  temporary = await mkdtemp(path.join(os.tmpdir(), 'timds-local-oauth-'));
  const credentialsPath = path.join(temporary, 'credentials.json');
  // Refuse to reuse an unknown server already bound to the fixture port.
  const portCheck = net.createServer();
  await new Promise((resolve, reject) => { portCheck.once('error', reject); portCheck.listen(8798, '127.0.0.1', resolve); });
  await new Promise(resolve => portCheck.close(resolve));
  stage = 'start local cf dev';
  child = spawn(path.join(root, 'node_modules/.bin/cf'), ['dev'], {
    cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    check(!cancelled.signal.aborted, 'Smoke cancelled');
    check(!spawnFailed && child.exitCode === null, 'cf dev exited before readiness');
    try {
      const response = await http(`${origin}/health`);
      if (response.ok && (await response.json()).testOnly === true) { ready = true; break; }
    } catch { /* The real dev server may still be booting. */ }
    await delay(250);
  }
  check(ready, 'Local cf dev did not become ready');
  pass('cf beta14 serves the fixture in workerd with local KV');

  stage = 'discovery';
  const metadata = await (await http(`${origin}/.well-known/oauth-authorization-server`)).json();
  check(metadata.issuer === origin && metadata.registration_endpoint === `${origin}/register`, 'Discovery origin or registration endpoint mismatch');
  check(metadata.code_challenge_methods_supported.includes('S256') && metadata.token_endpoint_auth_methods_supported.includes('none'), 'Discovery lacks public PKCE support');
  check(expectedScopes.every(scope => metadata.scopes_supported.includes(scope)), 'Discovery lacks TimDS scopes');
  const denied = await probe('invalid-test-token');
  check(denied.status === 401 && denied.headers.get('www-authenticate')?.includes('resource_metadata'), 'Resource challenge missing');
  const protectedMetadata = await (await http(`${origin}/.well-known/oauth-protected-resource/api/timds`)).json();
  check(protectedMetadata.resource === resource && protectedMetadata.scopes_supported.includes('timds:read'), 'Protected resource metadata mismatch');
  pass('authorization and protected-resource discovery advertise the agreed audience/scopes');

  let challenge, registrations = 0, codeExchanges = 0, refreshExchanges = 0;
  const observedFetch = async (url, options) => {
    check(new URL(url).origin === origin, 'Client attempted a cross-origin request');
    const pathname = new URL(url).pathname;
    if (pathname === '/register') {
      const registration = JSON.parse(options.body);
      check(registration.token_endpoint_auth_method === 'none' && !registration.client_secret, 'Registration must use a public client');
      check(registration.redirect_uris.length === 1 && new URL(registration.redirect_uris[0]).hostname === '127.0.0.1', 'Registration is not loopback-bound');
      registrations += 1;
    }
    if (pathname === '/token') {
      const fields = new URLSearchParams(options.body);
      check(fields.get('resource') === resource, 'Client token request has the wrong audience');
      if (fields.get('grant_type') === 'authorization_code') {
        check(createHash('sha256').update(fields.get('code_verifier')).digest('base64url') === challenge, 'PKCE challenge does not match the exchanged verifier');
        codeExchanges += 1;
      } else if (fields.get('grant_type') === 'refresh_token') refreshExchanges += 1;
    }
    // Observe only; never synthesize responses or change the successful exchange.
    return fetch(url, options);
  };
  const navigate = async ({ verificationUrl, redirectUri, flow }) => {
    check(flow === 'oauth', 'Toolkit selected the wrong flow');
    const authorize = new URL(verificationUrl);
    check(authorize.origin === origin && authorize.searchParams.get('code_challenge_method') === 'S256', 'Authorization request is not origin-bound PKCE S256');
    challenge = authorize.searchParams.get('code_challenge');
    const response = await http(verificationUrl);
    check(response.status === 302, 'Provider did not issue an authorization redirect');
    const callback = new URL(response.headers.get('location'));
    const expected = new URL(redirectUri);
    check(callback.origin === expected.origin && callback.pathname === expected.pathname && callback.searchParams.get('iss') === origin, 'Provider callback binding mismatch');
    const wrongState = new URL(callback);
    wrongState.searchParams.set('state', 'wrong-state');
    check((await http(wrongState)).status === 400, 'Toolkit callback accepted the wrong state');
    check((await http(callback)).status === 200, 'Toolkit callback rejected the provider authorization code');
    check((await http(callback)).status === 404, 'Toolkit callback accepted a second authorization response');
  };
  const loginOptions = { credentialsPath, timeoutMs: 30_000, signal: cancelled.signal, openBrowser: false, onAuthorization: navigate, fetchImpl: observedFetch };
  stage = 'toolkit authorization code login';
  const login = await loginWithHost(origin, loginOptions);
  check(login.flow === 'oauth' && registrations === 1 && codeExchanges === 1, 'Toolkit did not discover, register, and exchange a code');
  const initial = await record(credentialsPath);
  check(initial.oauth.resource === resource && initial.oauth.refreshToken && initial.accessToken, 'Toolkit did not save OAuth credentials');
  check(((await stat(credentialsPath)).mode & 0o777) === 0o600, 'Credentials file permissions are not 0600');
  await verifyClaims(initial.accessToken, initial, expectedScopes);
  check((await probe(initial.accessToken, 'POST')).status === 200, 'Write-scoped token cannot perform the probe write');
  pass('real toolkit auto discovery, public DCR, S256 login, state/single-use callback, and 0600 persistence');
  pass('provider authenticates the saved token with exact resource/client/subject/scopes');

  stage = 'audience and client rejection';
  for (const fields of [
    { client_id: initial.oauth.clientId, resource: `${origin}/different-resource` },
    { client_id: 'unregistered-fixture-client', resource },
  ]) {
    const response = await http(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: initial.oauth.refreshToken, ...fields }) });
    check(response.status >= 400 && response.status < 500 && !(await response.json()).access_token, 'Provider accepted a refresh for the wrong audience or client');
  }
  pass('provider refuses refresh with the wrong resource or client');

  stage = 'toolkit refresh';
  // Advance only the client's expiry check. The provider's real token lifetime
  // and clock stay unchanged; no provider state or credential file is edited.
  const accessToken = await resolveAccessToken(origin, { credentialsPath, signal: cancelled.signal, fetchImpl: observedFetch, now: () => Date.parse(initial.oauth.expiresAt) + 1 });
  const renewed = await record(credentialsPath);
  check(refreshExchanges === 1 && accessToken === renewed.accessToken && accessToken !== initial.accessToken, 'Toolkit did not exchange and save a new access token');
  check(renewed.oauth.refreshToken !== initial.oauth.refreshToken, 'Provider did not rotate the refresh token');
  await verifyClaims(accessToken, renewed, expectedScopes);
  check((await resolveAccessToken(origin, { credentialsPath })) === accessToken, 'A subsequent client read did not use the saved token');
  pass('toolkit refreshes with the real provider, persists rotation, and reuses the saved token');

  stage = 'read-only scope enforcement';
  const readPath = path.join(temporary, 'read-only.json');
  await loginWithHost(origin, { ...loginOptions, credentialsPath: readPath, scopes: ['timds:read', 'offline_access'] });
  const readOnly = await record(readPath);
  await verifyClaims(readOnly.accessToken, readOnly, ['timds:read', 'offline_access']);
  const writeDenied = await probe(readOnly.accessToken, 'POST');
  check(writeDenied.status === 403 && writeDenied.headers.get('www-authenticate')?.includes('insufficient_scope'), 'Read-only token was not denied a write');
  pass('read-only grant can read and receives insufficient_scope for a write');

  stage = 'provider PKCE rejection';
  let rejectedExchange = false, rejectedLogin = false;
  const wrongVerifierFetch = async (url, options) => {
    if (new URL(url).pathname !== '/token') return fetch(url, options);
    const fields = new URLSearchParams(options.body);
    fields.set('code_verifier', 'x'.repeat(43));
    const response = await fetch(url, { ...options, body: fields.toString() });
    rejectedExchange = response.status >= 400 && response.status < 500 && !(await response.clone().json()).access_token;
    return response;
  };
  const rejectedPath = path.join(temporary, 'rejected.json');
  try { await loginWithHost(origin, { ...loginOptions, credentialsPath: rejectedPath, fetchImpl: wrongVerifierFetch }); }
  catch { rejectedLogin = true; }
  check(rejectedLogin && rejectedExchange, 'Provider accepted an invalid PKCE verifier');
  check(await stat(rejectedPath).then(() => false, error => error.code === 'ENOENT'), 'Failed login persisted credentials');
  pass('actual provider rejects a wrong PKCE verifier; toolkit saves no credentials');

  const dependencies = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  console.log(JSON.stringify({ result: 'passed', checkedAt: new Date().toISOString(), toolkitVersion: toolkitPackage.version,
    toolkitCommit, oauthProvider: dependencies.dependencies['@cloudflare/workers-oauth-provider'], cf: dependencies.devDependencies.cf,
    runtime: 'local workerd via cf dev', checks: checks.length, productionAcceptance: false }));
} catch (error) {
  // Assertion frameworks and transport errors can print tokens/URLs. Emit only
  // fixed check messages; discard raw exceptions and all child process output.
  console.error(`FAIL ${stage}: ${error instanceof CheckFailure ? error.message : 'operation failed; raw details suppressed to avoid credential logging'}`);
  process.exitCode = 1;
} finally {
  if (child?.pid) {
    const exited = once(child, 'exit').catch(() => {});
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    await Promise.race([exited, delay(2_000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No remaining child group. */ }
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
