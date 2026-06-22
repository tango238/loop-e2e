import { describe, it, expect, vi } from 'vitest'
import { proposeScenarios } from './proposeScenarios.js'
import type { Llm } from './client.js'
import type { RawPage, PageInfo } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

const rawPage = (url: string): RawPage => ({ url, title: 't', html: '', meta: {}, screenshotPath: '' })

const pageInfo = (url: string): PageInfo => ({
  url, title: 'Hotel list', description: 'list of hotels',
  displayItems: [{ type: 'table', label: 'hotels' }],
  inputItems: [], expectations: ['shows hotels'], capabilities: ['view hotels'],
})

const validScenario = (id: string): Scenario => ({
  id,
  title: 'Hotel list view',
  businessFlow: 'Logged-in admin views the hotel list',
  steps: [
    { action: 'navigate', target: '/hotel', expectedOutcome: 'hotel list shown' },
    { action: 'assert', target: 'table', expectedOutcome: 'rows visible' },
  ],
  expectedResults: [{ kind: 'ui', description: 'list shown', assertion: 'table has rows' }],
  expectedDbState: [],
})

function makeLlm(returned: Scenario[]): Llm {
  return { complete: vi.fn(async () => returned) } as unknown as Llm
}

describe('proposeScenarios', () => {
  it('extracts page info per uncovered page and returns proposed scenarios', async () => {
    const extractPageInfo = vi.fn(async (_llm: Llm, raw: RawPage) => pageInfo(raw.url))
    const llm = makeLlm([validScenario('hotel-list')])
    const result = await proposeScenarios(llm, [rawPage('http://x/hotel'), rawPage('http://x/booking')], { extractPageInfo })
    expect(extractPageInfo).toHaveBeenCalledTimes(2)
    expect(result.length).toBe(1)
  })

  it('normalizes ids to be grow-prefixed', async () => {
    const extractPageInfo = vi.fn(async (_llm: Llm, raw: RawPage) => pageInfo(raw.url))
    const llm = makeLlm([validScenario('hotel-list')])
    const result = await proposeScenarios(llm, [rawPage('http://x/hotel')], { extractPageInfo })
    expect(result[0].id).toMatch(/^grow-/)
  })

  it('keeps an already grow-prefixed id and dedups collisions', async () => {
    const extractPageInfo = vi.fn(async (_llm: Llm, raw: RawPage) => pageInfo(raw.url))
    const llm = makeLlm([validScenario('grow-hotel'), validScenario('grow-hotel')])
    const result = await proposeScenarios(llm, [rawPage('http://x/hotel')], { extractPageInfo })
    expect(result.map((s) => s.id)).toEqual(['grow-hotel', 'grow-hotel-2'])
  })

  it('strips path separators from an unsafe LLM id (no traversal)', async () => {
    const extractPageInfo = vi.fn(async (_llm: Llm, raw: RawPage) => pageInfo(raw.url))
    const llm = makeLlm([validScenario('grow-../../x')])
    const result = await proposeScenarios(llm, [rawPage('http://x/hotel')], { extractPageInfo })
    expect(result[0].id).toMatch(/^grow-[A-Za-z0-9_-]+$/)
    expect(result[0].id).not.toContain('/')
    expect(result[0].id).not.toContain('.')
  })

  it('returns empty array for no uncovered pages without calling the llm', async () => {
    const extractPageInfo = vi.fn()
    const llm = makeLlm([])
    const result = await proposeScenarios(llm, [], { extractPageInfo })
    expect(result).toEqual([])
    expect(extractPageInfo).not.toHaveBeenCalled()
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('proposes in batches (bounded response) and isolates a failing batch', async () => {
    const extractPageInfo = vi.fn(async (_llm: Llm, raw: RawPage) => pageInfo(raw.url))
    let call = 0
    const llm = {
      complete: vi.fn(async () => {
        call += 1
        if (call === 2) throw new Error('LLM structured output failed: truncated JSON')
        return [validScenario(`s${call}`)]
      }),
    } as unknown as Llm
    const pages = Array.from({ length: 12 }, (_, i) => rawPage(`http://x/p${i}`))
    const result = await proposeScenarios(llm, pages, { extractPageInfo, batchSize: 5 })
    expect(extractPageInfo).toHaveBeenCalledTimes(12)
    expect(llm.complete).toHaveBeenCalledTimes(3) // ceil(12/5) batches
    expect(result.length).toBe(2) // batch 2 threw → scenarios from batches 1 and 3 only
  })

  it('skips a page whose extraction fails without aborting', async () => {
    const extractPageInfo = vi.fn(async (_llm: Llm, raw: RawPage) => {
      if (raw.url.endsWith('/bad')) throw new Error('extract boom')
      return pageInfo(raw.url)
    })
    const llm = makeLlm([validScenario('ok')])
    const result = await proposeScenarios(llm, [rawPage('http://x/good'), rawPage('http://x/bad')], { extractPageInfo })
    expect(extractPageInfo).toHaveBeenCalledTimes(2)
    expect(result.length).toBe(1) // 1 page survived → 1 batch → proposal returned
  })
})
