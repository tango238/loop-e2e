import { describe, it, expect } from 'vitest'
import { modelConstraints, inferCandidateTables } from './constraintModel.js'
import type { Llm } from '../llm/client.js'
import type { DiscoveredForm } from './types.js'

const form: DiscoveredForm = {
  screenPath: '/user/create',
  submitSelector: 'button[type="submit"]',
  fields: [
    { name: 'email', selector: '[name="email"]', htmlType: 'email' },
    { name: 'age', selector: '[name="age"]', htmlType: 'number' },
  ],
}

function llmReturning(obj: unknown): Llm {
  return {
    // @ts-expect-error overload narrowing in fake
    complete: async (_role: string, _prompt: string, _schema?: unknown) => obj,
  }
}

describe('modelConstraints', () => {
  it('returns constraints whose selectors are reconciled to form fields', async () => {
    const llm = llmReturning({
      constraints: [
        { field: 'email', selector: '[name="email"]', required: true, type: 'email', maxLength: 255, table: 'users', column: 'email', evidence: 'NOT NULL' },
        { field: 'age', selector: 'WRONG', required: false, type: 'integer', min: 0, max: 150, evidence: 'unsigned' },
        { field: 'ghost', selector: '#ghost', required: true, type: 'string', evidence: 'hallucinated' },
      ],
    })
    const out = await modelConstraints(form, [], 'rules text', llm)
    expect(out.map((c) => c.field).sort()).toEqual(['age', 'email'])
    // age selector reconciled from form field name
    expect(out.find((c) => c.field === 'age')?.selector).toBe('[name="age"]')
    // ghost dropped (no matching form field)
    expect(out.find((c) => c.field === 'ghost')).toBeUndefined()
  })

  it('returns [] on LLM error', async () => {
    const llm: Llm = {
      complete: async () => { throw new Error('llm down') },
    }
    expect(await modelConstraints(form, [], '', llm)).toEqual([])
  })
})

describe('inferCandidateTables', () => {
  it('returns the table list from the model', async () => {
    const llm = llmReturning({ tables: ['users', 'profiles'] })
    expect(await inferCandidateTables(form, llm)).toEqual(['users', 'profiles'])
  })

  it('returns [] on LLM error', async () => {
    const llm: Llm = {
      complete: async () => { throw new Error('x') },
    }
    expect(await inferCandidateTables(form, llm)).toEqual([])
  })
})
