import { logger } from '../../util/logger.js'
import type { RunContext, DiffFinding, VerifyFinding, SiteStructure, PriorState, RawPage, TargetEnv } from '../../domain/types.js'
import type { CollectResult } from '../../pipeline/collect.js'
import type { RunVerifyDeps } from '../../pipeline/verify/index.js'
import type { Scenario, LoadedScenario } from '../../scenario/schema.js'
import { isLoginScenario, findLoginScenario } from '../../scenario/loginScenario.js'
import type { DbDriverOptions } from '../../services/db/index.js'
import type { PageLike } from '../../services/browser/crawler.js'
import type { LoginResult } from '../../services/browser/login.js'
import type { prepare } from '../../pipeline/prepare.js'
import type { ExecuteScenariosDeps } from '../../pipeline/executeScenarios.js'

export type RunOpts = {
  target?: string
  skipPrepare?: boolean
  skipScenarios?: boolean
}

type CollectFn = (ctx: RunContext, deps: object) => Promise<CollectResult>
type DetectDiffsFn = (deps: {
  current: SiteStructure
  baseline: SiteStructure | null
  scenarios: Scenario[]
  llm: import('../../services/llm/client.js').Llm
}) => Promise<DiffFinding[]>
type RunVerifyFn = (deps: RunVerifyDeps) => Promise<VerifyFinding[]>

/** Injectable login executor for testing */
type ExecuteLoginFn = (
  page: PageLike,
  target: TargetEnv,
  scenario: Scenario,
  creds: { username: string; password: string },
  deps?: import('../../services/browser/login.js').LoginDeps,
) => Promise<LoginResult>

/** Injectable page factory — returns a PageLike from a browser */
type CreatePageFn = () => Promise<PageLike>

export type RunDeps = {
  collect: CollectFn
  detectDiffs: DetectDiffsFn
  runVerify: RunVerifyFn
  /** Persist findings to the shared store (consumed by the `report` command) */
  writeFindings?: (root: string, entry: import('../../state/findings.js').FindingsEntry) => Promise<void>
  /** Append a one-line activity record (shown in the aggregated report) */
  appendActivity?: (root: string, entry: import('../../state/findings.js').ActivityEntry) => Promise<void>
  /** Save the crawl baseline (run owns this — moved out of the report step) */
  saveBaseline?: (root: string, structure: SiteStructure) => Promise<void>
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
  /** Injectable login executor — production passes executeLoginScenario */
  executeLogin?: ExecuteLoginFn
  /** Deps forwarded to executeLogin (pinRunner, secrets, getAuthResponse, …) */
  loginDeps?: import('../../services/browser/login.js').LoginDeps
  /** Injectable page factory — production passes browser.newPage */
  createPage?: CreatePageFn
  /** Injectable scenario execution stage — production passes executeScenarios from pipeline */
  executeScenarios?: (
    page: PageLike,
    target: TargetEnv,
    scenarios: Scenario[],
    creds: { username: string; password: string },
    deps?: ExecuteScenariosDeps,
  ) => Promise<VerifyFinding[]>
  /** Deps forwarded to executeScenarios (pinRunner, vars, secrets, authenticate, clearCookies, …) */
  scenarioExecDeps?: ExecuteScenariosDeps
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
    // The login scenario carries its own twoFactor + scriptDir (from loadScenarios).
    const result = await deps.executeLogin(page, target, loginScenario, creds, deps.loginDeps)
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

/**
 * Stage 3c: execute adopted scenarios' steps against the live app, applying each
 * scenario's auth precondition. The detected login scenario is excluded (Stage 3b
 * handles it). Returns VerifyFinding(category:'scenario')[]. Never throws — a failure
 * here logs and yields no findings so the rest of the run still produces a report.
 */
async function runScenarioStage(
  ctx: RunContext,
  deps: RunDeps,
  opts: RunOpts,
  scenarios: Scenario[],
): Promise<VerifyFinding[]> {
  if (opts.skipScenarios || !deps.executeScenarios || !deps.createPage) return []

  const configTarget = ctx.config.targets[0]
  if (!configTarget?.auth) return []

  const loginPath = configTarget.auth.loginPath ?? '/login'
  const toRun = scenarios.filter((s) => !isLoginScenario(s, loginPath))
  if (toRun.length === 0) return []

  const creds = resolveCredentials(ctx.secrets, configTarget.auth)
  if (!creds) {
    logger.warn('Scenario stage: credentials not configured — skipping')
    return []
  }

  const target: TargetEnv = {
    name: configTarget.name,
    baseUrl: configTarget.baseUrl,
    auth: {
      strategy: configTarget.auth.strategy,
      loginPath: configTarget.auth.loginPath,
      username: creds.username,
      password: creds.password,
    },
  }

  let page: PageLike
  try {
    page = await deps.createPage()
  } catch (err) {
    logger.error({ err }, 'Scenario stage: failed to create page — skipping')
    return []
  }

  // Authenticated-precondition scenarios re-use the login flow; supply the designated login
  // scenario's 2FA config + scriptDir so the session can complete 2FA.
  const login = findLoginScenario(scenarios as LoadedScenario[], loginPath)
  const execDeps = {
    ...deps.scenarioExecDeps,
    twoFactor: login?.twoFactor,
    scriptDir: login?.scriptDir,
  }

  try {
    return await deps.executeScenarios(page, target, toRun, creds, execDeps)
  } catch (err) {
    logger.warn({ err: String(err) }, 'Scenario execution stage failed — continuing')
    return []
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
export async function runRun(root: string, opts: RunOpts, deps: RunDeps): Promise<{ findingsWritten: boolean }> {
  const { collect, detectDiffs, runVerify, clock, ctx: injectedCtx, llm } = deps
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

  // Stage 3c: scenario execution (optional — runs adopted scenarios with auth preconditions)
  const scenarioFindings = await runScenarioStage(runCtx, deps, opts, deps.scenarios ?? [])
  verifyFindings = [...verifyFindings, ...scenarioFindings]

  // Stage 4: persist baseline + findings + activity. Reporting is a separate step (the `report`
  // command), invoked automatically by the CLI unless --no-report. run is now a findings producer.
  const startedAt = new Date().toISOString()
  try {
    if (deps.saveBaseline) await deps.saveBaseline(root, structure)
  } catch (error) {
    logger.error({ error, runId }, 'baseline save failed')
  }
  // findingsWritten gates the CLI's "written to the store" reassurance under --no-report: if the
  // store write fails there, the findings exist nowhere, so the CLI must surface a hard error.
  let findingsWritten = !deps.writeFindings // no store dep (tests) ⇒ treat as ok
  try {
    if (deps.writeFindings) {
      await deps.writeFindings(root, { source: 'run', runId, startedAt, diffFindings, verifyFindings })
      findingsWritten = true
    }
  } catch (error) {
    logger.error({ error, runId }, 'findings store write failed')
  }
  try {
    if (deps.appendActivity) {
      const summary = `findings ${diffFindings.length + verifyFindings.length} (diff ${diffFindings.length}, verify ${verifyFindings.length})`
      await deps.appendActivity(root, { source: 'run', runId, startedAt, summary })
    }
  } catch (error) {
    logger.error({ error, runId }, 'activity append failed')
  }
  return { findingsWritten }
}
