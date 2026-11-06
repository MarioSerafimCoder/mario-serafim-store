import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { operations } from '../worker/admin-operations.ts';

test('diagnóstico identifica migrations de carrinho e identidade comercial ausentes', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const binding = { prepare: sql => ({ first: async () => db.prepare(sql).get() ?? null }) };
  const directory = new URL('../migrations/', import.meta.url);
  const migrations = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations.slice(0, 4)) db.exec(readFileSync(new URL(name, directory), 'utf8'));
  assert.equal((await operations({}, binding)).schemaReady, false, 'carrinho ainda não migrado');
  db.exec(readFileSync(new URL(migrations[4], directory), 'utf8'));
  assert.equal((await operations({}, binding)).schemaReady, false, 'identidade ainda não migrada');
  db.exec(readFileSync(new URL(migrations[5], directory), 'utf8'));
  assert.equal((await operations({}, binding)).schemaReady, true);
});
