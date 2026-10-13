import { createHostProvider } from '@dtconcepts/timds/hosted';
import { createContractValidator } from './contract.mjs';

/** The pinned toolkit owns work operations. Only routes absent from its client use fetch. */
export function createConformanceClient({ url, token, fetchImpl = fetch, onResponse = () => {}, onCreatedSession = () => {}, onPublicationAttempt = () => {}, onAcceptedPublication = () => {}, timeoutMs = 120_000 }) {
  const origin = new URL(url).origin;
  const validate = createContractValidator();
  const transport = async (input, init = {}) => {
    if (new URL(input).origin !== origin) throw new Error('Refusing to send a host credential to another origin');
    const publish = /^\/api\/timds\/submissions\/([^/]+)\/publish$/.exec(new URL(input).pathname);
    if (init.method === 'POST' && publish) {
      let body;
      try { body = JSON.parse(init.body); } catch { /* Unknown requests may still be writes. */ }
      if (body?.dryRun !== true && body?.preflight !== true) await onPublicationAttempt(decodeURIComponent(publish[1]));
    }
    const response = await fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    // A successful create may still violate the response schema. Preserve its
    // minimal identity before validation so teardown can remove its resources.
    if (response.ok && init.method === 'POST' && /^\/api\/timds\/(?:sessions|design-systems\/[^/]+\/drafts)$/.test(new URL(input).pathname)) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.session) await onCreatedSession(payload.session);
    }
    if (response.ok && init.method === 'POST' && publish) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.publication) await onAcceptedPublication(payload.publication, decodeURIComponent(publish[1]));
    }
    const operationId = await validate(input, init, response);
    await onResponse({ operationId, status: response.status });
    return response;
  };
  const extension = async (method, path, body, publicRead = false) => {
    const response = await transport(`${origin}${path}`, { method, headers: publicRead ? {} : {
      Accept: 'application/json', 'Content-Type': 'application/json', 'X-TimDS-API-Version': '1', Authorization: `Bearer ${token}`,
    }, ...(body ? { body: JSON.stringify({ ...body, apiVersion: 1 }) } : {}) });
    if (publicRead) return response;
    const payload = await response.json();
    if (!response.ok) throw new Error(`Host extension returned HTTP ${response.status}`);
    return payload;
  };
  const sourcePath = id => `/api/timds/design-systems/${encodeURIComponent(id)}`;
  return {
    ...createHostProvider({ url: origin, token, fetchImpl: transport }),
    startRequest: (id, input) => extension('POST', `${sourcePath(id)}/requests`, input),
    requestStatus: (id, requestId) => extension('GET', `${sourcePath(id)}/requests/${encodeURIComponent(requestId)}`),
    submissions: id => extension('GET', `${sourcePath(id)}/submissions`),
    previewTokens: (id, ref, method = 'GET') => extension(method, `/api/public/design-system-previews/${encodeURIComponent(id)}/${encodeURIComponent(ref)}/tokens.css`, undefined, true),
  };
}
