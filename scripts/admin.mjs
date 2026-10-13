#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readCredentials } from '@dtconcepts/timds/auth';

const usage = `TimDS host administration
node scripts/admin.mjs <command> --host https://host.example [options]

Commands: me, bootstrap, organization, provision, agent, grant,
          publishers, principals, archive, restore
--credentials PATH  Existing TimDS CLI credential store (default CLI location)
--input PATH        JSON operation body for organization/provision/agent/grant
--source-id UUID    Source for grants, publisher/identity reads or archive/restore
--cursor UUID       Next page cursor from a publisher/identity read
--operation-id UUID Stable bootstrap/archive/restore operation ID, reused on retry
--secret-file PATH  Private bootstrap secret file, used only for bootstrap

Sign in with the OAuth-capable TimDS CLI first. This command never prints tokens.
Keep operation input and IDs unchanged when retrying an interrupted request.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    host: { type: 'string' }, credentials: { type: 'string' }, input: { type: 'string' },
    'source-id': { type: 'string' }, 'operation-id': { type: 'string' }, 'secret-file': { type: 'string' },
    cursor: { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(usage); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !['me','bootstrap','organization','provision','agent','grant','publishers','principals','archive','restore'].includes(command)) throw new Error('Choose a supported command; use --help');
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(['grant','publishers','principals','archive','restore'].includes(command)&&!uuid.test(values['source-id']||''))throw new Error('This command requires --source-id UUID');
  if(values.cursor&&(!['publishers','principals'].includes(command)||!uuid.test(values.cursor)))throw new Error('--cursor requires a publisher/identity read and a UUID');
  const origin = new URL(values.host);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1'].includes(origin.hostname))) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Use an exact HTTPS host origin');
  const credentials = await readCredentials({ credentialsPath: values.credentials });
  const saved = credentials.portals[origin.origin];
  if (!saved?.accessToken || saved.oauth?.expiresAt && Date.parse(saved.oauth.expiresAt) <= Date.now()) throw new Error('Sign in to this host with timds auth login before continuing');
  const headers = { Authorization: `Bearer ${saved.accessToken}`, 'X-TimDS-API-Version': '1', Accept: 'application/json' };
  let path = '/api/timds/me', input;
  if (command === 'bootstrap') {
    if (!values['operation-id'] || !values['secret-file']) throw new Error('Bootstrap requires --operation-id and --secret-file');
    headers['X-TimDS-Bootstrap-Secret'] = (await readFile(values['secret-file'], 'utf8')).trim();
    input = { apiVersion: 1, operationId: values['operation-id'] };
    path = '/api/timds/bootstrap';
  } else if (['publishers','principals'].includes(command)) {
    path=`/api/timds/admin/systems/${values['source-id']}/${command==='publishers'?'authority':'principals'}${values.cursor?`/${values.cursor}`:''}`;
  } else if (['archive','restore'].includes(command)) {
    if(!uuid.test(values['operation-id']||''))throw new Error('Archive/restore requires a stable --operation-id UUID');
    input={apiVersion:1,operationId:values['operation-id']};
    path=`/api/timds/admin/systems/${values['source-id']}/${command}`;
  } else if (command !== 'me') {
    if (!values.input) throw new Error('This command requires a saved --input JSON operation');
    input = JSON.parse(await readFile(values.input, 'utf8'));
    if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Operation input must be a JSON object');
    if (command === 'grant' && !/^[a-f0-9-]{36}$/i.test(values['source-id'] || '')) throw new Error('Grant requires --source-id');
    path = command === 'grant' ? `/api/timds/admin/systems/${values['source-id']}/authority` : `/api/timds/admin/${{ organization:'organizations', provision:'systems', agent:'agents' }[command]}`;
  }
  if (input) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(path, origin), { method: input ? 'POST' : 'GET', headers, body: input ? JSON.stringify(input) : undefined, redirect: 'error', signal: AbortSignal.timeout(command === 'provision' ? 15 * 60_000 : 60_000) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Host returned HTTP ${response.status}: ${typeof result?.error==='string'?result.error:result?.error?.message || 'operation unavailable'}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch(error => { process.stderr.write(`TimDS host: ${error.message}\n`); process.exitCode = 1; });
