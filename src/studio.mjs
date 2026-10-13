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

// Live views and Previews are framed from an explicit allowlist only:
// TIMDS_STUDIO_FRAME_ORIGINS holds space-separated https origins or one-level
// wildcard patterns (https://*.example.workers.dev). Anything else is dropped;
// an empty or wholly invalid setting yields frame-src 'none'.
const frameToken = /^https:\/\/(\*\.)?[a-z0-9.-]+$/;
const sharedSuffixes = new Set(['workers.dev', 'pages.dev']);
let frameCache = { raw: null, value: "'none'" };
export function studioFrameSources(raw = '') {
  if (frameCache.raw === raw) return frameCache.value;
  const accepted = [];
  for (const token of String(raw).trim().split(/\s+/).filter(Boolean).slice(0, 20)) {
    if (!frameToken.test(token)) continue;
    const host = token.slice('https://'.length).replace(/^\*\./, '');
    if (host.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-')) || !host.includes('.')) continue;
    if (token.startsWith('https://*.') && sharedSuffixes.has(host)) continue;
    if (!accepted.includes(token)) accepted.push(token);
  }
  frameCache = { raw, value: accepted.length ? accepted.join(' ') : "'none'" };
  return frameCache.value;
}

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
  // Embedded live views and Previews may only come from the configured origins.
  securedHeaders.set('Content-Security-Policy', headers['Content-Security-Policy']
    .replace("connect-src 'self'", `connect-src 'self' ${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`)
    .replace("form-action 'self'", `frame-src ${studioFrameSources(env.TIMDS_STUDIO_FRAME_ORIGINS || '')}; form-action 'self'`));
  return new Response(response.body, { status: response.status, headers: securedHeaders });
}
