import { logger } from '../../util/logger.js'
import type { DbAdapter } from '../db/adapter.js'

/**
 * True if a row exists in `table` where `column` equals `value`. Parameterized
 * ($1 for postgres, ? for mysql). Never throws — returns false on error.
 */
export async function wasValueSaved(
  db: DbAdapter,
  dbType: 'postgres' | 'mysql',
  table: string,
  column: string,
  value: string,
): Promise<boolean> {
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
