import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInit } from './init.js'
import type { InitDeps } from './init.js'

describe('runInit', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'loop-e2e-init-test-'))
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const makeConfig = () => ({
    repositories: [
      { name: 'frontend', label: 'Frontend', url: 'https://github.com/org/frontend', role: 'frontend' as const, audience: 'user' as const },
      { name: 'backend', label: 'Backend', url: 'https://github.com/org/backend', role: 'backend' as const, audience: 'admin' as const },
    ],
    targets: [
      { name: 'app', baseUrl: 'http://localhost:3000', auth: { strategy: 'form' as const, loginPath: '/login', usernameEnv: 'APP_USER', passwordEnv: 'APP_PASS' } },
    ],
    databases: [
      { name: 'main', type: 'postgres' as const, host: 'localhost', port: 5432, database: 'app', user: 'postgres', passwordEnv: 'DB_PASS' },
    ],
    schedule: { intervalMinutes: 60 },
    scenarioDir: 'scenarios',
    github: { labels: { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' } },
    baseline: { commit: false },
    models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
    ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
    refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] as any },
  })

  const mockClient = {} as any

  const makeDeps = (overrides?: Partial<InitDeps>): InitDeps => ({
    prompt: vi.fn().mockResolvedValue(makeConfig()),
    ensureLabels: vi.fn().mockResolvedValue(undefined),
    githubClient: mockClient,
    ...overrides,
  })

  it('calls saveConfig and creates scenario and state dirs', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    // config file written
    const configPath = join(tmpRoot, 'loop-e2e.config.yaml')
    await expect(stat(configPath)).resolves.toBeTruthy()

    // scenarioDir created
    await expect(stat(join(tmpRoot, 'scenarios'))).resolves.toBeTruthy()

    // state dirs created
    for (const dir of ['baseline', 'runs', 'reports', 'feedback']) {
      await expect(stat(join(tmpRoot, '.loop-e2e', dir))).resolves.toBeTruthy()
    }
  })

  it('calls ensureLabels once per repository', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    expect(deps.ensureLabels).toHaveBeenCalledTimes(2)
    expect(deps.ensureLabels).toHaveBeenCalledWith(
      expect.anything(),
      { owner: 'org', name: 'frontend' },
      { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' },
    )
    expect(deps.ensureLabels).toHaveBeenCalledWith(
      expect.anything(),
      { owner: 'org', name: 'backend' },
      { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' },
    )
  })

  it('writes .env.example with env var names and empty values', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    const envExample = await readFile(join(tmpRoot, '.env.example'), 'utf8')
    expect(envExample).toContain('ANTHROPIC_API_KEY=')
    expect(envExample).toContain('GITHUB_TOKEN=')
    expect(envExample).toContain('DB_PASS=')
    expect(envExample).toContain('APP_PASS=')
    // must not contain actual secret values
    expect(envExample).not.toMatch(/=.+/)
  })

  it('writes .gitignore ignoring .loop-e2e/ and .env', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    const gitignore = await readFile(join(tmpRoot, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.loop-e2e/')
    expect(gitignore).toContain('.env')
  })

  it('adds negation for baseline dir when baseline.commit is true', async () => {
    const config = makeConfig()
    config.baseline = { commit: true }
    const deps = makeDeps({ prompt: vi.fn().mockResolvedValue(config) })
    await runInit(tmpRoot, {}, deps)

    const gitignore = await readFile(join(tmpRoot, '.gitignore'), 'utf8')
    expect(gitignore).toContain('!.loop-e2e/baseline/')
  })

  it('does not add baseline negation when baseline.commit is false', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    const gitignore = await readFile(join(tmpRoot, '.gitignore'), 'utf8')
    expect(gitignore).not.toContain('!.loop-e2e/baseline/')
  })

  it('is idempotent — reruns without error', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)
    // reset mock counts for second run
    vi.clearAllMocks()
    deps.prompt = vi.fn().mockResolvedValue(makeConfig())
    deps.ensureLabels = vi.fn().mockResolvedValue(undefined)
    await expect(runInit(tmpRoot, {}, deps)).resolves.toBeUndefined()
  })

  // Important 1 — null github client must not crash
  it('completes without throwing when githubClient is null and does not call ensureLabels', async () => {
    const deps = makeDeps({ githubClient: null })
    await expect(runInit(tmpRoot, {}, deps)).resolves.toBeUndefined()
    expect(deps.ensureLabels).not.toHaveBeenCalled()
  })

  it('completes without throwing when githubClient is absent (undefined)', async () => {
    const { githubClient: _omit, ...depsWithoutClient } = makeDeps()
    await expect(runInit(tmpRoot, {}, depsWithoutClient)).resolves.toBeUndefined()
    expect(depsWithoutClient.ensureLabels).not.toHaveBeenCalled()
  })

  // Important 2 — .gitignore must preserve existing user content on re-run
  it('preserves existing .gitignore user content and appends only missing loop-e2e lines', async () => {
    const { writeFile: writeFileFs } = await import('node:fs/promises')
    const gitignorePath = join(tmpRoot, '.gitignore')
    // Pre-create .gitignore with custom user content
    await writeFileFs(gitignorePath, 'node_modules/\ndist/\n', 'utf8')

    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    const gitignore = await readFile(gitignorePath, 'utf8')
    // Custom content preserved
    expect(gitignore).toContain('node_modules/')
    expect(gitignore).toContain('dist/')
    // Required loop-e2e lines present
    expect(gitignore).toContain('.loop-e2e/')
    expect(gitignore).toContain('.env')
  })

  it('does not duplicate .gitignore lines on a second run', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    // Second run
    const deps2 = makeDeps()
    await runInit(tmpRoot, {}, deps2)

    const gitignore = await readFile(join(tmpRoot, '.gitignore'), 'utf8')
    // Count occurrences — each required line should appear exactly once
    const loopCount = (gitignore.match(/^\.loop-e2e\/$/gm) ?? []).length
    const envCount = (gitignore.match(/^\.env$/gm) ?? []).length
    expect(loopCount).toBe(1)
    expect(envCount).toBe(1)
  })

  // Minor 4 — buildEnvExample must include usernameEnv
  it('writes .env.example with usernameEnv from target auth', async () => {
    const deps = makeDeps()
    await runInit(tmpRoot, {}, deps)

    const envExample = await readFile(join(tmpRoot, '.env.example'), 'utf8')
    expect(envExample).toContain('APP_USER=')
  })
})
