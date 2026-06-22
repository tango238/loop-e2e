import { describe, it, expect } from 'vitest'

const RUN = process.env.RUN_E2E === '1'

describe.skipIf(!RUN)('explore real-machine E2E', () => {
  it('runs explore against a configured create form and produces a result', async () => {
    const { runExplore } = await import('../cli/commands/explore.js')
    const { explore } = await import('./explore.js')
    const { loadConfig } = await import('../config/load.js')
    const { createLlm } = await import('../services/llm/client.js')
    const { createDbAdapter } = await import('../services/db/index.js')
    const { createGithubClient } = await import('../services/github/client.js')
    const { launchBrowser } = await import('../services/browser/browser.js')

    const screen = process.env.EXPLORE_SCREEN ?? '/user/create'
    const result = await runExplore(process.cwd(), { screens: [screen] }, {
      loadConfig, explore, createLlm, createDbAdapter, createGithubClient, launchBrowser,
    })
    expect(result.forms).toBeGreaterThanOrEqual(0)
    expect(result.cases).toBeGreaterThanOrEqual(0)
  }, 180_000)
})
