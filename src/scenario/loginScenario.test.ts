import { describe, it, expect } from 'vitest'
import { isLoginScenario, findLoginScenario } from './loginScenario.js'
import type { Scenario } from './schema.js'

const base = (over: Partial<Scenario>): Scenario => ({
  id: 'x',
  title: 't',
  businessFlow: 'b',
  steps: [{ action: 'navigate', target: '/home', expectedOutcome: 'ok' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
  ...over,
})

describe('isLoginScenario', () => {
  it('matches a scenario that navigates to the exact loginPath', () => {
    const s = base({ steps: [{ action: 'navigate', target: '/login', expectedOutcome: 'login shown' }] })
    expect(isLoginScenario(s, '/login')).toBe(true)
  })

  it('matches on title mention only with a credential step on the loginPath', () => {
    const s = base({
      title: 'Admin login',
      steps: [{ action: 'fill', target: '/login', input: 'x', expectedOutcome: 'filled' }],
    })
    expect(isLoginScenario(s, '/login')).toBe(true)
  })

  it('does not match a non-login scenario', () => {
    expect(isLoginScenario(base({ title: 'View products' }), '/login')).toBe(false)
  })
})

describe('findLoginScenario', () => {
  it('returns the first login scenario in the list', () => {
    const login = base({ id: 'login', steps: [{ action: 'navigate', target: '/login', expectedOutcome: 'x' }] })
    const other = base({ id: 'other' })
    expect(findLoginScenario([other, login], '/login')?.id).toBe('login')
  })

  it('returns undefined when none match', () => {
    expect(findLoginScenario([base({ id: 'a' })], '/login')).toBeUndefined()
  })
})
