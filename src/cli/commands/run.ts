import { logger } from '../../util/logger.js'
import type { RunContext, DiffFinding, VerifyFinding, SiteStructure, PriorState, RawPage, TargetEnv } from '../../domain/types.js'
import type { CollectResult } from '../../pipeline/collect.js'
import type { WriteReportDeps } from '../../pipeline/report.js'
import type { RunVerifyDeps } from '../../pipeline/verify/index.js'
import type { Scenario } from '../../scenario/schema.js'
import type { DbDriverOptions } from '../../services/db/index.js'
import type { PageLike } from '../../services/browser/crawler.js'
import type { LoginResult } from '../../services/browser/login.js'
import type { prepare } from '../../pipeline/prepare.js'

export type RunOpts = {
  target?: string
  skipPrepare?: boolean
}

type CollectFn = (ctx: RunContext, deps: object) => Promise<CollectResult>
type DetectDiffsFn = (deps: {
  current: SiteStructure
  baseline: SiteStructure | null
  scenarios: Scenario[]
  llm: import('../../services/llm/client.js').Llm
}) => Promise<DiffFinding[]>
type RunVerifyFn = (deps: RunVerifyDeps) => Promise<VerifyFinding[]>
type WriteReportFn = (root: string, runId: string, deps: WriteReportDeps) => Promise<void>

/** Injectable login executor for testing */
type ExecuteLoginFn = (
  page: PageLike,
  target: TargetEnv,
  scenario: Scenario,
  creds: { username: string; password: string },
) => Promise<LoginResult>

/** Injectable page factory — returns a PageLike from a browser */
type CreatePageFn = () => Promise<PageLike>

export type RunDeps = {
  collect: CollectFn
  detectDiffs: DetectDiffsFn
  runVerify: RunVerifyFn
  writeReport: WriteReportFn
  /** Injectable prepare phase — production passes real prepare; tests inject a mock */
  prepare?: typeof prepare
  /** Injected for deterministic runId in tests; defaults to ISO timestamp */
  clock?: () => string
  /** Injected RunContext for tests; if omitted, loaded from config */
  ctx?: RunContext
  /** Optional LLM for diff/report/verify stages; required in production */
  llm?: import('../../services/llm/client.js').Llm
  /** Pages from the collect stage, passed to verify; empty in tests unless injected */
  pages?: RawPage[]
  /** Scenarios for the verify stage and detectDiffs */
  scenarios?: Scenario[]
  /** Injectable DB driver factories for verify tests */
  dbDrivers?: DbDriverOptions
  /** Real adjudicate fn — production passes adjudicate from refute.ts */
  adjudicate?: WriteReportDeps['adjudicate']
  /** Real upsertIssue fn — production passes upsertIssue from issues.ts */
  upsertIssue?: WriteReportDeps['upsertIssue']
  /** Real store with saveBaseline — production passes from store.ts */
  store?: WriteReportDeps['store']
  /** GitHub client — null means no issue filing */
  githubClient?: import('../../services/github/client.js').GithubClient | null
  /** GitHub repo ref — null means no issue filing */
  repo?: import('../../services/github/labels.js').RepoRef | null
  /** Injectable login executor — production passes executeLoginScenario */
  executeLogin?: ExecuteLoginFn
  /** Injectable page factory — production passes browser.newPage */
  createPage?: CreatePageFn
}

function makeEmptyStructure(): SiteStructure {
  return {
    generatedAt: new Date().toISOString(),
    pages: [],
    transitions: [],
  }
}

/**
 * Run the login scenario if one is detected in `scenarios`.
 * Returns zero or one VerifyFinding with category 'login'.
 * Never throws — login failures become findings, not exceptions.
 */
