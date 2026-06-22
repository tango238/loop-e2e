import { logger } from '../../util/logger.js'
import { CandidateTablesSchema, FieldConstraintsSchema } from './types.js'
import type { DiscoveredForm, ColumnDef, FieldConstraint } from './types.js'
import type { Llm } from '../llm/client.js'

function fieldList(form: DiscoveredForm): string {
  return form.fields
    .map((f) => `- field="${f.name}" selector="${f.selector}" htmlType="${f.htmlType}"${f.label ? ` label="${f.label}"` : ''}`)
    .join('\n')
}

/** Opus guesses candidate DB table names for a form from its path + fields. Never throws. */
export async function inferCandidateTables(form: DiscoveredForm, llm: Llm): Promise<string[]> {
  const prompt =
    `You are mapping a web form to database tables. Given the screen path and form fields, ` +
    `list the most likely database table name(s) that this form writes to (snake_case, plural where typical). ` +
    `Return at most 3.\n\nScreen: ${form.screenPath}\nFields:\n${fieldList(form)}`
  try {
    const out = await llm.complete('verification', prompt, CandidateTablesSchema)
    return out.tables
  } catch (err) {
    logger.warn({ err: String(err), screen: form.screenPath }, 'inferCandidateTables failed')
    return []
  }
}

function columnList(columns: ColumnDef[]): string {
  if (columns.length === 0) return '(no DB columns available)'
  return columns
    .map((c) => `- ${c.name} ${c.dataType} ${c.nullable ? 'NULL' : 'NOT NULL'}${c.maxLength ? ` maxlen=${c.maxLength}` : ''}`)
    .join('\n')
}

/**
 * Fuse HTML fields + DB columns + source validation rules into per-field constraints (Opus).
 * Reconciles each constraint's selector to a real form field (by selector, else by field name);
 * drops constraints that match no form field. Never throws — returns [] on error.
 */
export async function modelConstraints(
  form: DiscoveredForm,
  columns: ColumnDef[],
  sourceRules: string,
  llm: Llm,
): Promise<FieldConstraint[]> {
  const prompt =
    `You are deriving input-validation constraints for a web form. Names may differ across ` +
    `the HTML field, the DB column, and the source validation rule — reconcile them.\n\n` +
    `Screen: ${form.screenPath}\n\nHTML fields:\n${fieldList(form)}\n\n` +
    `DB columns:\n${columnList(columns)}\n\nSource validation rules:\n${sourceRules || '(none)'}\n\n` +
    `For each HTML field, output a constraint: required, type (string|number|integer|boolean|date|email|url|enum|unknown), ` +
    `maxLength/minLength/min/max/format/enumValues when known, the backing table/column when identifiable, ` +
    `and an "evidence" string citing the DB column or rule (never include secret values). ` +
    `Use the EXACT selector from the HTML fields list.`
  let parsed
  try {
    parsed = await llm.complete('verification', prompt, FieldConstraintsSchema)
  } catch (err) {
    logger.warn({ err: String(err), screen: form.screenPath }, 'modelConstraints failed')
    return []
  }

  const bySelector = new Map(form.fields.map((f) => [f.selector, f]))
  const byName = new Map(form.fields.map((f) => [f.name, f]))
  const reconciled: FieldConstraint[] = []
  for (const c of parsed.constraints) {
    const match = bySelector.get(c.selector) ?? byName.get(c.field)
    if (!match) continue // drop hallucinated fields
    reconciled.push({ ...c, selector: match.selector, field: match.name })
  }
  return reconciled
}
