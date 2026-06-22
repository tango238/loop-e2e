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

/**
 * Read column definitions for `table` from information_schema.columns.
 * Postgres uses `$1`; MySQL uses `?`. Never throws — returns [] on error.
 */
export async function introspectTable(
  db: DbAdapter,
  dbType: 'postgres' | 'mysql',
  table: string,
): Promise<ColumnDef[]> {
  const placeholder = dbType === 'postgres' ? '$1' : '?'
  const sql =
    `SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision ` +
    `FROM information_schema.columns WHERE table_name = ${placeholder}`
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
