import { describe, it, expect, vi } from 'vitest'
import { executeScenarios, resolvePersonaCreds } from './executeScenarios.js'
import type { Scenario } from '../scenario/schema.js'
import type { TargetEnv } from '../domain/types.js'

const target: TargetEnv = {
  name: 'admin',
  baseUrl: 'https://app.test',
  auth: { strategy: 'form', loginPath: '/login' },
}
const creds = { username: 'u', password: 'p' }
const page = {} as never

const scn = (
  id: string,
  pre?: 'authenticated' | 'unauthenticated',
  results: Scenario['expectedResults'] = [{ kind: 'ui', description: 'd', assertion: 'a' }],
): Scenario => ({
  id,
  title: id,
  businessFlow: 'f',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'ok' }],
  expectedResults: results,
  expectedDbState: [],
  ...(pre ? { precondition: { auth: pre } } : {}),
})

describe('executeScenarios', () => {
  it('runs ensureAuthenticated for each authenticated scenario and produces scenario findings', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: true, detail: 'ok' }))
    const ensureUnauthenticated = vi.fn(async () => {})
    const executeScenario = vi.fn(async (_p: unknown, _t: unknown, s: Scenario) => ({
      scenarioId: s.id,
      ok: true,
      detail: 'passed',
      finalUrl: 'https://app.test/x',
    }))
    const findings = await executeScenarios(page, target, [scn('a', 'authenticated'), scn('b', 'authenticated')], creds, {
      ensureAuthenticated,
      ensureUnauthenticated,
      executeScenario,
    })
    expect(ensureAuthenticated).toHaveBeenCalledTimes(2)
    expect(executeScenario).toHaveBeenCalledTimes(2)
    expect(findings.every((f) => f.category === 'scenario')).toBe(true)
    expect(findings.every((f) => f.severity === 'low')).toBe(true)
  })

  it('maps a failed scenario to a high finding', async () => {
    const executeScenario = vi.fn(async (_p: unknown, _t: unknown, s: Scenario) => ({
      scenarioId: s.id,
      ok: false,
      failedStepIndex: 0,
      detail: 'boom',
      finalUrl: 'https://app.test/x',
    }))
    const findings = await executeScenarios(page, target, [scn('a')], creds, { executeScenario })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].detail).toContain('boom')
  })

  it('skips remaining authenticated scenarios when login fails (one finding)', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: false, detail: 'login failed' }))
    const executeScenario = vi.fn()
    const findings = await executeScenarios(
      page,
      target,
      [scn('a', 'authenticated'), scn('b', 'authenticated')],
      creds,
      { ensureAuthenticated, executeScenario },
    )
    expect(executeScenario).not.toHaveBeenCalled()
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('high')
  })

  it('does not auth when precondition is absent', async () => {
    const ensureAuthenticated = vi.fn()
    const ensureUnauthenticated = vi.fn()
    const executeScenario = vi.fn(async (_p: unknown, _t: unknown, s: Scenario) => ({
      scenarioId: s.id,
      ok: true,
      detail: 'passed',
      finalUrl: 'u',
    }))
    await executeScenarios(page, target, [scn('a')], creds, {
      ensureAuthenticated,
      ensureUnauthenticated,
      executeScenario,
    })
    expect(ensureAuthenticated).not.toHaveBeenCalled()
    expect(ensureUnauthenticated).not.toHaveBeenCalled()
  })

  it('clears cookies for an unauthenticated scenario', async () => {
    const ensureUnauthenticated = vi.fn(async () => {})
    const executeScenario = vi.fn(async (_p: unknown, _t: unknown, s: Scenario) => ({
      scenarioId: s.id,
      ok: true,
      detail: 'passed',
      finalUrl: 'u',
    }))
    await executeScenarios(page, target, [scn('a', 'unauthenticated')], creds, {
      ensureUnauthenticated,
      executeScenario,
    })
    expect(ensureUnauthenticated).toHaveBeenCalledOnce()
  })

  it('notes unverified api/db expectedResults in a passed finding detail', async () => {
    const executeScenario = vi.fn(async (_p: unknown, _t: unknown, s: Scenario) => ({
      scenarioId: s.id,
      ok: true,
      detail: 'passed',
      finalUrl: 'u',
    }))
    const findings = await executeScenarios(
      page,
      target,
      [scn('a', undefined, [{ kind: 'api', description: 'GET ok', assertion: '200' }])],
      creds,
      { executeScenario },
    )
    expect(findings[0].detail.toLowerCase()).toContain('expectedresults')
  })
})

