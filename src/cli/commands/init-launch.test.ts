import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInit } from './init.js'
import type { InitDeps } from './init.js'
import type { ProcessState } from '../../state/process.js'

describe('runInit — launch orchestration (Task 3.1)', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'loop-e2e-init-launch-'))
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  const makeBaseConfig = () => ({
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

  const makeLaunch = () => ({
    compose: { files: ['docker-compose.yml'], projectName: 'test-project' },
    readiness: { url: 'http://localhost:3000/health', timeoutSec: 60, intervalSec: 3 },
    seed: { command: 'docker exec db psql -U postgres -c "SELECT 1"' },
    targetName: 'app',
  })

  const makeSecrets = () => ({
    anthropicApiKey: 'sk-ant-test',
    githubToken: 'ghp_test',
    db: { DB_PASS: 'dbpassword' },
    targetAuth: { APP_PASS: 'apppassword' },
  })

  const makeDeps = (overrides?: Partial<InitDeps>): InitDeps => ({
    prompt: vi.fn().mockResolvedValue(makeBaseConfig()),
    ensureLabels: vi.fn().mockResolvedValue(undefined),
    githubClient: null,
    composeUp: vi.fn().mockResolvedValue(undefined),
    waitForReadiness: vi.fn().mockResolvedValue(undefined),
    seedDatabase: vi.fn().mockResolvedValue(undefined),
    ensureRepoClone: vi.fn().mockResolvedValue('/tmp/repo'),
    saveProcessState: vi.fn().mockResolvedValue(undefined),
    secrets: makeSecrets(),
    now: () => '2024-01-01T00:00:00.000Z',
    ...overrides,
  })

  it('launch present: calls clone → composeUp → saveProcessState → waitForReadiness → seedDatabase in order', async () => {
    const callOrder: string[] = []
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({
      prompt: vi.fn().mockResolvedValue(config),
      ensureRepoClone: vi.fn().mockImplementation(async () => { callOrder.push('clone'); return '/tmp/repo' }),
      composeUp: vi.fn().mockImplementation(async () => { callOrder.push('composeUp') }),
      saveProcessState: vi.fn().mockImplementation(async () => { callOrder.push('saveProcessState') }),
      waitForReadiness: vi.fn().mockImplementation(async () => { callOrder.push('waitForReadiness') }),
      seedDatabase: vi.fn().mockImplementation(async () => { callOrder.push('seedDatabase') }),
    })

    await runInit(tmpRoot, {}, deps)

    expect(callOrder).toEqual(['clone', 'clone', 'composeUp', 'saveProcessState', 'waitForReadiness', 'seedDatabase'])
  })

  it('launch present: ensureRepoClone called once per repository', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({ prompt: vi.fn().mockResolvedValue(config) })

    await runInit(tmpRoot, {}, deps)

    expect(deps.ensureRepoClone).toHaveBeenCalledTimes(2)
    expect(deps.ensureRepoClone).toHaveBeenCalledWith(
      config.repositories[0],
      makeSecrets().githubToken,
      config.ingestion,
      tmpRoot,
    )
    expect(deps.ensureRepoClone).toHaveBeenCalledWith(
      config.repositories[1],
      makeSecrets().githubToken,
      config.ingestion,
      tmpRoot,
    )
  })

  it('launch present: composeUp called with launch config, root, and allSecrets', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({ prompt: vi.fn().mockResolvedValue(config) })
    const secrets = makeSecrets()

    await runInit(tmpRoot, {}, deps)

    const expectedSecrets = [
      secrets.anthropicApiKey,
      secrets.githubToken,
      ...Object.values(secrets.db),
      ...Object.values(secrets.targetAuth),
    ].filter(Boolean)

    expect(deps.composeUp).toHaveBeenCalledWith(config.launch, tmpRoot, undefined, expectedSecrets)
  })

  it('launch present: saveProcessState called with correct state immediately after composeUp', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({ prompt: vi.fn().mockResolvedValue(config) })

    await runInit(tmpRoot, {}, deps)

    const expectedState: ProcessState = {
      projectName: 'test-project',
      composeFiles: ['docker-compose.yml'],
      startedAt: '2024-01-01T00:00:00.000Z',
      readinessUrl: 'http://localhost:3000/health',
    }
    expect(deps.saveProcessState).toHaveBeenCalledWith(tmpRoot, expectedState)
  })

  it('launch present: waitForReadiness called with readiness config', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({ prompt: vi.fn().mockResolvedValue(config) })

    await runInit(tmpRoot, {}, deps)

    expect(deps.waitForReadiness).toHaveBeenCalledWith(
      'http://localhost:3000/health',
      { timeoutSec: 60, intervalSec: 3 },
    )
  })

  it('launch present: seedDatabase called with seed config when seed is present', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({ prompt: vi.fn().mockResolvedValue(config) })
    const secrets = makeSecrets()

    await runInit(tmpRoot, {}, deps)

    const expectedSecrets = [
      secrets.anthropicApiKey,
      secrets.githubToken,
      ...Object.values(secrets.db),
      ...Object.values(secrets.targetAuth),
    ].filter(Boolean)

    expect(deps.seedDatabase).toHaveBeenCalledWith(
      config.launch!.seed,
      tmpRoot,
      undefined,
      expectedSecrets,
    )
  })

  it('launch absent: clone, composeUp, saveProcessState, waitForReadiness, seedDatabase not called', async () => {
    const deps = makeDeps()
    // prompt returns config without launch

    await runInit(tmpRoot, {}, deps)

    expect(deps.ensureRepoClone).not.toHaveBeenCalled()
    expect(deps.composeUp).not.toHaveBeenCalled()
    expect(deps.saveProcessState).not.toHaveBeenCalled()
    expect(deps.waitForReadiness).not.toHaveBeenCalled()
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('readiness failure: error propagates, seedDatabase not called, saveProcessState WAS already called', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const readinessError = new Error('timeout waiting for readiness')
    const deps = makeDeps({
      prompt: vi.fn().mockResolvedValue(config),
      waitForReadiness: vi.fn().mockRejectedValue(readinessError),
    })

    await expect(runInit(tmpRoot, {}, deps)).rejects.toThrow('readiness check')

    // saveProcessState was called before readiness
    expect(deps.saveProcessState).toHaveBeenCalledTimes(1)
    // seedDatabase was NOT called
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('launch with no seed: seedDatabase not called', async () => {
    const launchNoSeed = { ...makeLaunch(), seed: undefined }
    const config = { ...makeBaseConfig(), launch: launchNoSeed }
    const deps = makeDeps({ prompt: vi.fn().mockResolvedValue(config) })

    await runInit(tmpRoot, {}, deps)

    expect(deps.seedDatabase).not.toHaveBeenCalled()
    expect(deps.composeUp).toHaveBeenCalledTimes(1)
    expect(deps.waitForReadiness).toHaveBeenCalledTimes(1)
  })

  it('launch present but a launch dep missing: rejects with clear error, composeUp not called', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({
      prompt: vi.fn().mockResolvedValue(config),
      composeUp: undefined,
    })

    await expect(runInit(tmpRoot, {}, deps)).rejects.toThrow(
      'init launch requires deps: composeUp, waitForReadiness, seedDatabase, ensureRepoClone, saveProcessState',
    )

    expect(deps.ensureRepoClone).not.toHaveBeenCalled()
  })

  it('launch present + repos + no github token: rejects with clear error before any clone/composeUp call', async () => {
    const config = { ...makeBaseConfig(), launch: makeLaunch() }
    const deps = makeDeps({
      prompt: vi.fn().mockResolvedValue(config),
      secrets: { anthropicApiKey: 'sk-ant-test', githubToken: '', db: {}, targetAuth: {} },
    })

    await expect(runInit(tmpRoot, {}, deps)).rejects.toThrow(
      'GITHUB_TOKEN is required to clone repositories for launch',
    )

    expect(deps.ensureRepoClone).not.toHaveBeenCalled()
    expect(deps.composeUp).not.toHaveBeenCalled()
  })
})
