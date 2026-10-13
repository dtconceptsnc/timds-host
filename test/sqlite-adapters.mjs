import { DatabaseSync } from 'node:sqlite';

// Test adapters execute the same SQL against real SQLite databases. They are
// not in-memory object stores, and never substitute for workerd acceptance.
export function sqliteStorage(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON');
  let depth = 0, alarm = null;
  return {
    sql: { exec(query,...bindings) {
      if (query.trim().startsWith('CREATE TABLE')) { db.exec(query); return {toArray:() => []}; }
      const result = db.prepare(query).all(...bindings);
      return {toArray:() => result};
    } },
    transactionSync(task) {
      const key = `tx${depth++}`; db.exec(`SAVEPOINT ${key}`);
      try { const value = task(); db.exec(`RELEASE ${key}`); return value; }
      catch (error) { db.exec(`ROLLBACK TO ${key}; RELEASE ${key}`); throw error; }
      finally { depth--; }
    },
    async setAlarm(value) { alarm = value; },
    async getAlarm() { return alarm; },
    close() { db.close(); },
  };
}

export function sqliteD1(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON');
  const prepare = query => {
    let values = [];
    const statement = { bind(...args) { values = args; return statement; },
      async first() { return db.prepare(query).get(...values) || null; },
      async all() { return {results:db.prepare(query).all(...values)}; },
      async run() { const result = db.prepare(query).run(...values); return {success:true,meta:{changes:Number(result.changes)}}; },
      execute() { return db.prepare(query).run(...values); },
    }; return statement;
  };
  const api = { prepare, exec:query => db.exec(query), withSession() { return api; },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(statement => ({success:true,meta:{changes:Number(statement.execute().changes)}})); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
  return api;
}
