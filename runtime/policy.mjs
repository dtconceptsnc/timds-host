export const sessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateRun(input, {maxPromptBytes = 32 * 1024} = {}) {
  const remote = new URL(input?.remote || 'invalid:');
  if (remote.protocol !== 'https:' || !/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(remote.hostname) || remote.username || remote.password || remote.port || remote.search || remote.hash || !/^\/git\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\.git$/.test(remote.pathname)) throw new Error('Invalid fork remote');
  if (!/^[a-f0-9]{40}$/.test(input.baseRevision || '') || typeof input.repoToken !== 'string' || input.repoToken.length < 10 || input.repoToken.length > 4000) throw new Error('Invalid fork credential or revision');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || new TextEncoder().encode(input.prompt).length > maxPromptBytes) throw new Error('Request must be 1–32 KiB');
  return { remote:remote.href, baseRevision:input.baseRevision, repoToken:input.repoToken, prompt:input.prompt };
}
export function outboundCredential(request, { remote, repoToken }, openaiKey) {
  const url = new URL(request.url), repo = new URL(remote);
  if (url.protocol !== 'https:') return null;
  if (url.hostname === 'api.openai.com' && request.method === 'POST' && ['/v1/responses','/v1/responses/compact'].includes(url.pathname) && !url.search) return openaiKey;
  const gitRead = request.method === 'GET' && url.pathname === `${repo.pathname}/info/refs` && url.search === '?service=git-upload-pack'
    || request.method === 'POST' && url.pathname === `${repo.pathname}/git-upload-pack` && !url.search;
  // This runner returns a change set; even the scoped fork token cannot be used
  // to push through its outbound gateway. Other agent writers use fork tokens.
  return url.origin === repo.origin && gitRead ? repoToken : null;
}
export function agentPushEvent(input) {
  return input?.type === 'cf.artifacts.repo.pushed' && input?.source?.type === 'artifacts.repo'
    && /^[a-zA-Z0-9._-]+$/.test(input.source.namespace || '') && /^session-[a-f0-9-]+$/.test(input.source.repoName || '')
    && input?.payload?.ref === 'refs/heads/main' && /^[a-f0-9]{40}$/.test(input.payload.after || '') && !/^0+$/.test(input.payload.after);
}

// Queue receipts deliberately exclude commit messages, authors, headers and bodies.
export function agentPushReceipt(input, { receivedAt = new Date(), queuedAt } = {}) {
  if (!agentPushEvent(input)) return null;
  const sessionId = input.source.repoName.slice('session-'.length);
  if (!sessionIdPattern.test(sessionId)) return null;
  const iso = value => {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  };
  const receiptTime = iso(receivedAt);
  if (!receiptTime) return null;
  const eventTimestamp = iso(input.metadata?.eventTimestamp), queueEnqueuedAt = iso(queuedAt);
  return { stage:'fork-push', sessionId, headCommit:input.payload.after, receivedAt:receiptTime,
    ...(eventTimestamp ? { eventTimestamp } : {}), ...(queueEnqueuedAt ? { queueEnqueuedAt } : {}) };
}

// Never surface model text, stderr, provider bodies, prompts or headers.
export function safeTaskDiagnostics(value = {}) {
  const eventTypes = ['thread.started','turn.started','turn.completed','turn.failed','item.started','item.updated','item.completed','error'];
  return {
    ...(['codex','collect'].includes(value.stage) ? { stage:value.stage } : {}),
    eventTypes:eventTypes.filter(type => Array.isArray(value.eventTypes) && value.eventTypes.includes(type)),
    ...(Number.isInteger(value.exitCode) ? { exitCode:value.exitCode } : {}),
    ...(['SIGKILL','SIGTERM','SIGINT','SIGABRT','SIGSEGV'].includes(value.signal) ? { signal:value.signal } : {}),
    ...(['ENOENT','SPAWN_FAILED'].includes(value.spawnError) ? { spawnError:value.spawnError } : {}),
    ...(value.timedOut === true ? { timedOut:true } : {}),
  };
}
