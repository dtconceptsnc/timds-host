import { fail } from './store/errors.mjs';
import { safeRequestDiagnostic } from './requests/diagnostics.mjs';

export const apiHeaders = { 'X-TimDS-API-Version': '1', 'Cache-Control': 'no-store' };
export function jsonResponse(value, status = 200) { return Response.json({ apiVersion: 1, ...value }, { status, headers: apiHeaders }); }
export function errorResponse(error) {
  const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
  return jsonResponse({ error: status >= 500 ? 'The TimDS host could not complete this operation' : error.message,
    ...(safeRequestDiagnostic(error?.requestDiagnostic)?{diagnostic:safeRequestDiagnostic(error.requestDiagnostic)}:{}),
    ...(safeRequestDiagnostic(error?.cleanupDiagnostic)?{cleanupDiagnostic:safeRequestDiagnostic(error.cleanupDiagnostic)}:{}),
    ...(status<500&&Array.isArray(error?.conflicts)?{conflicts:error.conflicts,...(/^[a-f0-9]{40}$/.test(error.mainRevision||'')?{mainRevision:error.mainRevision}:{})}:{}) }, status);
}
export async function readJson(request, limit = 16 * 1024 * 1024) {
  if (!request.body) return {};
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fail(415, 'Use application/json');
  if (Number(request.headers.get('Content-Length')) > limit) throw fail(413, 'Request body is too large');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw fail(413, 'Request body is too large'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  if (!size) return {};
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail(400, 'Invalid JSON request'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'Expected a JSON object');
  return value;
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
export function hostOrigin(env) {
  let url; try { url = new URL(env.HOST_ORIGIN); } catch { throw fail(503, 'The host origin is not configured'); }
  const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw fail(503, 'The host origin is not configured');
  return url.origin;
}
export function assertApiVersion(request, input = {}) {
  if ((request.headers.has('X-TimDS-API-Version') && request.headers.get('X-TimDS-API-Version') !== '1') || (input.apiVersion !== undefined && input.apiVersion !== 1)) throw fail(400, 'Unsupported TimDS API version');
}
