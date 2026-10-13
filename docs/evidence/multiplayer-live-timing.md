# Multiplayer live timing: warm drafts and visible wake (template)

Status: **not yet run.** Fill this on the deployed host. Use one disposable
source and draft, the normal OAuth API and the Studio feed. Write no tests or
harnesses; observe the deployed behaviour only. Record raw values in the
[JSON receipt](multiplayer-live-timing.json); this page holds the summary.

- Host: `<https://studio.timds.com or the host under test>`
- Host commit: `<sha>`, deployed at `<ISO time>`
- Source / system: `<sourceId>` / `<systemId>`
- Draft (session) under test: `<sessionId>`
- Browsers: `<browser + version>` for tab A (viewer) and tab B (second viewer)

## Setup

```sh
export HOST=https://studio.timds.com SOURCE=<sourceId> SESSION=<sessionId>
export TOKEN=<OAuth bearer from `timds login`; never record it>
# Cursor before each step: the latest seq.
curl -s -H "Authorization: Bearer $TOKEN" "$HOST/api/timds/design-systems/$SOURCE/events?after=0&limit=1" | jq '.latestSeq // .events[-1].seq'
# Every live_state/updated row for the draft after a cursor, with commit timestamps.
events() { curl -s -H "Authorization: Bearer $TOKEN" "$HOST/api/timds/design-systems/$SOURCE/events?after=$1&limit=500" \
  | jq -c --arg s "$SESSION" '.events[] | select(.session_id==$s) | {seq,created_at,event_type,state:.details_json.state,requestId:.details_json.requestId}'; }
# Runner state as presence reports it (LiveSession.status(); never starts a container).
runner() { curl -s -H "Authorization: Bearer $TOKEN" "$HOST/api/timds/design-systems/$SOURCE/active-work" \
  | jq -c --arg s "$SESSION" '[.sessions[]?, .drafts[]?] | map(select(.id==$s)) | .[0] | {liveState, runner}'; }
```

For feed receipt times, the Studio feed client logs each frame with
`Date.now()` (Phase 4 client). Without it, paste the snippet below into the
console of a signed-in Studio tab. `ticket()` is the page's own
`POST .../feed/tickets` call and should come from the Studio feed client.

```js
const t = await ticket(); // {url}
const ws = new WebSocket(t.url);
ws.onmessage = m => { const f = JSON.parse(m.data); if (f.type === 'event') console.log('feed', f.seq, f.event.event_type, f.event.details_json?.state, f.event.created_at, new Date().toISOString()); };
```

## 1. Cold wake (reported, not gated)

1. Let the draft sleep: close every tab viewing it, then wait until `runner()`
   shows `runner.state: "sleeping"` and `events` shows `live_state: sleeping`.
2. Note the cursor `C1`. Send a Request to the draft (Studio composer or
   `POST /api/timds/design-systems/$SOURCE/requests` with `sessionId`). Record
   the client send time `T0`.
3. `events C1` should show `request_received`, `live_state: waking`,
   `live_state: starting`, `request_started`, `live_state: running`, then
   `live_state: ready`.

Record: `T0`, then `created_at` of `waking`, `starting` and `ready`.
- `waking - T0` is **gated at < 2 s** (Studio shows waking within two seconds).
- `ready - T0` is the cold wake time, reported only.

Repeat once with a viewer instead of a Request. Open the sleeping draft in tab A
and record `T0` at navigation. `events` should show `waking`, `starting`,
`ready` with no Request. Studio should reload the frame on `ready`.

## 2. Warm reload after a push (< 5 s, gated)

1. With the draft awake and its frame visible in tab A, note cursor `C2`.
2. Push a visible change to the draft (a token colour) with the toolkit
   (`timds session update` / submit), or have a Request finish.
3. `T_push` is the `created_at` of the `updated` row in `events C2`.
4. `T_visible` is when the frame shows the new value. Read it from a screen
   recording with an on-screen clock, or log it from the frame's own
   `/__timds_live/version` change, in tab A's console:

```js
let v; setInterval(async () => { const j = await (await fetch(frameUrl + '/__timds_live/version', {cache:'no-store'})).json(); if (v !== undefined && v !== j.version) console.log('frame version', j.version, new Date().toISOString()); v = j.version; }, 100);
```

Gate: `T_visible - T_push < 5 s` on 3 consecutive pushes. Record whether the
source declares `timds.json` `live.strategy: "hmr"` (in-place refresh) or uses a
restart. A restart also depends on that dev server's own start time.

## 3. Watched draft does not sleep across 30 idle minutes (gated)

1. Open the awake draft in tab A, which sends `viewing` and re-sends it every 5
   minutes. Then make the frame idle: switch tab A to the background, which
   stops the frame's version polling, or use a feed-only client that sends
   `{type:'viewing', sessionId}` every 5 minutes with no frame.
2. Send no Requests or pushes and keep no other tab on the draft. Note cursor
   `C3` and time `T3`.
3. At `T3 + 31 min`, `events C3` must have **no** `live_state: sleeping` for
   the draft, and `runner()` must not show `sleeping`.

## 4. Unwatched draft sleeps on schedule (gated)

1. From the awake state, close every tab and feed client for the draft (or
   send `{type:'viewing', viewing:null}`). Note cursor `C4` and time `T4`.
2. Within `T4 + 10 min + 1 min of alarm slack`, `events C4` must show
   `live_state: sleeping` and `runner()` must show `sleeping`.

Record `created_at(sleeping) - T4`. It should be at most the idle timeout
(10 minutes) after the last activity: the last frame poll or watch refresh.

## 5. Feed delivery latency (reported)

With tabs A and B both on the source, cause any committed row, such as a
`claimed` row or a push. For each row, latency is tab B's console receipt time
minus the row's `created_at`. The two clocks are the browser's and the
Worker's, so record the browser clock offset as well. Report the median and
maximum over at least 10 rows.

## Result

| Check | Gate | Value | Pass |
| --- | --- | --- | --- |
| Request → `waking` | < 2 s | | |
| Cold wake, Request → `ready` | reported | | n/a |
| Viewer open → `ready` | reported | | n/a |
| Push `updated` → frame visible | < 5 s | | |
| Watched draft, 31 idle min | no `sleeping` | | |
| Unwatched draft | `sleeping` ≤ 11 min | | |
| Feed delivery (median / max) | reported | | n/a |
