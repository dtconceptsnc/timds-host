// Smoke: the D1 migrations apply in order to a fresh SQLite database and the
// catalog can resolve an identity and bootstrap the first administrator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../src/store/catalog.mjs';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrations = readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort();

// Minimal D1-shaped adapter over node:sqlite, enough for the catalog.
function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const prepare = query => {
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return db.prepare(query).get(...values) || null; },
      async all() { return { results: db.prepare(query).all(...values) }; },
      async run() { const result = db.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      execute() { return db.prepare(query).run(...values); },
    };
    return statement;
  };
  const api = {
    db, prepare, exec: query => db.exec(query), withSession() { return api; },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(statement => ({ success: true, meta: { changes: Number(statement.execute().changes) } })); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return api;
}

test('migrations apply in order to an empty database', () => {
  assert.ok(migrations.length > 0);
  const { db, exec } = sqliteD1();
  for (const name of migrations) exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of ['organizations', 'principals', 'installation_bootstrap']) assert.ok(tables.includes(table), table);
});

test('catalog resolves an identity and bootstraps a single administrator', async () => {
  const d1 = sqliteD1();
  for (const name of migrations) d1.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'));
  const catalog = new Catalog(d1, { clock: () => Date.parse('2026-10-13T00:00:00Z') });
  const identity = { issuer: 'https://issuer.example', subject: 'user:first', name: 'First Admin' };
  const first = await catalog.resolveIdentity(identity);
  assert.equal(first.type, 'user');
  assert.equal((await catalog.resolveIdentity(identity)).id, first.id, 'resolving the same identity is idempotent');
  const admin = await catalog.bootstrapAdmin({ principalId: first.id }, randomUUID());
  assert.equal(admin.admin, true);
  const second = await catalog.resolveIdentity({ ...identity, subject: 'user:second' });
  await assert.rejects(catalog.bootstrapAdmin({ principalId: second.id }, randomUUID()), { statusCode: 403 });
});
