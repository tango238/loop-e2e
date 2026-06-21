import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import type { VerifyFinding } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'
import type { Config } from '../../config/schema.js'
import type { DbAdapter } from '../../services/db/index.js'
import { createDbAdapter, type DbDriverOptions } from '../../services/db/index.js'

/**
 * Validates that a SQL identifier (table name, column name) contains only
 * safe characters: letters, digits, and underscores, starting with a letter or underscore.
 * Rejects anything that could be used for SQL structural injection.
 */
export function isValidIdentifier(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)
}

export type RegisteredDataDeps = {
  scenarios: Scenario[]
  config: Config
  secrets: Record<string, string>
  /** Injectable DB driver options for unit tests (avoids real connections) */
  dbDrivers?: DbDriverOptions
}

/**
 * Resolves the DbAdapter for a named connection.
 * Returns null and logs a warning if connection config is missing.
 */
function resolveAdapter(
  connectionName: string,
  config: Config,
  secrets: Record<string, string>,
  drivers?: DbDriverOptions,
): DbAdapter | null {
  const dbConf = config.databases.find((d) => d.name === connectionName)
  if (!dbConf) {
    logger.warn({ connectionName }, 'registeredData verify: unknown connection name — skipping')
    return null
  }
  const password = secrets[dbConf.passwordEnv] ?? ''
  return createDbAdapter(dbConf, password, drivers)
}

/**
 * Checks whether the actual DB row matches all expectedValues.
 * Returns an array of field-level mismatches.
 */
function diffRow(
  expectedValues: Record<string, unknown>,
  row: Record<string, unknown>,
): { field: string; expected: unknown; actual: unknown }[] {
  return Object.entries(expectedValues)
    .filter(([field, expected]) => {
      const actual = row[field]
      // Loose equality to handle string/number conversions from DB
      // eslint-disable-next-line eqeqeq
      return actual != expected
    })
    .map(([field, expected]) => ({ field, expected, actual: row[field] }))
}

/**
 * Builds the WHERE clause and params array from `match` map.
 */
function buildWhereClause(
  match: Record<string, unknown>,
  dbType: 'postgres' | 'mysql',
): { sql: string; params: unknown[] } {
  const entries = Object.entries(match)
  const params: unknown[] = []
  const clauses = entries.map(([col, val], i) => {
    params.push(val)
    // postgres uses $1,$2,...; mysql uses ?
    return dbType === 'postgres' ? `${col} = $${i + 1}` : `${col} = ?`
  })
  return { sql: clauses.join(' AND '), params }
}

/**
 * Verifies DB state expectations from scenario.expectedDbState.
 * For each entry: queries the DB and compares actual row vs expectedValues.
 */
export async function verifyRegisteredData(deps: RegisteredDataDeps): Promise<VerifyFinding[]> {
  const { scenarios, config, secrets, dbDrivers } = deps
  const findings: VerifyFinding[] = []

  for (const scenario of scenarios) {
    for (const dbExpect of scenario.expectedDbState) {
      const { connection, table, match, expectedValues } = dbExpect

      const adapter = resolveAdapter(connection, config, secrets, dbDrivers)
      if (!adapter) {
        findings.push({
          category: 'registered-data',
          severity: 'medium',
          title: `DB connection "${connection}" not configured`,
          detail: `Scenario "${scenario.title}" references connection "${connection}" which is not in config.databases.`,
          evidence: `scenario:${scenario.id} connection:${connection}`,
        })
        continue
      }

      // Guard against SQL structural injection via table and column identifiers.
      if (!isValidIdentifier(table)) {
        throw new Error(
          `Invalid SQL identifier for table: "${table}" in scenario "${scenario.id}". Only [a-zA-Z_][a-zA-Z0-9_]* is allowed.`,
        )
      }
      const invalidCol = Object.keys(match).find((col) => !isValidIdentifier(col))
      if (invalidCol) {
        throw new Error(
          `Invalid SQL identifier for column: "${invalidCol}" in scenario "${scenario.id}". Only [a-zA-Z_][a-zA-Z0-9_]* is allowed.`,
        )
      }

      const dbConf = config.databases.find((d) => d.name === connection)!
      const { sql: whereClause, params } = buildWhereClause(match, dbConf.type)
      const sql = `SELECT * FROM ${table} WHERE ${whereClause} LIMIT 1`

      try {
        const rows = await adapter.query(sql, params)

        if (rows.length === 0) {
          findings.push({
            category: 'registered-data',
            severity: 'high',
            title: `Expected DB row not found in "${table}"`,
            detail: `Scenario "${scenario.title}": no row matched in ${connection}.${table} for the given conditions.`,
            evidence: `scenario:${scenario.id} table:${table} match:${JSON.stringify(match)}`,
          })
          continue
        }

        const mismatches = diffRow(
          expectedValues as Record<string, unknown>,
          rows[0] as Record<string, unknown>,
        )
        for (const { field, expected, actual } of mismatches) {
          findings.push({
            category: 'registered-data',
            severity: 'high',
            title: `DB field mismatch: ${table}.${field}`,
            detail: `Scenario "${scenario.title}": expected ${table}.${field}=${JSON.stringify(expected)} but got ${JSON.stringify(actual)}.`,
            evidence: `scenario:${scenario.id} table:${table} field:${field} expected:${JSON.stringify(expected)} actual:${JSON.stringify(actual)}`,
          })
        }
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message : String(error)
        const dbConf2 = config.databases.find((d) => d.name === connection)
        const password = (dbConf2 ? (secrets[dbConf2.passwordEnv] ?? '') : '')
        const msg = maskSecrets(rawMsg, [password])
        logger.warn({ error, scenario: scenario.id, table }, 'registeredData verify: query failed')
        findings.push({
          category: 'registered-data',
          severity: 'medium',
          title: `DB query error for "${table}"`,
          detail: `Scenario "${scenario.title}": query failed — ${msg}`,
          evidence: `scenario:${scenario.id} table:${table}`,
        })
      }
    }
  }

  return findings
}
