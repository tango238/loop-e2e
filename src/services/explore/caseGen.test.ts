import { describe, it, expect } from 'vitest'
import { generateCases, buildBaseline, validValueFor } from './caseGen.js'
import type { FieldConstraint } from './types.js'
import type { Llm } from '../llm/client.js'

const required: FieldConstraint = { field: 'name', selector: '#name', required: true, type: 'string', maxLength: 10, table: 't', column: 'name', evidence: 'e' }
const num: FieldConstraint = { field: 'age', selector: '#age', required: false, type: 'integer', min: 0, max: 150, evidence: 'e' }
const email: FieldConstraint = { field: 'email', selector: '#email', required: true, type: 'email', evidence: 'e' }
const enumC: FieldConstraint = { field: 'role', selector: '#role', required: true, type: 'enum', enumValues: ['admin', 'user'], evidence: 'e' }

describe('validValueFor', () => {
  it('produces type-appropriate valid values', () => {
    expect(validValueFor(email)).toContain('@')
    expect(Number(validValueFor(num))).toBeGreaterThanOrEqual(0)
    expect(['admin', 'user']).toContain(validValueFor(enumC))
    expect(validValueFor(required).length).toBeLessThanOrEqual(10)
  })
})

describe('buildBaseline', () => {
  it('maps every selector to a valid value', () => {
    const b = buildBaseline([required, num, email])
    expect(Object.keys(b).sort()).toEqual(['#age', '#email', '#name'])
  })
})

describe('generateCases (rule-based)', () => {
  it('emits empty + over-length reject cases for a required maxLength field', async () => {
    const cases = await generateCases([required])
    const rejects = cases.filter((c) => c.expectation === 'reject')
    expect(rejects.some((c) => c.value === '')).toBe(true)
    expect(rejects.some((c) => c.value.length === 11)).toBe(true)
    expect(cases.some((c) => c.expectation === 'accept')).toBe(true)
    // table/column propagated
    expect(rejects[0].table).toBe('t')
    expect(rejects[0].column).toBe('name')
  })

  it('emits min-1 / max+1 and non-numeric reject cases for an integer field', async () => {
    const cases = await generateCases([num])
    const values = cases.filter((c) => c.expectation === 'reject').map((c) => c.value)
    expect(values).toContain('-1')
    expect(values).toContain('151')
    expect(values.some((v) => Number.isNaN(Number(v)))).toBe(true)
  })

  it('emits malformed-email and out-of-enum reject cases', async () => {
    const cases = await generateCases([email, enumC])
    const rejects = cases.filter((c) => c.expectation === 'reject').map((c) => c.value)
    expect(rejects).toContain('notanemail')
    expect(rejects.some((v) => v === '__not_in_enum__')).toBe(true)
  })

  it('works without an LLM (rule-only)', async () => {
    const cases = await generateCases([required])
    expect(cases.length).toBeGreaterThan(0)
  })
})

describe('generateCases (LLM add-on)', () => {
  it('appends LLM reject cases when llm is given', async () => {
    const llm: Llm = {
      // @ts-expect-error fake returns a value object
      complete: async () => ({ cases: [{ field: 'name', selector: '#name', value: '  trailing  ', rationale: 'whitespace' }] }),
    }
    const cases = await generateCases([required], llm)
    expect(cases.some((c) => c.value === '  trailing  ' && c.expectation === 'reject')).toBe(true)
  })

  it('swallows LLM failure and still returns rule cases', async () => {
    const llm: Llm = {
      complete: async () => { throw new Error('x') },
    }
    const cases = await generateCases([required], llm)
    expect(cases.length).toBeGreaterThan(0)
  })
})
