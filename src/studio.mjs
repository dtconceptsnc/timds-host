// Only these trusted application files can be served on the OAuth origin.
// Design System HTML and previews belong to their separate public origins.
const assets = new Map([
  ['/studio/', '/index.html'],
  ['/studio/app.js', '/app.js'],
  ['/studio/style.css', '/style.css'],
]);
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

export async function studioFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/' && url.pathname !== '/studio' && !assets.has(url.pathname)) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  if (url.pathname === '/' || url.pathname === '/studio') {
    url.pathname = '/studio/';
    return new Response(null, { status: 302, headers: { ...headers, Location: url.href } });
  }
  url.pathname = assets.get(url.pathname);
  url.search = '';
  const response = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  const securedHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) securedHeaders.set(name, value);
  // The live feed is a same-origin WebSocket; name its scheme explicitly.
  securedHeaders.set('Content-Security-Policy', headers['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`));
  return new Response(response.body, { status: response.status, headers: securedHeaders });
}
