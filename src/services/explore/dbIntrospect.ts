import { logger } from '../../util/logger.js'
import type { DbAdapter } from '../db/adapter.js'
import type { ColumnDef } from './types.js'

/** Case-insensitive lookup over a DB row (information_schema casing differs by driver). */
function pick(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key]
  const lower = key.toLowerCase()
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lower) return row[k]
  }
  return undefined
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Only plain identifiers are accepted as table names (guards against LLM-hallucinated input). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Read column definitions for `table` from information_schema.columns, scoped to the
 * current schema/database so a same-named table in another schema can't bleed in.
 * Postgres uses `$1`; MySQL uses `?`. Never throws — returns [] on error or bad table name.
 */
export async function introspectTable(
  db: DbAdapter,
  dbType: 'postgres' | 'mysql',
  table: string,
): Promise<ColumnDef[]> {
  if (!IDENT.test(table)) {
    logger.warn({ table }, 'introspectTable: non-identifier table name — skipping')
    return []
  }
  const placeholder = dbType === 'postgres' ? '$1' : '?'
  const schemaScope = dbType === 'postgres' ? `AND table_schema = current_schema()` : `AND table_schema = DATABASE()`
  const sql =
    `SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision ` +
    `FROM information_schema.columns WHERE table_name = ${placeholder} ${schemaScope}`
  try {
    const rows = await db.query(sql, [table])
    return rows.map((row) => {
      const maxLength = toNumber(pick(row, 'character_maximum_length'))
      const numericPrecision = toNumber(pick(row, 'numeric_precision'))
      const col: ColumnDef = {
        name: String(pick(row, 'column_name') ?? ''),
        dataType: String(pick(row, 'data_type') ?? ''),
        nullable: String(pick(row, 'is_nullable') ?? '').toUpperCase() === 'YES',
      }
      if (maxLength !== undefined) col.maxLength = maxLength
      if (numericPrecision !== undefined) col.numericPrecision = numericPrecision
      return col
    })
  } catch (err) {
    logger.warn({ err: String(err), table }, 'introspectTable: query failed — returning []')
    return []
  }
}
