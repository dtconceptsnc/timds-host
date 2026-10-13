// Smoke: every runtime module that does not depend on the Workers runtime
// loads under plain Node. Catches syntax errors, broken imports and bad
// top-level code without exercising any behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const modules = [];
(function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.mjs')) modules.push(path);
  }
})(join(root, 'src'));

const needsWorkersRuntime = path => /from\s+['"]cloudflare:/.test(readFileSync(path, 'utf8'));
const portable = modules.filter(path => !needsWorkersRuntime(path));

test('src contains modules to load', () => {
  assert.ok(modules.length > 0);
  assert.ok(portable.length > 0);
});

for (const path of portable) {
  test(`loads ${relative(root, path)}`, async t => {
    try {
      await import(path);
    } catch (error) {
      // A transitive `cloudflare:` import only exists inside the Workers runtime.
      if (error.code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME' && /cloudflare:/.test(error.message)) return t.skip('needs the Workers runtime');
      throw error;
    }
  });
}
