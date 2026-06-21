/** Row type: a record returned by a DB query */
export type Row = Record<string, unknown>

/**
 * Minimal DB abstraction used by the verify pipeline.
 * Implementations must not leak passwords in thrown errors.
 */
export interface DbAdapter {
  query(sql: string, params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}
