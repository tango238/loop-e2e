import { logger } from '../util/logger.js'
import type { TargetEnv, VerifyFinding, SiteStructure } from '../domain/types.js'
import type { PageLike } from '../services/browser/crawler.js'
import type { DbAdapter } from '../services/db/adapter.js'
import type { Llm } from '../services/llm/client.js'
import type { Config } from '../config/schema.js'
import type { WriteReportDeps } from './report.js'
import type { LoginResult } from '../services/browser/login.js'
import type {
  DiscoveredForm, ColumnDef, FieldConstraint, InputCase, CaseOutcome, Baseline, GapVerdict, QualityFinding,
} from '../services/explore/types.js'
import type { ExploreExecDeps } from '../services/explore/execute.js'

export type ExploreOpts = { target?: string; screens?: string[]; skipPrepare?: boolean; noReseed?: boolean }

export type ExploreResult = {
  findings: VerifyFinding[]
  forms: number
  cases: number
  gapsHigh: number
  gapsMedium: number
  messageIssues: number
}

/** All external I/O is injected. `reportDeps` is everything writeReport needs except findings. */
export type ExploreDeps = {
  target: TargetEnv
  creds: { username: string; password: string }
  dbType: 'postgres' | 'mysql'
  /** launch.seed config (undefined ⇒ none configured) */
  seed?: { command: string }
  /** config used for prepare + setup hooks (optional; only needed when prepare runs) */
  config?: Config
  secrets?: string[]

  createPage: () => Promise<PageLike>
  authenticate: (page: PageLike, target: TargetEnv, creds: { username: string; password: string }) => Promise<LoginResult>
  discoverForms: (page: PageLike, target: TargetEnv, screens: string[]) => Promise<DiscoveredForm[]>
  inferCandidateTables: (form: DiscoveredForm, llm: Llm) => Promise<string[]>
  introspectTable: (db: DbAdapter, dbType: 'postgres' | 'mysql', table: string) => Promise<ColumnDef[]>
  modelConstraints: (form: DiscoveredForm, columns: ColumnDef[], sourceRules: string, llm: Llm) => Promise<FieldConstraint[]>
  generateCases: (constraints: FieldConstraint[], llm?: Llm) => Promise<InputCase[]>
  buildBaseline: (constraints: FieldConstraint[]) => Baseline
  runCase: (page: PageLike, form: DiscoveredForm, baseline: Baseline, inputCase: InputCase, deps?: ExploreExecDeps) => Promise<CaseOutcome>
  classifyGap: (inputCase: InputCase, outcome: CaseOutcome, dbProbe?: () => Promise<boolean>) => Promise<GapVerdict>
  classifyErrorQuality: (form: DiscoveredForm, outcomes: CaseOutcome[], llm: Llm) => Promise<QualityFinding[]>
  wasValueSaved: (db: DbAdapter, dbType: 'postgres' | 'mysql', table: string, column: string, value: string) => Promise<boolean>

  db?: DbAdapter
  llm: Llm
  sourceRules?: string
  execDeps?: ExploreExecDeps

  writeReport: (root: string, runId: string, deps: WriteReportDeps) => Promise<void>
  reportDeps: Omit<WriteReportDeps, 'verifyFindings' | 'diffFindings' | 'currentStructure'>
  prepare?: (config: Config, root: string, deps: { secrets: string[]; gitToken: string }) => Promise<void>
  seedDatabase: (seed: { command: string }, root: string, secrets: string[]) => Promise<void>
  runId?: string
}

function emptyStructure(): SiteStructure {
  return { generatedAt: new Date().toISOString(), pages: [], transitions: [] }
}

function gapFinding(form: DiscoveredForm, c: InputCase, v: GapVerdict): VerifyFinding {
  return {
    category: 'input-validation',
    severity: v.confidence === 'high' ? 'high' : 'medium',
    title: `入力チェック漏れ: ${form.screenPath} ${c.field}`,
    detail:
      `不正値「${c.value}」（${c.rationale}）が ${form.screenPath} の ${c.field} で拒否されませんでした。` +
      (v.confidence === 'high' ? ` DB(${c.table}.${c.column})に保存を確認。` : ' UI/ネットワーク信号のみ（DB裏取り不可）。'),
    evidence: `selector=${c.selector} expectation=reject confidence=${v.confidence}`,
  }
}

