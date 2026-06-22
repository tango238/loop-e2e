import { describe, it, expect, vi } from 'vitest'
import { executeScenarios } from './executeScenarios.js'
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
