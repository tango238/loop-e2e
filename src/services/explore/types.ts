import { z } from 'zod'

// --- discovery ---
export type FormField = { name: string; selector: string; htmlType: string; label?: string }
export type DiscoveredForm = { screenPath: string; submitSelector: string; fields: FormField[] }

// --- db introspection ---
export type ColumnDef = {
  name: string
  dataType: string
  nullable: boolean
  maxLength?: number
  numericPrecision?: number
}

// --- constraint model ---
export type ConstraintType =
  | 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'email' | 'url' | 'enum' | 'unknown'

// Lenient: LLMs vary in which fields they include and their types. `.catch` turns a missing or
// wrong-typed field into a sensible default so one odd field never fails the whole constraint
// (and `modelConstraints` then reconciles selector/field against the real form, dropping junk).
export const FieldConstraintSchema = z.object({
  field: z.string().catch(''),
  selector: z.string().catch(''),
  required: z.boolean().catch(false),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'email', 'url', 'enum', 'unknown']).catch('unknown'),
  maxLength: z.number().int().optional().catch(undefined),
  minLength: z.number().int().optional().catch(undefined),
  min: z.number().optional().catch(undefined),
  max: z.number().optional().catch(undefined),
  format: z.string().optional().catch(undefined),
  enumValues: z.array(z.string()).optional().catch(undefined),
  table: z.string().optional().catch(undefined),
  column: z.string().optional().catch(undefined),
  evidence: z.string().catch(''),
})
export type FieldConstraint = z.infer<typeof FieldConstraintSchema>

/**
 * Normalize whatever the model returns into `{ constraints: [...] }` before validation:
 * a bare array, `{ constraints: [...] }`, `{ <any-key>: [...] }`, or an object with no array
 * (→ empty). Only genuinely unparseable JSON still fails (and is retried by the LLM client);
 * a valid-but-misshaped response degrades to the best-available constraint list instead of
 * burning all retries and skipping the form.
 */
export const FieldConstraintsSchema = z.preprocess((val) => {
  if (Array.isArray(val)) return { constraints: val }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>
    if (Array.isArray(obj.constraints)) return { constraints: obj.constraints }
    const firstArray = Object.values(obj).find((v) => Array.isArray(v))
    return { constraints: firstArray ?? [] }
  }
  return { constraints: [] }
}, z.object({ constraints: z.array(FieldConstraintSchema) }))
export const CandidateTablesSchema = z.object({ tables: z.array(z.string()) })

// --- case generation ---
export type InputCase = {
  field: string
  selector: string
  value: string
  expectation: 'reject' | 'accept'
  rationale: string
  table?: string
  column?: string
}
export type Baseline = Record<string, string>

export const LlmCasesSchema = z.object({
  cases: z.array(
    z.object({ field: z.string(), selector: z.string(), value: z.string(), rationale: z.string() }),
  ),
})

// --- execution / oracle ---
export type CaseOutcome = {
  errorsShown: string[]
  submitStatus?: number
  navigatedAway: boolean
  finalUrl: string
}
export type GapVerdict = { gap: boolean; confidence: 'high' | 'medium' }
export type QualityFinding = { screenPath: string; issue: string; evidence: string; severity: 'medium' | 'low' }

export const QualityFindingsSchema = z.object({
  findings: z.array(
    z.object({ issue: z.string(), evidence: z.string(), severity: z.enum(['medium', 'low']) }),
  ),
})
