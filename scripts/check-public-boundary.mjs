#!/usr/bin/env node
// Public repository boundary check (see AGENTS.md). Flags lines that look like
// installation or customer records: non-example deployment hostnames, server
// paths, identifiers in documentation, and credential material.
//
//   node scripts/check-public-boundary.mjs          # lines added since the merge base with master
//   node scripts/check-public-boundary.mjs --all    # every tracked file (audit mode)
//   node scripts/check-public-boundary.mjs docs/ci.md README.md
//
// Read-only. Exit status 1 when anything is flagged. Patterns are deliberately
// broad: a hit means "look at this line", not "this is certainly private".
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
const skipped = file => /(^|\/)(package-lock\.json|node_modules\/|\.png$|\.jpg$|\.gif$|\.ico$|\.woff2?$|\.pdf$)/.test(file) || file === 'scripts/check-public-boundary.mjs';
const docs = file => /\.md$/.test(file) || file.startsWith('docs/');

// Synthetic hosts: reserved example names, placeholders such as <team> or
// YOUR-WORKER, wildcards, and the fixtures used by the unit tests.
const exampleHost = /(^|[.-])(example|test|localhost|<[^>]+>|\*)([.-]|$)|[A-Z]/;
const fixture = file => /^(test|conformance\/test)\//.test(file);
const rules = [
  { name: 'server path', pattern: /\/var\/www\/[^\s'"`)]+/g },
  { name: 'ssh target', pattern: /\b(?:[a-z0-9_-]+@)?ssh\.[a-z0-9.-]+\.[a-z]{2,}\b|\broot@[a-z0-9.-]+\b/gi },
  { name: 'deployment hostname', pattern: /\b([a-z0-9-]+)\.(workers\.dev|cloudflareaccess\.com|pages\.dev|r2\.dev)\b/gi, only: file => !fixture(file), accept: m => exampleHost.test(m[1]) },
  { name: 'private hostname', pattern: /\b[a-z0-9-]+\.(dtconcepts\.net)\b/gi },
  { name: 'identifier in documentation', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, only: docs, accept: m => /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(m[0]) },
  { name: 'commit hash in documentation', pattern: /\b[0-9a-f]{40}\b/g, only: docs, acceptLine: line => /github\.com\/[^/\s]+\/[^/\s]+\/(commit|pull|releases)\//.test(line) || /^\s*uses:\s/.test(line) },
  { name: 'credential material', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:CLOUDFLARE_API_TOKEN|TIMDS_BUILDS_API_TOKEN|OPENAI_API_KEY|TIMDS_BOOTSTRAP_SECRET|TIMDS_PORTAL_TRANSFER_SECRET|TIMDS_ACCESS_TOKEN|TIMDS_MEMBER_ACCESS_TOKEN)=['"]?[A-Za-z0-9_\-./+]{8,}/g },
];

function scanLine(file, line, text, hits) {
  for (const rule of rules) {
    if (rule.only && !rule.only(file)) continue;
    if (rule.acceptLine?.(text)) continue;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.accept?.(match)) continue;
      hits.push(`${file}:${line}: ${rule.name}: ${match[0]}`);
    }
  }
}

const args = process.argv.slice(2);
const hits = [];
let scanned = 0;
if (args.length && args[0] !== '--all') {
  for (const file of args.map(file => path.relative(root, path.resolve(file)))) {
    if (skipped(file)) continue;
    scanned++;
    readFileSync(path.join(root, file), 'utf8').split('\n').forEach((text, i) => scanLine(file, i + 1, text, hits));
  }
} else if (args[0] === '--all') {
  for (const file of git('ls-files').split('\n').filter(Boolean).filter(file => !skipped(file))) {
    let text; try { text = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    scanned++;
    text.split('\n').forEach((line, i) => scanLine(file, i + 1, line, hits));
  }
} else {
  // Only lines this branch adds are blamed; existing content is covered by --all.
  let base;
  for (const candidate of ['origin/master', 'master', 'origin/main', 'main']) {
    try { base = git('merge-base', candidate, 'HEAD').trim(); break; } catch { /* try the next branch name */ }
  }
  if (!base) { console.error('No master/main merge base found; pass --all or explicit paths.'); process.exit(2); }
  let file = null, line = 0;
  for (const raw of git('diff', '-U0', '--no-color', base, '--').split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, ''); if (file === '/dev/null') file = null; else scanned++; continue; }
    if (raw.startsWith('@@')) { line = Number(/\+(\d+)/.exec(raw)[1]); continue; }
    if (!file || skipped(file)) continue;
    if (raw.startsWith('+')) { scanLine(file, line, raw.slice(1), hits); line++; }
  }
  for (const file of git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).filter(file => !skipped(file))) {
    scanned++;
    readFileSync(path.join(root, file), 'utf8').split('\n').forEach((text, i) => scanLine(file, i + 1, text, hits));
  }
}

for (const hit of hits) console.error(hit);
console.log(`${scanned} file${scanned === 1 ? '' : 's'} scanned, ${hits.length} flagged line${hits.length === 1 ? '' : 's'}`);
process.exit(hits.length ? 1 : 0);
