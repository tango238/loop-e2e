import { dirname, join } from 'node:path'
import { logger } from '../util/logger.js'
import { loadScenarios as defaultLoadScenarios } from '../scenario/schema.js'
import { toOperationScenario, toPendingEntry } from '../services/rdra/convert.js'
import { matchUsecase, navigateRoutes } from '../services/rdra/match.js'
import { mergeIntoAnalysisResult } from '../services/rdra/merge.js'
import { validateAnalysisResult } from '../services/rdra/validate.js'
import {
  readAnalysisResult as defaultReadAnalysis,
  writeAnalysisResult as defaultWriteAnalysis,
  writePending as defaultWritePending,
} from '../services/rdra/io.js'
import type { OperationScenario, PendingEntry } from '../services/rdra/types.js'
import type { Scenario } from '../scenario/schema.js'

export type RdraExportArgs = { scenarioDir: string; intoPath: string }

export type RdraExportDeps = {
  loadScenarios?: (dir: string) => Promise<Scenario[]>
  readAnalysisResult?: typeof defaultReadAnalysis
  writeAnalysisResult?: typeof defaultWriteAnalysis
  writePending?: typeof defaultWritePending
}

export type RdraExportResult = {
  matched: number
  pending: number
  replaced: number
  intoPath: string
  pendingPath?: string
}

const PENDING_FILENAME = 'loop-e2e-pending.json'

/**
 * Map adopted scenarios to OperationScenario, merge route-matched ones into the
 * rdra-analyzer analysis_result.json (idempotent), and write unmatched ones to
 * loop-e2e-pending.json for rdra-analyzer's reconcile. Validation runs before any
 * write — on failure nothing is written.
 */
export async function rdraExport(args: RdraExportArgs, deps: RdraExportDeps = {}): Promise<RdraExportResult> {
  const loadScenarios = deps.loadScenarios ?? defaultLoadScenarios
  const readAnalysis = deps.readAnalysisResult ?? defaultReadAnalysis
  const writeAnalysis = deps.writeAnalysisResult ?? defaultWriteAnalysis
  const writePending = deps.writePending ?? defaultWritePending

  const scenarios = await loadScenarios(args.scenarioDir)
  if (scenarios.length === 0) {
    logger.info({ scenarioDir: args.scenarioDir }, 'rdra-export: no scenarios to export')
    return { matched: 0, pending: 0, replaced: 0, intoPath: args.intoPath }
  }

  const analysis = await readAnalysis(args.intoPath)

  const matched: OperationScenario[] = []
  const pending: PendingEntry[] = []
  for (const scenario of scenarios) {
    const uc = matchUsecase(scenario, analysis.usecases)
    if (uc) matched.push(toOperationScenario(scenario, uc))
    else pending.push(toPendingEntry(scenario, navigateRoutes(scenario)))
  }

  const { analysis: merged, replaced } = mergeIntoAnalysisResult(analysis, matched)
  validateAnalysisResult(merged) // throws → nothing written
  await writeAnalysis(args.intoPath, merged)

  let pendingPath: string | undefined
  if (pending.length > 0) {
    pendingPath = join(dirname(args.intoPath), PENDING_FILENAME)
    await writePending(pendingPath, pending)
  }

  logger.info({ matched: matched.length, pending: pending.length, replaced }, 'rdra-export complete')
  return { matched: matched.length, pending: pending.length, replaced, intoPath: args.intoPath, pendingPath }
}
