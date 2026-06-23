import { logger } from '../../util/logger.js'
import type { Config } from '../../config/schema.js'
import type { Secrets, RunContext, DiffFinding, VerifyFinding } from '../../domain/types.js'
import type { RenderReportDeps } from '../../pipeline/report.js'
import type { FindingsEntry, ActivityEntry } from '../../state/findings.js'

export type RunReportOpts = { target?: string }

export type RunReportResult = {
  reportRunId: string
  findings: number
  sources: string[]
  /** false when there was nothing pending to report */
  wrote: boolean
}

export type RunReportDeps = {
  loadConfig: (cwd: string) => Promise<{ config: Config; secrets: Secrets }>
  readPendingFindings: (root: string) => Promise<FindingsEntry[]>
  readPendingActivity: (root: string) => Promise<ActivityEntry[]>
  archiveConsumed: (root: string, reportRunId: string) => Promise<void>
  renderReport: (root: string, runId: string, deps: RenderReportDeps) => Promise<void>
  createLlm: (apiKey: string, models: Config['models'], opts?: { language?: string }) => import('../../services/llm/client.js').Llm
  createGithubClient: (token: string) => import('../../services/github/client.js').GithubClient
  /** Injected for deterministic reportRunId in tests */
  clock?: () => string
}

/**
 * Aggregate all pending findings (from `run`/`explore`) + activity (from grow/scenario/run/explore),
 * run the refutation gate once, write a single report + GitHub issues, then archive the consumed
 * entries so the next `report` starts clean.
 */
export async function runReport(cwd: string, opts: RunReportOpts, deps: RunReportDeps): Promise<RunReportResult> {
  const { config, secrets } = await deps.loadConfig(cwd)
  const reportRunId = deps.clock ? deps.clock() : new Date().toISOString().replace(/[:.]/g, '-')

  const entries = await deps.readPendingFindings(cwd)
  const activity = await deps.readPendingActivity(cwd)

  const diffFindings: DiffFinding[] = entries.flatMap((e) => e.diffFindings)
  const verifyFindings: VerifyFinding[] = entries.flatMap((e) => e.verifyFindings)
  const sources = [...new Set(entries.map((e) => e.source))]

  if (diffFindings.length === 0 && verifyFindings.length === 0 && activity.length === 0) {
    logger.info('report: nothing pending — skipping')
    return { reportRunId, findings: 0, sources: [], wrote: false }
  }

  const selected = opts.target
    ? (config.targets.find((t) => t.name === opts.target) ?? config.targets[0])
    : config.targets[0]
  const orderedConfig: Config = selected && selected !== config.targets[0]
    ? { ...config, targets: [selected, ...config.targets.filter((t) => t !== selected)] }
    : config

  const ctx: RunContext = { root: cwd, runId: reportRunId, config: orderedConfig, secrets }
  const llm = deps.createLlm(secrets.anthropicApiKey, config.models, { language: config.language })

  const allSecrets: string[] = [
    secrets.anthropicApiKey,
    secrets.githubToken,
    ...Object.values(secrets.db),
    ...Object.values(secrets.targetAuth),
  ].filter(Boolean) as string[]

  const githubClient = secrets.githubToken ? deps.createGithubClient(secrets.githubToken) : null
  const repoUrl = config.repositories[0]?.url
  const { adjudicate } = await import('../../services/llm/refute.js')
  const { upsertIssue } = await import('../../services/github/issues.js')
  const { parseRepoUrl } = await import('../../services/github/labels.js')
  const repo = githubClient && repoUrl ? parseRepoUrl(repoUrl) : null

  await deps.renderReport(cwd, reportRunId, {
    ctx,
    diffFindings,
    verifyFindings,
    activity,
    llm,
    adjudicate,
    upsertIssue: (client, r, finding, label) => upsertIssue(client, r, finding, label, allSecrets),
    githubClient,
    repo,
  })

  await deps.archiveConsumed(cwd, reportRunId)

  return { reportRunId, findings: diffFindings.length + verifyFindings.length, sources, wrote: true }
}
