import { describe, it, expect, vi } from 'vitest'
import type { SiteStructure, PageInfo, Transition } from '../domain/types.js'
import type { Scenario } from '../scenario/schema.js'
import type { Llm } from '../services/llm/client.js'
import { detectDiffs } from './diff.js'

function makePage(url: string, overrides: Partial<PageInfo> = {}): PageInfo {
  return {
    url,
    title: 'Page',
    description: 'A page',
    displayItems: [],
    inputItems: [],
    expectations: [],
    capabilities: [],
    ...overrides,
  }
}

function makeStructure(pages: PageInfo[], transitions: Transition[]): SiteStructure {
  return { generatedAt: '2024-01-01T00:00:00.000Z', pages, transitions }
}

function makeMockLlm(gapFindings: unknown[] = []): Llm {
  return {
    complete: vi.fn().mockResolvedValue(gapFindings),
  } as unknown as Llm
}

const noopLlm = makeMockLlm()

describe('detectDiffs', () => {
  it('detects added transition', async () => {
    const baseline = makeStructure([], [])
    const current = makeStructure([], [{ fromUrl: '/a', toUrl: '/b', trigger: 'click' }])
    const results = await detectDiffs({ current, baseline, scenarios: [], llm: noopLlm })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'transition', severity: 'high' })
    expect(results[0]?.actual).toContain('/a')
  })

  it('detects removed transition', async () => {
    const baseline = makeStructure([], [{ fromUrl: '/a', toUrl: '/b', trigger: 'click' }])
    const current = makeStructure([], [])
    const results = await detectDiffs({ current, baseline, scenarios: [], llm: noopLlm })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'transition', severity: 'high' })
    expect(results[0]?.expected).toContain('/a')
  })

  it('detects added displayItem on a page', async () => {
    const baseline = makeStructure([makePage('/home')], [])
    const current = makeStructure(
      [makePage('/home', { displayItems: [{ type: 'text', label: 'Hello', selector: '#h' }] })],
      [],
    )
    const results = await detectDiffs({ current, baseline, scenarios: [], llm: noopLlm })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'displayItem' })
    expect(results[0]?.actual).toContain('Hello')
  })

  it('detects removed displayItem on a page', async () => {
    const baseline = makeStructure(
      [makePage('/home', { displayItems: [{ type: 'text', label: 'Hello', selector: '#h' }] })],
      [],
    )
    const current = makeStructure([makePage('/home')], [])
    const results = await detectDiffs({ current, baseline, scenarios: [], llm: noopLlm })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'displayItem' })
    expect(results[0]?.expected).toContain('Hello')
  })

  it('detects added inputItem on a page', async () => {
    const baseline = makeStructure([makePage('/form')], [])
    const current = makeStructure(
      [makePage('/form', { inputItems: [{ type: 'text', label: 'Email', name: 'email' }] })],
      [],
    )
    const results = await detectDiffs({ current, baseline, scenarios: [], llm: noopLlm })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'inputItem' })
    expect(results[0]?.actual).toContain('Email')
  })

  it('detects expectation-gap via diffJudge when scenario expected not in capabilities', async () => {
    const scenario: Scenario = {
      id: 's1',
      title: 'Login flow',
      businessFlow: 'User logs in',
      steps: [{ action: 'click', target: '#login', expectedOutcome: 'logged in' }],
      expectedResults: [{ kind: 'ui', description: 'Show dashboard', assertion: 'visible' }],
      expectedDbState: [],
    }
    const page = makePage('/login', { capabilities: ['show form'] })
    const current = makeStructure([page], [])
    const gapFinding = {
      kind: 'expectation-gap' as const,
      severity: 'medium' as const,
      expected: 'Show dashboard',
      actual: 'not covered',
      location: '/login',
    }
    const llmWithGap = makeMockLlm([gapFinding])
    const results = await detectDiffs({ current, baseline: null, scenarios: [scenario], llm: llmWithGap })
    const gaps = results.filter((f) => f.kind === 'expectation-gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject(gapFinding)
  })

  it('returns empty array when no diffs', async () => {
    const structure = makeStructure([makePage('/a')], [{ fromUrl: '/a', toUrl: '/b', trigger: 'click' }])
    const results = await detectDiffs({ current: structure, baseline: structure, scenarios: [], llm: noopLlm })
    expect(results).toHaveLength(0)
  })
})