async function runLoginIfDetected(
  ctx: RunContext,
  deps: RunDeps,
  scenarios: Scenario[],
): Promise<VerifyFinding[]> {
  if (!deps.executeLogin || !deps.createPage) return []

  const configTarget = ctx.config.targets[0]
  if (!configTarget?.auth || configTarget.auth.strategy === 'none') return []

  const loginPath = configTarget.auth.loginPath ?? '/login'
  const loginScenario = scenarios.find((s) => isLoginScenario(s, loginPath))
  if (!loginScenario) {
    logger.debug('No login scenario detected — skipping login execution')
    return []
  }

  const creds = resolveCredentials(ctx.secrets, configTarget.auth)
  if (!creds) {
    logger.warn({ loginPath }, 'Login scenario detected but credentials not configured — skipping')
    return []
  }

  const target: TargetEnv = {
    name: configTarget.name,
    baseUrl: configTarget.baseUrl,
    auth: {
      strategy: configTarget.auth.strategy,
      loginPath: configTarget.auth.loginPath,
    },
  }

  let page: PageLike
  try {
    page = await deps.createPage()
  } catch (err) {
    logger.error({ err }, 'Failed to create page for login — skipping')
    return []
  }

  try {
    const result = await deps.executeLogin(page, target, loginScenario, creds)
    logger.info({ ok: result.ok, finalUrl: result.finalUrl }, 'Login execution complete')

    const finding: VerifyFinding = {
      category: 'login',
      severity: result.ok ? 'low' : 'high',
      title: result.ok ? 'Login succeeded' : 'Login failed',
      detail: result.detail,
      evidence: `finalUrl: ${result.finalUrl}`,
    }
    return [finding]
  } catch (err) {
    logger.error({ err }, 'Login execution threw unexpectedly')
    const finding: VerifyFinding = {
      category: 'login',
      severity: 'high',
      title: 'Login execution error',
      detail: `Unexpected error during login: ${err instanceof Error ? err.message : String(err)}`,
      evidence: '',
    }
    return [finding]
  } finally {
    await page.close?.().catch(() => {})
  }
}

const emptyPrior: PriorState = {
  baseline: null,
  latestReport: null,
  feedback: [],
}

/**
 * Returns true if the scenario looks like a login scenario.
 * Primary signal: any step navigates to the exact loginPath.
 * Secondary signal (title text) requires corroboration — the scenario must also have
 * a credential-action step (fill/submit/login) targeting the loginPath; title text alone
 * is not sufficient to avoid false-positives like "Logout redirects to login".
 */
function isLoginScenario(scenario: Scenario, loginPath?: string): boolean {
  // Primary: exact path match
  if (loginPath && scenario.steps.some((s) => s.target === loginPath)) {
    return true
  }

  // Secondary: title/businessFlow mentions login only when there is also a
  // credential-action step targeting the loginPath
  if (loginPath) {
    const text = `${scenario.title} ${scenario.businessFlow}`.toLowerCase()
    const mentionsLogin = text.includes('login') || text.includes('sign in') || text.includes('signin')
    const hasCredentialStep = scenario.steps.some(
      (s) =>
        s.target === loginPath &&
        (s.action === 'fill' || s.action === 'submit' || s.action === 'login'),
    )
    if (mentionsLogin && hasCredentialStep) {
      return true
    }
  }

  return false
}

/**
 * Resolve credentials from secrets using the target's auth env var names.
 */
function resolveCredentials(
  secrets: RunContext['secrets'],
  auth: NonNullable<import('../../config/schema.js').Config['targets'][number]['auth']>,
): { username: string; password: string } | null {
  const username = auth.usernameEnv ? secrets.targetAuth[auth.usernameEnv] : undefined
  const password = auth.passwordEnv ? secrets.targetAuth[auth.passwordEnv] : undefined
  if (!username || !password) return null
  return { username, password }
}

/**
 * Orchestrates the run pipeline: prepare → collect → diff → verify → report.
 * Each stage is wrapped in try/catch so partial failures still produce a report.
 * The prepare stage (repo refresh + setup hooks) runs before collect unless
 * opts.skipPrepare is true. Prepare failures abort the run (propagate).
 * All external dependencies are injectable for deterministic testing.
 */
