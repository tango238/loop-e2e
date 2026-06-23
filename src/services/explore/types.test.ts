import { describe, it, expect } from 'vitest'
import {
  FieldConstraintSchema,
  FieldConstraintsSchema,
  CandidateTablesSchema,
  LlmCasesSchema,
  QualityFindingsSchema,
} from './types.js'

describe('explore types schemas', () => {
  it('accepts a minimal FieldConstraint', () => {
    const c = FieldConstraintSchema.parse({
      field: 'email',
      selector: '[name="email"]',
      required: true,
      type: 'email',
      evidence: 'DB column users.email NOT NULL',
    })
    expect(c.required).toBe(true)
    expect(c.type).toBe('email')
  })

  it('leniently coerces a malformed constraint to sensible defaults (no throw)', () => {
    // unknown type → 'unknown', missing required/evidence → defaults, string maxLength → dropped
    const c = FieldConstraintSchema.parse({ field: 'x', selector: '#x', type: 'banana', maxLength: 'lots' })
    expect(c.type).toBe('unknown')
    expect(c.required).toBe(false)
    expect(c.evidence).toBe('')
    expect(c.maxLength).toBeUndefined()
  })

  it('FieldConstraintsSchema normalizes any shape into { constraints: [...] }', () => {
    const item = { field: 'email', selector: '[name="email"]', required: true, type: 'email', evidence: 'e' }
    // bare array
    expect(FieldConstraintsSchema.parse([item]).constraints).toHaveLength(1)
    // wrapped under the right key
    expect(FieldConstraintsSchema.parse({ constraints: [item] }).constraints).toHaveLength(1)
    // wrapped under a different key (LLM used "fields")
    expect(FieldConstraintsSchema.parse({ fields: [item] }).constraints).toHaveLength(1)
    // object with no array (LLM gave up) → empty, not a throw
    expect(FieldConstraintsSchema.parse({}).constraints).toEqual([])
  })

  it('wraps constraints/tables/cases/findings', () => {
    expect(FieldConstraintsSchema.parse({ constraints: [] }).constraints).toEqual([])
    expect(CandidateTablesSchema.parse({ tables: ['users'] }).tables).toEqual(['users'])
    expect(
      LlmCasesSchema.parse({ cases: [{ field: 'a', selector: '#a', value: ' x ', rationale: 'space' }] })
        .cases.length,
    ).toBe(1)
    expect(
      QualityFindingsSchema.parse({ findings: [{ issue: 'bundled', evidence: 'one box', severity: 'medium' }] })
        .findings[0].severity,
    ).toBe('medium')
  })
})
