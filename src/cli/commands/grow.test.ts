import { describe, it, expect, vi } from 'vitest'
import { runGrow, type RunGrowDeps } from './grow.js'
import type { Config } from '../../config/schema.js'
import type { Secrets } from '../../domain/types.js'

const config = {
  repositories: [],
  targets: [{
    name: 'admin', baseUrl: 'http://localhost:3000',
    auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'ADMIN_USER', passwordEnv: 'ADMIN_PASS', twoFactor: { pinCommand: 'echo 1', pinFieldSelector: 'input[name="pin_code"]', submitSelector: 'button[type="submit"]' } },
  }],
  databases: [], schedule: { intervalMinutes: 60 }, scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  baseline: { commit: false },
  models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
  ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
  grow: { maxPages: 50, maxDepth: 3, excludePaths: [] },
} as unknown as Config

const secrets: Secrets = {
  db: {}, targetAuth: { ADMIN_USER: 'admin@example.com', ADMIN_PASS: 'pw' }, anthropicApiKey: 'k', githubToken: 't',
}

function makeDeps(over: Partial<RunGrowDeps> = {}): RunGrowDeps {
  return {
    loadConfig: vi.fn(async () => ({ config, secrets })),
    grow: vi.fn(async () => ({ discovered: 1, uncovered: 1, proposed: [] })),
    createPage: vi.fn(),
    authenticate: vi.fn(),
    discoverPages: vi.fn(),
    findUncoveredPages: vi.fn(),
    proposeScenarios: vi.fn(),
    loadScenarios: vi.fn(),
    saveProposedScenario: vi.fn(),
    llm: { complete: vi.fn() } as never,
    ...over,
  } as RunGrowDeps
}

describe('runGrow', () => {
  it('resolves target, credentials, and scenarioDir into grow args (2FA is scenario-owned)', async () => {
    const deps = makeDeps()
    await runGrow('/base', {}, deps)
    expect(deps.grow).toHaveBeenCalledTimes(1)
    const [growArgs] = (deps.grow as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(growArgs.target.name).toBe('admin')
    expect(growArgs.target.auth.username).toBe('admin@example.com')
    expect(growArgs.target.auth.password).toBe('pw')
    // 2FA is no longer copied onto the target — it lives on the login scenario.
    expect(growArgs.target.auth.twoFactor).toBeUndefined()
    expect(growArgs.scenarioDir).toBe('/base/scenarios')
    expect(growArgs.creds).toEqual({ username: 'admin@example.com', password: 'pw' })
  })

  it('applies --max-pages override', async () => {
    const deps = makeDeps()
    await runGrow('/base', { maxPages: 5 }, deps)
    const [growArgs] = (deps.grow as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(growArgs.config.grow.maxPages).toBe(5)
  })

  it('throws when credentials are missing', async () => {
    const deps = makeDeps({ loadConfig: vi.fn(async () => ({ config, secrets: { ...secrets, targetAuth: {} } })) })
    await expect(runGrow('/base', {}, deps)).rejects.toThrow(/missing credentials/)
  })

  it('throws when the named target is not found', async () => {
    const deps = makeDeps()
    await expect(runGrow('/base', { target: 'nope' }, deps)).rejects.toThrow(/target not found/)
  })
})
