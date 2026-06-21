import { describe, it, expect, vi } from 'vitest'
import { verifyErrorHandling, pageHasErrorMessages } from './errorHandling.js'
import type { RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'

function makePage(html: string, url = 'http://example.com/form'): RawPage {
  return { url, title: 'Form', html, meta: {}, screenshotPath: '/tmp/shot.png' }
}

function makeLlm(response: unknown): Llm {
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as Llm
}

// --- helper unit tests ---

describe('pageHasErrorMessages', () => {
  it('detects class="error"', () => {
    expect(pageHasErrorMessages(`<div class="error">bad</div>`)).toBe(true)
  })

  it('detects id="alert-banner"', () => {
    expect(pageHasErrorMessages(`<p id="alert-banner">Oops</p>`)).toBe(true)
  })

  it('detects class="is-invalid"', () => {
    expect(pageHasErrorMessages(`<input class="is-invalid">`)).toBe(true)
  })

  it('returns false for normal page', () => {
    expect(pageHasErrorMessages(`<div class="container"><p>Hello</p></div>`)).toBe(false)
  })
})

// --- integration tests ---

describe('verifyErrorHandling', () => {
  it('returns empty array when no pages', async () => {
    const llm = makeLlm({ findings: [] })
    const result = await verifyErrorHandling({ llm, pages: [] })
    expect(result).toEqual([])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('skips pages without error indicators (optimization)', async () => {
    const llm = makeLlm({ findings: [] })
    const html = `<html><body><form><input type="text"><button>Submit</button></form></body></html>`
    await verifyErrorHandling({ llm, pages: [makePage(html)] })
    // LLM should NOT be called for pages with no error patterns
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('calls LLM for pages containing error indicators', async () => {
    const llm = makeLlm({ findings: [] })
    const html = `<div class="error">Something went wrong.</div>`
    await verifyErrorHandling({ llm, pages: [makePage(html)] })
    expect(llm.complete).toHaveBeenCalledOnce()
  })

  it('returns findings for vague error message (bad fixture)', async () => {
    const llm = makeLlm({
      findings: [
        {
          severity: 'high',
          title: 'Vague error message',
          detail: 'Error message "An error occurred" provides no actionable guidance',
          evidence: 'An error occurred',
        },
      ],
    })

    const html = `<div class="error">An error occurred.</div>`
    const result = await verifyErrorHandling({ llm, pages: [makePage(html)] })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      category: 'error-handling',
      severity: 'high',
      title: 'Vague error message',
    })
    expect(result[0].evidence).toContain('http://example.com/form')
  })

  it('returns empty when LLM confirms good error messages', async () => {
    const llm = makeLlm({ findings: [] })
    const html = `<div class="error">Email address is required. Please enter a valid email to continue.</div>`
    const result = await verifyErrorHandling({ llm, pages: [makePage(html)] })
    expect(result).toEqual([])
  })

  it('aggregates findings from multiple pages with errors', async () => {
    const llm: Llm = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          findings: [{ severity: 'high', title: 'Vague message', detail: 'No guidance', evidence: 'Error' }],
        })
        .mockResolvedValueOnce({
          findings: [{ severity: 'medium', title: 'Technical jargon', detail: 'SQL error shown', evidence: 'SQL syntax error' }],
        }),
    } as unknown as Llm

    const pages = [
      makePage(`<div class="error">Error</div>`, 'http://a.com/'),
      makePage(`<div class="alert">SQL syntax error near...</div>`, 'http://b.com/'),
    ]
    const result = await verifyErrorHandling({ llm, pages })

    expect(result).toHaveLength(2)
    expect(result[0].evidence).toContain('http://a.com/')
    expect(result[1].evidence).toContain('http://b.com/')
  })

  it('skips a page and continues if LLM throws', async () => {
    const llm: Llm = {
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('LLM error'))
        .mockResolvedValueOnce({ findings: [{ severity: 'low', title: 'Minor', detail: 'Minor', evidence: 'msg' }] }),
    } as unknown as Llm

    const pages = [
      makePage(`<div class="error">fail page</div>`, 'http://fail.com/'),
      makePage(`<div class="warning">warn page</div>`, 'http://ok.com/'),
    ]
    const result = await verifyErrorHandling({ llm, pages })

    expect(result).toHaveLength(1)
    expect(result[0].evidence).toContain('http://ok.com/')
  })

  it('uses planning role', async () => {
    const llm = makeLlm({ findings: [] })
    const html = `<div class="error">Fail</div>`
    await verifyErrorHandling({ llm, pages: [makePage(html)] })
    expect(llm.complete).toHaveBeenCalledWith('planning', expect.any(String), expect.anything())
  })
})
