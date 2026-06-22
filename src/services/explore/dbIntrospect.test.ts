import { describe, it, expect } from 'vitest'
import { introspectTable } from './dbIntrospect.js'
import type { DbAdapter } from '../db/adapter.js'

function fakeDb(rows: Record<string, unknown>[]): DbAdapter & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    async query(sql: string, params: unknown[]) {
      calls.push([sql, params])
      return rows
    },
    async close() {},
  }
}

describe('introspectTable', () => {
  it('maps information_schema rows to ColumnDef (postgres, $1 placeholder)', async () => {
    const db = fakeDb([
      { column_name: 'email', data_type: 'varchar', is_nullable: 'NO', character_maximum_length: 255, numeric_precision: null },
      { column_name: 'age', data_type: 'integer', is_nullable: 'YES', character_maximum_length: null, numeric_precision: 32 },
    ])
    const cols = await introspectTable(db, 'postgres', 'users')
    expect(db.calls[0][0]).toContain('$1')
    expect(db.calls[0][1]).toEqual(['users'])
    expect(cols).toEqual([
      { name: 'email', dataType: 'varchar', nullable: false, maxLength: 255 },
      { name: 'age', dataType: 'integer', nullable: true, numericPrecision: 32 },
    ])
  })

  it('uses ? placeholder for mysql and reads UPPERCASE keys', async () => {
    const db = fakeDb([
      { COLUMN_NAME: 'name', DATA_TYPE: 'varchar', IS_NULLABLE: 'NO', CHARACTER_MAXIMUM_LENGTH: 100, NUMERIC_PRECISION: null },
    ])
    const cols = await introspectTable(db, 'mysql', 'hotels')
    expect(db.calls[0][0]).toContain('?')
    expect(cols[0]).toEqual({ name: 'name', dataType: 'varchar', nullable: false, maxLength: 100 })
  })

  it('returns [] and does not throw when the query fails', async () => {
    const db: DbAdapter = {
      async query() { throw new Error('boom') },
      async close() {},
    }
    expect(await introspectTable(db, 'postgres', 'x')).toEqual([])
  })

  it('scopes the query to the current schema', async () => {
    const db = fakeDb([])
    await introspectTable(db, 'postgres', 'users')
    expect(String(db.calls[0][0])).toContain('current_schema()')
    const db2 = fakeDb([])
    await introspectTable(db2, 'mysql', 'users')
    expect(String(db2.calls[0][0])).toContain('DATABASE()')
  })

  it('refuses a non-identifier table name', async () => {
    let called = false
    const db: DbAdapter = { async query() { called = true; return [] }, async close() {} }
    expect(await introspectTable(db, 'postgres', 'users; DROP TABLE users')).toEqual([])
    expect(called).toBe(false)
  })
})
