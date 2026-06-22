import { join, isAbsolute } from 'node:path'
import { loadConfig as defaultLoadConfig } from '../../config/load.js'
import {
  loadProposedScenarios as defaultLoadProposed,
  approveScenario as defaultApprove,
  type Scenario,
} from '../../scenario/schema.js'
import { logger } from '../../util/logger.js'

export type RunApproveOpts = { all?: boolean; ids?: string[] }

export type RunApproveDeps = {
  loadConfig?: typeof defaultLoadConfig
  loadProposedScenarios?: (dir: string) => Promise<Scenario[]>
  approveScenario?: (dir: string, id: string) => Promise<void>
}

export type ApproveResult = { approved: string[]; skipped: Array<{ id: string; reason: string }> }

/**
 * `loop-e2e approve` — promote proposed scenarios to active. With `all`, approves
 * every scenario under `<scenarioDir>/proposed/`; otherwise the given ids. Each
 * approval that conflicts (active id exists) or is missing is skipped with a reason.
 */
export async function runApprove(root: string, opts: RunApproveOpts, deps: RunApproveDeps = {}): Promise<ApproveResult> {
  const load = deps.loadConfig ?? defaultLoadConfig
  const loadProposed = deps.loadProposedScenarios ?? defaultLoadProposed
  const approve = deps.approveScenario ?? defaultApprove

  const { config } = await load(root)
  const scenarioDir = isAbsolute(config.scenarioDir) ? config.scenarioDir : join(root, config.scenarioDir)

  const proposed = await loadProposed(scenarioDir)
  const targetIds = opts.all ? proposed.map((s) => s.id) : (opts.ids ?? [])

  if (targetIds.length === 0) {
    logger.info('approve: no scenarios to approve')
    return { approved: [], skipped: [] }
  }

  const approved: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const id of targetIds) {
    try {
      await approve(scenarioDir, id)
      approved.push(id)
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { approved, skipped }
}
