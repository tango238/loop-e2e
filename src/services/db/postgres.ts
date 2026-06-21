import { maskSecrets } from '../../util/mask.js'
import type { DbAdapter, Row } from './adapter.js'
import type { DbConfig } from '../../config/schema.js'

/** Minimal interface for a pg Pool — injectable for unit tests */
export interface PgPool {
  query(text: string, values: unknown[]): Promise<{ rows: Row[] }>
  end(): Promise<void>
}

type PgPoolCtor = (opts: {
  host: string
  port: number
  database: string
  user: string
  password: string
}) => PgPool

/** Default pg Pool factory — real driver; only used in production */
function defaultPgPoolCtor(opts: {
  host: string
  port: number
  database: string
  user: string
  password: string
}): PgPool {
  // Dynamic import keeps pg out of unit-test module graph when a fake is injected
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as { Pool: new (opts: unknown) => PgPool }
  return new Pool(opts)
}

/**
 * Creates a PostgreSQL DbAdapter.
 * @param conn  - connection config (no password)
 * @param password - resolved at runtime from secrets
 * @param poolCtor - injectable Pool factory (tests pass a fake)
 */
export function createPostgresAdapter(
  conn: DbConfig,
  password: string,
  poolCtor: PgPoolCtor = defaultPgPoolCtor,
): DbAdapter {
  const pool = poolCtor({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password,
  })

  return {
    async query(sql: string, params: unknown[]): Promise<Row[]> {
      try {
        const result = await pool.query(sql, params)
        return result.rows
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(`PostgreSQL query failed: ${maskSecrets(msg, [password])}`)
      }
    },
    async close(): Promise<void> {
      await pool.end()
    },
  }
}
