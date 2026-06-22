import { describe, it, expect, vi } from 'vitest'
import { runExplore } from './explore.js'

describe('runExplore', () => {
  const config = {
    targets: [{ name: 't', baseUrl: 'http://app', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'U', passwordEnv: 'P', twoFactor: { pinCommand: 'pin' } } }],
    databases: [{ type: 'postgres', passwordEnv: 'DBPASS' }],
    launch: { seed: { command: 'seed-cmd' } },
    models: { planning: 'o', report: 's', verification: 'o' },
    refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: [] },
    github: { labels: { ready: 'R', autoDetect: 'A' } },
    repositories: [],
    setup: [],
  }
  const secrets = { db: { DBPASS: 'pw' }, targetAuth: { U: 'user', P: 'pass' }, anthropicApiKey: 'k', githubToken: '' }

  it('resolves config and invokes explore with wired deps', async () => {
    const exploreFn = vi.fn(async () => ({ findings: [], forms: 2, cases: 9, gapsHigh: 1, gapsMedium: 0, messageIssues: 1 }))
    const res = await runExplore('/cwd', { screens: ['/user/create'] }, {
      loadConfig: async () => ({ config, secrets }) as never,
      explore: exploreFn as never,
      createLlm: () => ({}) as never,
      createDbAdapter: () => ({ query: async () => [], close: async () => {} }),
      createGithubClient: () => ({}) as never,
      launchBrowser: async () => ({ browser: { newPage: async () => ({ close: async () => {} }), close: async () => {} } }) as never,
    } as never)
    expect(exploreFn).toHaveBeenCalledOnce()
    expect(res.gapsHigh).toBe(1)
  })

  it('throws when the named target is missing', async () => {
    await expect(
      runExplore('/cwd', { target: 'nope' }, {
        loadConfig: async () => ({ config: { ...config, targets: [] }, secrets }) as never,
        explore: vi.fn() as never,
        createLlm: () => ({}) as never,
        createDbAdapter: () => ({ query: async () => [], close: async () => {} }),
        createGithubClient: () => ({}) as never,
        launchBrowser: async () => ({ browser: { newPage: async () => ({}), close: async () => {} } }) as never,
      } as never),
    ).rejects.toThrow()
  })
})
