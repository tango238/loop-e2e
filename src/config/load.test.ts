import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from './save.js'
import { loadConfig } from './load.js'
import type { Config } from './schema.js'

// A valid config fixture matching ConfigSchema requirements
const valid: Config = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'staging', baseUrl: 'https://staging.example.com', auth: { strategy: 'none' } }],
  databases: [{ name: 'main', type: 'postgres', host: 'localhost', port: 5432, database: 'app', user: 'app', passwordEnv: 'DB_MAIN_PASSWORD' }],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  baseline: { commit: false },
  models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
  ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
}

describe('loadConfig', () => {
  let dir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'le2e-'))
    // Save a snapshot of env so we can restore it after each test
    originalEnv = { ...process.env }
  })

  afterEach(async () => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips config and resolves secrets', async () => {
    await saveConfig(dir, valid)
    await writeFile(join(dir, '.env'), 'DB_MAIN_PASSWORD=secret\nANTHROPIC_API_KEY=ant-key\nGITHUB_TOKEN=gh-token\n')

    const { config, secrets } = await loadConfig(dir)
    expect(config.scenarioDir).toBe('scenarios')
    expect(secrets.db['DB_MAIN_PASSWORD']).toBe('secret')
    expect(secrets.anthropicApiKey).toBe('ant-key')
    expect(secrets.githubToken).toBe('gh-token')
  })

  it('throws a clear error when a required env var is missing (no secret value in message)', async () => {
    await saveConfig(dir, valid)
    // Write .env without DB_MAIN_PASSWORD
    await writeFile(join(dir, '.env'), 'ANTHROPIC_API_KEY=ant-key\nGITHUB_TOKEN=gh-token\n')
    // Ensure the DB env var is not in process.env
    delete process.env['DB_MAIN_PASSWORD']

    await expect(loadConfig(dir)).rejects.toThrow('DB_MAIN_PASSWORD')
  })
})
