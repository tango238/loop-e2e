import { describe, it, expect, vi } from 'vitest'
import { verifyRegisteredData, isValidIdentifier } from './registeredData.js'
import type { Scenario } from '../../scenario/schema.js'
import type { Config } from '../../config/schema.js'
import type { PgPool } from '../../services/db/postgres.js'
import type { Row } from '../../services/db/adapter.js'

// --- fixtures ---

const pgDbConf = {
  name: 'main-pg',
  type: 'postgres' as const,
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testuser',
  passwordEnv: 'DB_PASSWORD',
}

const minimalConfig: Config = {
  repositories: [{ name: 'repo1', label: 'Repo 1', url: 'https://github.com/x/y', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'staging', baseUrl: 'http://localhost:3000' }],
  databases: [pgDbConf],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  baseline: { commit: false },
  models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
  ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
}

function makeScenario(expectedDbState: Scenario['expectedDbState']): Scenario {
  return {
    id: 'sc-1',
    title: 'User registration check',
    businessFlow: 'User registers and DB is updated',
    steps: [{ action: 'navigate', target: '/register', expectedOutcome: 'Form loads' }],
    expectedResults: [{ kind: 'db', description: 'User saved', assertion: 'User row exists' }],
    expectedDbState,
  }
}

function makeFakePgPool(rows: Row[]): PgPool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
    end: vi.fn().mockResolvedValue(undefined),
  }
}

function makeDbDrivers(pool: PgPool) {
  return { pgPool: () => pool }
}

describe('isValidIdentifier', () => {
  it('accepts plain table/column names', () => {
    expect(isValidIdentifier('users')).toBe(true)
    expect(isValidIdentifier('order_items')).toBe(true)
    expect(isValidIdentifier('_internal')).toBe(true)
    expect(isValidIdentifier('Col1')).toBe(true)
  })

  it('rejects SQL injection payloads', () => {
    expect(isValidIdentifier('users; DROP TABLE users--')).toBe(false)
    expect(isValidIdentifier('1_invalid')).toBe(false)
    expect(isValidIdentifier('col-name')).toBe(false)
    expect(isValidIdentifier('col name')).toBe(false)
    expect(isValidIdentifier('')).toBe(false)
  })
})

describe('verifyRegisteredData', () => {
  it('returns empty array when no scenarios', async () => {
    const result = await verifyRegisteredData({
      scenarios: [],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
    })
    expect(result).toEqual([])
  })

  it('returns empty array when scenario has no expectedDbState', async () => {
    const scenario = makeScenario([])
    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
    })
    expect(result).toEqual([])
  })

  it('returns finding when row not found', async () => {
    const pool = makeFakePgPool([]) // no rows returned
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'users',
      match: { email: 'alice@test.com' },
      expectedValues: { status: 'active' },
    }])

    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
      dbDrivers: makeDbDrivers(pool),
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      category: 'registered-data',
      severity: 'high',
      title: expect.stringContaining('not found'),
    })
  })

  it('returns finding for field mismatch', async () => {
    const pool = makeFakePgPool([{ email: 'alice@test.com', status: 'pending', role: 'user' }])
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'users',
      match: { email: 'alice@test.com' },
      expectedValues: { status: 'active' },
    }])

    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
      dbDrivers: makeDbDrivers(pool),
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      category: 'registered-data',
      severity: 'high',
      title: 'DB field mismatch: users.status',
    })
    expect(result[0].detail).toContain('"active"')
    expect(result[0].detail).toContain('"pending"')
  })

  it('returns no findings when row matches all expectedValues', async () => {
    const pool = makeFakePgPool([{ email: 'alice@test.com', status: 'active', role: 'admin' }])
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'users',
      match: { email: 'alice@test.com' },
      expectedValues: { status: 'active' },
    }])

    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
      dbDrivers: makeDbDrivers(pool),
    })

    expect(result).toEqual([])
  })

  it('returns finding for unknown connection', async () => {
    const scenario = makeScenario([{
      connection: 'nonexistent-db',
      table: 'users',
      match: { id: 1 },
      expectedValues: { name: 'Alice' },
    }])

    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: {},
    })

    expect(result).toHaveLength(1)
    expect(result[0].title).toContain('"nonexistent-db" not configured')
  })

  it('returns finding when query throws', async () => {
    const pool: PgPool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
      end: vi.fn(),
    }
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'orders',
      match: { id: 42 },
      expectedValues: { paid: true },
    }])

    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
      dbDrivers: makeDbDrivers(pool),
    })

    expect(result).toHaveLength(1)
    expect(result[0].category).toBe('registered-data')
    expect(result[0].severity).toBe('medium')
    expect(result[0].title).toContain('query error')
  })

  it('throws when table name is a SQL injection payload (never reaches adapter.query)', async () => {
    const pool = makeFakePgPool([])
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'users; DROP TABLE users--',
      match: { id: 1 },
      expectedValues: { name: 'Alice' },
    }])

    await expect(
      verifyRegisteredData({
        scenarios: [scenario],
        config: minimalConfig,
        secrets: { DB_PASSWORD: 'pw' },
        dbDrivers: makeDbDrivers(pool),
      }),
    ).rejects.toThrow(/Invalid SQL identifier for table/)

    // Critical: adapter.query must not be called when identifier is malformed
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('throws when a match column name is an invalid identifier', async () => {
    const pool = makeFakePgPool([])
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'users',
      match: { 'id; DROP TABLE users--': 1 },
      expectedValues: { name: 'Alice' },
    }])

    await expect(
      verifyRegisteredData({
        scenarios: [scenario],
        config: minimalConfig,
        secrets: { DB_PASSWORD: 'pw' },
        dbDrivers: makeDbDrivers(pool),
      }),
    ).rejects.toThrow(/Invalid SQL identifier for column/)

    expect(pool.query).not.toHaveBeenCalled()
  })

  it('masks password in query-error detail (maskSecrets)', async () => {
    const pool: PgPool = {
      query: vi.fn().mockRejectedValue(new Error('auth failed for secret_password_123')),
      end: vi.fn(),
    }
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'orders',
      match: { id: 42 },
      expectedValues: { paid: true },
    }])

    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'secret_password_123' },
      dbDrivers: makeDbDrivers(pool),
    })

    expect(result).toHaveLength(1)
    expect(result[0].detail).not.toContain('secret_password_123')
    expect(result[0].detail).toContain('***')
  })

  it('detects multiple field mismatches', async () => {
    const pool = makeFakePgPool([{ status: 'inactive', role: 'guest' }])
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'users',
      match: { id: 1 },
      expectedValues: { status: 'active', role: 'admin' },
    }])

    const result = await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
      dbDrivers: makeDbDrivers(pool),
    })

    expect(result).toHaveLength(2)
    const titles = result.map((f) => f.title)
    expect(titles).toContain('DB field mismatch: users.status')
    expect(titles).toContain('DB field mismatch: users.role')
  })

  it('closes each adapter after query, even on success', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const pool: PgPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ email: 'a@b.com', status: 'active' }] }),
      end: closeSpy,
    }
    const scenario = makeScenario([{
      connection: 'main-pg',
      table: 'users',
      match: { email: 'a@b.com' },
      expectedValues: { status: 'active' },
    }])

    await verifyRegisteredData({
      scenarios: [scenario],
      config: minimalConfig,
      secrets: { DB_PASSWORD: 'pw' },
      dbDrivers: { pgPool: () => pool },
    })

    // adapter.close() → pool.end() must have been called
    expect(closeSpy).toHaveBeenCalledOnce()
  })
})
