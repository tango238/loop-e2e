import { logger } from '../../util/logger.js'
import type { RunContext, DiffFinding, VerifyFinding, SiteStructure, PriorState, RawPage } from '../../domain/types.js'
import type { CollectResult } from '../../pipeline/collect.js'
import type { WriteReportDeps } from '../../pipeline/report.js'
import type { RunVerifyDeps } from '../../pipeline/verify/index.js'
import type { Scenario } from '../../scenario/schema.js'
import type { DbDriverOptions } from '../../services/db/index.js'

export type RunOpts = {
  target?: string
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

export type RunDeps = {
  collect: CollectFn
  detectDiffs: DetectDiffsFn
  runVerify: RunVerifyFn
  writeReport: WriteReportFn
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
}

function makeEmptyStructure(): SiteStructure {
  return {
    generatedAt: new Date().toISOString(),
    pages: [],
    transitions: [],
  }
}

const emptyPrior: PriorState = {
  baseline: null,
  latestReport: null,
  feedback: [],
}

/**
 * Orchestrates the run pipeline: collect → diff → verify → report.
 * Each stage is wrapped in try/catch so partial failures still produce a report.
 * All external dependencies are injectable for deterministic testing.
 */
export async function runRun(root: string, _opts: RunOpts, deps: RunDeps): Promise<void> {
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
