import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { runScenario, type ScenarioDeps } from './scenario.js'
import { saveScenario, loadScenarios, type Scenario } from '../../scenario/schema.js'
import type { Llm } from '../../services/llm/client.js'
import type { RequirementContext } from '../../services/repo/reader.js'

// Minimal valid scenario
const scenario1: Scenario = {
  id: 'sc-001',
  title: 'Login flow',
  businessFlow: 'User logs in with email',
  steps: [
    { action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' },
    { action: 'fill', target: 'email', input: 'a@b.com', expectedOutcome: 'Email filled' },
  ],
  expectedResults: [{ kind: 'ui', description: 'Dashboard shown', assertion: 'URL is /dashboard' }],
  expectedDbState: [],
}

const scenario2: Scenario = {
  id: 'sc-002',
  title: 'Logout flow',
  businessFlow: 'User logs out',
  steps: [
    { action: 'click', target: 'logout-button', expectedOutcome: 'Session cleared' },
  ],
  expectedResults: [{ kind: 'ui', description: 'Login page shown', assertion: 'URL is /login' }],
  expectedDbState: [],
}

const mockContext: RequirementContext = {
  repo: {
    name: 'app',
    label: 'App',
    url: 'https://github.com/acme/app',
    role: 'frontend',
    audience: 'user',
  },
  readme: '# App',
  docs: [],
  codeSummary: 'React app',
  gitlogSummary: 'abc Initial commit',
}

async function writeConfig(dir: string, scenarioDir: string): Promise<void> {
  const config = {
    repositories: [{ name: 'app', label: 'App', url: 'https://github.com/acme/app', role: 'frontend', audience: 'user' }],
    targets: [{ name: 'staging', baseUrl: 'https://staging.example.com' }],
    databases: [],
    schedule: { intervalMinutes: 60 },
    scenarioDir,
    github: { labels: { ready: 'ready', autoDetect: 'auto' } },
  }
  await writeFile(join(dir, 'loop-e2e.config.yaml'), stringify(config), 'utf8')
}

function makeMockLlm(): Llm {
  const mock = vi.fn(async () => [scenario1, scenario2])
  return { complete: mock } as unknown as Llm
}

describe('runScenario', () => {
  let root: string
  let scenarioDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-scenario-cmd-'))
    scenarioDir = join(root, 'scenarios')
    await mkdir(scenarioDir, { recursive: true })
    await writeConfig(root, scenarioDir)

    // Set required env vars
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    process.env['GITHUB_TOKEN'] = 'test-gh-token'
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['GITHUB_TOKEN']
  })

  function makeDeps(overrides: Partial<ScenarioDeps> = {}): ScenarioDeps {
    return {
      llm: makeMockLlm(),
      collectRequirements: async () => [mockContext],
      generateScenarios: async () => [scenario1, scenario2],
      confirm: async () => true,
      ...overrides,
    }
  }

  it('saves generated scenarios to scenarioDir', async () => {
    await runScenario(root, {}, makeDeps())

    const saved = await loadScenarios(scenarioDir)
    expect(saved.map((s) => s.id).sort()).toEqual(['sc-001', 'sc-002'])
  })

  it('skips overwrite when confirm returns false', async () => {
    // Pre-save a scenario so it shows up as existing
    await saveScenario(scenarioDir, { ...scenario1, title: 'Old title' })

    await runScenario(root, {}, makeDeps({ confirm: async () => false }))

    // The old title should remain because we declined the overwrite
    const saved = await loadScenarios(scenarioDir)
    const sc1 = saved.find((s) => s.id === 'sc-001')
    expect(sc1?.title).toBe('Old title')
  })

  it('overwrites when confirm returns true', async () => {
    await saveScenario(scenarioDir, { ...scenario1, title: 'Old title' })

    await runScenario(root, {}, makeDeps({ confirm: async () => true }))

    const saved = await loadScenarios(scenarioDir)
    const sc1 = saved.find((s) => s.id === 'sc-001')
    expect(sc1?.title).toBe('Login flow')
  })

  it('skips unchanged scenarios without prompting', async () => {
    await saveScenario(scenarioDir, scenario1)
    const confirmSpy = vi.fn(async () => true)

    await runScenario(root, {}, makeDeps({ confirm: confirmSpy, generateScenarios: async () => [scenario1] }))

    // Unchanged scenario should not trigger confirm
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('passes --from paths to collectRequirements', async () => {
    const capturedDeps: Array<Parameters<typeof import('../../services/repo/reader.js').collectRequirements>[1]> = []
    const deps = makeDeps({
      collectRequirements: async (_repos, d) => {
        capturedDeps.push(d)
        return [mockContext]
      },
    })

    await runScenario(root, { from: ['/path/to/req.md'] }, deps)

    expect(capturedDeps[0]?.fromPaths).toEqual(['/path/to/req.md'])
  })

  it('saves scenarios that do not yet exist without prompting', async () => {
    const confirmSpy = vi.fn(async () => true)

    await runScenario(root, {}, makeDeps({ confirm: confirmSpy }))

    // New scenarios should not require confirm
    expect(confirmSpy).not.toHaveBeenCalled()
    const saved = await loadScenarios(scenarioDir)
    expect(saved).toHaveLength(2)
  })
})
