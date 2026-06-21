import { describe, it, expect, vi } from 'vitest'
import { runVerify, type RunVerifyDeps } from './index.js'
import type { RawPage, VerifyFinding } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'
import type { Config } from '../../config/schema.js'

function makePage(url = 'http://example.com/'): RawPage {
  return { url, title: 'Test', html: '<html><body></body></html>', meta: {}, screenshotPath: '' }
}

function makeLlm(response: unknown = { findings: [] }): Llm {
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as Llm
}

const minimalConfig: Config = {
  repositories: [{ name: 'r', label: 'R', url: 'https://github.com/x/y', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'staging', baseUrl: 'http://localhost' }],
  databases: [],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  baseline: { commit: false },
  models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
  ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
}

function makeDeps(overrides: Partial<RunVerifyDeps> = {}): RunVerifyDeps {
  return {
    llm: makeLlm(),
    pages: [],
    scenarios: [],
    config: minimalConfig,
    secrets: {},
    ...overrides,
  }
}

describe('runVerify', () => {
  it('returns empty array when no pages and no scenarios', async () => {
    const result = await runVerify(makeDeps())
    expect(result).toEqual([])
  })

  it('aggregates findings from all categories', async () => {
    // LLM returns a finding for each call (layout, conditional, error-handling each call LLM)
    // security is deterministic; registered-data uses DB
    const llm: Llm = {
      complete: vi.fn().mockResolvedValue({
        findings: [{ severity: 'high', title: 'Issue', detail: 'Detail', evidence: 'Ev' }],
      }),
    } as unknown as Llm

    // Page with error class so error-handling calls LLM too
    const pageWithError: RawPage = {
      ...makePage(),
      html: '<div class="error">Oops</div>',
    }

    const result = await runVerify(makeDeps({ llm, pages: [pageWithError] }))
    // layout + conditional + error-handling each return 1 finding = 3
    // security: no cards/passwords/forms → 0
    // registered-data: no scenarios → 0
    expect(result.length).toBeGreaterThanOrEqual(1)
    const categories = result.map((f) => f.category)
    expect(categories).toContain('layout')
  })

  it('continues when one category throws and other categories still contribute findings', async () => {
    // layout will throw; error-handling and conditional should still run and return findings
    const llm: Llm = {
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('layout LLM error'))  // layout throws
        .mockResolvedValueOnce({                               // conditional returns a finding
          findings: [{ severity: 'medium', title: 'Conditional issue', detail: 'Detail', evidence: 'Ev' }],
        })
        .mockResolvedValue({ findings: [] }),                  // remaining calls (error-handling, etc.)
    } as unknown as Llm

    const pageWithError: RawPage = {
      ...makePage(),
      html: '<div class="error">Fail</div>',
    }

    const result = await runVerify(makeDeps({ llm, pages: [pageWithError] }))

    // Must not throw
    expect(Array.isArray(result)).toBe(true)

    // Other categories must have actually run and contributed findings
    // (proves real per-category isolation, not just no-crash)
    expect(result.some((f) => f.category !== 'layout')).toBe(true)
  })

  it('returns findings with correct categories', async () => {
    // security: inject a page with a credit card and a form without CSRF
    const sensitiveHtml = `
      <form><input type="text" name="q"><button>Go</button></form>
      <p>Your card 4111111111111111 was charged</p>
    `
    const page: RawPage = {
      ...makePage(),
      html: sensitiveHtml,
    }

    const result = await runVerify(makeDeps({ llm: makeLlm(), pages: [page] }))
    const cats = new Set(result.map((f) => f.category))
    expect(cats.has('security')).toBe(true)
  })

  it('passes scenarios to registered-data category', async () => {
    const scenario = {
      id: 'sc-1',
      title: 'Test',
      businessFlow: 'flow',
      steps: [{ action: 'navigate', target: '/', expectedOutcome: 'ok' }],
      expectedResults: [{ kind: 'db' as const, description: 'desc', assertion: 'a' }],
      expectedDbState: [{
        connection: 'missing-conn',
        table: 'users',
        match: { id: 1 },
        expectedValues: { name: 'Alice' },
      }],
    }

    const result = await runVerify(makeDeps({ scenarios: [scenario] }))
    const rdFindings = result.filter((f) => f.category === 'registered-data')
    // Should have a finding for unknown connection
    expect(rdFindings.length).toBeGreaterThan(0)
  })
})
