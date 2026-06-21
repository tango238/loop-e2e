import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ensureDir } from '../util/fs.js'
import { fingerprint } from '../util/hash.js'
import { logger } from '../util/logger.js'
import { maskSecrets } from '../util/mask.js'
import { statePaths } from '../state/paths.js'
import type {
  RunContext,
  DiffFinding,
  VerifyFinding,
  FindingVerdict,
  Report,
  SiteStructure,
} from '../domain/types.js'
import type { Llm } from '../services/llm/client.js'
import type { GithubClient } from '../services/github/client.js'
import type { RepoRef } from '../services/github/labels.js'
import type { Config } from '../config/schema.js'

type StoreApi = {
  saveBaseline: (root: string, structure: SiteStructure) => Promise<void>
}

type AdjudicateFn = (
  llm: Llm,
  finding: DiffFinding | VerifyFinding,
  evidence: string,
  refutation: Config['refutation'],
) => Promise<FindingVerdict>

type UpsertIssueFn = (
  client: GithubClient,
  repo: RepoRef,
  finding: { title: string; body: string; fingerprint: string },
  autoDetectLabel: string,
  secrets?: string[],
) => Promise<void>

export type WriteReportDeps = {
  ctx: RunContext
  diffFindings: DiffFinding[]
  verifyFindings: VerifyFinding[]
  currentStructure: SiteStructure
  llm: Llm
  adjudicate: AdjudicateFn
  upsertIssue: UpsertIssueFn
  store: StoreApi
  githubClient: GithubClient | null
  repo: RepoRef | null
}

function findingTitle(finding: DiffFinding | VerifyFinding): string {
  if ('kind' in finding) {
    return `[${finding.kind}] ${finding.location}: ${finding.expected.slice(0, 60)}`
  }
  return `[${finding.category}] ${finding.title}`
}

function findingBody(finding: DiffFinding | VerifyFinding, verdict: FindingVerdict): string {
  if ('kind' in finding) {
    return `**Kind:** ${finding.kind}\n**Severity:** ${finding.severity}\n**Location:** ${finding.location}\n\n**Expected:** ${finding.expected}\n\n**Actual:** ${finding.actual}\n\n**Verdict:** ${verdict.classification} (confidence: ${verdict.confidence.toFixed(2)})\n\n${verdict.rationale}`
  }
  return `**Category:** ${finding.category}\n**Severity:** ${finding.severity}\n**Title:** ${finding.title}\n\n**Detail:** ${finding.detail}\n\n**Evidence:** ${finding.evidence}\n\n**Verdict:** ${verdict.classification} (confidence: ${verdict.confidence.toFixed(2)})\n\n${verdict.rationale}`
}

function findingFingerprint(finding: DiffFinding | VerifyFinding): string {
  if ('kind' in finding) {
    return fingerprint([finding.kind, finding.location, finding.expected, finding.actual])
  }
  return fingerprint([finding.category, finding.title, finding.detail])
}

function buildEvidence(finding: DiffFinding | VerifyFinding): string {
  if ('kind' in finding) {
    return `kind=${finding.kind} location=${finding.location} expected=${finding.expected} actual=${finding.actual}`
  }
  return `category=${finding.category} title=${finding.title} detail=${finding.detail} evidence=${finding.evidence}`
}

function buildReportPrompt(
  diffFindings: DiffFinding[],
  verifyFindings: VerifyFinding[],
  target: string,
): string {
  const diffSummary = diffFindings
    .map((f) => `- [${f.kind}] ${f.location}: ${f.expected} → ${f.actual}`)
    .join('\n')

  const verifySummary = verifyFindings
    .map((f) => `- [${f.category}] ${f.title}: ${f.detail}`)
    .join('\n')

  return `You are an E2E test report writer. Generate a concise Markdown report for the following findings from target: ${target}.

## Diff Findings (${diffFindings.length})
${diffSummary || '(none)'}

## Verify Findings (${verifyFindings.length})
${verifySummary || '(none)'}

Write a professional summary with:
1. Executive summary (2-3 sentences)
2. Key findings (bullet list)
3. Risk assessment

Use Markdown formatting.`
}

/**
 * Generates and persists a run report:
 * 1. Generates body with Sonnet (role=report)
 * 2. Adjudicates each finding with Opus panel
 * 3. Only files GitHub issue if BOTH gates pass (confirmed + confidence≥threshold)
 * 4. Writes report.md + report.json, updates baseline
 */
