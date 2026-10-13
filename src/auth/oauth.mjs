import { OAuthProvider, OAuthError, getOAuthApi, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { Catalog } from '../store/catalog.mjs';
import { fail } from '../store/errors.mjs';
import { authenticateAccess, verifyBootstrapSecret } from './access.mjs';
import { principalActor } from './authorization.mjs';
import { escapeHtml, hostOrigin, jsonResponse, readJson } from '../http.mjs';

export const scopes = ['timds:read', 'timds:write', 'offline_access'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const securityHeaders = { 'Cache-Control':'no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
const consentKey = handle => `host-consent:${handle}`;
function consentPolicy(validatedRedirectUri) {
  const redirectOrigin = new URL(validatedRedirectUri).origin;
  // parseAuthRequest has checked the registered URI and allowed scheme. Keep
  // its origin literal: client metadata must not inject CSP syntax/wildcards.
  if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(redirectOrigin)) throw fail(400, 'Unsupported OAuth callback origin');
  // Chromium also applies form-action to the POST's redirect. The consent form
  // still posts to this host; permit only this request's validated callback,
  // including its exact loopback port, for the subsequent OAuth redirect.
  return `default-src 'none'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`;
}

export function createHostOAuth(env, { api, publicFetch, claimInvitations=async()=>{} }) {
  const origin = hostOrigin(env), resource = `${origin}/api/timds`;
  const options = {
    apiRoute: '/api/timds', authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register',
    scopesSupported: scopes, requiredScopes: ['timds:read'], clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 24 * 3600, clientRegistrationTTL: 30 * 24 * 3600,
    resourceMetadata: { resource, authorization_servers: [origin] },
    async tokenExchangeCallback(input) {
      const principal = await new Catalog(input.env.CATALOG).principal(input.props?.principalId);
      if (principal?.status !== 'active' || principal.id !== input.userId || input.resource !== resource) throw new OAuthError('invalid_grant', { description: 'This identity is unavailable' });
      return { newProps: { principalId: principal.id }, refreshTokenTTL: input.scope.includes('offline_access') ? 30 * 24 * 3600 : 0 };
    },
    apiHandler: {
      async fetch(request, bindings, context) {
        const required = new URL(request.url).pathname==='/api/timds/mcp' || ['GET','HEAD','OPTIONS'].includes(request.method) ? ['timds:read'] : ['timds:read','timds:write'];
        if (!context.auth || !required.every(scope => context.auth.scope.includes(scope))) return insufficientScope(context.auth, required);
        const principal = await new Catalog(bindings.CATALOG).principal(context.props?.principalId);
        if (principal?.status !== 'active' || principal.id !== context.auth.userId) throw fail(403, 'This TimDS identity is inactive');
        return api(request, bindings, context, { ...principalActor(principal), scopes:context.auth.scope, accessMode: required.length === 1 ? 'read' : 'write' });
      },
    },
    defaultHandler: {
      async fetch(request, bindings, context) {
        const url = new URL(request.url), catalog = new Catalog(bindings.CATALOG);
        if(url.pathname==='/service-auth'&&request.method==='GET') {
          const principal=await authenticateAccess(request,bindings,catalog);
          if(principal.type!=='agent')throw fail(403,'A host service identity is required');
          return jsonResponse({principalId:principal.id,assertion:request.headers.get('Cf-Access-Jwt-Assertion')});
        }
        if (url.pathname === '/bootstrap' && request.method === 'POST') {
          const principal = await authenticateAccess(request, bindings, catalog);
          if (principal.type !== 'user' || !verifyBootstrapSecret(request.headers.get('X-TimDS-Bootstrap-Secret'), bindings.TIMDS_BOOTSTRAP_SECRET)) throw fail(403, 'Bootstrap authentication failed');
          const input = await readJson(request, 4096);
          if (!uuid.test(input.operationId || '')) throw fail(400, 'A bootstrap operation UUID is required');
          const saved = await catalog.bootstrapAdmin(principalActor(principal), input.operationId);
          return jsonResponse({ principal: { id:saved.id, type:saved.type, name:saved.name, admin:saved.admin } });
        }
        if (url.pathname !== '/authorize') return publicFetch(request, bindings, context);
        const principal = await authenticateAccess(request, bindings, catalog);
        if (principal.type !== 'user') throw fail(403, 'Interactive consent requires a human identity');
        const helpers = getOAuthApi(options, bindings);
        if (request.method === 'GET') {
          const authRequest = await helpers.parseAuthRequest(request);
          if (authRequest.codeChallengeMethod !== 'S256' || !authRequest.codeChallenge || authRequest.resource !== resource || !authRequest.scope.includes('timds:read') || authRequest.scope.some(scope => !scopes.includes(scope))) throw fail(400, 'Use PKCE S256 and the TimDS resource and scopes');
          const policy = consentPolicy(authRequest.redirectUri);
          const description = await helpers.describeConsent(authRequest);
          const transaction = await helpers.beginConsent(authRequest);
          await bindings.OAUTH_KV.put(consentKey(transaction.handle), principal.id, { expirationTtl: 600 });
          const headers = new Headers(transaction.headers);
          for (const [key,value] of Object.entries(securityHeaders)) headers.set(key,value);
          headers.set('Content-Security-Policy',policy);
          // no-referrer makes a navigation POST's Origin null. Retain the
          // same-origin POST guard without sending a referrer to the callback.
          headers.set('Referrer-Policy','same-origin');
          headers.set('Content-Type','text/html; charset=utf-8');
          const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to TimDS</title><main><h1>Connect to TimDS</h1><p>Signed in as ${escapeHtml(principal.name)}</p><h2>${escapeHtml(description.clientName)}</h2><p>${description.clientDomain ? `Client domain: ${escapeHtml(description.clientDomain)}` : 'The client supplied this name.'}</p><p>Send authorization to <strong>${escapeHtml(description.redirectHost)}</strong></p><p>${escapeHtml(description.redirectUri)}</p>${description.redirectIsLoopback ? '<p>This opens a local app. Any local process could be listening at this address.</p>' : ''}<ul>${description.scope.map(scope => `<li>${escapeHtml(scope === 'timds:read' ? 'Read Design Systems you can access' : scope === 'timds:write' ? 'Edit and publish with your existing permissions' : 'Stay connected until you revoke access')}</li>`).join('')}</ul><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(transaction.handle)}"><button name="decision" value="approve">Connect</button> <button name="decision" value="deny">Cancel</button></form></main></html>`;
          return new Response(html, { headers });
        }
        if (request.method !== 'POST') return new Response(null, { status:405, headers:{ Allow:'GET, POST', ...securityHeaders } });
        if (request.headers.get('Origin') !== origin || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail(403, 'Consent must be submitted from this host');
        const reader = request.body?.getReader(); let formText = '', bytes = 0;
        if (!reader) throw fail(400, 'Consent is missing');
        try { while (true) { const { value,done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 8192) { await reader.cancel(); throw fail(413,'Consent is too large'); } formText += new TextDecoder().decode(value); } } finally { reader.releaseLock(); }
        const form = new URLSearchParams(formText), handle = form.get('handle');
        if (!handle || await bindings.OAUTH_KV.get(consentKey(handle)) !== principal.id) throw fail(403, 'Consent expired or belongs to another identity');
        if (form.get('decision') === 'deny') {
          const denied = await helpers.denyConsent(request, handle);
          await bindings.OAUTH_KV.delete(consentKey(handle));
          return new Response(null, { status:302, headers:denied.headers });
        }
        if (form.get('decision') !== 'approve') throw fail(400, 'Choose Connect or Cancel');
        const approved = await helpers.approveConsent(request, handle);
        await bindings.OAUTH_KV.delete(consentKey(handle));
        await claimInvitations(request,bindings,context);
        const { redirectTo } = await helpers.completeAuthorization({ request:approved.request, userId:principal.id, metadata:{ name:principal.name }, scope:approved.request.scope, props:{ principalId:principal.id } });
        const headers = new Headers(approved.headers); headers.set('Location',redirectTo); headers.set('Cache-Control','no-store');
        return new Response(null,{status:302,headers});
      },
    },
  };
  const provider = new OAuthProvider(options);
  return {
    async fetch(request, bindings, context) {
      if (new URL(request.url).origin !== origin) throw fail(421, 'Use the configured host origin');
      // A verified service Access JWT is an independent machine credential. A
      // header's presence alone, or a human Access cookie, never grants API scope.
      if (new URL(request.url).pathname.startsWith('/api/timds/') && request.headers.has('Cf-Access-Jwt-Assertion')) {
        const principal = await authenticateAccess(request, bindings, new Catalog(bindings.CATALOG));
        if (principal.type === 'agent') return api(request, bindings, context, { ...principalActor(principal), scopes:['timds:read','timds:write'], accessMode: ['GET','HEAD'].includes(request.method) ? 'read' : 'write' });
      }
      return provider.fetch(request, bindings, context);
    },
  };
}
