import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../src/schema.ts'
import { NodeStore } from '../src/store-node.ts'

describe('schema migrations', () => {
  it('upgrades a version 1 database', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'vasta-migrate-')), 'v1.db')
    const db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE types (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, system TEXT, name TEXT NOT NULL, plural_name TEXT NOT NULL,
        description TEXT, icon TEXT, color TEXT, properties TEXT NOT NULL, views TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `)
    db.close()

    const store = new NodeStore(file)
    const columns = (store.db.prepare('PRAGMA table_info(types)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toContain('deleted_at')
    expect(store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) })
    store.close()
  })

  it('adds missing columns even when the recorded version is already current', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'vasta-migrate-')), 'stale.db')
    const db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '${SCHEMA_VERSION}');
      CREATE TABLE types (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, system TEXT, name TEXT NOT NULL, plural_name TEXT NOT NULL,
        description TEXT, icon TEXT, color TEXT, properties TEXT NOT NULL, views TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `)
    db.close()
    const store = new NodeStore(file)
    expect(store.listTypes('any')).toEqual([])
    store.close()
  })
})
