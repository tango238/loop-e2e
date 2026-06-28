import { describe, it, expect } from 'vitest'
import { normalizePath, navigateRoutes } from './match.js'
import type { Scenario } from '../../scenario/schema.js'

const navScn = (target: string): Scenario => ({
  id: 'x',
  title: 'x',
  businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
})

describe('normalizePath', () => {
  it('strips origin, query, fragment, trailing slash', () => {
    expect(normalizePath('https://app.test/hotel/?q=1#x')).toBe('/hotel')
    expect(normalizePath('/hotel/')).toBe('/hotel')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('https://app.test/')).toBe('/')
  })
})

describe('navigateRoutes', () => {
  it('collects normalized navigate targets', () => {
    const s: Scenario = {
      ...navScn('/hotel'),
      steps: [
        { action: 'navigate', target: '/hotel/', expectedOutcome: 'o' },
        { action: 'navigate', target: 'https://app.test/booking?x=1', expectedOutcome: 'o' },
      ],
    }
    expect(navigateRoutes(s)).toEqual(['/hotel', '/booking'])
  })
})
