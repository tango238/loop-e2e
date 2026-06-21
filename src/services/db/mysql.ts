import { maskSecrets } from '../../util/mask.js'
import type { DbAdapter, Row } from './adapter.js'
import type { DbSchema } from '../../config/schema.js'

/** Minimal interface for a mysql2 Connection — injectable for unit tests */
export interface MysqlConnection {
  execute(sql: string, values: unknown[]): Promise<[Row[], unknown]>
  end(): Promise<void>
}

type MysqlConnectionCtor = (opts: {
  host: string
  port: number
  database: string
  user: string
  password: string
}) => MysqlConnection

/** Default mysql2 connection factory — real driver; only used in production */
function defaultMysqlCtor(opts: {
  host: string
  port: number
  database: string
  user: string
  password: string
}): MysqlConnection {
  // Dynamic import keeps mysql2 out of unit-test module graph when a fake is injected
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mysql = require('mysql2/promise') as {
    createConnection: (opts: unknown) => Promise<MysqlConnection>
  }
  // Return a sync-looking wrapper; actual connection deferred to query time
  let conn: MysqlConnection | null = null
  const connecting = mysql.createConnection(opts).then((c) => { conn = c })

  return {
    async execute(sql: string, values: unknown[]): Promise<[Row[], unknown]> {
      await connecting
      return conn!.execute(sql, values)
    },
    async end(): Promise<void> {
      await connecting
      await conn?.end()
    },
  }
}

/**
 * Creates a MySQL DbAdapter.
 * @param conn  - connection config (no password)
 * @param password - resolved at runtime from secrets
 * @param connCtor - injectable connection factory (tests pass a fake)
 */
export function createMysqlAdapter(
  conn: DbSchema,
  password: string,
  connCtor: MysqlConnectionCtor = defaultMysqlCtor,
): DbAdapter {
  const connection = connCtor({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password,
  })

  return {
    async query(sql: string, params: unknown[]): Promise<Row[]> {
      try {
        const [rows] = await connection.execute(sql, params)
        return rows
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(`MySQL query failed: ${maskSecrets(msg, [password])}`)
      }
    },
  }
}
