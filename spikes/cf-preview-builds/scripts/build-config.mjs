import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const name = process.env.TIMDS_SPIKE_NAME;
assert.match(name || '', /^timds-host-preview-spike-[a-z0-9-]{1,20}$/);
assert.equal(process.env.TIMDS_SPIKE_ACK, name);
const identity = JSON.parse(await readFile(new URL('../.spike-state.json', import.meta.url), 'utf8'));
assert.equal(identity.namespace, name);
const scriptTag = process.env.TIMDS_SPIKE_WORKER_TAG, tokenUuid = process.env.TIMDS_SPIKE_BUILD_TOKEN_UUID;
assert.match(scriptTag || '', /^[a-f0-9]{32}$/);
assert.match(tokenUuid || '', /^[a-f0-9-]{36}$/);
const settings = { build_caching_enabled: false, build_command: 'npm run build', build_token_uuid: tokenUuid, root_directory: '/', path_includes: ['*'], path_excludes: [] };
const body = {
  script_tag: scriptTag,
  git_repository: { provider_type: 'cloudflare_artifacts', provider_account_id: name, provider_account_name: name, repo_id: identity.repoId, repo_name: identity.repoName, branch: 'main' },
  production_settings: { ...settings, deploy_command: 'npx cf deploy' },
  previews_base_config: { ...settings, deploy_command: 'npx cf previews deploy' },
  previews_enabled: true,
};
await writeFile(new URL('../.spike-build-config.json', import.meta.url), JSON.stringify(body, null, 2) + '\n');
console.log('Wrote .spike-build-config.json (resource identity only, no credential values).');
