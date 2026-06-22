import { describe, it, expect } from 'vitest'
import { classifyGap, classifyErrorQuality } from './oracle.js'
import type { InputCase, CaseOutcome, DiscoveredForm } from './types.js'
import type { Llm } from '../llm/client.js'

const rejectCase: InputCase = { field: 'age', selector: '#age', value: '-1', expectation: 'reject', rationale: 'below min', table: 'users', column: 'age' }

describe('classifyGap', () => {
  it('high when no error, 2xx, and DB confirms the value was saved', async () => {
    const outcome: CaseOutcome = { errorsShown: [], submitStatus: 200, navigatedAway: true, finalUrl: '/u/1' }
    const v = await classifyGap(rejectCase, outcome, async () => true)
    expect(v).toEqual({ gap: true, confidence: 'high' })
  })

  it('medium when suspicious but no DB probe available', async () => {
    const outcome: CaseOutcome = { errorsShown: [], submitStatus: 200, navigatedAway: false, finalUrl: '/x' }
    const v = await classifyGap(rejectCase, outcome)
    expect(v).toEqual({ gap: true, confidence: 'medium' })
  })

  it('no gap when an error was shown', async () => {
    const outcome: CaseOutcome = { errorsShown: ['範囲外です'], submitStatus: 422, navigatedAway: false, finalUrl: '/x' }
    const v = await classifyGap(rejectCase, outcome, async () => true)
    expect(v.gap).toBe(false)
  })

  it('no gap (medium downgrade) when suspicious but DB probe disproves save', async () => {
    const outcome: CaseOutcome = { errorsShown: [], submitStatus: 200, navigatedAway: true, finalUrl: '/u/1' }
    const v = await classifyGap(rejectCase, outcome, async () => false)
    expect(v).toEqual({ gap: false, confidence: 'medium' })
  })
})

describe('classifyErrorQuality', () => {
  const form: DiscoveredForm = { screenPath: '/user/create', submitSelector: '#s', fields: [] }

  it('returns Opus quality findings', async () => {
    const llm: Llm = {
      // @ts-expect-error fake returns a value object
      complete: async () => ({ findings: [{ issue: 'all errors bundled into one banner', evidence: '入力に誤りがあります', severity: 'medium' }] }),
    }
    const out = await classifyErrorQuality(form, [{ errorsShown: ['入力に誤りがあります'], navigatedAway: false, finalUrl: '/x' }], llm)
    expect(out).toHaveLength(1)
    expect(out[0].screenPath).toBe('/user/create')
    expect(out[0].severity).toBe('medium')
  })

  it('returns [] on LLM error', async () => {
    const llm: Llm = {
      complete: async () => { throw new Error('x') },
    }
    expect(await classifyErrorQuality(form, [], llm)).toEqual([])
  })
})
