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
      writeFindings: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-2024-01-01',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect', 'diff', 'verify', 'report'])
    expect(deps.collect).toHaveBeenCalledOnce()
    expect(deps.detectDiffs).toHaveBeenCalledOnce()
    expect(deps.runVerify).toHaveBeenCalledOnce()
    expect(deps.writeFindings).toHaveBeenCalledOnce()
  })

  it('uses injected clock for deterministic runId', async () => {
    const capturedRunIds: string[] = []

    const deps = {
      collect: vi.fn().mockImplementation(async (ctx: { runId: string }) => { capturedRunIds.push(ctx.runId); return makeCollectResult() }),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
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
      writeFindings: vi.fn().mockImplementation(async (_root: string, entry: { verifyFindings: unknown }) => {
        capturedVerifyFindings = entry.verifyFindings
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
      writeFindings: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-partial',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect-fail', 'diff', 'verify', 'report'])
    expect(deps.detectDiffs).toHaveBeenCalledOnce()
    expect(deps.runVerify).toHaveBeenCalledOnce()
    expect(deps.writeFindings).toHaveBeenCalledOnce()
  })

  it('if diff fails, verify and report still run with empty diffFindings', async () => {
    const order: string[] = []
    let capturedDiffFindings: unknown = 'not-set'

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff-fail'); throw new Error('diff error') }),
      runVerify: vi.fn().mockImplementation(async () => { order.push('verify'); return [] }),
      writeFindings: vi.fn().mockImplementation(async (_root: string, entry: { diffFindings: unknown }) => {
        order.push('report')
        capturedDiffFindings = entry.diffFindings
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
      writeFindings: vi.fn().mockImplementation(async (_root: string, entry: { verifyFindings: unknown }) => {
        order.push('report')
        capturedVerifyFindings = entry.verifyFindings
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
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-scenarios-threaded',
      scenarios: [scenario],
    }

    await runRun('/tmp/root', {}, deps)
    expect(capturedScenarios).toEqual([scenario])
  })

  it('writes findings to the store with source=run and the diff/verify findings', async () => {
    let captured: Record<string, unknown> = {}
    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([sampleFinding]),
      runVerify: vi.fn().mockResolvedValue([sampleVerifyFinding]),
      writeFindings: vi.fn().mockImplementation(async (_root: string, entry: Record<string, unknown>) => {
        captured = entry
      }),
      clock: () => 'run-store',
    }
    await runRun('/tmp/root', {}, deps)
    expect(captured.source).toBe('run')
    expect(captured.runId).toBe('run-store')
    expect(captured.diffFindings).toEqual([sampleFinding])
    expect(captured.verifyFindings).toEqual([sampleVerifyFinding])
  })

  it('saves the baseline in run (no longer a report concern)', async () => {
    const realSaveBaseline = vi.fn().mockResolvedValue(undefined)
    const structure = { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] }
    const deps = {
      collect: vi.fn().mockResolvedValue({ structure, prior: { baseline: null, latestReport: null, feedback: [] }, rawPages: [] }),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      saveBaseline: realSaveBaseline,
      clock: () => 'run-real-store',
    }
    await runRun('/tmp/root', {}, deps)
    expect(realSaveBaseline).toHaveBeenCalledWith('/tmp/root', structure)
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
      writeFindings: vi.fn().mockImplementation(async (_r: string, d: { verifyFindings: VerifyFinding[] }) => {
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
      writeFindings: vi.fn().mockImplementation(async (_r: string, d: { verifyFindings: VerifyFinding[] }) => {
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

  it('passes the login scenario (which owns twoFactor) and loginDeps into executeLogin', async () => {
    const twoFactor = { pinCommand: 'bash get-2fa-pin.sh', pinFieldSelector: 'input[name="pin_code"]', submitSelector: 'button[type="submit"]' }
    const loginScenario = {
      id: 'sc-2fa',
      title: 'User login',
      businessFlow: 'User logs in',
      steps: [
        { action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' },
        { action: 'submit', target: 'button[type=submit]', expectedOutcome: 'Submitted' },
      ],
      expectedResults: [{ kind: 'ui' as const, description: 'Dashboard', assertion: 'URL is /' }],
      expectedDbState: [],
      // 2FA is owned by the scenario, with its script dir.
      twoFactor,
      scriptDir: '/tmp/root/scenarios/sc-2fa',
    }
    const executeLogin = vi.fn().mockResolvedValue({ ok: true, detail: 'ok', finalUrl: 'http://localhost:3000/' })
    const fakePage = { goto: vi.fn(), url: vi.fn(() => 'http://localhost:3000/'), title: vi.fn(), content: vi.fn(), evaluate: vi.fn(), screenshot: vi.fn(), waitForLoadState: vi.fn(), locator: vi.fn() }
    const loginDeps = { getAuthResponse: () => ({ status: 422, bodyText: 'x' }) }

    await runRun('/tmp/root', {}, {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn(),
      clock: () => 'run-2fa',
      scenarios: [loginScenario],
      ctx: {
        root: '/tmp/root',
        runId: 'run-2fa',
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
        secrets: { db: {}, targetAuth: { USERNAME: 'u@example.com', PASSWORD: 'pw' }, anthropicApiKey: '', githubToken: '' },
      },
      executeLogin,
      loginDeps,
      createPage: vi.fn().mockResolvedValue(fakePage),
    })

    expect(executeLogin).toHaveBeenCalledOnce()
    const [, , passedScenario, , passedDeps] = executeLogin.mock.calls[0]
    expect(passedScenario.twoFactor).toEqual(twoFactor)
    expect(passedScenario.scriptDir).toBe('/tmp/root/scenarios/sc-2fa')
    expect(passedDeps).toBe(loginDeps)
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
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-no-login',
      scenarios: [nonLoginScenario],
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    expect(executeLogin).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
  })

  // --- isLoginScenario tightening: endsWith false-positive fix (M4 review finding 4.4) ---

  it('does NOT mis-detect a scenario with only /admin-login path as login scenario for loginPath=/login', async () => {
    // Scenario whose only navigated path is /admin-login — must NOT match loginPath '/login'
    const adminLoginScenario = {
      id: 'sc-admin',
      title: 'Admin panel access',
      businessFlow: 'Admin accesses admin panel',
      steps: [
        { action: 'navigate', target: '/admin-login', expectedOutcome: 'Admin login page shown' },
        { action: 'fill', target: 'input[name=email]', input: 'admin@example.com', expectedOutcome: 'Email filled' },
        { action: 'submit', target: 'button[type=submit]', expectedOutcome: 'Admin logged in' },
      ],
      expectedResults: [{ kind: 'ui' as const, description: 'Admin dashboard', assertion: 'URL is /admin' }],
      expectedDbState: [],
    }

    const executeLogin = vi.fn()
    const createPage = vi.fn()

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-admin-login-no-match',
      scenarios: [adminLoginScenario],
      ctx: {
        root: '/tmp/root',
        runId: 'run-admin-login-no-match',
        config: {
          repositories: [],
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
          targetAuth: { USERNAME: 'admin', PASSWORD: 'adminpass' },
          anthropicApiKey: '',
          githubToken: '',
        },
      },
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    // /admin-login must NOT match loginPath='/login' — executeLogin should NOT be called
    expect(executeLogin).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
  })

  // --- Important 2: page.close() is always called after login execution ---

  const makeLoginCtx = () => ({
    root: '/tmp/root',
    runId: 'run-close-test',
    config: {
      repositories: [],
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
      targetAuth: { USERNAME: 'user@example.com', PASSWORD: 'pass' },
      anthropicApiKey: '',
      githubToken: '',
    },
  })

  const makeLoginScenarioWithStep = () => ({
    id: 'sc-login-close',
    title: 'Login flow',
    businessFlow: 'User logs in',
    steps: [
      { action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' },
      { action: 'fill', target: 'input[name=email]', input: 'user@example.com', expectedOutcome: 'Email filled' },
      { action: 'submit', target: 'button[type=submit]', expectedOutcome: 'Submitted' },
    ],
    expectedResults: [{ kind: 'ui' as const, description: 'Dashboard', assertion: 'URL is /dashboard' }],
    expectedDbState: [],
  })

  it('closes the page after a successful login run', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const fakePage = {
      goto: vi.fn(), url: vi.fn(() => 'http://localhost:3000/dashboard'), title: vi.fn(),
      content: vi.fn(), evaluate: vi.fn(), screenshot: vi.fn(), waitForLoadState: vi.fn(),
      locator: vi.fn(), close: closeSpy,
    }
    const createPage = vi.fn().mockResolvedValue(fakePage)
    const executeLogin = vi.fn().mockResolvedValue({ ok: true, detail: 'Login succeeded', finalUrl: 'http://localhost:3000/dashboard' })

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-close-success',
      scenarios: [makeLoginScenarioWithStep()],
      ctx: makeLoginCtx(),
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    expect(closeSpy).toHaveBeenCalledOnce()
  })

  it('closes the page even when executeLogin throws', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined)
    const fakePage = {
      goto: vi.fn(), url: vi.fn(), title: vi.fn(),
      content: vi.fn(), evaluate: vi.fn(), screenshot: vi.fn(), waitForLoadState: vi.fn(),
      locator: vi.fn(), close: closeSpy,
    }
    const createPage = vi.fn().mockResolvedValue(fakePage)
    const executeLogin = vi.fn().mockRejectedValue(new Error('network failure'))

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-close-throw',
      scenarios: [makeLoginScenarioWithStep()],
      ctx: makeLoginCtx(),
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    expect(closeSpy).toHaveBeenCalledOnce()
  })

  // --- Task 5: prepare phase wiring ---

  it('calls prepare before collect when skipPrepare is false (default)', async () => {
    const order: string[] = []

    const deps = {
      prepare: vi.fn().mockImplementation(async () => { order.push('prepare') }),
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff'); return [] }),
      runVerify: vi.fn().mockImplementation(async () => { order.push('verify'); return [] }),
      writeFindings: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-prepare-order',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['prepare', 'collect', 'diff', 'verify', 'report'])
    expect(deps.prepare).toHaveBeenCalledOnce()
    // Collect must not have been called when prepare ran
    const prepareCallOrder = order.indexOf('prepare')
    const collectCallOrder = order.indexOf('collect')
    expect(prepareCallOrder).toBeLessThan(collectCallOrder)
  })

  it('does NOT call prepare when skipPrepare is true, but rest of run still proceeds', async () => {
    const order: string[] = []

    const deps = {
      prepare: vi.fn().mockImplementation(async () => { order.push('prepare') }),
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff'); return [] }),
      runVerify: vi.fn().mockImplementation(async () => { order.push('verify'); return [] }),
      writeFindings: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-skip-prepare',
    }

    await runRun('/tmp/root', { skipPrepare: true }, deps)

    expect(deps.prepare).not.toHaveBeenCalled()
    expect(order).toEqual(['collect', 'diff', 'verify', 'report'])
    expect(deps.collect).toHaveBeenCalledOnce()
    expect(deps.writeFindings).toHaveBeenCalledOnce()
  })

  it('calls prepare with the loaded config, root, secrets array, and gitToken', async () => {
    const ctx = {
      root: '/tmp/root',
      runId: 'run-prepare-args',
      config: {
        repositories: [],
        targets: [{ name: 'local', baseUrl: 'http://localhost:3000' }],
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
        db: { DB_PASS: 'db-secret' },
        targetAuth: { APP_TOKEN: 'auth-token' },
        anthropicApiKey: 'anthropic-key',
        githubToken: 'gh-token',
      },
    }

    let capturedConfig: unknown = 'not-set'
    let capturedRoot: unknown = 'not-set'
    let capturedSecrets: unknown = 'not-set'
    let capturedGitToken: unknown = 'not-set'

    const deps = {
      prepare: vi.fn().mockImplementation(async (config: unknown, root: unknown, prepareDeps: { secrets?: unknown; gitToken?: unknown }) => {
        capturedConfig = config
        capturedRoot = root
        capturedSecrets = prepareDeps.secrets
        capturedGitToken = prepareDeps.gitToken
      }),
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-prepare-args',
      ctx,
    }

    await runRun('/tmp/root', {}, deps)

    expect(capturedConfig).toBe(ctx.config)
    expect(capturedRoot).toBe('/tmp/root')
    const secrets = capturedSecrets as string[]
    expect(secrets).toContain('anthropic-key')
    expect(secrets).toContain('gh-token')
    expect(secrets).toContain('db-secret')
    expect(secrets).toContain('auth-token')
    // gitToken must be the github token specifically, NOT the anthropic key
    expect(capturedGitToken).toBe('gh-token')
  })

  it('propagates prepare failure and aborts the run (does not swallow)', async () => {
    const deps = {
      prepare: vi.fn().mockRejectedValue(new Error('git fetch failed')),
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-prepare-fail',
    }

    await expect(runRun('/tmp/root', {}, deps)).rejects.toThrow('git fetch failed')
    expect(deps.collect).not.toHaveBeenCalled()
  })

  // --- Minor: "Logout redirects to login" must NOT be selected as login scenario ---

  it('does NOT select "Logout redirects to login" as a login scenario', async () => {
    const logoutScenario = {
      id: 'sc-logout',
      title: 'Logout redirects to login',
      businessFlow: 'User logs out and is redirected to login page',
      steps: [
        { action: 'navigate', target: '/dashboard', expectedOutcome: 'Dashboard shown' },
        { action: 'click', target: 'button#logout', expectedOutcome: 'Logged out' },
      ],
      expectedResults: [{ kind: 'ui' as const, description: 'Login page', assertion: 'URL contains /login' }],
      expectedDbState: [],
    }

    const executeLogin = vi.fn()
    const createPage = vi.fn()

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-logout-not-login',
      scenarios: [logoutScenario],
      ctx: {
        root: '/tmp/root',
        runId: 'run-logout-not-login',
        config: {
          repositories: [],
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
          targetAuth: { USERNAME: 'user', PASSWORD: 'pass' },
          anthropicApiKey: '',
          githubToken: '',
        },
      },
      executeLogin,
      createPage,
    }

    await runRun('/tmp/root', {}, deps)

    // Title mentions "login" but no fill/submit step targets /login — must NOT be selected
    expect(executeLogin).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
  })
})

describe('runRun — scenario execution stage', () => {
  const authedScenario = {
    id: 'grow-hotel',
    title: 'View hotel page',
    businessFlow: 'An authenticated admin views hotels',
    steps: [{ action: 'navigate', target: '/hotel', expectedOutcome: 'Hotel page loads' }],
    expectedResults: [{ kind: 'ui' as const, description: 'Hotel visible', assertion: 'heading shown' }],
    expectedDbState: [],
    precondition: { auth: 'authenticated' as const },
  }

  const ctxWithCreds = {
    root: '/tmp/root',
    runId: 'run-scn',
    config: {
      repositories: [],
      targets: [{ name: 'admin', baseUrl: 'http://localhost:3000', auth: { strategy: 'form' as const, loginPath: '/login', usernameEnv: 'USERNAME', passwordEnv: 'PASSWORD' } }],
      databases: [],
      schedule: { intervalMinutes: 60 },
      scenarioDir: 'scenarios',
      github: { labels: { ready: 'ready', autoDetect: 'auto' } },
      baseline: { commit: false },
      models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
      ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
      refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness' as const, 'security' as const, 'intentionality' as const] },
    },
    secrets: { db: {}, targetAuth: { USERNAME: 'admin@x', PASSWORD: 'secret-pass' }, anthropicApiKey: '', githubToken: '' },
  }

  it('runs the scenario execution stage and merges findings into the report', async () => {
    const executeScenarios = vi.fn().mockResolvedValue([
      { category: 'scenario', severity: 'high', title: 'grow-hotel', detail: 'failed', evidence: 'grow-hotel' },
    ])
    const createPage = vi.fn().mockResolvedValue({ goto: vi.fn(), url: vi.fn(), title: vi.fn(), content: vi.fn(), evaluate: vi.fn(), screenshot: vi.fn(), waitForLoadState: vi.fn(), locator: vi.fn(), close: vi.fn().mockResolvedValue(undefined) })
    let captured: VerifyFinding[] = []
    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockImplementation(async (_r: string, d: { verifyFindings: VerifyFinding[] }) => { captured = d.verifyFindings }),
      clock: () => 'run-scn',
      scenarios: [authedScenario],
      ctx: ctxWithCreds,
      executeScenarios,
      createPage,
    }
    await runRun('/tmp/root', { target: 'admin' }, deps)
    expect(executeScenarios).toHaveBeenCalledOnce()
    expect(captured.some((f) => f.category === 'scenario')).toBe(true)
  })

  it('skips the scenario stage when --skip-scenarios is set', async () => {
    const executeScenarios = vi.fn()
    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([]),
      runVerify: vi.fn().mockResolvedValue([]),
      writeFindings: vi.fn().mockResolvedValue(undefined),
      clock: () => 'run-scn-skip',
      scenarios: [authedScenario],
      ctx: ctxWithCreds,
      executeScenarios,
      createPage: vi.fn(),
    }
    await runRun('/tmp/root', { target: 'admin', skipScenarios: true }, deps)
    expect(executeScenarios).not.toHaveBeenCalled()
  })
})
