import { describe, it, expect } from 'vitest'
import { wasValueSaved } from './dbProbe.js'
import type { DbAdapter } from '../db/adapter.js'

describe('wasValueSaved', () => {
  it('builds a parameterized query and returns true when a row exists (postgres)', async () => {
    const calls: unknown[][] = []
    const db: DbAdapter = {
      async query(sql, params) { calls.push([sql, params]); return [{ '?column?': 1 }] },
      async close() {},
    }
    const found = await wasValueSaved(db, 'postgres', 'users', 'email', 'x@y.com')
    expect(found).toBe(true)
    expect(String(calls[0][0])).toContain('$1')
    expect(calls[0][1]).toEqual(['x@y.com'])
  })

  it('uses ? for mysql and returns false on no rows', async () => {
    const db: DbAdapter = { async query() { return [] }, async close() {} }
    expect(await wasValueSaved(db, 'mysql', 't', 'c', 'v')).toBe(false)
  })

  it('returns false on query error', async () => {
    const db: DbAdapter = { async query() { throw new Error('x') }, async close() {} }
    expect(await wasValueSaved(db, 'postgres', 't', 'c', 'v')).toBe(false)
  })

  it('refuses to query when table/column is not a plain identifier', async () => {
    let called = false
    const db: DbAdapter = { async query() { called = true; return [{}] }, async close() {} }
    expect(await wasValueSaved(db, 'postgres', 'users; DROP TABLE users; --', 'c', 'v')).toBe(false)
    expect(await wasValueSaved(db, 'postgres', 'users', 'col = 1 OR 1=1', 'v')).toBe(false)
    expect(called).toBe(false)
  })
})
