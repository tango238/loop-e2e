import { logger } from '../../util/logger.js'
import { LlmCasesSchema } from './types.js'
import type { FieldConstraint, InputCase, Baseline } from './types.js'
import type { Llm } from '../llm/client.js'

/** A deterministic valid value satisfying a constraint (used for baseline + accept cases). */
export function validValueFor(c: FieldConstraint): string {
  switch (c.type) {
    case 'email': return 'valid@example.com'
    case 'url': return 'https://example.com'
    case 'date': return '2024-01-01'
    case 'boolean': return 'true'
    case 'enum': return c.enumValues?.[0] ?? 'value'
    case 'number':
    case 'integer': {
      const lo = c.min ?? 1
      const hi = c.max ?? lo + 1
      const v = Math.min(Math.max(1, lo), hi)
      return String(v)
    }
    default: {
      const min = c.minLength ?? 1
      const max = c.maxLength ?? Math.max(min, 6)
      const len = Math.min(Math.max(min, 1), max)
      return 'a'.repeat(Math.max(1, len))
    }
  }
}

/** selector → valid value for every constraint. */
export function buildBaseline(constraints: FieldConstraint[]): Baseline {
  const baseline: Baseline = {}
  for (const c of constraints) baseline[c.selector] = validValueFor(c)
  return baseline
}

function reject(c: FieldConstraint, value: string, rationale: string): InputCase {
  const base: InputCase = { field: c.field, selector: c.selector, value, expectation: 'reject', rationale }
  if (c.table) base.table = c.table
  if (c.column) base.column = c.column
  return base
}

function ruleCases(c: FieldConstraint): InputCase[] {
  const cases: InputCase[] = []
  if (c.required) {
    cases.push(reject(c, '', 'required field left empty'))
    cases.push(reject(c, '   ', 'required field with whitespace only'))
  }
  if (c.maxLength !== undefined) {
    cases.push(reject(c, 'a'.repeat(c.maxLength + 1), `exceeds maxLength ${c.maxLength}`))
  }
  if (c.minLength !== undefined && c.minLength > 0) {
    cases.push(reject(c, 'a'.repeat(c.minLength - 1), `below minLength ${c.minLength}`))
  }
  if (c.type === 'number' || c.type === 'integer') {
    cases.push(reject(c, 'notanumber', 'non-numeric value for numeric field'))
    if (c.type === 'integer') cases.push(reject(c, '1.5', 'decimal for integer field'))
    if (c.min !== undefined) cases.push(reject(c, String(c.min - 1), `below min ${c.min}`))
    if (c.max !== undefined) cases.push(reject(c, String(c.max + 1), `above max ${c.max}`))
  }
  if (c.type === 'email') {
    for (const v of ['notanemail', 'a@', '@b.com']) cases.push(reject(c, v, 'malformed email'))
  }
  if (c.type === 'enum') {
    cases.push(reject(c, '__not_in_enum__', 'value outside allowed enum'))
  }
  // one accept baseline case per field
  const accept: InputCase = { field: c.field, selector: c.selector, value: validValueFor(c), expectation: 'accept', rationale: 'valid baseline value' }
  if (c.table) accept.table = c.table
  if (c.column) accept.column = c.column
  cases.push(accept)
  return cases
}

async function llmCases(constraints: FieldConstraint[], llm: Llm): Promise<InputCase[]> {
  const summary = constraints
    .map((c) => `- field="${c.field}" selector="${c.selector}" type=${c.type}${c.maxLength ? ` maxLength=${c.maxLength}` : ''}`)
    .join('\n')
  const prompt =
    `For the form fields below, propose values that LOOK valid but SHOULD be rejected ` +
    `(Unicode tricks, leading/trailing whitespace, semantically invalid but well-formed). ` +
    `One per field at most. Use the exact selector.\n\n${summary}`
  try {
    const out = await llm.complete('verification', prompt, LlmCasesSchema)
    const byField = new Map(constraints.map((c) => [c.field, c]))
    return out.cases.map((lc) => {
      const c = byField.get(lc.field)
      const ic: InputCase = { field: lc.field, selector: lc.selector, value: lc.value, expectation: 'reject', rationale: `LLM: ${lc.rationale}` }
      if (c?.table) ic.table = c.table
      if (c?.column) ic.column = c.column
      return ic
    })
  } catch (err) {
    logger.warn({ err: String(err) }, 'caseGen LLM add-on failed — using rule cases only')
    return []
  }
}

/**
 * Generate input cases: deterministic rule-based reject/boundary cases + one accept baseline
 * per field; optionally LLM "looks-valid-but-reject" cases when `llm` is supplied.
 */
export async function generateCases(constraints: FieldConstraint[], llm?: Llm): Promise<InputCase[]> {
  const rule = constraints.flatMap(ruleCases)
  if (!llm) return rule
  const extra = await llmCases(constraints, llm)
  return [...rule, ...extra]
}
