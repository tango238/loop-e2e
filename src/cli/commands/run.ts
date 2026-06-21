import { logger } from '../../util/logger.js'
import type { RunContext, DiffFinding, VerifyFinding, SiteStructure, PriorState } from '../../domain/types.js'
import type { CollectResult } from '../../pipeline/collect.js'
import type { WriteReportDeps } from '../../pipeline/report.js'

export type RunOpts = {
  target?: string
}

type CollectFn = (ctx: RunContext, deps: object) => Promise<CollectResult>
type DetectDiffsFn = (deps: {
  current: SiteStructure
  baseline: SiteStructure | null
  scenarios: import('../../scenario/schema.js').Scenario[]
  llm: import('../../services/llm/client.js').Llm
}) => Promise<DiffFinding[]>
type WriteReportFn = (root: string, runId: string, deps: WriteReportDeps) => Promise<void>

export type RunDeps = {
  collect: CollectFn
  detectDiffs: DetectDiffsFn
  writeReport: WriteReportFn
  /** Injected for deterministic runId in tests; defaults to ISO timestamp */
  clock?: () => string
  /** Injected RunContext for tests; if omitted, loaded from config */
  ctx?: RunContext
  /** Optional LLM for diff/report stages; required in production */
  llm?: import('../../services/llm/client.js').Llm
}

const emptyStructure: SiteStructure = {
  generatedAt: new Date().toISOString(),
  pages: [],
  transitions: [],
}

const emptyPrior: PriorState = {
  baseline: null,
  latestReport: null,
  feedback: [],
}

/**
 * Orchestrates the run pipeline: collect → diff → (verify stub) → report.
 * Each stage is wrapped in try/catch so partial failures still produce a report.
 * All external dependencies are injectable for deterministic testing.
 */
export async function runRun(root: string, _opts: RunOpts, deps: RunDeps): Promise<void> {
  const { collect, detectDiffs, writeReport, clock, ctx: injectedCtx, llm } = deps
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
  let structure: SiteStructure = emptyStructure
  let prior: PriorState = emptyPrior
  try {
    const result = await collect(runCtx, {})
    structure = result.structure
    prior = result.prior
  } catch (error) {
    logger.error({ error, runId }, 'collect stage failed — continuing with empty structure')
  }

  // Stage 2: diff
  let diffFindings: DiffFinding[] = []
  try {
    diffFindings = await detectDiffs({
      current: structure,
      baseline: prior.baseline,
      scenarios: [],
      llm: llm as never,
    })
  } catch (error) {
    logger.error({ error, runId }, 'diff stage failed — continuing with empty findings')
  }

  // Stage 3: verify stub (M6 fills this)
  const verifyFindings: VerifyFinding[] = []

  // Stage 4: report (always runs)
  try {
    await writeReport(root, runId, {
      ctx: runCtx,
      diffFindings,
      verifyFindings,
      currentStructure: structure,
      llm: llm as never,
      adjudicate: async () => ({
        classification: 'uncertain' as const,
        confidence: 0,
        confirmedCount: 0,
        panelSize: 3,
        votes: [],
        rationale: 'no llm available',
      }),
      upsertIssue: async () => {},
      store: {
        saveBaseline: async () => {},
      },
      githubClient: null,
      repo: null,
    })
  } catch (error) {
    logger.error({ error, runId }, 'report stage failed')
  }
}
