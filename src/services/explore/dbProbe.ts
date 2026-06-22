import { logger } from '../../util/logger.js'
import type { DbAdapter } from '../db/adapter.js'

/** SQL identifiers can't be parameterized; only allow plain identifiers (guards against LLM-hallucinated names). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * True if a row exists in `table` where `column` equals `value`. Parameterized
 * ($1 for postgres, ? for mysql). Never throws — returns false on error or a
 * non-identifier table/column (which can't be safely interpolated).
 */
export async function wasValueSaved(
  db: DbAdapter,
  dbType: 'postgres' | 'mysql',
  table: string,
  column: string,
  value: string,
): Promise<boolean> {
  if (!IDENT.test(table) || !IDENT.test(column)) {
    logger.warn({ table, column }, 'wasValueSaved: non-identifier table/column — refusing to query')
    return false
  }
  const placeholder = dbType === 'postgres' ? '$1' : '?'
  const sql = `SELECT 1 FROM ${table} WHERE ${column} = ${placeholder} LIMIT 1`
  try {
    const rows = await db.query(sql, [value])
    return rows.length > 0
  } catch (err) {
    logger.warn({ err: String(err), table, column }, 'wasValueSaved: query failed — treating as not saved')
    return false
  }
}