export async function writeReport(
  root: string,
  runId: string,
  deps: WriteReportDeps,
): Promise<void> {
  const { ctx, diffFindings, verifyFindings, currentStructure, llm, adjudicate, upsertIssue, store, githubClient, repo } = deps
  const paths = statePaths(root)
  const reportDir = join(paths.reports, runId)
  await ensureDir(reportDir)

  const target = ctx.config.targets[0]?.name ?? 'unknown'

  // Collect ALL secrets for masking — anthropicApiKey, githubToken, all db passwords, all target auth values
  const allSecrets: string[] = [
    ctx.secrets.anthropicApiKey,
    ctx.secrets.githubToken,
    ...Object.values(ctx.secrets.db),
    ...Object.values(ctx.secrets.targetAuth),
  ].filter((s): s is string => Boolean(s))

  // 1. Generate report body with Sonnet, then mask any secrets that crept in via LLM output
  const reportPrompt = buildReportPrompt(diffFindings, verifyFindings, target)
  const rawReportBody = await llm.complete('report', reportPrompt)
  const reportBody = maskSecrets(rawReportBody, allSecrets)

  // 2. Adjudicate each finding (parallel — panel inside each adjudicate also parallelizes)
  const allFindings: (DiffFinding | VerifyFinding)[] = [...diffFindings, ...verifyFindings]
  const verdicts: Record<string, FindingVerdict> = {}
  const gatePassedFindings: { finding: DiffFinding | VerifyFinding; verdict: FindingVerdict; fp: string }[] = []
  const uncertainFindings: { finding: DiffFinding | VerifyFinding; verdict: FindingVerdict }[] = []

  await Promise.all(
    allFindings.map(async (finding) => {
      const fp = findingFingerprint(finding)
      const evidence = buildEvidence(finding)
      const verdict = await adjudicate(llm, finding, evidence, ctx.config.refutation)
      verdicts[fp] = verdict

      const bothGatesPass =
        (verdict.classification === 'bug' || verdict.classification === 'unnecessary') &&
        verdict.confidence >= ctx.config.refutation.confidenceThreshold

      if (bothGatesPass) {
        gatePassedFindings.push({ finding, verdict, fp })
      } else {
        uncertainFindings.push({ finding, verdict })
      }
    }),
  )

  // 3. File GitHub issues for gate-passed findings — pass full secret set
  if (githubClient && repo) {
    for (const { finding, verdict, fp } of gatePassedFindings) {
      try {
        await upsertIssue(
          githubClient,
          repo,
          {
            title: findingTitle(finding),
            body: findingBody(finding, verdict),
            fingerprint: fp,
          },
          ctx.config.github.labels.autoDetect,
          allSecrets,
        )
      } catch (error) {
        logger.error({ error }, 'Failed to upsert issue — continuing')
      }
    }
  }

  // 4. Build report object
  const report: Report = {
    runId,
    startedAt: new Date().toISOString(),
    target,
    diffFindings,
    verifyFindings,
    verdicts,
    siteStructureRef: `runs/${runId}.yaml`,
    summary: reportBody,
  }

  // 5. Build markdown content
  const uncertainSection = uncertainFindings.length > 0
    ? `\n\n## ユーザー確認要 (${uncertainFindings.length} 件)\n\n` +
      uncertainFindings
        .map(({ finding, verdict }) => {
          const title = findingTitle(finding)
          return `### ${title}\n\n- **Verdict:** ${verdict.classification} (confidence: ${verdict.confidence.toFixed(2)})\n- **Rationale:** ${verdict.rationale}`
        })
        .join('\n\n')
    : ''

  const mdContent = `${reportBody}${uncertainSection}\n`

  // 6. Write files — mask secrets from both written artifacts before persisting
  const safeMd = maskSecrets(mdContent, allSecrets)
  const safeJson = maskSecrets(JSON.stringify(report, null, 2), allSecrets)
  await writeFile(join(reportDir, 'report.json'), safeJson, 'utf8')
  await writeFile(join(reportDir, 'report.md'), safeMd, 'utf8')
  logger.info({ runId, reportDir }, 'Report written')

  // 7. Update baseline
  await store.saveBaseline(root, currentStructure)
  logger.debug({ runId }, 'Baseline updated')
}
