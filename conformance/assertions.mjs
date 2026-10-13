import assert from 'node:assert/strict';

const datedVersion = value => {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d*)$/.exec(value);
  assert.ok(match, `publication version ${value} must use the toolkit's YYYY.MM.DD-N scheme`);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date, 'publication date is valid');
  return { date, sequence: Number(match[4]) };
};

export function assertConsecutiveVersions(first, second, { startedAt, finishedAt }) {
  const a = datedVersion(first), b = datedVersion(second);
  if (a.date === b.date) {
    assert.equal(b.sequence, a.sequence + 1, 'FIFO publication increments the dated release sequence exactly once');
  } else {
    assert.ok(b.date > a.date, 'publication date cannot regress');
    assert.ok(b.date > new Date(startedAt).toISOString().slice(0, 10) && b.date <= new Date(finishedAt).toISOString().slice(0, 10), 'date rollover must have occurred during this run');
    assert.equal(b.sequence, 1, 'the first release on a new UTC day has sequence 1');
  }
}

export async function readPublicStamp(url, { fetchImpl = fetch, systemId, version } = {}) {
  const target = new URL(url);
  assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'public artifact must use HTTPS or localhost');
  assert.ok(!target.username && !target.password, 'public artifact URL cannot embed credentials');
  const response = await fetchImpl(target, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, 'public publication stamp is readable anonymously');
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
  if (version !== undefined) assert.match(response.headers.get('cache-control') || '', /(?:^|,)\s*immutable\s*(?:,|$)/, 'pinned publication stamp is immutable');
  const stamp = await response.json();
  assert.equal(stamp.schemaVersion, 1); assert.equal(stamp.systemId, systemId);
  if (version !== undefined) assert.equal(stamp.version, version);
  assert.match(stamp.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(stamp.contentDigest, /^[a-f0-9]{64}$/);
  return stamp;
}

export async function readPreview(url, { fetchImpl = fetch } = {}) {
  const target = new URL(url);
  assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'submission Preview uses HTTPS or localhost');
  assert.ok(!target.username && !target.password, 'Preview URL cannot embed credentials');
  const response = await fetchImpl(target, { headers: { Accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const type = response.headers.get('content-type')?.split(';')[0];
  const text = await response.text();
  return { status: response.status, ready: response.status === 200 && type === 'text/html' && /<(?:!doctype|html)\b/i.test(text) && !text.includes('TimDS Preview is awaiting its first submission.') };
}
