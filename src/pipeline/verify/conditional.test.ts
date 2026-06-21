import { describe, it, expect, vi } from 'vitest'
import { verifyConditional } from './conditional.js'
import type { RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'
import type { Scenario } from '../../scenario/schema.js'

function makePage(overrides: Partial<RawPage> = {}): RawPage {
  return {
    url: 'http://example.com/pricing',
    title: 'Pricing',
    html: '<html><body><p>Adult: $20, Child: $10</p></body></html>',
    meta: {},
    screenshotPath: '/tmp/shot.png',
    ...overrides,
  }
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'scenario-1',
    title: 'Adult pricing check',
    businessFlow: 'Verify adult ticket pricing is $20',
    steps: [{ action: 'navigate', target: '/pricing', expectedOutcome: 'Page loads' }],
    expectedResults: [{ kind: 'ui', description: 'Price shown', assertion: 'Adult price is $20' }],
    expectedDbState: [],
    ...overrides,
  }
}

function makeLlm(response: unknown): Llm {
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as Llm
}

describe('verifyConditional', () => {
  it('returns empty array when no pages', async () => {
    const llm = makeLlm({ findings: [] })
    const result = await verifyConditional({ llm, pages: [], scenarios: [] })
    expect(result).toEqual([])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('returns findings for incorrect adult/child pricing', async () => {
    const llm = makeLlm({
      findings: [
        {
          severity: 'high',
          title: 'Wrong adult price displayed',
          detail: 'Page shows $15 for adult but scenario expects $20',
          evidence: 'Adult: $15',
        },
      ],
    })

    const result = await verifyConditional({
      llm,
      pages: [makePage()],
      scenarios: [makeScenario()],
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      category: 'conditional',
      severity: 'high',
      title: 'Wrong adult price displayed',
    })
    expect(result[0].evidence).toContain('http://example.com/pricing')
  })

  it('returns empty when no issues found (correct pricing)', async () => {
    const llm = makeLlm({ findings: [] })
    const result = await verifyConditional({
      llm,
      pages: [makePage()],
      scenarios: [makeScenario()],
    })
    expect(result).toEqual([])
  })

  it('aggregates findings across multiple pages', async () => {
    const llm: Llm = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          findings: [{ severity: 'high', title: 'Wrong discount', detail: 'Discount not applied', evidence: '$100' }],
        })
        .mockResolvedValueOnce({
          findings: [{ severity: 'medium', title: 'Time restriction ignored', detail: 'Event shows as available', evidence: 'Buy now' }],
        }),
    } as unknown as Llm

    const pages = [
      makePage({ url: 'http://example.com/shop' }),
      makePage({ url: 'http://example.com/events' }),
    ]
    const result = await verifyConditional({ llm, pages, scenarios: [] })

    expect(result).toHaveLength(2)
    expect(result[0].evidence).toContain('/shop')
    expect(result[1].evidence).toContain('/events')
  })

  it('skips a page if LLM throws and continues with others', async () => {
    const llm: Llm = {
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('LLM error'))
        .mockResolvedValueOnce({ findings: [{ severity: 'low', title: 'Minor', detail: 'Minor', evidence: 'x' }] }),
    } as unknown as Llm

    const pages = [
      makePage({ url: 'http://example.com/fail' }),
      makePage({ url: 'http://example.com/ok' }),
    ]
    const result = await verifyConditional({ llm, pages, scenarios: [] })

    expect(result).toHaveLength(1)
    expect(result[0].evidence).toContain('/ok')
  })

  it('passes scenarios to LLM prompt', async () => {
    const llm = makeLlm({ findings: [] })
    const scenario = makeScenario({ title: 'Child discount', businessFlow: 'Child ticket is 50% off' })

    await verifyConditional({ llm, pages: [makePage()], scenarios: [scenario] })

    const [, prompt] = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(prompt).toContain('Child discount')
    expect(prompt).toContain('Child ticket is 50% off')
  })

  it('uses planning role', async () => {
    const llm = makeLlm({ findings: [] })
    await verifyConditional({ llm, pages: [makePage()], scenarios: [] })
    expect(llm.complete).toHaveBeenCalledWith('planning', expect.any(String), expect.anything())
  })
})
