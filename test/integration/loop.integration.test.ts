/**
 * Integration test: init → scenario → run → feedback
 *
 * All external I/O is mocked/faked — no real GitHub, DB, Anthropic, or browser.
 * Asserts state files are produced and the feedback loop updates scenario + known-state.
 *
 * Real-browser / real-DB E2E is gated behind RUN_E2E=1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Llm } from '../../src/services/llm/client.js'
import type { CollectResult } from '../../src/pipeline/collect.js'
import type { DiffFinding, VerifyFinding, RawPage, SiteStructure, PriorState } from '../../src/domain/types.js'
import type { Scenario } from '../../src/scenario/schema.js'
import { runInit, type InitDeps } from '../../src/cli/commands/init.js'
import { runScenario, type ScenarioDeps } from '../../src/cli/commands/scenario.js'
import { runRun } from '../../src/cli/commands/run.js'
import { runFeedback } from '../../src/cli/commands/feedback.js'
import { saveScenario, loadScenarios } from '../../src/scenario/schema.js'
import { loadFeedback, loadKnownFindings, saveBaseline } from '../../src/state/store.js'
import { statePaths } from '../../src/state/paths.js'
import { writeYaml, ensureDir } from '../../src/util/fs.js'
import type { Report } from '../../src/domain/types.js'
import type { Config } from '../../src/config/schema.js'
import { saveConfig } from '../../src/config/save.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLlm(): Llm {
  return {
    complete: vi.fn().mockImplementation(async (_role: string, _prompt: string, schema?: unknown) => {
      if (schema) {
        // verifyFeedback path
        return { valid: true, classification: 'false-positive', rationale: 'Integration test mock.' }
      }
      // report body path
      return '## Summary\n\nNo issues found.\n'
    }),
  } as unknown as Llm
}

function makeRawPage(): RawPage {
  return {
    url: 'https://example.com/',
    title: 'Home',
    html: '<html><head><meta name="csrf-token" content="abc"/></head><body>Home</body></html>',
    meta: { 'csrf-token': 'abc' },
    screenshotPath: '/tmp/screenshot.png',
  }
}

function makeStructure(): SiteStructure {
  return {
    generatedAt: new Date().toISOString(),
    pages: [
      {
        url: 'https://example.com/',
        title: 'Home',
        description: 'Landing page',
        meta: {},
        displayItems: [],
        inputItems: [],
        expectations: ['page loads'],
        capabilities: ['browse'],
      },
    ],
    transitions: [],
  }
}

function makeScenario(id: string): Scenario {
  return {
    id,
    title: 'Login flow',
    businessFlow: 'User logs in',
    steps: [{ action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' }],
    expectedResults: [{ kind: 'ui', description: 'Submit button visible', assertion: 'visible' }],
    expectedDbState: [],
  }
}

function makeReport(runId: string, verifyFindings: VerifyFinding[]): Report {
  return {
    runId,
    startedAt: new Date().toISOString(),
    target: 'staging',
    diffFindings: [],
    verifyFindings,
    verdicts: {},
    siteStructureRef: `runs/${runId}.yaml`,
    summary: '## Summary\n\nNo issues found.\n',
  }
}

function makeConfig(root: string): Config {
  return {
    repositories: [
      {
        name: 'example',
        label: 'Example Repo',
        url: 'https://github.com/example/repo',
        role: 'frontend',
        audience: 'user',
      },
    ],
    targets: [
      {
        name: 'staging',
        baseUrl: 'https://example.com',
        auth: { strategy: 'none' },
      },
    ],
    databases: [],
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
  }
}

// ---------------------------------------------------------------------------
// Integration suite
// ---------------------------------------------------------------------------

describe('integration: init → scenario → run → feedback', () => {
  let root: string
  let scenarioDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-integration-'))
    scenarioDir = join(root, 'scenarios')
    await ensureDir(scenarioDir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('full four-command chain: runInit → runScenario → runRun → runFeedback with mocked deps', async () => {
    // --- Step 1: runInit with mocked prompt + no github ---
    const config = makeConfig(root)
    const initDeps: InitDeps = {
      prompt: vi.fn().mockResolvedValue(config),
      ensureLabels: vi.fn().mockResolvedValue(undefined),
      githubClient: null,
    }
    await runInit(root, {}, initDeps)

    // Config file must exist
    const configPath = join(root, 'loop-e2e.config.yaml')
    const configRaw = await readFile(configPath, 'utf8')
    expect(configRaw).toContain('staging')

    // --- Step 2: runScenario with mocked collectRequirements + generateScenarios ---
    // loadConfig reads env vars for secrets; provide stubs so it doesn't throw
    const origAnthropicKey = process.env['ANTHROPIC_API_KEY']
    const origGithubToken = process.env['GITHUB_TOKEN']
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    process.env['GITHUB_TOKEN'] = 'test-token'
    try {
      const generatedScenario = makeScenario('sc-four-cmd')
      const scenarioDeps: ScenarioDeps = {
        llm: makeLlm(),
        collectRequirements: vi.fn().mockResolvedValue([]),
        generateScenarios: vi.fn().mockResolvedValue([generatedScenario]),
        confirm: vi.fn().mockResolvedValue(true),
      }
      await runScenario(root, {}, scenarioDeps)
    } finally {
      if (origAnthropicKey === undefined) {
        delete process.env['ANTHROPIC_API_KEY']
      } else {
        process.env['ANTHROPIC_API_KEY'] = origAnthropicKey
      }
      if (origGithubToken === undefined) {
        delete process.env['GITHUB_TOKEN']
      } else {
        process.env['GITHUB_TOKEN'] = origGithubToken
      }
    }

    // Scenario file must exist
    const savedScenarios = await loadScenarios(scenarioDir)
    expect(savedScenarios).toHaveLength(1)
    expect(savedScenarios[0]?.id).toBe('sc-four-cmd')

    // --- Step 3: runRun with mocked collect/detect/verify/writeReport ---
    const structure = makeStructure()
    await saveBaseline(root, structure)
    const rawPage = makeRawPage()
    const verifyFinding: VerifyFinding = {
      category: 'security',
      severity: 'high',
      title: 'Missing CSRF protection',
      detail: 'No CSRF token found in form.',
      evidence: '<form>...</form>',
    }
    const emptyPrior: PriorState = { baseline: structure, latestReport: null, feedback: [] }
    const llm = makeLlm()

    let verifyReceivedPages: RawPage[] = []
    await runRun(root, {}, {
      collect: vi.fn().mockResolvedValue({
        structure,
        prior: emptyPrior,
        rawPages: [rawPage],
      } satisfies CollectResult),
      detectDiffs: vi.fn().mockResolvedValue([] as DiffFinding[]),
      runVerify: vi.fn().mockImplementation(async (deps: { pages: RawPage[] }) => {
        verifyReceivedPages = deps.pages
        return [verifyFinding]
      }),
      writeReport: vi.fn().mockImplementation(async (rt: string, runId: string) => {
        const report = makeReport(runId, [verifyFinding])
        const paths = statePaths(rt)
        await ensureDir(join(paths.reports, runId))
        await writeFile(join(paths.reports, runId, 'report.json'), JSON.stringify(report), 'utf8')
      }),
      clock: () => 'run-four-cmd-001',
      llm,
    })

    // rawPages must have been threaded into verify
    expect(verifyReceivedPages).toHaveLength(1)
    expect(verifyReceivedPages[0]?.url).toBe('https://example.com/')

    // --- Step 4: runFeedback on the verify finding ---
    await runFeedback(root, {
      runId: 'run-four-cmd-001',
      findingIndex: 0,
      comment: 'CSRF token is present via meta tag — false positive.',
      scenarioId: 'sc-four-cmd',
      scenarioDir,
    }, { llm })

    // Feedback persisted
    const feedbacks = await loadFeedback(root)
    expect(feedbacks).toHaveLength(1)
    expect(feedbacks[0]?.verdict).toBe('valid')
    expect(feedbacks[0]?.appliedTo).toContain('sc-four-cmd')

    // Known-state entry persisted
    const known = await loadKnownFindings(root)
    expect(known.length).toBeGreaterThan(0)
    expect(known[0]?.fingerprint).toBeTruthy()
    expect(known[0]?.reason).toContain('false positive')

    // Scenario updated with false-positive annotation
    const finalScenarios = await loadScenarios(scenarioDir)
    const sc = finalScenarios.find((s) => s.id === 'sc-four-cmd')
    expect(sc).toBeDefined()
    const hasAnnotation = sc!.expectedResults.some(
      (r) => r.description.includes('[known') || r.description.includes('false-positive'),
    )
    expect(hasAnnotation).toBe(true)
  })

  it('full loop: collect produces rawPages threaded into verify, report written, feedback updates scenario', async () => {
    // --- Arrange: write a baseline and a scenario ---
    const structure = makeStructure()
    await saveBaseline(root, structure)
    const scenario = makeScenario('sc-integration')
    await saveScenario(scenarioDir, scenario)

    const rawPage = makeRawPage()
    const verifyFinding: VerifyFinding = {
      category: 'security',
      severity: 'high',
      title: 'Missing CSRF protection',
      detail: 'No CSRF token found in form.',
      evidence: '<form>...</form>',
    }

    const emptyPrior: PriorState = { baseline: structure, latestReport: null, feedback: [] }

    let verifyReceivedPages: RawPage[] = []

    const llm = makeLlm()

    // --- Act: run pipeline (all deps mocked) ---
    await runRun(root, {}, {
      collect: vi.fn().mockResolvedValue({
        structure,
        prior: emptyPrior,
        rawPages: [rawPage],
      } satisfies CollectResult),
      detectDiffs: vi.fn().mockResolvedValue([] as DiffFinding[]),
      runVerify: vi.fn().mockImplementation(async (deps: { pages: RawPage[] }) => {
        verifyReceivedPages = deps.pages
        return [verifyFinding]
      }),
      writeReport: vi.fn().mockImplementation(async (rt: string, runId: string) => {
        // Write a real report.json so feedback can load it
        const report = makeReport(runId, [verifyFinding])
        const paths = statePaths(rt)
        await ensureDir(join(paths.reports, runId))
        await writeFile(join(paths.reports, runId, 'report.json'), JSON.stringify(report), 'utf8')
      }),
      clock: () => 'run-integration-001',
      llm,
    })

    // Verify rawPages were threaded from collect into runVerify
    expect(verifyReceivedPages).toHaveLength(1)
    expect(verifyReceivedPages[0]?.url).toBe('https://example.com/')

    // --- Act: submit feedback on the verify finding ---
    await runFeedback(root, {
      runId: 'run-integration-001',
      findingIndex: 0,
      comment: 'CSRF token is present via meta tag, not form field — false positive.',
      scenarioId: 'sc-integration',
      scenarioDir,
    }, {
      llm,
    })

    // --- Assert: feedback persisted ---
    const feedbacks = await loadFeedback(root)
    expect(feedbacks).toHaveLength(1)
    expect(feedbacks[0]?.verdict).toBe('valid')
    expect(feedbacks[0]?.userComment).toContain('CSRF')
    expect(feedbacks[0]?.appliedTo).toContain('sc-integration')

    // --- Assert: known-state entry persisted ---
    const known = await loadKnownFindings(root)
    expect(known.length).toBeGreaterThan(0)
    // Durable: fingerprint must be non-empty
    expect(known[0]?.fingerprint).toBeTruthy()
    // Also verify content is as expected
    expect(known[0]?.reason).toContain('false positive')

    // --- Assert: scenario updated with false-positive annotation ---
    const scenarios = await loadScenarios(scenarioDir)
    const sc = scenarios.find((s) => s.id === 'sc-integration')
    expect(sc).toBeDefined()
    const hasAnnotation = sc!.expectedResults.some(
      (r) => r.description.includes('[known') || r.description.includes('false-positive'),
    )
    expect(hasAnnotation).toBe(true)
  })

  it('rawPages threading: pages from collect are passed to verify (not empty fallback)', async () => {
    const rawPage = makeRawPage()
    const emptyPrior: PriorState = { baseline: null, latestReport: null, feedback: [] }
    let capturedPages: RawPage[] = []

    await runRun(root, {}, {
      collect: vi.fn().mockResolvedValue({
        structure: makeStructure(),
        prior: emptyPrior,
        rawPages: [rawPage],
      } satisfies CollectResult),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockImplementation(async (deps: { pages: RawPage[] }) => {
        capturedPages = deps.pages
        return []
      }),
      writeReport: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-threading-test',
      llm: makeLlm(),
    })

    expect(capturedPages).toHaveLength(1)
    expect(capturedPages[0]?.html).toContain('csrf-token')
  })

  it('invalid feedback: scenario NOT mutated, known-state NOT added', async () => {
    const scenario = makeScenario('sc-invalid-fb')
    await saveScenario(scenarioDir, scenario)

    const verifyFinding: VerifyFinding = {
      category: 'security',
      severity: 'high',
      title: 'Real security issue',
      detail: 'XSS vulnerability detected.',
      evidence: '<script>alert(1)</script>',
    }
    const report = makeReport('run-invalid-001', [verifyFinding])
    const paths = statePaths(root)
    await ensureDir(join(paths.reports, 'run-invalid-001'))
    await writeFile(join(paths.reports, 'run-invalid-001', 'report.json'), JSON.stringify(report), 'utf8')

    const invalidLlm: Llm = {
      complete: vi.fn().mockResolvedValue({
        valid: false,
        classification: 'misunderstanding',
        rationale: 'The finding is real — user misunderstood.',
      }),
    } as unknown as Llm

    const originalScenario = makeScenario('sc-invalid-fb')

    await runFeedback(root, {
      runId: 'run-invalid-001',
      findingIndex: 0,
      comment: 'I think this is fine.',
      scenarioId: 'sc-invalid-fb',
      scenarioDir,
    }, { llm: invalidLlm })

    // Feedback persisted with invalid verdict
    const feedbacks = await loadFeedback(root)
    expect(feedbacks[0]?.verdict).toBe('invalid')

    // Known-state NOT added
    const known = await loadKnownFindings(root)
    expect(known).toHaveLength(0)

    // Scenario unchanged
    const scenarios = await loadScenarios(scenarioDir)
    const sc = scenarios.find((s) => s.id === 'sc-invalid-fb')
    expect(sc?.expectedResults).toEqual(originalScenario.expectedResults)
  })
})

// ---------------------------------------------------------------------------
// Real-browser / real-DB E2E (gated behind RUN_E2E=1)
// ---------------------------------------------------------------------------
describe('E2E (real browser + DB)', () => {
  it.runIf(process.env['RUN_E2E'] === '1')('full init→run→feedback with real browser', async () => {
    // This test requires a real running app and DB.
    // Run with: RUN_E2E=1 pnpm test test/integration
    throw new Error('Real E2E test not yet implemented — provide a test harness with a real app')
  })
})
