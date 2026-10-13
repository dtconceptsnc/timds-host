import { createHash, randomBytes } from 'node:crypto';
import { fail, principalId } from '../store/errors.mjs';

// Live per-source feed over hibernatable WebSockets. The coordinator's SQLite
// `events` table stays the only source: replay pages committed rows by `seq`,
// and live delivery receives each row only after its transaction commits.
// Presence lives on socket attachments only and is never persisted.
const TICKET_TTL_MS = 60_000, REPLAY_PAGE = 500, REPLAY_PAGES = 10, MESSAGE_LIMIT = 4096;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ticketShape = /^[A-Za-z0-9_-]{43}$/;
export const FEED_CLOSE = { gone: 4410, reauthorize: 4401, replayContinues: 4100 };
const schema = `CREATE TABLE IF NOT EXISTS feed_tickets(ticket_hash TEXT PRIMARY KEY,principal_id TEXT NOT NULL,source_id TEXT NOT NULL,
 name TEXT NOT NULL,type TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS feed_tickets_expiry ON feed_tickets(expires_at);`;
const digest = value => createHash('sha256').update(value).digest('hex');
const cursor = value => { if (value === null || value === '') return 0; if (!/^\d{1,15}$/.test(value)) throw fail(400, 'after must be a non-negative event sequence'); return Number(value); };
const viewingOf = input => {
  if (input.viewing === null || (!Object.hasOwn(input,'sessionId') && !Object.hasOwn(input,'draftId') && !Object.hasOwn(input,'viewing'))) return null;
  const value = Object.hasOwn(input,'viewing') ? input.viewing : input;
  if (value && typeof value === 'object' && uuid.test(value.sessionId || '') && value.draftId === undefined) return { sessionId: value.sessionId.toLowerCase() };
  if (value && typeof value === 'object' && uuid.test(value.draftId || '') && value.sessionId === undefined) return { draftId: value.draftId.toLowerCase() };
  throw fail(400, 'viewing needs one sessionId or draftId UUID, or null');
};

/** ctx is the SystemCoordinator's DurableObjectState. authorize(actor,reference)
 * performs the `active-work` read check without entering the writer queue. */
