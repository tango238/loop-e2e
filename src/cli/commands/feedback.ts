import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { logger } from '../../util/logger.js'
import { fingerprint } from '../../util/hash.js'
import { saveFeedback, saveKnownFinding } from '../../state/store.js'
import { loadScenarios, saveScenario } from '../../scenario/schema.js'
import { verifyFeedback } from '../../services/llm/feedbackVerify.js'
import { statePaths } from '../../state/paths.js'
import { readJson } from '../../util/fs.js'
import type { Feedback, Report, VerifyFinding } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'

export type FeedbackOpts = {
  /** Run ID whose report to reference */
  runId: string
  /** Zero-based index into verifyFindings (or diffFindings if negative/out-of-range) */
  findingIndex: number
  /** User's free-text comment */
  comment: string
  /** Scenario id to update on valid feedback (optional) */
  scenarioId?: string
  /** Directory where scenario files live */
  scenarioDir: string
}

export type FeedbackDeps = {
  llm: Llm
  /** Injectable for testing: loads report.json for a given runId */
  loadReport?: (root: string, runId: string) => Promise<Report | null>
}

async function defaultLoadReport(root: string, runId: string): Promise<Report | null> {
  const paths = statePaths(root)
  const file = join(paths.reports, runId, 'report.json')
  try {
    return await readJson<Report>(file)
  } catch {
    return null
  }
}

/**
 * Feedback command: intake → verify → apply.
 *
 * 1. Intake: load the referenced finding from the run report.
 * 2. Verify: call verifyFeedback (Opus) to judge whether the comment is a
 *    valid correction or a misunderstanding.
 * 3. Apply (valid only):
 *    (a) Persist a known-finding entry so future diff/verify runs skip it.
 *    (b) Reflect the correction into the referenced Scenario:
 *        - registered-data / DB-related findings → append to expectedDbState
 *        - all other categories → append to expectedResults
 * 4. Persist the feedback item (always, with verdict set).
 *
 * The feedback id is generated ONCE and reused for both the verifyFeedback call
 * and the persisted item so they share the same traceable id.
 */
export async function runFeedback(
  root: string,
  opts: FeedbackOpts,
  deps: FeedbackDeps,
): Promise<void> {
  const { runId, findingIndex, comment, scenarioId, scenarioDir } = opts
  const { llm, loadReport = defaultLoadReport } = deps

  // --- 1. Intake: load report and resolve finding ---
  const report = await loadReport(root, runId)
  const finding = resolveFinding(report, findingIndex)
  const findingId = finding
    ? `${runId}:verify:${findingIndex}`
    : undefined

  logger.info({ runId, findingId, scenarioId }, 'Processing feedback')

  // --- 2. Verify with Opus ---
  // Generate the id ONCE so the transient Feedback passed to verifyFeedback and
  // the persisted FeedbackItem share the same id (preserves traceability).
  const feedbackId = randomUUID()

  const evidence = finding
    ? {
        findingTitle: finding.title,
        findingDetail: finding.detail,
        findingCategory: finding.category,
      }
    : {
        findingTitle: '(no specific finding)',
        findingDetail: comment,
        findingCategory: 'general',
      }

  const verifyResult = await verifyFeedback(llm, {
    id: feedbackId,
    targetFindingId: findingId,
    userComment: comment,
    appliedTo: [],
    createdAt: new Date().toISOString(),
  }, evidence)

  const appliedTo: string[] = []

  // --- 3. Apply (valid feedback only) ---
  if (verifyResult.valid) {
    // (a) Register as known-state
    const fp = finding
      ? fingerprint([finding.category, finding.title, finding.detail])
      : fingerprint(['general', comment])
    await saveKnownFinding(root, fp, { reason: comment, by: 'user' })
    logger.info({ fingerprint: fp }, 'Finding registered as known-state')

    // (b) Reflect into scenario
    if (scenarioId) {
      const scenarios = await loadScenarios(scenarioDir)
      const scenario = scenarios.find((s) => s.id === scenarioId)
      if (scenario) {
        const isDbFinding = finding?.category === 'registered-data'

        const updatedScenario = isDbFinding
          ? {
              ...scenario,
              expectedDbState: [
                ...scenario.expectedDbState,
                {
                  connection: 'default',
                  table: '[feedback-noted]',
                  match: {},
                  expectedValues: {
                    _note: `[known false-positive] ${finding?.title ?? 'feedback'}: ${comment}`,
                  },
                },
              ],
            }
          : {
              ...scenario,
              expectedResults: [
                ...scenario.expectedResults,
                {
                  kind: 'ui' as const,
                  description: `[known false-positive] ${finding?.title ?? 'feedback'}: ${comment}`,
                  assertion: '[known] acknowledged by user feedback',
                },
              ],
            }

        await saveScenario(scenarioDir, updatedScenario)
        appliedTo.push(scenarioId)
        logger.info({ scenarioId, isDbFinding }, 'Scenario updated with feedback correction')
      } else {
        logger.warn({ scenarioId }, 'Scenario not found — skipping scenario update')
      }
    }
  } else {
    logger.info({ classification: verifyResult.classification }, 'Feedback deemed invalid — no changes applied')
  }

  // --- 4. Persist feedback (always) ---
  const feedbackItem: Feedback = {
    id: feedbackId,
    targetFindingId: findingId,
    userComment: comment,
    verdict: verifyResult.valid ? 'valid' : 'invalid',
    appliedTo,
    createdAt: new Date().toISOString(),
  }
  await saveFeedback(root, feedbackItem)
  logger.info({ feedbackId: feedbackItem.id, verdict: feedbackItem.verdict }, 'Feedback saved')
}

function resolveFinding(
  report: Report | null,
  index: number,
): VerifyFinding | null {
  if (!report) return null
  return report.verifyFindings[index] ?? null
}
