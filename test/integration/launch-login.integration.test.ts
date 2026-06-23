/**
 * Integration test: init (with launch) → scenario → run (with login) → down
 *
 * All external I/O is mocked — no real docker/git/fetch/db/playwright/anthropic.
 * Uses a real temp directory so file artifacts are genuinely created and read.
 * Asserts ARTIFACTS: config file exists, scenario file exists with login scenario,
 * report.json contains login finding, process.json lifecycle (created then cleared).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runInit, type InitDeps } from '../../src/cli/commands/init.js'
import { runScenario, type ScenarioDeps } from '../../src/cli/commands/scenario.js'
import { runRun, type RunDeps } from '../../src/cli/commands/run.js'
import { runDown, type DownDeps } from '../../src/cli/commands/down.js'

import { loadProcessState } from '../../src/state/process.js'
import { loadScenarios } from '../../src/scenario/schema.js'
import { statePaths } from '../../src/state/paths.js'
import { ensureDir } from '../../src/util/fs.js'

import type { Config } from '../../src/config/schema.js'
import type { ProcessState } from '../../src/state/process.js'
import type { VerifyFinding, Report, SiteStructure, PriorState, RawPage } from '../../src/domain/types.js'
import type { CollectResult } from '../../src/pipeline/collect.js'
import type { Scenario } from '../../src/scenario/schema.js'

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

function makeConfig(root: string): Config {
  return {
    repositories: [
      {
        name: 'frontend',
        label: 'Frontend',
        url: 'https://github.com/example/frontend',
        role: 'frontend',
        audience: 'user',
      },
    ],
    targets: [
      {
        name: 'app',
        baseUrl: 'http://localhost:3000',
        auth: {
          strategy: 'form',
          loginPath: '/login',
          usernameEnv: 'APP_USER',
          passwordEnv: 'APP_PASS',
        },
      },
    ],
    databases: [
      {
        name: 'main',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'app',
        user: 'postgres',
        passwordEnv: 'DB_PASS',
      },
    ],
    schedule: { intervalMinutes: 60 },
    scenarioDir: join(root, 'scenarios'),
    github: { labels: { ready: 'e2e-ready', autoDetect: 'e2e-auto' } },
    baseline: { commit: false },
    models: {
      planning: 'claude-opus-4-8',
      report: 'claude-sonnet-4-6',
      verification: 'claude-opus-4-8',
    },
    ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
    refutation: {
      panelSize: 3,
      confidenceThreshold: 0.8,
      lenses: ['correctness', 'security', 'intentionality'],
    },
    launch: {
      compose: {
        files: ['docker-compose.yml'],
        projectName: 'test-launch-project',
      },
      readiness: {
        url: 'http://localhost:3000/health',
        timeoutSec: 30,
        intervalSec: 1,
      },
      seed: { command: 'docker exec db psql -U postgres -c "SELECT 1"' },
      targetName: 'app',
    },
  }
}

function makeSecrets() {
  return {
    anthropicApiKey: 'sk-ant-test',
    githubToken: 'ghp_test',
    db: { DB_PASS: 'dbpassword' },
    targetAuth: { APP_USER: 'admin@example.com', APP_PASS: 'apppassword' },
  }
}

function makeLoginScenario(): Scenario {
  return {
    id: 'login-flow',
    title: 'User Login',
    businessFlow: 'User logs in with valid credentials',
    steps: [
      { action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' },
      { action: 'fill', target: 'input[name=email]', input: 'user@example.com', expectedOutcome: 'Email filled' },
      { action: 'fill', target: 'input[type=password]', input: 'placeholder', expectedOutcome: 'Password filled' },
      { action: 'submit', target: 'button[type=submit]', expectedOutcome: 'Logged in, redirected' },
    ],
    expectedResults: [
      { kind: 'ui', description: 'Dashboard visible after login', assertion: 'URL is /dashboard' },
    ],
    expectedDbState: [],
  }
}

function makeEmptyStructure(): SiteStructure {
  return { generatedAt: new Date().toISOString(), pages: [], transitions: [] }
}

function makeEmptyPrior(): PriorState {
  return { baseline: null, latestReport: null, feedback: [] }
}

// ---------------------------------------------------------------------------
// Full lifecycle integration test
// ---------------------------------------------------------------------------

describe('integration: init(launch) → scenario → run(login) → down', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-launch-login-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('full four-command lifecycle with mocked external I/O asserts all artifacts', async () => {
    const config = makeConfig(root)
    const secrets = makeSecrets()

    // Track call order for launch orchestration
    const callOrder: string[] = []

    // -----------------------------------------------------------------------
    // Step 1: runInit with config.launch — assert launch orchestration order
    //         and that process.json is written on disk
    // -----------------------------------------------------------------------
    const initDeps: InitDeps = {
      prompt: vi.fn().mockResolvedValue(config),
      ensureLabels: vi.fn().mockResolvedValue(undefined),
      githubClient: null,
      ensureRepoClone: vi.fn().mockImplementation(async () => {
        callOrder.push('clone')
        return join(root, 'repos', 'frontend')
      }),
      composeUp: vi.fn().mockImplementation(async () => {
        callOrder.push('composeUp')
      }),
      saveProcessState: vi.fn().mockImplementation(async (r: string, state: ProcessState) => {
        // Call the real implementation so process.json lands on disk
        const { saveProcessState: realSave } = await import('../../src/state/process.js')
        await realSave(r, state)
        callOrder.push('saveProcessState')
      }),
      waitForReadiness: vi.fn().mockImplementation(async () => {
        callOrder.push('waitForReadiness')
      }),
      seedDatabase: vi.fn().mockImplementation(async () => {
        callOrder.push('seedDatabase')
      }),
      secrets,
      now: () => '2024-06-21T00:00:00.000Z',
    }

    await runInit(root, {}, initDeps)

    // --- Assert: config file exists ---
    const configPath = join(root, 'loop-e2e.config.yaml')
    const configContent = await readFile(configPath, 'utf8')
    expect(configContent).toContain('test-launch-project')
    expect(configContent).toContain('http://localhost:3000')

    // --- Assert: repos cloned (one per repository) ---
    expect(initDeps.ensureRepoClone).toHaveBeenCalledTimes(1)
    expect(initDeps.ensureRepoClone).toHaveBeenCalledWith(
      config.repositories[0],
      secrets.githubToken,
      config.ingestion,
      root,
    )

    // --- Assert: call order: clone → composeUp → saveProcessState → waitForReadiness → seedDatabase ---
    expect(callOrder).toEqual(['clone', 'composeUp', 'saveProcessState', 'waitForReadiness', 'seedDatabase'])

    // --- Assert: process.json written on disk ---
    const processState = await loadProcessState(root)
    expect(processState).not.toBeNull()
    expect(processState?.projectName).toBe('test-launch-project')
    expect(processState?.composeFiles).toEqual(['docker-compose.yml'])
    expect(processState?.startedAt).toBe('2024-06-21T00:00:00.000Z')
    expect(processState?.readinessUrl).toBe('http://localhost:3000/health')

    // -----------------------------------------------------------------------
    // Step 2: runScenario with fake LLM — assert scenario file written
    //         including a login scenario
    // -----------------------------------------------------------------------
    // runScenario calls loadConfig internally, which requires env vars.
    // Stub all required env vars for this block and restore them after.
    const envStubs: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
      DB_PASS: process.env['DB_PASS'],
      APP_USER: process.env['APP_USER'],
      APP_PASS: process.env['APP_PASS'],
    }
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    process.env['GITHUB_TOKEN'] = 'ghp_test'
    process.env['DB_PASS'] = 'dbpassword'
    process.env['APP_USER'] = 'admin@example.com'
    process.env['APP_PASS'] = 'apppassword'

    try {
      const loginScenario = makeLoginScenario()
      const scenarioDeps: ScenarioDeps = {
        llm: {
          complete: vi.fn().mockResolvedValue('mock LLM response'),
        } as never,
        collectRequirements: vi.fn().mockResolvedValue([]),
        generateScenarios: vi.fn().mockResolvedValue([loginScenario]),
        confirm: vi.fn().mockResolvedValue(true),
      }
      await runScenario(root, {}, scenarioDeps)
    } finally {
      for (const [key, val] of Object.entries(envStubs)) {
        if (val === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = val
        }
      }
    }

    // --- Assert: scenario file exists on disk ---
    const scenarioDir = config.scenarioDir
    const savedScenarios = await loadScenarios(scenarioDir)
    expect(savedScenarios).toHaveLength(1)
    expect(savedScenarios[0]?.id).toBe('login-flow')
    expect(savedScenarios[0]?.title).toContain('Login')

    // --- Assert: scenario file physically exists ---
    await expect(access(join(scenarioDir, 'login-flow.scenario.yaml'))).resolves.toBeUndefined()

    // -----------------------------------------------------------------------
    // Step 3: runRun with injected fake executeLogin returning success
    //         assert report.json contains category:'login' finding
    // -----------------------------------------------------------------------
    const runId = 'run-launch-login-001'
    const loginScenario = makeLoginScenario()

    const fakePage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('http://localhost:3000/dashboard'),
      title: vi.fn().mockResolvedValue('Dashboard'),
      content: vi.fn().mockResolvedValue('<html></html>'),
      evaluate: vi.fn().mockResolvedValue({}),
      screenshot: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        fill: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
      }),
    }

    const executeLogin = vi.fn().mockResolvedValue({
      ok: true,
      detail: 'login succeeded: navigated to http://localhost:3000/dashboard',
      finalUrl: 'http://localhost:3000/dashboard',
    })
    const createPage = vi.fn().mockResolvedValue(fakePage)

    const paths = statePaths(root)

    // Capture the verifyFindings actually passed by runRun to writeReport so we
    // can assert that the wiring from executeLogin → verifyFindings → writeReport
    // is real (not hardcoded inside the mock).
    let capturedVerifyFindings: VerifyFinding[] = []

    const runDeps: RunDeps = {
      collect: vi.fn().mockResolvedValue({
        structure: makeEmptyStructure(),
        prior: makeEmptyPrior(),
        rawPages: [] as RawPage[],
      } satisfies CollectResult),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([] as VerifyFinding[]),
      writeFindings: vi.fn().mockImplementation(async (r: string, entry: { runId: string; verifyFindings: VerifyFinding[] }) => {
        // Capture findings produced by runRun (including the login finding wired from executeLogin)
        capturedVerifyFindings = entry.verifyFindings

        // Write a real report.json so the artifact assertion below still holds (run now produces
        // findings; the report would be written by the separate `report` step — emulated here).
        const report: Report = {
          runId: entry.runId,
          startedAt: new Date().toISOString(),
          target: 'app',
          diffFindings: [],
          verifyFindings: entry.verifyFindings,
          verdicts: {},
          siteStructureRef: `runs/${entry.runId}.yaml`,
          summary: '## Summary\n\nLogin succeeded.\n',
        }
        await ensureDir(join(paths.reports, entry.runId))
        await writeFile(join(paths.reports, entry.runId, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
      }),
      clock: () => runId,
      scenarios: [loginScenario],
      ctx: {
        root,
        runId,
        config,
        secrets: {
          db: secrets.db,
          targetAuth: { APP_USER: 'user@example.com', APP_PASS: 'apppassword' },
          anthropicApiKey: secrets.anthropicApiKey,
          githubToken: secrets.githubToken,
        },
      },
      executeLogin,
      createPage,
    }

    await runRun(root, {}, runDeps)

    // --- Assert: executeLogin called ---
    expect(executeLogin).toHaveBeenCalledOnce()

    // --- Assert: runRun wired executeLogin's result into writeReport's verifyFindings ---
    // This proves the pipeline wiring is real: a regression that stops passing
    // loginFindings into writeReport would fail here, not just on the file artifact.
    const capturedLoginFinding = capturedVerifyFindings.find((f) => f.category === 'login')
    expect(capturedLoginFinding).toBeDefined()
    expect(capturedLoginFinding?.severity).toBe('low')
    expect(capturedLoginFinding?.title).toContain('Login succeeded')

    // --- Assert: report.json exists on disk ---
    const reportPath = join(paths.reports, runId, 'report.json')
    await expect(access(reportPath)).resolves.toBeUndefined()

    // --- Assert: report.json on disk reflects the captured findings ---
    const reportContent = await readFile(reportPath, 'utf8')
    const report = JSON.parse(reportContent) as Report
    const loginFinding = report.verifyFindings.find((f) => f.category === 'login')
    expect(loginFinding).toBeDefined()
    expect(loginFinding?.severity).toBe('low')
    expect(loginFinding?.title).toContain('Login succeeded')

    // -----------------------------------------------------------------------
    // Step 4: runDown — assert composeDown called and process.json cleared
    // -----------------------------------------------------------------------
    const composeDown = vi.fn().mockResolvedValue(undefined)

    const downDeps: DownDeps = {
      loadProcessState,
      composeDown,
      clearProcessState: async (r: string) => {
        const { clearProcessState: realClear } = await import('../../src/state/process.js')
        await realClear(r)
      },
    }

    await runDown(root, {}, downDeps)

    // --- Assert: composeDown called with correct state ---
    expect(composeDown).toHaveBeenCalledOnce()
    const downCallArgs = composeDown.mock.calls[0] as unknown[]
    const downState = downCallArgs[0] as { projectName: string; composeFiles: string[] }
    expect(downState.projectName).toBe('test-launch-project')
    expect(downState.composeFiles).toEqual(['docker-compose.yml'])

    // --- Assert: process.json cleared (loadProcessState now returns null) ---
    const clearedState = await loadProcessState(root)
    expect(clearedState).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Targeted lifecycle assertions
  // -------------------------------------------------------------------------

  it('runInit with launch writes .env.example file', async () => {
    const config = makeConfig(root)
    const secrets = makeSecrets()

    const initDeps: InitDeps = {
      prompt: vi.fn().mockResolvedValue(config),
      ensureLabels: vi.fn().mockResolvedValue(undefined),
      githubClient: null,
      ensureRepoClone: vi.fn().mockResolvedValue(join(root, 'repos', 'frontend')),
      composeUp: vi.fn().mockResolvedValue(undefined),
      saveProcessState: vi.fn().mockImplementation(async (r: string, state: ProcessState) => {
        const { saveProcessState: realSave } = await import('../../src/state/process.js')
        await realSave(r, state)
      }),
      waitForReadiness: vi.fn().mockResolvedValue(undefined),
      seedDatabase: vi.fn().mockResolvedValue(undefined),
      secrets,
    }

    await runInit(root, {}, initDeps)

    const envExamplePath = join(root, '.env.example')
    const envContent = await readFile(envExamplePath, 'utf8')
    expect(envContent).toContain('ANTHROPIC_API_KEY=')
    expect(envContent).toContain('GITHUB_TOKEN=')
    expect(envContent).toContain('DB_PASS=')
    expect(envContent).toContain('APP_PASS=')
  })

  it('runInit with launch writes .gitignore with required entries', async () => {
    const config = makeConfig(root)
    const secrets = makeSecrets()

    const initDeps: InitDeps = {
      prompt: vi.fn().mockResolvedValue(config),
      ensureLabels: vi.fn().mockResolvedValue(undefined),
      githubClient: null,
      ensureRepoClone: vi.fn().mockResolvedValue(join(root, 'repos', 'frontend')),
      composeUp: vi.fn().mockResolvedValue(undefined),
      saveProcessState: vi.fn().mockImplementation(async (r: string, state: ProcessState) => {
        const { saveProcessState: realSave } = await import('../../src/state/process.js')
        await realSave(r, state)
      }),
      waitForReadiness: vi.fn().mockResolvedValue(undefined),
      seedDatabase: vi.fn().mockResolvedValue(undefined),
      secrets,
    }

    await runInit(root, {}, initDeps)

    const gitignorePath = join(root, '.gitignore')
    const gitignoreContent = await readFile(gitignorePath, 'utf8')
    expect(gitignoreContent).toContain('.loop-e2e/')
    expect(gitignoreContent).toContain('.env')
  })

  it('runDown with no running stack is a no-op (composeDown not called)', async () => {
    const composeDown = vi.fn().mockResolvedValue(undefined)

    const downDeps: DownDeps = {
      loadProcessState: vi.fn().mockResolvedValue(null),
      composeDown,
      clearProcessState: vi.fn().mockResolvedValue(undefined),
    }

    await runDown(root, {}, downDeps)

    expect(composeDown).not.toHaveBeenCalled()
  })

  it('runRun without executeLogin dep does not attempt login execution', async () => {
    const loginScenario = makeLoginScenario()
    let capturedVerifyFindings: VerifyFinding[] = []

    const runDeps: RunDeps = {
      collect: vi.fn().mockResolvedValue({
        structure: makeEmptyStructure(),
        prior: makeEmptyPrior(),
        rawPages: [] as RawPage[],
      } satisfies CollectResult),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockImplementation(async (_r: string, entry: { verifyFindings: VerifyFinding[] }) => {
        capturedVerifyFindings = entry.verifyFindings
      }),
      clock: () => 'run-no-login-deps',
      scenarios: [loginScenario],
      // executeLogin and createPage deliberately omitted
    }

    await runRun(root, {}, runDeps)

    // No login finding because executeLogin dep is absent
    const loginFinding = capturedVerifyFindings.find((f) => f.category === 'login')
    expect(loginFinding).toBeUndefined()
  })
})
