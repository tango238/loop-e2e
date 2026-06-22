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

export const FieldConstraintSchema = z.object({
  field: z.string(),
  selector: z.string(),
  required: z.boolean(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'email', 'url', 'enum', 'unknown']),
  maxLength: z.number().int().optional(),
  minLength: z.number().int().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  format: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  table: z.string().optional(),
  column: z.string().optional(),
  evidence: z.string(),
})
export type FieldConstraint = z.infer<typeof FieldConstraintSchema>

export const FieldConstraintsSchema = z.object({ constraints: z.array(FieldConstraintSchema) })
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
