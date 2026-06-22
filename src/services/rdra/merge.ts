import { LE_PREFIX } from './types.js'
import type { AnalysisResult, OperationScenario } from './types.js'

/**
 * Merge loop-e2e-origin scenarios into the analysis result idempotently:
 * remove existing LE- scenarios, append the new ones, recompute metadata counts.
 * Usecases, non-LE scenarios, and unknown top-level fields are preserved.
 */
export function mergeIntoAnalysisResult(
  analysis: AnalysisResult,
  leScenarios: OperationScenario[],
): { analysis: AnalysisResult; replaced: number } {
  const existingNonLe = analysis.scenarios.filter((s) => !s.scenario_id.startsWith(LE_PREFIX))
  const replaced = analysis.scenarios.length - existingNonLe.length
  const scenarios = [...existingNonLe, ...leScenarios]
  const merged: AnalysisResult = {
    ...analysis,
    usecases: [...analysis.usecases],
    scenarios,
    metadata: {
      ...(analysis.metadata ?? {}),
      total_usecases: analysis.usecases.length,
      total_scenarios: scenarios.length,
    },
  }
  return { analysis: merged, replaced }
}
