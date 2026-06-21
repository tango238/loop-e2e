import { logger } from '../util/logger.js'
import type {
  RunContext,
  RawPage,
  PageInfo,
  SiteStructure,
  PriorState,
  Feedback,
  TargetEnv,
  Scenario,
} from '../domain/types.js'
import type { BrowserLike } from '../services/browser/crawler.js'

// --- Injectable dependency interfaces ---

type StoreApi = {
  loadBaseline: (root: string) => Promise<SiteStructure | null>
  saveBaseline: (root: string, s: SiteStructure) => Promise<void>
  loadLatestReport: (root: string) => Promise<SiteStructure | null>
  loadFeedback: (root: string) => Promise<Feedback[]>
  saveRunStructure: (root: string, runId: string, s: SiteStructure) => Promise<void>
}

type CrawlFn = (
  browser: BrowserLike,
  target: TargetEnv,
  scenarios: Scenario[],
  screenshotDir: string,
) => Promise<RawPage[]>

type ExtractPageInfoFn = (llm: unknown, raw: RawPage) => Promise<PageInfo>

export type CollectDeps = {
  store: StoreApi
  crawl: CrawlFn
  extractPageInfo: ExtractPageInfoFn
  /** Optional browser instance; if null/omitted, crawling is skipped (returns empty page list) */
  browser?: BrowserLike | null
  /** Optional LLM instance; if not provided, extractPageInfo won't be called with one */
  llm?: unknown
  /** Screenshot output directory (default: <root>/.loop-e2e/runs/<runId>/screenshots) */
  screenshotDir?: string
}

export type CollectResult = {
  structure: SiteStructure
  prior: PriorState
}

/**
 * The collect pipeline stage:
 * 1. Load prior state (baseline, feedback)
 * 2. Detect first run (baseline absent)
 * 3. Crawl the target site
 * 4. Extract structured PageInfo for each page via LLM
 * 5. Assemble SiteStructure
 * 6. Persist run snapshot; save baseline on first run
 *
 * All external dependencies (store, crawl, extractPageInfo) are injected
 * to enable clean unit testing without real I/O.
 */
export async function collect(ctx: RunContext, deps: CollectDeps): Promise<CollectResult> {
  const { root, runId, config } = ctx
  const { store, crawl, extractPageInfo, browser = null, llm = null } = deps
  const screenshotDir =
    deps.screenshotDir ?? `${root}/.loop-e2e/runs/${runId}/screenshots`

  // 1. Load prior state
  const [baseline, latestReport, feedback] = await Promise.all([
    store.loadBaseline(root),
    store.loadLatestReport(root),
    store.loadFeedback(root),
  ])

  const isFirstRun = baseline === null
  logger.info({ runId, isFirstRun }, 'Starting collect pipeline')

  const prior: PriorState = {
    baseline,
    latestReport,
    feedback,
  }

  // 2. Build TargetEnv from config (first target for now)
  const configTarget = config.targets[0]
  const target: TargetEnv = {
    name: configTarget.name,
    baseUrl: configTarget.baseUrl,
    auth: configTarget.auth
      ? {
          strategy: configTarget.auth.strategy,
          loginPath: configTarget.auth.loginPath,
          username: configTarget.auth.usernameEnv
            ? ctx.secrets.targetAuth[configTarget.auth.usernameEnv]
            : undefined,
          password: configTarget.auth.passwordEnv
            ? ctx.secrets.targetAuth[configTarget.auth.passwordEnv]
            : undefined,
        }
      : undefined,
  }

  // 3. Crawl — skip if no browser is available (returns empty page list)
  // Note: scenarios is hardcoded to [] here — a known placeholder; the `run` command
  // will thread real scenarios through in a later milestone (M4/M5).
  const rawPages: RawPage[] = browser !== null
    ? await crawl(browser, target, [], screenshotDir)
    : []
  logger.info({ pageCount: rawPages.length }, 'Crawl complete')

  // 4. Extract PageInfo for each page
  const pages: PageInfo[] = await Promise.all(
    rawPages.map((raw) => extractPageInfo(llm, raw)),
  )

  // 5. Assemble SiteStructure
  const structure: SiteStructure = {
    generatedAt: new Date().toISOString(),
    pages,
    transitions: [],
  }

  // 6. Persist
  await store.saveRunStructure(root, runId, structure)
  logger.debug({ runId }, 'Run structure saved')

  if (isFirstRun) {
    await store.saveBaseline(root, structure)
    logger.info({ runId }, 'First run — baseline saved')
  }

  return { structure, prior }
}
