import { dirname, join } from 'node:path'
import { logger } from '../util/logger.js'
import { loadScenarios as defaultLoadScenarios } from '../scenario/schema.js'
import { toPendingEntry } from '../services/rdra/convert.js'
import { navigateRoutes } from '../services/rdra/match.js'
import { writePending as defaultWritePending } from '../services/rdra/io.js'
import type { PendingEntry } from '../services/rdra/types.js'
import type { Scenario } from '../scenario/schema.js'

export type RdraExportArgs = { scenarioDir: string; intoPath: string }

export type RdraExportDeps = {
  loadScenarios?: (dir: string) => Promise<Scenario[]>
  writePending?: typeof defaultWritePending
}

export type RdraExportResult = {
  pending: number
  pendingPath?: string
  /** Anchors the output directory (the pending file is written next to it). */
  intoPath: string
}

const PENDING_FILENAME = 'loop-e2e-pending.json'

/**
 * Convert every adopted scenario to a PendingEntry and write them all to
 * loop-e2e-pending.json next to the rdra-analyzer analysis_result.json.
 *
 * loop-e2e performs NO usecase matching and never writes analysis_result.json:
 * rdra-analyzer's `reconcile` is the sole arbiter (route match + checkpoint
 * fact-check + conflict detection + synthesize). This is the single inbound
 * Published-Language channel of rdra-analyzer context-map R4 (loop-e2e → ②).
 */
export async function rdraExport(args: RdraExportArgs, deps: RdraExportDeps = {}): Promise<RdraExportResult> {
  const loadScenarios = deps.loadScenarios ?? defaultLoadScenarios
  const writePending = deps.writePending ?? defaultWritePending

  const scenarios = await loadScenarios(args.scenarioDir)
  if (scenarios.length === 0) {
    logger.info({ scenarioDir: args.scenarioDir }, 'rdra-export: no scenarios to export')
    return { pending: 0, intoPath: args.intoPath }
  }

  const pending: PendingEntry[] = scenarios.map((s) => toPendingEntry(s, navigateRoutes(s)))

  const pendingPath = join(dirname(args.intoPath), PENDING_FILENAME)
  await writePending(pendingPath, pending)

  logger.info({ pending: pending.length, pendingPath }, 'rdra-export complete (all scenarios → pending)')
  return { pending: pending.length, pendingPath, intoPath: args.intoPath }
}
