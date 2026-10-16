import { OAuthProvider, OAuthError, getOAuthApi, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { Catalog } from '../store/catalog.mjs';
import { fail } from '../store/errors.mjs';
import { authenticateAccess, verifyBootstrapSecret } from './access.mjs';
import { principalActor } from './authorization.mjs';
import { escapeHtml, oauthOrigin, jsonResponse, readJson } from '../http.mjs';

export const scopes = ['timds:read', 'timds:write', 'offline_access'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const securityHeaders = { 'Cache-Control':'no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
const consentKey = handle => `host-consent:${handle}`;
function consentPolicy(validatedRedirectUri, nonce) {
  const redirectOrigin = new URL(validatedRedirectUri).origin;
  // parseAuthRequest has checked the registered URI and allowed scheme. Keep
  // its origin literal: client metadata must not inject CSP syntax/wildcards.
  if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(redirectOrigin)) throw fail(400, 'Unsupported OAuth callback origin');
  // Chromium also applies form-action to the POST's redirect. The consent form
  // still posts to this host; permit only this request's validated callback,
  // including its exact loopback port, for the subsequent OAuth redirect.
  return `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`;
}
const permissions = {
  'timds:read': ['Read Design Systems you can access', 'Sessions, submissions, releases and guidance that your existing grants already cover.'],
  'timds:write': ['Edit and publish with your existing permissions', 'Start and edit sessions and submit them for review. Publishing still needs a publisher grant you already hold.'],
  offline_access: ['Stay connected until you revoke access', 'The client renews its connection without asking you to sign in again.'],
};
// Studio's palette and type (studio/style.css), inlined because the consent
// page is served from the API origin under a default-src 'none' policy.
const consentStyle = `:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#252b23;background:#f4f3ed;font-size:15px;line-height:1.55;--ink:#252b23;--muted:#697061;--line:#dedfd4;--paper:#fffef9;--accent:#375638;--danger:#9c3a2e}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;justify-content:center}
.consent{width:min(560px,100%);padding:clamp(28px,7vw,72px) 20px 56px}
.wordmark{display:block;font-size:2rem;letter-spacing:-.09em;font-weight:780;line-height:1;margin-bottom:48px}.dot{color:#73934f}
.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-weight:650;font-size:.69rem;color:var(--muted);margin:0 0 12px}
h1{font-size:clamp(1.9rem,4vw,2.6rem);font-weight:500;letter-spacing:-.055em;line-height:1.16;margin:0 0 12px;overflow-wrap:anywhere}
.lede{color:var(--muted);margin:0 0 26px}.lede strong{color:var(--ink);font-weight:600}
.panel{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:14px}
h2{font-size:.74rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:650;margin:0 0 12px}
.permissions{list-style:none;margin:0;padding:0}.permissions li{display:flex;flex-direction:column;gap:2px;padding:10px 0;border-top:1px solid var(--line)}.permissions li:first-child{border-top:0;padding-top:0}.permissions li:last-child{padding-bottom:0}
.permissions strong{font-weight:600}.permissions span{font-size:.86rem;color:var(--muted)}
.host{font-size:1.1rem;font-weight:600;margin:0 0 4px;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--muted);margin:0;overflow-wrap:anywhere}
.note{font-size:.86rem;color:var(--muted);margin:14px 0 0;padding-top:12px;border-top:1px solid var(--line)}.note.warn{color:var(--danger)}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0 18px}
button{font:inherit;font-weight:600;min-height:44px;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:var(--paper);color:var(--ink);cursor:pointer}
button:hover{background:#eeeee4;border-color:#a9b09e}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover{background:#29452c}
:focus-visible{outline:3px solid #9eb285;outline-offset:3px}
.footer{font-size:.8rem;color:var(--muted);margin:0}`;
function consentPage({ principal, description, handle, nonce }) {
  const permission = scope => { const [title, detail] = permissions[scope] || [scope, '']; return `<li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></li>`; };
  const readOnly = !description.scope.includes('timds:write');
  const client = description.clientDomain ? `Verified client domain <strong>${escapeHtml(description.clientDomain)}</strong>.` : 'This client supplied its own name; TimDS has not verified it.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Connect to TimDS</title><style nonce="${nonce}">${consentStyle}</style></head><body><main class="consent">`
    + `<span class="wordmark">timds<span class="dot">.</span></span><p class="eyebrow">Connect a client</p><h1>${escapeHtml(description.clientName)}</h1>`
    + `<p class="lede">${client} You are signed in as <strong>${escapeHtml(principal.name)}</strong>.</p>`
    + `<section class="panel"><h2>It will be able to</h2><ul class="permissions">${description.scope.map(permission).join('')}</ul>${readOnly ? '<p class="note">This client asked for read access only. Editing tools stay hidden until it connects again and asks for write access.</p>' : ''}</section>`
    + `<section class="panel"><h2>Authorization is sent to</h2><p class="host">${escapeHtml(description.redirectHost)}</p><p class="mono">${escapeHtml(description.redirectUri)}</p>${description.redirectIsLoopback ? '<p class="note warn">This opens a local app. Any process on this computer could be listening at that address, whatever the client calls itself.</p>' : ''}</section>`
    + `<form method="post" action="/authorize" class="actions"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><button class="primary" name="decision" value="approve">Connect</button><button name="decision" value="deny">Cancel</button></form>`
    + `<p class="footer">Your existing Design System permissions apply. Connecting never grants more than you already hold.</p></main></body></html>`;
}

export function createHostOAuth(env, { api, publicFetch, claimInvitations=async()=>{}, requestOrigin }) {
  const origin = oauthOrigin(env, requestOrigin), resource = `${origin}/api/timds`;
  const options = {
    apiRoute: '/api/timds', authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register',
    // requiredScopes is what the MCP resource's 401 challenge and protected-resource
    // metadata name, and MCP clients request exactly that: a client offered only
    // timds:read could never reach the contribution tools. It is advertised, not
    // enforced; apiHandler below still admits a token that holds only timds:read.
    scopesSupported: scopes, requiredScopes: ['timds:read', 'timds:write'], clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 24 * 3600, clientRegistrationTTL: 30 * 24 * 3600,
    resourceMetadata: { resource, authorization_servers: [origin] },
    async tokenExchangeCallback(input) {
      const principal = await new Catalog(input.env.CATALOG).principal(input.props?.principalId);
      if (principal?.status !== 'active' || principal.id !== input.userId || input.resource !== resource) throw new OAuthError('invalid_grant', { description: 'This identity is unavailable' });
      return { newProps: { principalId: principal.id }, refreshTokenTTL: input.scope.includes('offline_access') ? 30 * 24 * 3600 : 0 };
    },
    apiHandler: {
      async fetch(request, bindings, context) {
        // A feed ticket only authorizes watching committed events, so a read-only token may request one.
        const pathname = new URL(request.url).pathname;
        const required = pathname==='/api/timds/mcp' || /^\/api\/timds\/design-systems\/[^/]+\/feed\/tickets$/.test(pathname) || ['GET','HEAD','OPTIONS'].includes(request.method) ? ['timds:read'] : ['timds:read','timds:write'];
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
          const nonce = crypto.randomUUID().replaceAll('-', '');
          const policy = consentPolicy(authRequest.redirectUri, nonce);
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
          const html = consentPage({ principal, description, handle: transaction.handle, nonce });
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
