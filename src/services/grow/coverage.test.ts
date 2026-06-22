import { describe, it, expect } from 'vitest'
import { findUncoveredPages } from './coverage.js'
import type { RawPage } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

const rawPage = (url: string): RawPage => ({ url, title: 't', html: '', meta: {}, screenshotPath: '' })

const scenario = (id: string, navTargets: string[]): Scenario => ({
  id,
  title: id,
  businessFlow: 'flow',
  steps: navTargets.map((t) => ({ action: 'navigate' as const, target: t, expectedOutcome: 'shown' })),
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
})

describe('findUncoveredPages', () => {
  it('returns only pages not covered by a scenario navigate step', async () => {
    const discovered = [
      rawPage('http://localhost:3000/login'),
      rawPage('http://localhost:3000/hotel'),
      rawPage('http://localhost:3000/booking'),
    ]
    const scenarios = [scenario('admin-login', ['/login']), scenario('hotel', ['/hotel'])]
    const uncovered = findUncoveredPages(discovered, scenarios)
    expect(uncovered.map((p) => p.url)).toEqual(['http://localhost:3000/booking'])
  })

  it('normalizes trailing slash and query when comparing', async () => {
    const discovered = [
      rawPage('http://localhost:3000/hotel/'),
      rawPage('http://localhost:3000/booking?status=open'),
    ]
    const scenarios = [scenario('s', ['/hotel', '/booking'])]
    expect(findUncoveredPages(discovered, scenarios)).toEqual([])
  })

  it('treats full-URL navigate targets the same as bare paths', async () => {
    const discovered = [rawPage('http://localhost:3000/hotel')]
    const scenarios = [scenario('s', ['http://localhost:3000/hotel'])]
    expect(findUncoveredPages(discovered, scenarios)).toEqual([])
  })

  it('returns all pages when there are no scenarios', async () => {
    const discovered = [rawPage('http://localhost:3000/a'), rawPage('http://localhost:3000/b')]
    expect(findUncoveredPages(discovered, []).length).toBe(2)
  })

  it('ignores non-navigate steps (fill/submit) when computing coverage', async () => {
    const discovered = [rawPage('http://localhost:3000/hotel')]
    const s: Scenario = {
      id: 's', title: 's', businessFlow: 'f',
      steps: [
        { action: 'fill', target: '/hotel', input: 'x', expectedOutcome: 'o' }, // not a navigate — does not cover
      ],
      expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
      expectedDbState: [],
    }
    expect(findUncoveredPages(discovered, [s]).length).toBe(1)
  })
})