export function createSourceFeed({ sourceId, ctx, store, catalog, authorize, clock = () => Date.now() }) {
  const sql = ctx.storage.sql;
  sql.exec(schema);
  const timestamp = (offset = 0) => new Date(clock()+offset).toISOString();
  const names = new Map(), replaying = new Map();
  let outgoing = [], draining = null;
  const attachment = ws => { try { return ws.deserializeAttachment() || null; } catch { return null; } };
  const sockets = (except = null) => ctx.getWebSockets().filter(ws => ws !== except && ws.readyState <= 1 && attachment(ws)?.sourceId === sourceId);
  const close = (ws,code,reason) => { try { ws.close(code,reason); } catch {} };
  const send = (ws,message) => { try { ws.send(typeof message === 'string' ? message : JSON.stringify(message)); return true; } catch { replaying.delete(ws); close(ws,1011,'Feed delivery failed'); return false; } };
  const closeAll = (code,reason,principal = null) => { for (const ws of principal ? ctx.getWebSockets(principal) : ctx.getWebSockets()) { replaying.delete(ws); close(ws,code,reason); } };
  // Same view as the events route: row plus resolved actor names, cached per object.
  const principalName = async id => {
    if (!id) return null;
    if (!names.has(id)) names.set(id, catalog.principal(id).then(row => row?.name || id, () => { names.delete(id); return id; }));
    return names.get(id);
  };
  const named = rows => Promise.all(rows.map(async row => { const name = await principalName(row.actor_principal_id); return { ...row, principal_name: name || row.actor_principal_id, actor_name: name || row.actor_principal_id }; }));
  // Every send advances the socket's cursor; rows at or below it are never resent.
  const deliver = (ws,events) => {
    const buffer = replaying.get(ws); if (buffer) { buffer.push(...events); return; }
    const state = attachment(ws); if (!state) return;
    let after = state.after;
    for (const event of [...events].sort((a,b) => a.seq-b.seq)) if (event.seq > after) { if (!send(ws,{ type: 'event', seq: event.seq, event })) return; after = event.seq; }
    if (after !== state.after) ws.serializeAttachment({ ...state, after });
  };
  async function drain() {
    try {
      while (outgoing.length) {
        const views = await named(outgoing.splice(0));
        if (store.deletionFence()) { closeAll(FEED_CLOSE.gone,'This Design System is deleting or deleted'); continue; }
        for (const ws of sockets()) deliver(ws,views);
      }
    } finally { draining = null; }
  }
  const viewers = (except = null) => {
    const seen = new Map();
    for (const ws of sockets(except)) {
      const state = attachment(ws), viewer = { principalId: state.principalId, name: state.name, type: state.type, viewing: state.viewing || null };
      seen.set(`${viewer.principalId}|${JSON.stringify(viewer.viewing)}`, viewer);
    }
    return [...seen.values()];
  };
  const presence = (except = null) => { const message = JSON.stringify({ type: 'presence', viewers: viewers(except) }); for (const ws of sockets(except)) send(ws,message); };
  const live = async () => {
    if (store.deletionFence()) return false;
    const source = await store.getSource(sourceId);
    return Boolean(source && !source.archived_at && source.lifecycle_status === 'ready');
  };
  const feed = {
    // Store hook: called once per committed audit row, outside its transaction.
    onEvent(row) { if (!Number.isSafeInteger(row?.seq) || !ctx.getWebSockets().length) return; outgoing.push(row); draining ??= drain(); },
    async ticket(actor,reference) {
      await authorize(actor,reference);
      const principal = await catalog.principal(principalId(actor));
      if (principal?.status !== 'active') throw fail(403, 'An active TimDS identity is required');
      const ticket = randomBytes(32).toString('base64url'), expiresAt = timestamp(TICKET_TTL_MS);
      ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM feed_tickets WHERE expires_at<=?', timestamp());
        sql.exec('INSERT INTO feed_tickets(ticket_hash,principal_id,source_id,name,type,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
          digest(ticket), principal.id, sourceId, String(principal.name || principal.id).slice(0,200), principal.type || 'user', expiresAt, timestamp());
      });
      return { ticket, expiresAt };
    },
    async accept(request) {
      const url = new URL(request.url);
      if (!/^\/api\/timds\/design-systems\/[^/]+\/feed$/.test(url.pathname)) throw fail(404, 'Route not found');
      if (request.method !== 'GET') throw fail(405, 'Use GET with Upgrade: websocket');
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') throw fail(426, 'Upgrade: websocket is required');
      const after = cursor(url.searchParams.get('after')), ticket = url.searchParams.get('ticket') || '';
      if (!ticketShape.test(ticket)) throw fail(400, 'A feed ticket is required');
      // Single use: the row is deleted by the same statement that reads it.
      const row = ctx.storage.transactionSync(() => sql.exec('DELETE FROM feed_tickets WHERE ticket_hash=? RETURNING principal_id,source_id,name,type,expires_at', digest(ticket)).toArray()[0]);
      if (!row || row.expires_at <= timestamp() || row.source_id !== sourceId) throw fail(401, 'The feed ticket is invalid, used or expired');
      if (!await live()) throw fail(410, 'This Design System is archived, deleting or deleted');
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      ctx.acceptWebSocket(server, [row.principal_id]);
      server.serializeAttachment({ principalId: row.principal_id, sourceId, after, name: row.name, type: row.type, viewing: null });
      replaying.set(server, []);
      let cursorAt = after, complete = false, latestSeq = after, failed = false;
      try {
        for (let page = 0; page < REPLAY_PAGES && replaying.has(server); page++) {
          const result = await store.eventsAfter(sourceId, cursorAt, REPLAY_PAGE);
          latestSeq = result.latestSeq;
          for (const event of result.events) { if (!send(server,{ type: 'event', seq: event.seq, event })) break; cursorAt = event.seq; }
          if (!result.hasMore) { complete = true; break; }
        }
      } catch { failed = true; } finally {
        // Rows broadcast while replay awaited were buffered; apply them past the
        // cursor only after a complete replay, so a continued replay has no gap.
        const buffered = replaying.get(server) || [];
        replaying.delete(server);
        if (server.readyState <= 1 && attachment(server)) {
          server.serializeAttachment({ ...attachment(server), after: cursorAt });
          if (complete && !failed) deliver(server, buffered);
        }
      }
      if (failed) close(server, 1011, 'Replay failed; reconnect with the last seq');
      else if (complete) { send(server,{ type: 'ready', after: attachment(server)?.after ?? cursorAt, latestSeq: Math.max(latestSeq, attachment(server)?.after ?? cursorAt) }); presence(); }
      else close(server, FEED_CLOSE.replayContinues, 'Reconnect with the last seq to continue replay');
      return new Response(null, { status: 101, webSocket: client });
    },
    async message(ws,message) {
      const state = attachment(ws);
      if (!state || state.sourceId !== sourceId) return close(ws,1008,'Unknown feed socket');
      if (!await live()) return close(ws,FEED_CLOSE.gone,'This Design System is archived, deleting or deleted');
      if (typeof message !== 'string' || message.length > MESSAGE_LIMIT) return close(ws,1009,'Feed messages are short JSON text');
      if (message === 'ping') return send(ws,'pong');
      let input; try { input = JSON.parse(message); } catch { return send(ws,{ type: 'error', message: 'Invalid JSON message' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(ws,{ type: 'error', message: 'Expected a JSON object' });
      if (input.type === 'ping') return;
      if (input.type === 'presence') return send(ws,{ type: 'presence', viewers: viewers() });
      if (input.type !== 'viewing') return send(ws,{ type: 'error', message: 'Unknown feed message type' });
      let viewing; try { viewing = viewingOf(input); } catch (error) { return send(ws,{ type: 'error', message: error.message }); }
      if (JSON.stringify(viewing) === JSON.stringify(state.viewing || null)) return;
      ws.serializeAttachment({ ...state, viewing });
      presence();
    },
    closed(ws) { replaying.delete(ws); close(ws,1000,'Closed'); presence(ws); },
    // Coordinator operations that end a socket's authorization.
    afterOperation(operation,args = []) {
      if (operation === 'archive') closeAll(FEED_CLOSE.gone,'This Design System is archived');
      else if (operation === 'authority' && uuid.test(args[0]?.command?.principalId || '')) closeAll(FEED_CLOSE.reauthorize,'Access changed; reconnect with a new ticket',args[0].command.principalId);
    },
    closePrincipal(id) { if (uuid.test(id || '')) closeAll(FEED_CLOSE.reauthorize,'This identity was deactivated',id); },
  };
  return feed;
}
