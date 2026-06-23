import { describe, it, expect, vi } from 'vitest'
import { explore } from './explore.js'
import type { ExploreDeps } from './explore.js'
import type { DiscoveredForm, FieldConstraint, InputCase, CaseOutcome, Baseline } from '../services/explore/types.js'
import type { PageLike } from '../services/browser/crawler.js'

const form: DiscoveredForm = {
  screenPath: '/user/create',
  submitSelector: '#submit',
  fields: [{ name: 'age', selector: '#age', htmlType: 'number' }],
}
const constraint: FieldConstraint = { field: 'age', selector: '#age', required: true, type: 'integer', min: 0, table: 'users', column: 'age', evidence: 'e' }
const gapCase: InputCase = { field: 'age', selector: '#age', value: '-1', expectation: 'reject', rationale: 'below min', table: 'users', column: 'age' }

function fakePage(): PageLike {
  return {
    url: () => 'http://app/user/create',
    title: async () => 'x',
    content: async () => '<form></form>',
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: () => ({ fill: async () => {}, click: async () => {}, count: async () => 1 }),
    close: async () => {},
  }
}

function baseDeps(overrides: Partial<ExploreDeps> = {}): ExploreDeps {
  const writeFindings = vi.fn(async () => {})
  const seedDatabase = vi.fn(async () => {})
  return {
    target: { name: 't', baseUrl: 'http://app', auth: { strategy: 'form', loginPath: '/login' } },
    creds: { username: 'u', password: 'p' },
    dbType: 'postgres',
    seed: { command: 'seed-cmd' },
    createPage: async () => fakePage(),
    authenticate: async () => ({ ok: true, detail: 'ok', finalUrl: 'http://app/' }),
    discoverForms: async () => [form],
    inferCandidateTables: async () => ['users'],
    introspectTable: async () => [],
    modelConstraints: async () => [constraint],
    generateCases: async () => [gapCase],
    buildBaseline: () => ({ '#age': '5' }) as Baseline,
    runCase: async () => ({ errorsShown: [], submitStatus: 200, navigatedAway: true, finalUrl: 'http://app/user/1' }) as CaseOutcome,
    classifyGap: async () => ({ gap: true, confidence: 'high' }),
    classifyErrorQuality: async () => [],
    wasValueSaved: async () => true,
    llm: {} as ExploreDeps['llm'],
    writeFindings,
    seedDatabase,
    ...overrides,
  }
}

describe('explore pipeline', () => {
  it('produces a high input-validation finding for a confirmed gap and re-seeds', async () => {
    const deps = baseDeps()
    const res = await explore('/root', { screens: ['/user/create'] }, deps)
    expect(res.gapsHigh).toBe(1)
    expect(res.findings.some((f) => f.category === 'input-validation' && f.severity === 'high')).toBe(true)
    expect(deps.writeFindings).toHaveBeenCalledOnce()
    expect(deps.seedDatabase).toHaveBeenCalledOnce()
  })

  it('aborts (throws) before executing cases when auth fails — no reseed, no report', async () => {
    const runCase = vi.fn(async () => ({ errorsShown: [], navigatedAway: false, finalUrl: 'x' }) as CaseOutcome)
    const deps = baseDeps({
      authenticate: async () => ({ ok: false, detail: 'bad creds', finalUrl: 'http://app/login' }),
      runCase,
    })
    await expect(explore('/root', { screens: ['/user/create'] }, deps)).rejects.toThrow(/auth/i)
    expect(runCase).not.toHaveBeenCalled()
    expect(deps.writeFindings).not.toHaveBeenCalled()
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('skips re-seed when noReseed is set', async () => {
    const deps = baseDeps()
    await explore('/root', { screens: ['/user/create'], noReseed: true }, deps)
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('throws a guard error when no seed is configured and reseed is not disabled', async () => {
    const deps = baseDeps({ seed: undefined })
    await expect(explore('/root', { screens: ['/user/create'] }, deps)).rejects.toThrow(/seed/i)
  })

  it('runs prepare before discovery unless skipped', async () => {
    const prepare = vi.fn(async () => {})
    const deps = baseDeps({ prepare, config: { setup: [], repositories: [] } as never })
    await explore('/root', { screens: ['/user/create'] }, deps)
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('isolates a per-form modeling failure and still reports', async () => {
    const deps = baseDeps({ modelConstraints: async () => { throw new Error('llm down') } })
    const res = await explore('/root', { screens: ['/user/create'] }, deps)
    expect(res.forms).toBe(1)
    expect(res.cases).toBe(0)
    expect(deps.writeFindings).toHaveBeenCalledOnce()
    expect(deps.seedDatabase).toHaveBeenCalledOnce()
  })
})
