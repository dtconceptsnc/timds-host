import {
  getOAuthApi,
  insufficientScope,
  OAuthProvider,
  type OAuthProviderOptions,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';

const origin = 'http://127.0.0.1:8798';
const resource = `${origin}/api/timds`;
const scopes = ['timds:read', 'timds:write', 'offline_access'];
type Env = { OAUTH_KV: KVNamespace };
type FixtureProps = { principalId: 'fixture-user'; testOnly: true };

const options: OAuthProviderOptions<Env> = {
  apiRoute: '/api/timds',
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: scopes,
  requiredScopes: ['timds:read'],
  accessTokenTTL: 120,
  refreshTokenTTL: 600,
  clientRegistrationTTL: 600,
  resourceMetadata: { resource, authorization_servers: [origin] },
  apiHandler: {
    async fetch(request, _env, context) {
      const ctx = context as OAuthResourceContext<FixtureProps>;
      const required = request.method === 'POST' ? ['timds:read', 'timds:write'] : ['timds:read'];
      if (!required.every(scope => ctx.auth.scope.includes(scope))) return insufficientScope(ctx.auth, required);
      if (new URL(request.url).pathname !== '/api/timds/probe') return new Response('Not found', { status: 404 });
      // Never return ctx.auth itself: it also contains the bearer token.
      return Response.json({
        testOnly: ctx.props.testOnly,
        principalId: ctx.props.principalId,
        userId: ctx.auth.userId,
        clientId: ctx.auth.clientId,
        audience: ctx.auth.audience,
        scope: ctx.auth.scope,
      }, { headers: { 'Cache-Control': 'no-store' } });
    },
  },
  defaultHandler: {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/health') return Response.json({ testOnly: true, runtime: 'workerd' });
      if (url.pathname !== '/authorize' || request.method !== 'GET') return new Response('Not found', { status: 404 });
      const helpers = getOAuthApi(options, env);
      const authRequest = await helpers.parseAuthRequest(request);
      if (authRequest.codeChallengeMethod !== 'S256' || !authRequest.codeChallenge ||
          authRequest.resource !== resource || authRequest.scope.some(scope => !scopes.includes(scope))) {
        return new Response('Invalid fixture authorization request', { status: 400 });
      }
      // TEST ONLY: synthetic sign-in and consent. This proves wire interoperability,
      // not Access identity verification, browser consent, or host authorization.
      const { redirectTo } = await helpers.completeAuthorization({
        request: authRequest,
        userId: 'fixture-user',
        metadata: { testOnly: true },
        scope: authRequest.scope,
        props: { principalId: 'fixture-user', testOnly: true } satisfies FixtureProps,
      });
      return new Response(null, { status: 302, headers: { Location: redirectTo, 'Cache-Control': 'no-store' } });
    },
  },
};
const provider = new OAuthProvider<Env>(options);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).origin !== origin) return new Response('Local fixture only', { status: 403 });
    return provider.fetch(request, env, ctx);
  },
};
