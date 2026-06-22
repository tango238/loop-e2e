import { logger } from '../util/logger.js'
import type { Config } from '../config/schema.js'
import type { TargetEnv, RawPage } from '../domain/types.js'
import type { Scenario } from '../scenario/schema.js'
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
}

export type GrowDeps = {
  prepare?: (config: Config, root: string, opts: { secrets?: string[]; gitToken?: string }) => Promise<void>
  createPage: () => Promise<PageLike>
  authenticate: (
    page: PageLike,
    target: TargetEnv,
    creds: { username: string; password: string },
    deps?: { pinRunner?: ComposeRunner; secrets?: string[] },
  ) => Promise<LoginResult>
  discoverPages: (page: PageLike, target: TargetEnv, opts: Config['grow'] & object) => Promise<RawPage[]>
  findUncoveredPages: (discovered: RawPage[], scenarios: Scenario[]) => RawPage[]
  proposeScenarios: (llm: Llm, uncovered: RawPage[]) => Promise<Scenario[]>
  loadScenarios: (dir: string) => Promise<Scenario[]>
  saveProposedScenario: (dir: string, scenario: Scenario) => Promise<void>
  llm: Llm
  pinRunner?: ComposeRunner
  secrets?: string[]
  gitToken?: string
}

export type GrowResult = { discovered: number; uncovered: number; proposed: Scenario[] }

const DEFAULT_GROW = { maxPages: 50, maxDepth: 3, excludePaths: [] as string[] }

/**
 * The grow pipeline: prepare → authenticate (2FA) → discover (BFS) → find
 * uncovered pages → propose scenarios (Opus) → save as proposed drafts.
 * Authentication failure aborts grow (no point crawling unauthenticated).
 * All external operations are injected for deterministic testing.
 */
export async function grow(args: GrowArgs, deps: GrowDeps): Promise<GrowResult> {
  const { config, root, scenarioDir, target, creds } = args

  if (!args.skipPrepare && deps.prepare) {
    logger.info({ root }, 'grow: prepare phase starting')
    await deps.prepare(config, root, { secrets: deps.secrets, gitToken: deps.gitToken })
    logger.info({ root }, 'grow: prepare phase complete')
  }

  const page = await deps.createPage()

  logger.info({ target: target.name }, 'grow: authenticating')
  const auth = await deps.authenticate(page, target, creds, { pinRunner: deps.pinRunner, secrets: deps.secrets })
  if (!auth.ok) {
    throw new Error(`grow: authentication failed: ${auth.detail}`)
  }

  const discovered = await deps.discoverPages(page, target, config.grow ?? DEFAULT_GROW)
  const existing = await deps.loadScenarios(scenarioDir)
  const uncovered = deps.findUncoveredPages(discovered, existing)
  logger.info({ discovered: discovered.length, uncovered: uncovered.length }, 'grow: coverage analyzed')

  const proposed = await deps.proposeScenarios(deps.llm, uncovered)
  for (const scenario of proposed) {
    await deps.saveProposedScenario(scenarioDir, scenario)
  }
  logger.info({ proposed: proposed.length }, 'grow: proposed scenarios saved')

  return { discovered: discovered.length, uncovered: uncovered.length, proposed }
}
