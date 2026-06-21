import { describe, it, expect, vi } from 'vitest'
import { verifyLayout } from './layout.js'
import type { RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'

function makePage(overrides: Partial<RawPage> = {}): RawPage {
  return {
    url: 'http://example.com/',
    title: 'Home',
    html: '<html><body><div>Hello</div></body></html>',
    meta: {},
    screenshotPath: '/tmp/screenshot.png',
    ...overrides,
  }
}

function makeLlm(response: unknown): Llm {
  return {
    complete: vi.fn().mockResolvedValue(response),
  } as unknown as Llm
}

describe('verifyLayout', () => {
  it('returns empty array when no pages provided', async () => {
    const llm = makeLlm({ findings: [] })
    const result = await verifyLayout({ llm, pages: [] })
    expect(result).toEqual([])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('returns findings for broken layout fixture', async () => {
    const llm = makeLlm({
      findings: [
        {
          severity: 'high',
          title: 'Content overflow detected',
          detail: 'Main container overflows horizontally',
          evidence: '.main-container { overflow: visible }',
        },
      ],
    })

    const result = await verifyLayout({ llm, pages: [makePage()] })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      category: 'layout',
      severity: 'high',
      title: 'Content overflow detected',
    })
    expect(result[0].evidence).toContain('http://example.com/')
  })

  it('returns empty array when LLM reports no issues (normal page)', async () => {
    const llm = makeLlm({ findings: [] })
    const result = await verifyLayout({ llm, pages: [makePage()] })
    expect(result).toEqual([])
  })

  it('aggregates findings across multiple pages', async () => {
    const llm: Llm = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          findings: [{ severity: 'medium', title: 'Overlap', detail: 'Overlap found', evidence: 'div.overlap' }],
        })
        .mockResolvedValueOnce({
          findings: [{ severity: 'low', title: 'Small text', detail: 'Text too small', evidence: 'p.small' }],
        }),
    } as unknown as Llm

    const pages = [
      makePage({ url: 'http://example.com/a' }),
      makePage({ url: 'http://example.com/b' }),
    ]
    const result = await verifyLayout({ llm, pages })

    expect(result).toHaveLength(2)
    expect(result[0].evidence).toContain('/a')
    expect(result[1].evidence).toContain('/b')
  })

  it('skips a page and continues if LLM throws', async () => {
    const llm: Llm = {
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('LLM error'))
        .mockResolvedValueOnce({ findings: [{ severity: 'low', title: 'Minor', detail: 'Minor issue', evidence: 'div' }] }),
    } as unknown as Llm

    const pages = [
      makePage({ url: 'http://example.com/fail' }),
      makePage({ url: 'http://example.com/ok' }),
    ]
    const result = await verifyLayout({ llm, pages })

    // Only the second page produced a finding; first was skipped
    expect(result).toHaveLength(1)
    expect(result[0].evidence).toContain('/ok')
  })

  it('calls LLM with planning role', async () => {
    const llm = makeLlm({ findings: [] })
    await verifyLayout({ llm, pages: [makePage()] })
    expect(llm.complete).toHaveBeenCalledWith('planning', expect.any(String), expect.anything())
  })
})