const actScn = (id: string): Scenario => ({
  id, title: id, businessFlow: 'f',
  personas: [
    { name: 'creator', auth: 'authenticated' },
    { name: 'verifier', auth: 'authenticated', credEnv: { usernameEnv: 'REV_U', passwordEnv: 'REV_P' } },
  ],
  acts: [
    { persona: 'creator', steps: [{ action: 'navigate', target: '/coupon/create', expectedOutcome: 'o' }, { action: 'capture', target: '#code', var: 'COUPON', expectedOutcome: 'o' }] },
    { persona: 'verifier', steps: [{ action: 'assert', target: 'text={{COUPON}}', expectedOutcome: 'o' }] },
  ],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

describe('executeScenarios multi-act', () => {
  it('runs each act with its persona session, sharing the vars bag, and forces reauth on identity change', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: true, detail: 'ok' }))
    const seenVars: Array<Record<string, string>> = []
    const executeSteps = vi.fn(async (_p: unknown, _t: unknown, _steps: unknown, deps: { vars?: Record<string, string> } = {}) => {
      if (deps.vars) { deps.vars.COUPON = deps.vars.COUPON ?? 'SUMMER25'; seenVars.push(deps.vars) }
      return { ok: true, detail: 'passed (n steps)', finalUrl: 'https://app.test/x' }
    })
    const findings = await executeScenarios(page, target, [actScn('flow')], creds, {
      ensureAuthenticated, executeSteps, secretsEnv: { REV_U: 'r', REV_P: 'pw' },
    })
    expect(ensureAuthenticated).toHaveBeenCalledTimes(2)
    const secondCall = ensureAuthenticated.mock.calls[1] as unknown as [unknown, unknown, unknown, unknown, { forceReauth?: boolean }]
    expect(secondCall[4].forceReauth).toBe(true)
    expect(seenVars[0]).toBe(seenVars[1])
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('low')
    expect(findings[0].detail).toContain('acts')
  })

  it('maps a failed act to a high finding naming the act and persona', async () => {
    const executeSteps = vi.fn(async () => ({ ok: false, failedStepIndex: 0, detail: 'step 0 (assert) failed', finalUrl: 'https://app.test/x' }))
    const findings = await executeScenarios(page, target, [actScn('flow')], creds, {
      ensureAuthenticated: vi.fn(async () => ({ ok: true, detail: 'ok' })), executeSteps, secretsEnv: { REV_U: 'r', REV_P: 'pw' },
    })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].detail).toMatch(/act 0 \(persona creator\)/)
  })
})

describe('resolvePersonaCreds', () => {
  it('uses credEnv from env when present, else run creds', () => {
    expect(resolvePersonaCreds({ name: 'v', auth: 'authenticated', credEnv: { usernameEnv: 'U', passwordEnv: 'P' } }, creds, { U: 'x', P: 'y' })).toEqual({ username: 'x', password: 'y' })
    expect(resolvePersonaCreds(undefined, creds, {})).toEqual(creds)
  })
})

describe('executeScenarios multi-act fixes', () => {
  it('seeds the vars bag from inherited deps.vars (env credentials still resolve in multi-act)', async () => {
    let seen: Record<string, string> | undefined
    const executeSteps = vi.fn(async (_p: unknown, _t: unknown, _s: unknown, deps: { vars?: Record<string, string> } = {}) => {
      seen = deps.vars
      return { ok: true, detail: 'passed', finalUrl: 'https://app.test/x' }
    })
    const oneAct: Scenario = {
      id: 'one', title: 'one', businessFlow: 'f',
      personas: [{ name: 'a', auth: 'authenticated' }],
      acts: [{ persona: 'a', steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }] }],
      expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
    }
    await executeScenarios(page, target, [oneAct], creds, {
      ensureAuthenticated: vi.fn(async () => ({ ok: true, detail: 'ok' })), executeSteps,
      vars: { TARGET_USER: 'admin@example.com' },
    })
    expect(seen?.TARGET_USER).toBe('admin@example.com')
  })

  it('returns a clear finding when a persona credEnv is not set', async () => {
    const findings = await executeScenarios(page, target, [actScn('flow')], creds, {
      ensureAuthenticated: vi.fn(async () => ({ ok: true, detail: 'ok' })),
      executeSteps: vi.fn(async () => ({ ok: true, detail: 'passed', finalUrl: 'u' })),
      secretsEnv: {}, // REV_U / REV_P missing
    })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].detail).toMatch(/credEnv not set.*REV_U/)
  })
})

const crossScn = (): Scenario => ({
  id: 'cross', title: 'cross', businessFlow: 'f',
  personas: [
    { name: 'admin', target: 'admin', auth: 'authenticated' },
    { name: 'shopper', target: 'storefront', auth: 'authenticated' },
  ],
  acts: [
    { persona: 'admin', steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }] },
    { persona: 'shopper', steps: [{ action: 'navigate', target: '/buy', expectedOutcome: 'o' }] },
  ],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

describe('executeScenarios multi-target', () => {
  const storefront = { name: 'storefront', baseUrl: 'https://shop.test', auth: { strategy: 'form', loginPath: '/login' } } as TargetEnv
  const resolveTarget = (name: string) =>
    name === 'admin' ? { target, creds } :
    name === 'storefront' ? { target: storefront, creds: { username: 's', password: 'sp' } } : undefined

  it('runs each act against its persona.target and does NOT force reauth across targets', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: true, detail: 'ok' }))
    const targetsSeen: string[] = []
    const executeSteps = vi.fn(async (_p: unknown, t: TargetEnv) => { targetsSeen.push(t.name); return { ok: true, detail: 'passed', finalUrl: 'u' } })
    const findings = await executeScenarios(page, target, [crossScn()], creds, { ensureAuthenticated, executeSteps, resolveTarget })
    expect(targetsSeen).toEqual(['admin', 'storefront'])
    const secondCall = ensureAuthenticated.mock.calls[1] as unknown as [unknown, TargetEnv, unknown, unknown, { forceReauth?: boolean }]
    expect(secondCall[1].name).toBe('storefront')
    expect(secondCall[4].forceReauth).toBe(false)
    expect(findings[0].severity).toBe('low')
  })

  it('fails with a clear finding when persona.target is not resolvable', async () => {
    const bad: Scenario = { ...crossScn(), personas: [{ name: 'admin', target: 'ghost', auth: 'authenticated' }], acts: [{ persona: 'admin', steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }] }] }
    const findings = await executeScenarios(page, target, [bad], creds, { ensureAuthenticated: vi.fn(async () => ({ ok: true, detail: 'ok' })), executeSteps: vi.fn(), resolveTarget: () => undefined })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].detail).toMatch(/cannot use target 'ghost'/)
  })
})
