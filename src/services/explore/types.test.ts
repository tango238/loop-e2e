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

  it('rejects an unknown constraint type', () => {
    expect(() =>
      FieldConstraintSchema.parse({
        field: 'x',
        selector: '#x',
        required: false,
        type: 'banana',
        evidence: '',
      }),
    ).toThrow()
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
