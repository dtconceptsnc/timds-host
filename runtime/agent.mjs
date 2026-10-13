// Runs inside the isolated container. Provider and Artifacts credentials stay
// in the Worker; the repository receives neither credential.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { safeTaskDiagnostics } from './policy.mjs';

export async function runBoundedCommand(command, args, { cwd, timeoutMs = 10 * 60_000, onProgress = () => {} } = {}) {
  const diagnostics = { stage:'codex', eventTypes:[] };
  const progress = () => onProgress(safeTaskDiagnostics(diagnostics));
  progress();
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env:process.env, detached:true, stdio:['ignore','pipe','ignore'] });
    let pending = '', truncated = false;
    const line = value => {
      try { const event = JSON.parse(value), safe = safeTaskDiagnostics({ eventTypes:[event.type] }).eventTypes;
        if (safe.length && !diagnostics.eventTypes.includes(safe[0])) { diagnostics.eventTypes.push(safe[0]); progress(); }
      } catch {}
    };
    child.stdout.on('data', bytes => {
      for (const part of bytes.toString().split(/(?<=\n)/)) {
        if (!truncated) pending += part;
        if (pending.length > 64 * 1024) { pending = ''; truncated = true; }
        if (part.endsWith('\n')) { if (!truncated) line(pending); pending = ''; truncated = false; }
      }
    });
    child.on('error', error => { diagnostics.spawnError = error.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED'; });
    const timer = setTimeout(() => { diagnostics.timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (exitCode, signal) => { clearTimeout(timer); diagnostics.exitCode = exitCode; diagnostics.signal = signal; progress(); resolve(safeTaskDiagnostics(diagnostics)); });
  });
}

async function main() {
const [baseRevision, model, prompt] = process.argv.slice(2);
const git = args => execFileSync('git', args, { cwd:'/workspace/repo', maxBuffer:16 * 1024 * 1024 });
let result, diagnostics = { stage:'codex', eventTypes:[] };
const progress = value => { diagnostics = value; writeFileSync('/workspace/task/progress.tmp', JSON.stringify(value)); renameSync('/workspace/task/progress.tmp','/workspace/task/progress.json'); };
try {
  const run = await runBoundedCommand('codex', ['exec','--json','--ephemeral','--dangerously-bypass-approvals-and-sandbox',
    '--model',model,'--config','model_provider="timds-openai"',
    '--config','model_providers.timds-openai={name="TimDS OpenAI",base_url="https://api.openai.com/v1",wire_api="responses"}',
    '--config','analytics.enabled=false','--config','check_for_update_on_startup=false','--config','features.plugins=false',
    '--',`${prompt}\n\nEdit the files for this Request. The portal collects and submits your working-tree changes. Keep changes bounded to the request.`],
  { cwd:'/workspace/repo', onProgress:progress });
  if (run.exitCode !== 0 || run.spawnError || run.signal || run.timedOut) throw new Error('Codex task failed or exceeded ten minutes');
  progress({ ...diagnostics, stage:'collect' });
  git(['add','-A','--','.']);
  const entries = new Map(git(['ls-files','--stage','-z']).toString().split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('Unresolved repository entry');
    return [match[3], { mode:match[1], hash:match[2] }];
  }));
  const paths = git(['diff','--cached','--name-only','--no-renames','-z',baseRevision,'--']).toString().split('\0').filter(Boolean);
  if (paths.length > 4000) throw new Error('Too many changed files');
  const changedFiles = [], deletedPaths = []; let size = 0;
  for (const path of paths) {
    const entry = entries.get(path);
    if (!entry) { deletedPaths.push(path); continue; }
    if (!['100644','100755','120000'].includes(entry.mode)) throw new Error('Unsupported file mode');
    const content = git(['cat-file','blob',entry.hash]); size += content.length;
    if (size > 10 * 1024 * 1024) throw new Error('Changes exceed ten megabytes');
    changedFiles.push({ path, mode:entry.mode, encoding:'base64', content:content.toString('base64') });
  }
  result = { state:'succeeded', diagnostics, changeSet:{ baseRevision, changedFiles, deletedPaths } };
} catch { result = { state:'failed', diagnostics, error:'The designer task could not produce a valid bounded change set' }; }
writeFileSync('/workspace/task/result.tmp', JSON.stringify(result));
execFileSync('mv', ['/workspace/task/result.tmp','/workspace/task/result.json']);

}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
