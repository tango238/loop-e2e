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

  it('returns empty array for no uncovered pages without calling the llm', async () => {
    const extractPageInfo = vi.fn()
    const llm = makeLlm([])
    const result = await proposeScenarios(llm, [], { extractPageInfo })
    expect(result).toEqual([])
    expect(extractPageInfo).not.toHaveBeenCalled()
    expect(llm.complete).not.toHaveBeenCalled()
  })
})