export async function runRun(root: string, opts: RunOpts, deps: RunDeps): Promise<void> {
  const { collect, detectDiffs, runVerify, writeReport, clock, ctx: injectedCtx, llm } = deps
  const runId = clock ? clock() : new Date().toISOString().replace(/[:.]/g, '-')

  // In tests, ctx is injected. In production, it would be loaded from config.
  // We use a minimal stub when no ctx is provided so tests without config work.
  const ctx: RunContext = injectedCtx ?? {
    root,
    runId,
    config: {
      repositories: [],
      targets: [{ name: 'unknown', baseUrl: 'http://localhost' }],
      databases: [],
      schedule: { intervalMinutes: 60 },
      scenarioDir: 'scenarios',
      github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
      baseline: { commit: false },
      models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
      ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
      refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
    },
    secrets: {
      db: {},
      targetAuth: {},
      anthropicApiKey: '',
      githubToken: '',
    },
  }

  // Update runId in ctx
  const runCtx: RunContext = { ...ctx, root, runId }

  // Stage 0: prepare (repo refresh + setup hooks) — runs before collect unless skipped.
  // Failures propagate and abort the run; they are not swallowed.
  if (!opts.skipPrepare && deps.prepare) {
    const allSecrets: string[] = [
      runCtx.secrets.anthropicApiKey,
      runCtx.secrets.githubToken,
      ...Object.values(runCtx.secrets.db),
      ...Object.values(runCtx.secrets.targetAuth),
    ].filter(Boolean) as string[]
    logger.info({ root }, 'prepare phase starting')
    await deps.prepare(runCtx.config, root, { secrets: allSecrets, gitToken: runCtx.secrets.githubToken })
    logger.info({ root }, 'prepare phase complete')
  }

  // Stage 1: collect
  let structure: SiteStructure = makeEmptyStructure()
  let prior: PriorState = emptyPrior
  let collectedPages: import('../../domain/types.js').RawPage[] = deps.pages ?? []
  try {
    const result = await collect(runCtx, {})
    structure = result.structure
    prior = result.prior
    // Thread rawPages from collect into verify — closes the pages-threading gap flagged in M6
    collectedPages = result.rawPages.length > 0 ? result.rawPages : (deps.pages ?? [])
  } catch (error) {
    logger.error({ error, runId }, 'collect stage failed — continuing with empty structure')
  }

  // Stage 2: diff — use deps.scenarios (not hardcoded []) so production gets real scenario data
  let diffFindings: DiffFinding[] = []
  try {
    diffFindings = await detectDiffs({
      current: structure,
      baseline: prior.baseline,
      scenarios: deps.scenarios ?? [],
      llm: llm as never,
    })
  } catch (error) {
    logger.error({ error, runId }, 'diff stage failed — continuing with empty findings')
  }

  // Stage 3: verify — run all 5 categories, resilient to per-category failure
  let verifyFindings: VerifyFinding[] = []
  try {
    verifyFindings = await runVerify({
      llm: llm as never,
      pages: collectedPages,
      scenarios: deps.scenarios ?? [],
      config: runCtx.config,
      secrets: runCtx.secrets.db,
      dbDrivers: deps.dbDrivers,
    })
  } catch (error) {
    logger.error({ error, runId }, 'verify stage failed — continuing with empty findings')
  }

  // Stage 3b: login scenario execution (optional — only when a login scenario is detected)
  const loginFindings = await runLoginIfDetected(runCtx, deps, deps.scenarios ?? [])
  verifyFindings = [...verifyFindings, ...loginFindings]

  // Stage 4: report (always runs)
  // Use injected deps for adjudicate/upsertIssue/store; fall back to no-ops only in tests
  // that don't exercise those paths. Production wiring (cli/index.ts) must always supply real deps.
  try {
    await writeReport(root, runId, {
      ctx: runCtx,
      diffFindings,
      verifyFindings,
      currentStructure: structure,
      llm: llm as never,
      adjudicate: deps.adjudicate ?? (async () => ({
        classification: 'uncertain' as const,
        confidence: 0,
        confirmedCount: 0,
        panelSize: 3,
        votes: [],
        rationale: 'no adjudicate dep provided',
      })),
      upsertIssue: deps.upsertIssue ?? (async () => {}),
      store: deps.store ?? { saveBaseline: async () => {} },
      githubClient: deps.githubClient ?? null,
      repo: deps.repo ?? null,
    })
  } catch (error) {
    logger.error({ error, runId }, 'report stage failed')
  }
}
