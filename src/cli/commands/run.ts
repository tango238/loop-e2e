import { logger } from '../../util/logger.js'
import type { RunContext, DiffFinding, VerifyFinding, SiteStructure, PriorState, RawPage, TargetEnv } from '../../domain/types.js'
import type { CollectResult } from '../../pipeline/collect.js'
import type { RunVerifyDeps } from '../../pipeline/verify/index.js'
import type { Scenario, LoadedScenario } from '../../scenario/schema.js'
import { isLoginScenario, findLoginScenario } from '../../scenario/loginScenario.js'
import { createDbAdapter as defaultCreateDbAdapter, type DbDriverOptions } from '../../services/db/index.js'
import type { DbAdapter, Row } from '../../services/db/adapter.js'
import type { PageLike } from '../../services/browser/crawler.js'
import type { LoginResult } from '../../services/browser/login.js'
import type { prepare } from '../../pipeline/prepare.js'
import type { ExecuteScenariosDeps } from '../../pipeline/executeScenarios.js'

export type RunOpts = {
  target?: string
  skipPrepare?: boolean
  skipScenarios?: boolean
  /** Enable the exploratory input-verification stage (produces DB/UI state before verify). */
  explore?: boolean
  /** Screen paths for the explore stage (falls back to config.explore.screens). */
  screens?: string[]
  /** Skip the final DB re-seed (dev escape hatch; explore writes will NOT be restored). */
  noReseed?: boolean
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
  /**
   * Exploratory input-verification stage (run --explore). Produces input-exploration state
   * (invalid/boundary writes) and persists its own `input-validation` findings (source:'explore').
   * Run calls it with reseed deferred — run owns the final reseed (see `reseed`).
   * Returns the findings it produced (run merges them into its verify findings).
   */
  exploreState?: (root: string) => Promise<{ findings: VerifyFinding[] }>
  /**
   * Re-crawl after the explore stage so conditional/error-handling verify see produced UI state.
   * Returns raw pages only (no baseline/diff bookkeeping — that uses the pre-explore collect).
   */
  recrawl?: (ctx: RunContext) => Promise<RawPage[]>
  /** Restore the DB after a destructive explore run. Run owns this when explore ran. */
  reseed?: (root: string) => Promise<void>
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
  const { dbQuery, close: closeDb } = buildDbQuery(ctx.config, ctx.secrets.db, deps.dbDrivers)
  const execDeps = {
    ...deps.scenarioExecDeps,
    twoFactor: login?.twoFactor,
    scriptDir: login?.scriptDir,
    resolveTarget: buildTargetResolver(ctx.config, ctx.secrets),
    dbQuery,
  }

  try {
    return await deps.executeScenarios(page, target, toRun, creds, execDeps)
  } catch (err) {
    logger.warn({ err: String(err) }, 'Scenario execution stage failed — continuing')
    return []
  } finally {
    await page.close?.().catch(() => {})
    await closeDb()
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

/** Build a persona-target resolver from config.targets + secrets (name → TargetEnv + creds). */
export function buildTargetResolver(
  config: RunContext['config'],
  secrets: RunContext['secrets'],
): (name: string) => { target: TargetEnv; creds: { username: string; password: string } } | undefined {
  return (name) => {
    const t = config.targets.find((x) => x.name === name)
    if (!t?.auth) return undefined
    const c = resolveCredentials(secrets, t.auth)
    if (!c) return undefined
    return {
      target: {
        name: t.name,
        baseUrl: t.baseUrl,
        auth: { strategy: t.auth.strategy, loginPath: t.auth.loginPath, username: c.username, password: c.password },
      },
      creds: c,
    }
  }
}

/** Build a lazy db query helper (one adapter per connection) for db: captures, plus a close-all. */
export function buildDbQuery(
  config: RunContext['config'],
  dbSecrets: Record<string, string>,
  drivers?: DbDriverOptions,
  createAdapter: typeof defaultCreateDbAdapter = defaultCreateDbAdapter,
): { dbQuery?: (connection: string, sql: string) => Promise<Row[]>; close: () => Promise<void> } {
  if (config.databases.length === 0) return { dbQuery: undefined, close: async () => {} }
  const adapters = new Map<string, DbAdapter>()
  const dbQuery = async (connection: string, sql: string): Promise<Row[]> => {
    let a = adapters.get(connection)
    if (!a) {
      const conf = config.databases.find((d) => d.name === connection)
      if (!conf) throw new Error(`db: capture references unknown connection '${connection}'`)
      const pw = dbSecrets[conf.passwordEnv]
      // env set-but-empty ('') is allowed (passwordless local DBs); only a missing env is an error.
      if (conf.passwordEnv && pw === undefined) {
        throw new Error(`db: connection '${connection}' password env '${conf.passwordEnv}' is not set`)
      }
      a = createAdapter(conf, pw ?? '', drivers)
      adapters.set(connection, a)
    }
    return a.query(sql, [])
  }
  const close = async (): Promise<void> => {
    for (const a of adapters.values()) await a.close().catch(() => {})
  }
  return { dbQuery, close }
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

  // Stage 0.4: explore guard — explore writes invalid/boundary data, so refuse to run it without a
  // way to restore the DB. Mirror explore.ts's guard, but here run owns the final reseed.
  // Aborts BEFORE any destructive write (propagates).
  if (opts.explore) {
    const seedConfigured = Boolean(runCtx.config.launch?.seed)
    if (!seedConfigured && !opts.noReseed) {
      throw new Error(
        'run --explore: launch.seed is not configured and --no-reseed was not passed; aborting to avoid leaving the DB dirty',
      )
    }
    if (!seedConfigured && opts.noReseed) {
      logger.warn({ root }, 'run --explore: running with --no-reseed and NO seed configured — DB changes will NOT be restored')
    }
  }

  // Stage 1: collect (#1, pre-explore). This is the CLEAN baseline crawl used by diff — it must run
  // before any explore-produced state pollutes the app, so diff compares like-for-like vs baseline.
  let structure: SiteStructure = makeEmptyStructure()
  let prior: PriorState = emptyPrior
  let collectedPages: RawPage[] = deps.pages ?? []
  try {
    const result = await collect(runCtx, {})
    structure = result.structure
    prior = result.prior
    // Thread rawPages from collect into verify — closes the pages-threading gap flagged in M6
    collectedPages = result.rawPages.length > 0 ? result.rawPages : (deps.pages ?? [])
  } catch (error) {
    logger.error({ error, runId }, 'collect stage failed — continuing with empty structure')
  }

  // Stage 1.5: explore-state (optional). Produces input-exploration state (invalid/boundary writes)
  // and persists its own input-validation findings (source:'explore'). Reseed is deferred to Stage 5.
  if (opts.explore && deps.exploreState) {
    try {
      const exploreResult = await deps.exploreState(root)
      logger.info({ runId, findings: exploreResult.findings.length }, 'explore-state stage complete')
    } catch (error) {
      logger.error({ error, runId }, 'explore-state stage failed — continuing')
    }
  }

  // Stage 1.6: re-crawl (#2, post-explore). The crawled pages now reflect explore-produced state,
  // so conditional/error-handling verify become meaningful. Only the raw pages are needed here —
  // diff keeps using the clean Stage-1 structure. Falls back to Stage-1 pages on failure.
  let verifyPages: RawPage[] = collectedPages
  if (opts.explore && deps.recrawl) {
    try {
      const statePages = await deps.recrawl(runCtx)
      if (statePages.length > 0) verifyPages = statePages
    } catch (error) {
      logger.error({ error, runId }, 'post-explore re-crawl failed — verify uses pre-explore pages')
    }
  }

  // Stage 2: diff — use deps.scenarios (not hardcoded []) so production gets real scenario data.
  // Always uses the clean pre-explore structure.
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

  // Stage 3: verify — run all 5 categories, resilient to per-category failure.
  // Uses the post-explore state pages (verifyPages) + runtime DB (explore writes still present
  // because reseed is deferred to Stage 5).
  let verifyFindings: VerifyFinding[] = []
  try {
    verifyFindings = await runVerify({
      llm: llm as never,
      pages: verifyPages,
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

  // Stage 5: re-seed (run owns the final reseed when explore produced destructive state).
  // Runs after findings are persisted. A reseed failure is safety-critical (DB left dirty), so it
  // propagates rather than being swallowed like the resilient stages above.
  if (opts.explore && !opts.noReseed && deps.reseed) {
    logger.info({ runId }, 'reseed stage starting (restoring DB after explore)')
    await deps.reseed(root)
    logger.info({ runId }, 'reseed stage complete')
  }

  return { findingsWritten }
}
