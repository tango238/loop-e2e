import { logger } from '../util/logger.js'
import type { Config } from '../config/schema.js'
import type { TargetEnv, RawPage } from '../domain/types.js'
import type { Scenario, LoadedScenario, ScenarioTwoFactor } from '../scenario/schema.js'
import { findLoginScenario } from '../scenario/loginScenario.js'
import type { ProposeInput } from '../services/llm/proposeScenarios.js'
import type { RequirementContext } from '../services/repo/reader.js'
import type { AuthHint } from '../services/llm/prompts/scenario.js'
import type { Llm } from '../services/llm/client.js'
import type { PageLike } from '../services/browser/crawler.js'
import type { ComposeRunner } from '../services/compose/compose.js'
import type { LoginResult } from '../services/browser/login.js'

export type GrowArgs = {
  config: Config
  root: string
  scenarioDir: string
  target: TargetEnv
  creds: { username: string; password: string }
  skipPrepare?: boolean
  /** Use only repository source/requirements (no live crawl/auth). */
  sourceOnly?: boolean
  /** Use only the live crawl (no source/requirements). */
  crawlOnly?: boolean
  /** Extra requirement files (from `--from`) merged into source context. */
  fromPaths?: string[]
}

export type GrowDeps = {
  prepare?: (config: Config, root: string, opts: { secrets?: string[]; gitToken?: string }) => Promise<void>
  createPage: () => Promise<PageLike>
  authenticate: (
    page: PageLike,
    target: TargetEnv,
    creds: { username: string; password: string },
    deps?: { pinRunner?: ComposeRunner; secrets?: string[]; twoFactor?: ScenarioTwoFactor; scriptDir?: string },
  ) => Promise<LoginResult>
  discoverPages: (page: PageLike, target: TargetEnv, opts: Config['grow'] & object) => Promise<RawPage[]>
  findUncoveredPages: (discovered: RawPage[], scenarios: Scenario[]) => RawPage[]
  proposeScenarios: (llm: Llm, input: ProposeInput) => Promise<Scenario[]>
  collectRequirements: (
    repos: Config['repositories'],
    deps: { llm: Llm; token: string; root: string; ingestion: Config['ingestion']; fromPaths?: string[] },
  ) => Promise<RequirementContext[]>
  loadScenarios: (dir: string) => Promise<LoadedScenario[]>
  saveProposedScenario: (dir: string, scenario: Scenario) => Promise<void>
  llm: Llm
  pinRunner?: ComposeRunner
  secrets?: string[]
  gitToken?: string
}

export type GrowResult = {
  discovered: number
  uncovered: number
  proposed: Scenario[]
  mode: 'full' | 'source' | 'crawl'
  requirementsRepos: number
  /** True when source/requirement collection threw and was degraded to empty (distinguishes a
   * genuine "nothing to propose" from "the static understanding source silently collapsed"). */
  sourceError: boolean
}

const DEFAULT_GROW = { maxPages: 50, maxDepth: 3, excludePaths: [] as string[] }

/**
 * The grow pipeline: prepare → authenticate (2FA) → discover (BFS) → find
 * uncovered pages → propose scenarios (Opus) → save as proposed drafts.
 * Authentication failure aborts grow (no point crawling unauthenticated).
 * All external operations are injected for deterministic testing.
 */
export async function grow(args: GrowArgs, deps: GrowDeps): Promise<GrowResult> {
  const { config, root, scenarioDir, target, creds } = args
  const sourceOnly = Boolean(args.sourceOnly)
  const crawlOnly = Boolean(args.crawlOnly)
  const mode: GrowResult['mode'] = sourceOnly ? 'source' : crawlOnly ? 'crawl' : 'full'

  if (!args.skipPrepare && deps.prepare) {
    logger.info({ root }, 'grow: prepare phase starting')
    await deps.prepare(config, root, { secrets: deps.secrets, gitToken: deps.gitToken })
    logger.info({ root }, 'grow: prepare phase complete')
  }

  // Load scenarios first: used for coverage (uncovered pages), id-collision avoidance, and the
  // designated login scenario's 2FA (pinCommand + scriptDir).
  const existing = await deps.loadScenarios(scenarioDir)

  // --- static understanding (source / requirements) ---
  let requirements: RequirementContext[] = []
  let sourceError = false
  if (!crawlOnly) {
    try {
      requirements = await deps.collectRequirements(config.repositories, {
        llm: deps.llm,
        token: deps.gitToken ?? '',
        root,
        ingestion: config.ingestion,
        fromPaths: args.fromPaths,
      })
    } catch (err) {
      sourceError = true
      logger.warn({ err: String(err) }, 'grow: requirement collection failed — continuing without source context')
    }
  }

  // --- dynamic understanding (crawl) ---
  let uncovered: RawPage[] = []
  let discoveredCount = 0
  if (!sourceOnly) {
    const page = await deps.createPage()
    const login = findLoginScenario(existing, target.auth?.loginPath)
    logger.info({ target: target.name }, 'grow: authenticating')
    const auth = await deps.authenticate(page, target, creds, {
      pinRunner: deps.pinRunner,
      secrets: deps.secrets,
      twoFactor: login?.twoFactor,
      scriptDir: login?.scriptDir,
    })
    if (!auth.ok) {
      throw new Error(`grow: authentication failed: ${auth.detail}`)
    }
    const discovered = await deps.discoverPages(page, target, config.grow ?? DEFAULT_GROW)
    discoveredCount = discovered.length
    uncovered = deps.findUncoveredPages(discovered, existing)
    logger.info({ discovered: discovered.length, uncovered: uncovered.length }, 'grow: coverage analyzed')
  }

  // --- unified proposal (fuse crawl + source) ---
  const authHint: AuthHint | undefined = target.auth?.loginPath ? { loginPath: target.auth.loginPath } : undefined
  const proposed = await deps.proposeScenarios(deps.llm, { uncovered, requirements, authHint })

  const existingIds = new Set(existing.map((s) => s.id))
  const fresh = proposed.filter((s) => !existingIds.has(s.id))
  for (const scenario of fresh) {
    await deps.saveProposedScenario(scenarioDir, scenario)
  }
  logger.info({ proposed: fresh.length, mode }, 'grow: proposed scenarios saved')

  // Distinguish "fully covered" from "both understanding sources collapsed".
  if (fresh.length === 0 && (sourceError || (mode === 'full' && requirements.length === 0 && uncovered.length === 0))) {
    logger.warn({ mode, sourceError, requirementsRepos: requirements.length, uncovered: uncovered.length },
      'grow: 0 scenarios proposed — verify this means full coverage, not failed understanding (source/crawl)')
  }

  return { discovered: discoveredCount, uncovered: uncovered.length, proposed: fresh, mode, requirementsRepos: requirements.length, sourceError }
}
