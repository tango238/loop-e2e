import type { DbAdapter } from './adapter.js'
import type { DbConfig } from '../../config/schema.js'
import { createPostgresAdapter, type PgPool } from './postgres.js'
import { createMysqlAdapter, type MysqlConnection } from './mysql.js'

export type { DbAdapter, Row } from './adapter.js'

/** Injectable driver overrides — used in unit tests to avoid real connections */
export type DbDriverOptions = {
  pgPool?: (opts: {
    host: string; port: number; database: string; user: string; password: string
  }) => PgPool
  mysqlConn?: (opts: {
    host: string; port: number; database: string; user: string; password: string
  }) => MysqlConnection
}

/**
 * Selects the correct driver based on `conn.type` and returns a DbAdapter.
 * Passwords are never logged or included in error messages.
 *
 * @param conn    - connection config from Config.databases
 * @param password - resolved password (from secrets)
 * @param drivers - injectable driver factories (tests only)
 */
export function createDbAdapter(
  conn: DbConfig,
  password: string,
  drivers: DbDriverOptions = {},
): DbAdapter {
  switch (conn.type) {
    case 'postgres':
      return createPostgresAdapter(conn, password, drivers.pgPool)
    case 'mysql':
      return createMysqlAdapter(conn, password, drivers.mysqlConn)
    default: {
      const _exhaustive: never = conn.type
      throw new Error(`Unsupported database type: ${String(_exhaustive)}`)
    }
  }
}
