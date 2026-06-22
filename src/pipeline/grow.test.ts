import { describe, it, expect, vi } from 'vitest'
import { grow, type GrowDeps, type GrowArgs } from './grow.js'
import type { Config } from '../config/schema.js'
import type { TargetEnv, RawPage } from '../domain/types.js'
import type { Scenario } from '../scenario/schema.js'
import type { Llm } from '../services/llm/client.js'

const target: TargetEnv = {
  name: 'admin',
  baseUrl: 'http://localhost:3000',
  auth: { strategy: 'form', loginPath: '/login' },
}

const baseConfig = { grow: { maxPages: 50, maxDepth: 3, excludePaths: [] } } as unknown as Config

const args: GrowArgs = {
  config: baseConfig,
  root: '/base',
  scenarioDir: '/base/scenarios',
  target,
  creds: { username: 'u', password: 'p' },
}

const rawPage = (url: string): RawPage => ({ url, title: 't', html: '', meta: {}, screenshotPath: '' })
const scenario = (id: string): Scenario => ({
  id, title: id, businessFlow: 'f',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

function makeDeps(over: Partial<GrowDeps> = {}): GrowDeps {
  const order: string[] = []
  const deps: GrowDeps = {
    prepare: vi.fn(async () => { order.push('prepare') }),
    createPage: vi.fn(async () => ({}) as never),
    authenticate: vi.fn(async () => { order.push('authenticate'); return { ok: true, detail: 'ok', finalUrl: 'http://localhost:3000/' } }),
    discoverPages: vi.fn(async () => { order.push('discover'); return [rawPage('http://localhost:3000/hotel')] }),
    findUncoveredPages: vi.fn((discovered) => { order.push('coverage'); return discovered }),
    proposeScenarios: vi.fn(async () => { order.push('propose'); return [scenario('grow-hotel')] }),
    loadScenarios: vi.fn(async () => []),
    saveProposedScenario: vi.fn(async () => { order.push('save') }),
    llm: { complete: vi.fn() } as unknown as Llm,
    ...over,
  }
  ;(deps as unknown as { _order: string[] })._order = order
  return deps
}

describe('grow', () => {
  it('runs prepare → authenticate → discover → coverage → propose → save in order', async () => {
    const deps = makeDeps()
    const order = (deps as unknown as { _order: string[] })._order
    const result = await grow(args, deps)
    expect(order).toEqual(['prepare', 'authenticate', 'discover', 'coverage', 'propose', 'save'])
    expect(result).toEqual({ discovered: 1, uncovered: 1, proposed: [scenario('grow-hotel')] })
    expect(deps.saveProposedScenario).toHaveBeenCalledWith('/base/scenarios', scenario('grow-hotel'))
  })

  it('aborts when authentication fails (no discover/propose)', async () => {
    const deps = makeDeps({
      authenticate: vi.fn(async () => ({ ok: false, detail: '2FA failed: pin not found', finalUrl: 'x' })),
    })
    await expect(grow(args, deps)).rejects.toThrow(/authentication failed/)
    expect(deps.discoverPages).not.toHaveBeenCalled()
    expect(deps.proposeScenarios).not.toHaveBeenCalled()
  })

  it('skips prepare when skipPrepare is set', async () => {
    const deps = makeDeps()
    await grow({ ...args, skipPrepare: true }, deps)
    expect(deps.prepare).not.toHaveBeenCalled()
    expect(deps.authenticate).toHaveBeenCalled()
  })

  it('compares discovered pages against existing scenarios for coverage', async () => {
    const existing = [scenario('grow-hotel')]
    const deps = makeDeps({ loadScenarios: vi.fn(async () => existing) })
    await grow(args, deps)
    expect(deps.findUncoveredPages).toHaveBeenCalledWith([rawPage('http://localhost:3000/hotel')], existing)
  })
})
