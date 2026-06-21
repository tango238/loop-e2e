import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Config } from '../config/schema.js'
import type { refreshRepo } from '../services/repo/refresh.js'
import type { runSetupHooks } from '../services/setup/setup.js'

// --- Fixture helpers ---

const makeRepo = (name: string, branch?: string): Config['repositories'][number] => ({
  name,
  label: name,
  url: `https://github.com/org/${name}`,
  role: 'frontend',
  audience: 'user',
  ...(branch !== undefined ? { branch } : {}),
})

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  repositories: [makeRepo('repo-a')],
  targets: [{ name: 'test-target', baseUrl: 'https://example.com' }],
  databases: [],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'ready', autoDetect: 'auto' } },
  baseline: { commit: false },
  models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
  ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
  ...overrides,
})

describe('pipeline/prepare', () => {
  let mockRefreshRepo: ReturnType<typeof vi.fn>
  let mockRunSetupHooks: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockRefreshRepo = vi.fn().mockResolvedValue(undefined)
    mockRunSetupHooks = vi.fn().mockResolvedValue(undefined)
  })

  it('does not call refreshRepo for repos without a branch', async () => {
    const { prepare } = await import('./prepare.js')
    const config = makeConfig({
      repositories: [makeRepo('repo-no-branch')],
    })

    await prepare(config, '/root', {
      refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
    })

    expect(mockRefreshRepo).not.toHaveBeenCalled()
  })

  it('calls refreshRepo once per repo that has a branch set', async () => {
    const { prepare } = await import('./prepare.js')
    const config = makeConfig({
      repositories: [
        makeRepo('repo-with-branch', 'main'),
        makeRepo('repo-no-branch'),
        makeRepo('repo-other-branch', 'develop'),
      ],
    })

    await prepare(config, '/root', {
      refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
    })

    expect(mockRefreshRepo).toHaveBeenCalledTimes(2)
  })

  it('calls refreshRepo with correct repo and branch arguments', async () => {
    const { prepare } = await import('./prepare.js')
    const repo = makeRepo('my-repo', 'main')
    const config = makeConfig({ repositories: [repo] })

    await prepare(config, '/some/root', {
      refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
    })

    expect(mockRefreshRepo).toHaveBeenCalledWith(repo, 'main', '/some/root', { secrets: undefined })
  })

  it('calls all refreshRepo before runSetupHooks (strict order)', async () => {
    const { prepare } = await import('./prepare.js')
    const callOrder: string[] = []

    const orderedRefreshRepo = vi.fn().mockImplementation(async (repo: Config['repositories'][number]) => {
      callOrder.push(`refresh:${repo.name}`)
    })
    const orderedSetupHooks = vi.fn().mockImplementation(async () => {
      callOrder.push('setup')
    })

    const config = makeConfig({
      repositories: [
        makeRepo('repo-a', 'main'),
        makeRepo('repo-b', 'feature'),
      ],
      setup: [{ command: 'echo done' }],
    })

    await prepare(config, '/root', {
      refreshRepo: orderedRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: orderedSetupHooks as unknown as typeof runSetupHooks,
    })

    // All refreshes must come before setup
    expect(callOrder).toEqual(['refresh:repo-a', 'refresh:repo-b', 'setup'])
  })

  it('does not call runSetupHooks when config.setup is undefined', async () => {
    const { prepare } = await import('./prepare.js')
    const config = makeConfig({ setup: undefined })

    await prepare(config, '/root', {
      refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
    })

    expect(mockRunSetupHooks).not.toHaveBeenCalled()
  })

  it('does not call runSetupHooks when config.setup is an empty array', async () => {
    const { prepare } = await import('./prepare.js')
    const config = makeConfig({ setup: [] })

    await prepare(config, '/root', {
      refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
    })

    expect(mockRunSetupHooks).not.toHaveBeenCalled()
  })

  it('passes secrets through to refreshRepo', async () => {
    const { prepare } = await import('./prepare.js')
    const config = makeConfig({
      repositories: [makeRepo('repo-a', 'main')],
    })
    const secrets = ['secret-token', 'another-secret']

    await prepare(config, '/root', {
      refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
      secrets,
    })

    expect(mockRefreshRepo).toHaveBeenCalledWith(
      expect.any(Object),
      'main',
      '/root',
      { secrets },
    )
  })

  it('passes secrets through to runSetupHooks', async () => {
    const { prepare } = await import('./prepare.js')
    const setup = [{ command: 'echo hello' }]
    const config = makeConfig({ setup })
    const secrets = ['secret-token']

    await prepare(config, '/root', {
      refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
      runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
      secrets,
    })

    expect(mockRunSetupHooks).toHaveBeenCalledWith(setup, '/root', { secrets })
  })

  it('propagates errors from refreshRepo without wrapping', async () => {
    const { prepare } = await import('./prepare.js')
    const config = makeConfig({
      repositories: [makeRepo('repo-a', 'main')],
    })
    const error = new Error('git fetch failed')
    mockRefreshRepo.mockRejectedValue(error)

    await expect(
      prepare(config, '/root', {
        refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
        runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
      }),
    ).rejects.toThrow('git fetch failed')
  })

  it('propagates errors from runSetupHooks without wrapping', async () => {
    const { prepare } = await import('./prepare.js')
    const config = makeConfig({
      setup: [{ command: 'bad-command' }],
    })
    const error = new Error('setup command failed')
    mockRunSetupHooks.mockRejectedValue(error)

    await expect(
      prepare(config, '/root', {
        refreshRepo: mockRefreshRepo as unknown as typeof refreshRepo,
        runSetupHooks: mockRunSetupHooks as unknown as typeof runSetupHooks,
      }),
    ).rejects.toThrow('setup command failed')
  })
})
