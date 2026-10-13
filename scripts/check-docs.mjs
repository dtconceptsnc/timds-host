#!/usr/bin/env node
// Documentation reference check. Fails when a Markdown file links to a path or
// heading anchor that does not exist, or when a file under docs/ is missing
// from the docs/README.md index. Read-only; no network.
//
//   node scripts/check-docs.mjs            # every tracked or untracked *.md
//   node scripts/check-docs.mjs docs/ci.md # only the named files
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter(file => !file.split('/').includes('node_modules'));
const files = process.argv.length > 2 ? process.argv.slice(2).map(file => path.relative(root, path.resolve(file))) : listed;

// GitHub's heading slug: lower-case, strip punctuation other than hyphens and spaces, spaces to hyphens.
const slug = heading => heading.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const headings = new Map();
const anchorsOf = file => {
  if (!headings.has(file)) {
    const seen = new Map(), out = new Set();
    for (const [, text] of readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
      const base = slug(text), n = seen.get(base) ?? 0;
      seen.set(base, n + 1); out.add(n ? `${base}-${n}` : base);
    }
    headings.set(file, out);
  }
  return headings.get(file);
};

const problems = [];
for (const file of files) {
  const absolute = path.join(root, file);
  if (!existsSync(absolute)) { problems.push(`${file}: file not found`); continue; }
  const text = readFileSync(absolute, 'utf8');
  let fenced = false, line = 0;
  for (const raw of text.split('\n')) {
    line++;
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    if (fenced) continue;
    for (const [, target] of raw.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
      const [rawPath, fragment] = target.split('#');
      const resolved = rawPath ? path.resolve(path.dirname(absolute), decodeURIComponent(rawPath)) : absolute;
      if (!existsSync(resolved)) { problems.push(`${file}:${line}: missing target ${target}`); continue; }
      if (fragment && statSync(resolved).isFile() && resolved.endsWith('.md') && !anchorsOf(resolved).has(fragment.toLowerCase()))
        problems.push(`${file}:${line}: missing anchor ${target}`);
    }
  }
}

// Every document under docs/ must be reachable from the index agents read first.
const index = path.join(root, 'docs/README.md');
if (existsSync(index)) {
  const body = readFileSync(index, 'utf8');
  for (const file of listed.filter(f => f.startsWith('docs/') && f !== 'docs/README.md')) {
    const relative = path.relative('docs', file);
    if (!body.includes(`(${relative})`) && !body.includes(`(${relative}#`)) problems.push(`docs/README.md: ${file} is not listed in the documentation index`);
  }
}

for (const problem of problems) console.error(problem);
console.log(`${files.length} Markdown files checked, ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
process.exit(problems.length ? 1 : 0);
