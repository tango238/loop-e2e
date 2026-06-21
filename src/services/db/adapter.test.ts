import { describe, it, expect, vi } from 'vitest'
import { createDbAdapter } from './index.js'
import type { DbSchema } from '../../config/schema.js'
import type { PgPool } from './postgres.js'
import type { MysqlConnection } from './mysql.js'
import type { Row } from './adapter.js'

const pgConn: DbSchema = {
  name: 'pg-test',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testuser',
  passwordEnv: 'DB_PASS',
}

const mysqlConn: DbSchema = {
  name: 'mysql-test',
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  database: 'testdb',
  user: 'testuser',
  passwordEnv: 'DB_PASS',
}

function makeFakePgPool(rows: Row[]): PgPool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
    end: vi.fn().mockResolvedValue(undefined),
  }
}

function makeFakeMysqlConn(rows: Row[]): MysqlConnection {
  return {
    execute: vi.fn().mockResolvedValue([rows, undefined]),
    end: vi.fn().mockResolvedValue(undefined),
  }
}

describe('createDbAdapter (postgres)', () => {
  it('routes to postgres driver and returns rows', async () => {
    const fakeRows: Row[] = [{ id: 1, name: 'Alice' }]
    const pool = makeFakePgPool(fakeRows)
    const adapter = createDbAdapter(pgConn, 'secret', { pgPool: () => pool })

    const result = await adapter.query('SELECT * FROM users WHERE id = $1', [1])
    expect(result).toEqual(fakeRows)
    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1])
  })

  it('wraps postgres errors without leaking password', async () => {
    const pool: PgPool = {
      query: vi.fn().mockRejectedValue(new Error('auth failed: password=s3cr3t')),
      end: vi.fn(),
    }
    const adapter = createDbAdapter(pgConn, 's3cr3t', { pgPool: () => pool })

    await expect(adapter.query('SELECT 1', [])).rejects.toThrow('PostgreSQL query failed')
    await expect(adapter.query('SELECT 1', [])).rejects.not.toThrow('s3cr3t')
  })

  it('passes empty params array correctly', async () => {
    const pool = makeFakePgPool([])
    const adapter = createDbAdapter(pgConn, 'secret', { pgPool: () => pool })
    await adapter.query('SELECT 1', [])
    expect(pool.query).toHaveBeenCalledWith('SELECT 1', [])
  })
})

describe('createDbAdapter (mysql)', () => {
  it('routes to mysql driver and returns rows', async () => {
    const fakeRows: Row[] = [{ id: 2, name: 'Bob' }]
    const conn = makeFakeMysqlConn(fakeRows)
    const adapter = createDbAdapter(mysqlConn, 'secret', { mysqlConn: () => conn })

    const result = await adapter.query('SELECT * FROM users WHERE id = ?', [2])
    expect(result).toEqual(fakeRows)
    expect(conn.execute).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?', [2])
  })

  it('wraps mysql errors without leaking password', async () => {
    const conn: MysqlConnection = {
      execute: vi.fn().mockRejectedValue(new Error('Access denied for user; password=mypass')),
      end: vi.fn(),
    }
    const adapter = createDbAdapter(mysqlConn, 'mypass', { mysqlConn: () => conn })

    await expect(adapter.query('SELECT 1', [])).rejects.toThrow('MySQL query failed')
    await expect(adapter.query('SELECT 1', [])).rejects.not.toThrow('mypass')
  })
})

describe('createDbAdapter driver selection', () => {
  it('throws for unknown type', () => {
    const badConn = { ...pgConn, type: 'sqlite' as never }
    expect(() => createDbAdapter(badConn, 'pw')).toThrow('Unsupported database type')
  })
})
