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
import type { ActivityEntry } from '../state/findings.js'
import type { Llm } from '../services/llm/client.js'
import type { GithubClient } from '../services/github/client.js'
import type { RepoRef } from '../services/github/labels.js'
import type { Config } from '../config/schema.js'

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

export type RenderReportDeps = {
  ctx: RunContext
  diffFindings: DiffFinding[]
  verifyFindings: VerifyFinding[]
  /** Activity summary lines from grow/scenario/run/explore (shown in the report). */
  activity?: ActivityEntry[]
  llm: Llm
  adjudicate: AdjudicateFn
  upsertIssue: UpsertIssueFn
  githubClient: GithubClient | null
  repo: RepoRef | null
}

function findingTitle(finding: DiffFinding | VerifyFinding): string {
  if ('kind' in finding) {
    return `[${finding.kind}] ${finding.location}: ${finding.expected.slice(0, 60)}`
  }
  return `[${finding.category}] ${finding.title}`
}

/**
 * Best-effort page/URL for a finding so the user can tell which page it refers to.
 * DiffFinding carries `location`; VerifyFinding embeds the page in `evidence`
 * (`[url] …`, `… @ url`, `finalUrl: url`) or any URL across its fields.
 */
function findingPage(finding: DiffFinding | VerifyFinding): string {
  if ('kind' in finding) return finding.location || '(ページ不明)'
  const ev = finding.evidence ?? ''
  // `[<url-or-path>]` — restricted to URL/path so it doesn't match selectors like [name="age"].
  const bracket = /\[((?:https?:\/\/|\/)[^\]]+)\]/.exec(ev)
  if (bracket) return bracket[1].trim()
  const at = /@\s*(\S+)/.exec(ev)
  if (at) return at[1]
  const finalUrl = /finalUrl:\s*(\S+)/.exec(ev)
  if (finalUrl) return finalUrl[1]
  const haystack = `${ev} ${finding.detail} ${finding.title}`
  const anyUrl = /(https?:\/\/\S+)/.exec(haystack)
  if (anyUrl) return anyUrl[1]
  // No full URL (e.g. input-validation findings reference a relative screen path like /user/create).
  const path = /(?:^|\s)(\/[A-Za-z0-9/_.-]+)/.exec(haystack)
  if (path) return path[1]
  return '(ページ不明)'
}

/** One-line "what changed/was found" for the user-facing section. */
function findingDetail(finding: DiffFinding | VerifyFinding): string {
  return 'kind' in finding ? `${finding.expected} → ${finding.actual}` : finding.detail
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

/** De-duplicate findings across sources by fingerprint, keeping first occurrence. */
function dedupeFindings<T extends DiffFinding | VerifyFinding>(findings: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const f of findings) {
    const fp = findingFingerprint(f)
    if (seen.has(fp)) continue
    seen.add(fp)
    out.push(f)
  }
  return out
}

/** Markdown "実施サマリ" listing what each command did (grow/scenario/run/explore). */
function activitySection(activity: ActivityEntry[]): string {
  if (activity.length === 0) return ''
  const lines = activity.map((a) => `- [${a.source}] ${a.summary}`).join('\n')
  return `\n\n## 実施サマリ\n\n${lines}`
}

/**
 * Generates and persists a report from aggregated findings:
 * 1. Generates body with Sonnet (role=report)
 * 2. Adjudicates each finding with Opus panel
 * 3. Only files GitHub issue if BOTH gates pass (confirmed + confidence≥threshold)
 * 4. Writes report.md + report.json
 * Findings are de-duplicated across sources; baseline is NOT touched (the run command owns it).
 */
export async function renderReport(
  root: string,
  runId: string,
  deps: RenderReportDeps,
): Promise<void> {
  const { ctx, llm, adjudicate, upsertIssue, githubClient, repo } = deps
  const diffFindings = dedupeFindings(deps.diffFindings)
  const verifyFindings = dedupeFindings(deps.verifyFindings)
  const activity = deps.activity ?? []
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
          // Always state which page the finding refers to.
          return `### ${title}\n\n- **ページ:** ${findingPage(finding)}\n- **Detail:** ${findingDetail(finding)}\n- **Verdict:** ${verdict.classification} (confidence: ${verdict.confidence.toFixed(2)})\n- **Rationale:** ${verdict.rationale}`
        })
        .join('\n\n')
    : ''

  const mdContent = `${reportBody}${activitySection(activity)}${uncertainSection}\n`

  // 6. Write files — mask secrets from both written artifacts before persisting
  const safeMd = maskSecrets(mdContent, allSecrets)
  const safeJson = maskSecrets(JSON.stringify(report, null, 2), allSecrets)
  await writeFile(join(reportDir, 'report.json'), safeJson, 'utf8')
  await writeFile(join(reportDir, 'report.md'), safeMd, 'utf8')
  logger.info({ runId, reportDir }, 'Report written')
}

// --- Back-compat shim (removed once run/explore migrate to the findings store) ---
// Old callers also expect the baseline to be saved; renderReport no longer does this.
export type WriteReportDeps = RenderReportDeps & {
  currentStructure: SiteStructure
  store: { saveBaseline: (root: string, structure: SiteStructure) => Promise<void> }
}

/** @deprecated Use renderReport (+ save the baseline in the caller). Kept until run/explore migrate. */
export async function writeReport(root: string, runId: string, deps: WriteReportDeps): Promise<void> {
  await renderReport(root, runId, deps)
  await deps.store.saveBaseline(root, deps.currentStructure)
  logger.debug({ runId }, 'Baseline updated')
}
