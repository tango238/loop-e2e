import { describe, it, expect, vi } from 'vitest'
import type { CollectResult } from '../../pipeline/collect.js'
import type { DiffFinding, VerifyFinding } from '../../domain/types.js'
import { runRun } from './run.js'

const emptyStructure = { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] }
const emptyPrior = { baseline: null, latestReport: null, feedback: [] }

const sampleFinding: DiffFinding = {
  kind: 'transition',
  severity: 'high',
  expected: 'expected',
  actual: 'actual',
  location: '/home',
}

const sampleVerifyFinding: VerifyFinding = {
  category: 'security',
  severity: 'high',
  title: 'Test security issue',
  detail: 'Details here',
  evidence: 'evidence string',
}

function makeCollectResult(): CollectResult {
  return { structure: emptyStructure, prior: emptyPrior, rawPages: [] }
}

describe('runRun', () => {
  it('calls stages in order: collect → diff → verify → report', async () => {
    const order: string[] = []

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff'); return [] }),
      runVerify: vi.fn().mockImplementation(async () => { order.push('verify'); return [] }),
      writeReport: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-2024-01-01',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect', 'diff', 'verify', 'report'])
    expect(deps.collect).toHaveBeenCalledOnce()
    expect(deps.detectDiffs).toHaveBeenCalledOnce()
    expect(deps.runVerify).toHaveBeenCalledOnce()
    expect(deps.writeReport).toHaveBeenCalledOnce()
  })

  it('uses injected clock for deterministic runId', async () => {
    const capturedRunIds: string[] = []

    const deps = {
      collect: vi.fn().mockImplementation(async (ctx: { runId: string }) => { capturedRunIds.push(ctx.runId); return makeCollectResult() }),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockResolvedValue(undefined),
      clock: () => 'test-run-fixed',
    }

    await runRun('/tmp/root', {}, deps)
    expect(capturedRunIds[0]).toBe('test-run-fixed')
  })

  it('passes verifyFindings from runVerify to writeReport', async () => {
    let capturedVerifyFindings: unknown = 'not-set'

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([sampleFinding]),
      runVerify: vi.fn().mockResolvedValue([sampleVerifyFinding]),
      writeReport: vi.fn().mockImplementation(async (_root: string, _runId: string, reportDeps: { verifyFindings: unknown }) => {
        capturedVerifyFindings = reportDeps.verifyFindings
      }),
      clock: () => 'run-wired',
    }

    await runRun('/tmp/root', {}, deps)
    expect(capturedVerifyFindings).toEqual([sampleVerifyFinding])
  })

  it('if collect fails, diff, verify and report still run with empty structure', async () => {
    const order: string[] = []

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect-fail'); throw new Error('crawl error') }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff'); return [] }),
      runVerify: vi.fn().mockImplementation(async () => { order.push('verify'); return [] }),
      writeReport: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-partial',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect-fail', 'diff', 'verify', 'report'])
    expect(deps.detectDiffs).toHaveBeenCalledOnce()
    expect(deps.runVerify).toHaveBeenCalledOnce()
    expect(deps.writeReport).toHaveBeenCalledOnce()
  })

  it('if diff fails, verify and report still run with empty diffFindings', async () => {
    const order: string[] = []
    let capturedDiffFindings: unknown = 'not-set'

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff-fail'); throw new Error('diff error') }),
      runVerify: vi.fn().mockImplementation(async () => { order.push('verify'); return [] }),
      writeReport: vi.fn().mockImplementation(async (_root: string, _runId: string, reportDeps: { diffFindings: unknown }) => {
        order.push('report')
        capturedDiffFindings = reportDeps.diffFindings
      }),
      clock: () => 'run-partial-diff',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect', 'diff-fail', 'verify', 'report'])
    expect(capturedDiffFindings).toEqual([])
  })

  it('if verify fails, report still runs with empty verifyFindings', async () => {
    const order: string[] = []
    let capturedVerifyFindings: unknown = 'not-set'

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff'); return [] }),
      runVerify: vi.fn().mockImplementation(async () => { order.push('verify-fail'); throw new Error('verify error') }),
      writeReport: vi.fn().mockImplementation(async (_root: string, _runId: string, reportDeps: { verifyFindings: unknown }) => {
        order.push('report')
        capturedVerifyFindings = reportDeps.verifyFindings
      }),
      clock: () => 'run-partial-verify',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect', 'diff', 'verify-fail', 'report'])
    expect(capturedVerifyFindings).toEqual([])
  })

  it('threads deps.scenarios into detectDiffs — not hardcoded []', async () => {
    const scenario = {
      id: 'sc-1',
      title: 'Login flow',
      businessFlow: 'User logs in',
      steps: [{ action: 'navigate', target: '/login', expectedOutcome: 'Form loads' }],
      expectedResults: [{ kind: 'ui' as const, description: 'Form visible', assertion: 'form present' }],
      expectedDbState: [],
    }
    let capturedScenarios: unknown = 'not-set'

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockImplementation(async (d: { scenarios: unknown }) => {
        capturedScenarios = d.scenarios
        return []
      }),
      runVerify: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-scenarios-threaded',
      scenarios: [scenario],
    }

    await runRun('/tmp/root', {}, deps)
    expect(capturedScenarios).toEqual([scenario])
  })

  it('passes adjudicate dep through to writeReport without defaulting to no-op', async () => {
    const realAdjudicate = vi.fn().mockResolvedValue({
      classification: 'bug' as const,
      confidence: 0.9,
      confirmedCount: 3,
      panelSize: 3,
      votes: [],
      rationale: 'real adjudicate called',
    })

    const writeReportDeps: Record<string, unknown> = {}
    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([sampleFinding]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockImplementation(async (_root: string, _runId: string, d: Record<string, unknown>) => {
        Object.assign(writeReportDeps, d)
      }),
      clock: () => 'run-real-adjudicate',
      adjudicate: realAdjudicate,
    }

    await runRun('/tmp/root', {}, deps)
    expect(writeReportDeps['adjudicate']).toBe(realAdjudicate)
  })

  it('passes store.saveBaseline dep through to writeReport without defaulting to no-op', async () => {
    const realSaveBaseline = vi.fn().mockResolvedValue(undefined)
    const writeReportDeps: Record<string, unknown> = {}
    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockImplementation(async (_root: string, _runId: string, d: Record<string, unknown>) => {
        Object.assign(writeReportDeps, d)
      }),
      clock: () => 'run-real-store',
      store: { saveBaseline: realSaveBaseline },
    }

    await runRun('/tmp/root', {}, deps)
    const store = writeReportDeps['store'] as { saveBaseline: unknown }
    expect(store?.saveBaseline).toBe(realSaveBaseline)
  })

  // --- Task 4.4: login scenario execution ---

  it('executes login scenario when detected and includes result in verifyFindings', async () => {
    const loginScenario = {
      id: 'sc-001',
      title: 'User login',
      businessFlow: 'User logs in with credentials',
      steps: [
        { action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' },
        { action: 'fill', target: 'input[name=email]', input: 'user@example.com', expectedOutcome: 'Email filled' },
        { action: 'fill', target: 'input[type=password]', input: 'placeholder', expectedOutcome: 'Password filled' },
        { action: 'submit', target: 'button[type=submit]', expectedOutcome: 'Submitted' },
      ],
      expectedResults: [{ kind: 'ui' as const, description: 'Dashboard', assertion: 'URL is /dashboard' }],
      expectedDbState: [],
    }

    const executeLogin = vi.fn().mockResolvedValue({ ok: true, detail: 'Login succeeded — navigated to /dashboard', finalUrl: 'http://localhost:3000/dashboard' })
    const fakePage = { goto: vi.fn(), url: vi.fn(() => 'http://localhost:3000/dashboard'), title: vi.fn(), content: vi.fn(), evaluate: vi.fn(), screenshot: vi.fn(), waitForLoadState: vi.fn(), locator: vi.fn() }
    const createPage = vi.fn().mockResolvedValue(fakePage)

    let capturedVerifyFindings: VerifyFinding[] = []
    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockImplementation(async (_r: string, _id: string, d: { verifyFindings: VerifyFinding[] }) => {
        capturedVerifyFindings = d.verifyFindings
      }),
      clock: () => 'run-login-4.4',
      scenarios: [loginScenario],
      ctx: {
        root: '/tmp/root',
        runId: 'run-login-4.4',
        config: {
          repositories: [{ name: 'app', label: 'App', url: 'https://github.com/acme/app', role: 'frontend' as const, audience: 'user' as const }],
          targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form' as const, loginPath: '/login', usernameEnv: 'USERNAME', passwordEnv: 'PASSWORD' } }],
          databases: [],
          schedule: { intervalMinutes: 60 },
          scenarioDir: 'scenarios',
          github: { labels: { ready: 'ready', autoDetect: 'auto' } },
          baseline: { commit: false },
          models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
          ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
          refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness' as const, 'security' as const, 'intentionality' as const] },
        },
        secrets: {
          db: {},
          targetAuth: { USERNAME: 'testuser@example.com', PASSWORD: 'secret-pass' },
          anthropicApiKey: '',
          githubToken: '',
        },
      },
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    expect(executeLogin).toHaveBeenCalledOnce()
    expect(capturedVerifyFindings.some((f) => f.category === 'login')).toBe(true)
    const loginFinding = capturedVerifyFindings.find((f) => f.category === 'login')!
    expect(loginFinding.severity).toBe('low')  // success = low severity
    expect(loginFinding.detail).not.toContain('secret-pass')
  })

  it('records login finding as high severity when login fails', async () => {
    const loginScenario = {
      id: 'sc-001',
      title: 'Login scenario',
      businessFlow: 'User logs in',
      steps: [
        { action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' },
        { action: 'submit', target: 'button[type=submit]', expectedOutcome: 'Submitted' },
      ],
      expectedResults: [{ kind: 'ui' as const, description: 'Dashboard', assertion: 'URL changes' }],
      expectedDbState: [],
    }

    const executeLogin = vi.fn().mockResolvedValue({ ok: false, detail: 'Login failed: still on /login', finalUrl: 'http://localhost:3000/login' })
    const fakePage = { goto: vi.fn(), url: vi.fn(), title: vi.fn(), content: vi.fn(), evaluate: vi.fn(), screenshot: vi.fn(), waitForLoadState: vi.fn(), locator: vi.fn() }
    const createPage = vi.fn().mockResolvedValue(fakePage)

    let capturedVerifyFindings: VerifyFinding[] = []
    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockImplementation(async (_r: string, _id: string, d: { verifyFindings: VerifyFinding[] }) => {
        capturedVerifyFindings = d.verifyFindings
      }),
      clock: () => 'run-login-fail',
      scenarios: [loginScenario],
      ctx: {
        root: '/tmp/root',
        runId: 'run-login-fail',
        config: {
          repositories: [{ name: 'app', label: 'App', url: 'https://github.com/acme/app', role: 'frontend' as const, audience: 'user' as const }],
          targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form' as const, loginPath: '/login', usernameEnv: 'USERNAME', passwordEnv: 'PASSWORD' } }],
          databases: [],
          schedule: { intervalMinutes: 60 },
          scenarioDir: 'scenarios',
          github: { labels: { ready: 'ready', autoDetect: 'auto' } },
          baseline: { commit: false },
          models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
          ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
          refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness' as const, 'security' as const, 'intentionality' as const] },
        },
        secrets: {
          db: {},
          targetAuth: { USERNAME: 'testuser', PASSWORD: 'wrongpass' },
          anthropicApiKey: '',
          githubToken: '',
        },
      },
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    const loginFinding = capturedVerifyFindings.find((f) => f.category === 'login')!
    expect(loginFinding).toBeDefined()
    expect(loginFinding.severity).toBe('high')
    expect(loginFinding.detail).not.toContain('wrongpass')
  })

  it('skips login execution when no login scenario is present', async () => {
    const nonLoginScenario = {
      id: 'sc-002',
      title: 'View product list',
      businessFlow: 'User browses products',
      steps: [
        { action: 'navigate', target: '/products', expectedOutcome: 'Products shown' },
      ],
      expectedResults: [{ kind: 'ui' as const, description: 'Products visible', assertion: 'List not empty' }],
      expectedDbState: [],
    }

    const executeLogin = vi.fn()
    const createPage = vi.fn()

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-no-login',
      scenarios: [nonLoginScenario],
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    expect(executeLogin).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
  })
})