function qualityFinding(q: QualityFinding): VerifyFinding {
  return {
    category: 'input-validation',
    severity: q.severity,
    title: `エラーメッセージ品質: ${q.screenPath}`,
    detail: q.issue,
    evidence: q.evidence,
  }
}

/**
 * Orchestrate exploratory input validation. Guards destructive runs (requires seed or --no-reseed),
 * authenticates once, then per form: model constraints → generate cases → execute → classify gaps
 * and message quality. Findings flow through writeReport; the DB is re-seeded afterward.
 */
export async function explore(root: string, opts: ExploreOpts, deps: ExploreDeps): Promise<ExploreResult> {
  // Guard: refuse to run destructively without a way to restore state.
  if (!deps.seed && !opts.noReseed) {
    throw new Error('explore: launch.seed is not configured and --no-reseed was not passed; aborting to avoid leaving the DB dirty')
  }

  const secrets = deps.secrets ?? []
  const runId = deps.runId ?? new Date().toISOString().replace(/[:.]/g, '-')

  // Stage 0: prepare (repo refresh + setup hooks).
  if (!opts.skipPrepare && deps.prepare && deps.config) {
    logger.info({ root }, 'explore prepare phase starting')
    await deps.prepare(deps.config, root, { secrets, gitToken: '' })
    logger.info({ root }, 'explore prepare phase complete')
  }

  const page = await deps.createPage()
  try {
    // Stage 1: authenticate once. Abort before any destructive submit on failure.
    const auth = await deps.authenticate(page, deps.target, deps.creds)
    if (!auth.ok) {
      throw new Error(`explore: authentication failed (${auth.detail}) — aborting before any form submission`)
    }

    // Stage 2: discover forms.
    const screens = opts.screens ?? []
    const forms = await deps.discoverForms(page, deps.target, screens)

    const findings: VerifyFinding[] = []
    let cases = 0
    let gapsHigh = 0
    let gapsMedium = 0
    let messageIssues = 0

    for (const form of forms) {
      try {
        // model
        const tables = await deps.inferCandidateTables(form, deps.llm)
        const columns: ColumnDef[] = []
        if (deps.db) {
          for (const t of tables) columns.push(...(await deps.introspectTable(deps.db, deps.dbType, t)))
        }
        const constraints = await deps.modelConstraints(form, columns, deps.sourceRules ?? '', deps.llm)
        if (constraints.length === 0) continue

        // generate
        const baseline = deps.buildBaseline(constraints)
        const inputCases = await deps.generateCases(constraints, deps.llm)

        // execute + classify gaps
        const rejectOutcomes: CaseOutcome[] = []
        for (const c of inputCases) {
          try {
            const outcome = await deps.runCase(page, form, baseline, c, deps.execDeps)
            cases++
            if (c.expectation !== 'reject') continue
            rejectOutcomes.push(outcome)
            const probe =
              deps.db && c.table && c.column
                ? () => deps.wasValueSaved(deps.db!, deps.dbType, c.table!, c.column!, c.value)
                : undefined
            const verdict = await deps.classifyGap(c, outcome, probe)
            if (verdict.gap) {
              findings.push(gapFinding(form, c, verdict))
              if (verdict.confidence === 'high') gapsHigh++
              else gapsMedium++
            }
          } catch (err) {
            logger.warn({ err: String(err), screen: form.screenPath, field: c.field }, 'explore: case failed — continuing')
          }
        }

        // message quality
        const quality = await deps.classifyErrorQuality(form, rejectOutcomes, deps.llm)
        for (const q of quality) {
          findings.push(qualityFinding(q))
          messageIssues++
        }
      } catch (err) {
        logger.warn({ err: String(err), screen: form.screenPath }, 'explore: form failed — continuing')
      }
    }

    // Stage 3: report.
    await deps.writeReport(root, runId, {
      ...deps.reportDeps,
      verifyFindings: findings,
      diffFindings: [],
      currentStructure: emptyStructure(),
    })

    // Stage 4: re-seed to restore the DB.
    if (!opts.noReseed && deps.seed) {
      await deps.seedDatabase(deps.seed, root, secrets)
    }

    return { findings, forms: forms.length, cases, gapsHigh, gapsMedium, messageIssues }
  } finally {
    await page.close?.().catch(() => {})
  }
}
