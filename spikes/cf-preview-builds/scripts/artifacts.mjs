// Capture credential-bearing CLI responses in memory; never echo them.
import assert from 'node:assert/strict';
import { execFile as rawExec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(rawExec);
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = fileURLToPath(new URL('../node_modules/.bin/cf', import.meta.url));
const statePath = new URL('../.spike-state.json', import.meta.url);
const name = process.env.TIMDS_SPIKE_NAME;
assert.match(name || '', /^timds-host-preview-spike-[a-z0-9-]{1,20}$/);
assert.equal(process.env.TIMDS_SPIKE_ACK, name, 'Set TIMDS_SPIKE_ACK to the exact disposable name');

async function cf(args, json = true) {
  try {
    const { stdout } = await exec(binary, args, { cwd: root, env: process.env, maxBuffer: 2 ** 20 });
    return json ? JSON.parse(stdout) : undefined;
  } catch { throw new Error(`cf ${args.slice(0, 4).join(' ')} failed; response suppressed to protect credentials`); }
}
async function revoke(id) {
  for (let attempt = 0; ; attempt++) {
    try { await cf(['artifacts', 'namespaces', 'tokens', 'revoke', id, '--namespace', name, '--force'], false); return; }
    catch (error) { if (attempt === 4) throw error; await sleep(1_000); }
  }
}
async function state() {
  const value = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(value.namespace, name);
  assert.equal(value.repoName, 'static-site');
  const remote = new URL(value.remote);
  assert.equal(remote.protocol, 'https:');
  assert.equal(remote.hostname, `${process.env.CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net`);
  assert.equal(remote.pathname, `/git/${name}/static-site.git`);
  assert.ok(!remote.username && !remote.password);
  return value;
}

const action = process.argv[2];
if (action === 'create') {
  await cf(['artifacts', 'namespaces', 'create', '--namespace', name]);
  const repository = await cf(['artifacts', 'namespaces', 'repos', 'create', name, '--name', 'static-site', '--default-branch', 'main']);
  // repo-create includes a temporary write capability. Persist only these fields.
  try {
    await writeFile(statePath, JSON.stringify({ namespace: name, repoName: 'static-site', repoId: repository.id, remote: repository.remote }, null, 2) + '\n', { mode: 0o600 });
  } finally {
    // An identity-file IO failure must not leave the initial capability live.
    for (let attempt = 0; ; attempt++) {
      const tokens = await cf(['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', name, '--name', 'static-site', '--state', 'active']);
      if (tokens.length) { for (const token of tokens) await revoke(token.id); break; }
      if (attempt === 4) throw new Error('Initial repository capability was not yet discoverable; retry revocation before continuing');
      await sleep(1_000);
    }
  }
  console.log('Disposable namespace and repository created; initial capability revoked. Nonsecret identity is in .spike-state.json.');
} else if (action === 'push') {
  const identity = await state(), branch = process.argv[3];
  assert.ok(branch === 'main' || branch === 'review-cf-proof');
  const capability = await cf(['artifacts', 'namespaces', 'tokens', 'create', name, '--repo', identity.repoName, '--scope', 'write', '--ttl', '120']);
  try {
    assert.equal(typeof capability.plaintext, 'string');
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Bearer ${capability.plaintext}`, GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false' };
    try { await exec('git', ['push', identity.remote, `HEAD:${branch}`], { cwd: root, env, maxBuffer: 2 ** 20 }); }
    catch { throw new Error('Git push failed; output suppressed to protect the short-lived capability'); }
  } finally { await revoke(capability.id); }
  console.log(`Pushed ${branch}; short-lived capability revoked.`);
} else {
  throw new Error('Use: node scripts/artifacts.mjs create | push main | push review-cf-proof');
}
