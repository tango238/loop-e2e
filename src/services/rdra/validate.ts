import type { AnalysisResult } from './types.js'

/**
 * Referential-integrity check run before writing the analysis file.
 * Throws (so the file is NOT written) on a dangling usecase_id, a duplicate
 * scenario_id, or a non-sequential step_no (must be 1..n).
 */
export function validateAnalysisResult(analysis: AnalysisResult): void {
  const ucIds = new Set(analysis.usecases.map((u) => u.id))
  const seen = new Set<string>()
  for (const s of analysis.scenarios) {
    if (!ucIds.has(s.usecase_id)) {
      throw new Error(`dangling usecase_id "${s.usecase_id}" in scenario "${s.scenario_id}"`)
    }
    if (seen.has(s.scenario_id)) throw new Error(`duplicate scenario_id "${s.scenario_id}"`)
    seen.add(s.scenario_id)
    s.steps.forEach((step, i) => {
      if (step.step_no !== i + 1) {
        throw new Error(`non-sequential step_no in scenario "${s.scenario_id}": expected ${i + 1}, got ${step.step_no}`)
      }
    })
  }
}
