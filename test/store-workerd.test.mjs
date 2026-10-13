import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

test('real workerd DO SQLite + local D1: schema, transactional rollback, isolate restart and alarm outbox recovery',async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'timds-workerd-store-'));
  const root = fileURLToPath(new URL('..',import.meta.url)), modules = {};
  for (const name of ['test/store-workerd-entry.mjs','src/store/catalog.mjs','src/store/sqlite.mjs','src/store/errors.mjs']) modules[name] = {type:'esm',contents:await readFile(path.join(root,name),'utf8')};
  // Native Miniflare 5 config, matching the cf beta14 resource model.
  const options = {host:'127.0.0.1',resourcePersistencePath:directory,logRequests:false,workers:[{config:{name:'timds-store-proof',
    compatibilityDate:'2026-10-12',compatibilityFlags:['nodejs_compat'],
    manifest:{mainModule:'test/store-workerd-entry.mjs',modulesRoot:root,modules},
    exports:{StoreProof:{type:'durable-object',storage:'sqlite'}},
    env:{PROOF:{type:'durable-object',worker:'timds-store-proof',exportName:'StoreProof'},CATALOG:{type:'d1',id:'fixture-catalog'}}}}]};
  let worker = new Miniflare(options);
  t.after(async () => {await worker.dispose();await rm(directory,{recursive:true,force:true});});
  const database = await worker.getD1Database('CATALOG');
  const migration = await readFile(new URL('../migrations/0001_catalog.sql',import.meta.url),'utf8');
  // D1 exec accepts one statement per line. Strip comments and send each complete
  // SQL statement on one line; the production migration file is unchanged.
  await database.exec(migration.replace(/--[^\n]*/g,'').split(';').map(statement => statement.trim().replace(/\s+/g,' ')).filter(Boolean).join(';\n'));
  const call = async route => {const response = await worker.dispatchFetch(`http://localhost/${route}`);const body = await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  assert.deepEqual(await call('initialize'),{status:'open',source:'local-proof',events:1});
  assert.deepEqual(await call('check'),{status:'open',unchanged:true,rolledBack:true,members:1,events:1});
  assert.deepEqual(await call('enqueue'),{pending:1});
  await worker.dispose(); worker = new Miniflare(options);
  assert.deepEqual(await call('recover'),{pending:0,events:2});
  const recovered = await worker.getD1Database('CATALOG');
  const audit = await recovered.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind='event'").first();
  assert.equal(audit.n,2);
  assert.deepEqual(await call('recover'),{pending:0,events:2});
  assert.equal((await recovered.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind='event'").first()).n,2);
});
