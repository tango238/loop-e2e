import { isAbsolute, join } from 'node:path'
import { rdraExport as defaultRdraExport } from '../../pipeline/rdraExport.js'
import type { RdraExportResult } from '../../pipeline/rdraExport.js'

export type RunRdraExportDeps = {
  rdraExport: typeof defaultRdraExport
  loadConfig?: (root: string) => Promise<{ config: { scenarioDir: string } }>
}

function absolutize(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p)
}

/**
 * Resolve scenarioDir (opts → config.scenarioDir → "scenarios") and intoPath
 * (opts.into → <root>/output/usecases/analysis_result.json), then run the export.
 */
export async function runRdraExport(
  root: string,
  opts: { into?: string; scenarioDir?: string },
  deps: RunRdraExportDeps,
): Promise<RdraExportResult> {
  let configScenarioDir = 'scenarios'
  if (deps.loadConfig) {
    try {
      const { config } = await deps.loadConfig(root)
      configScenarioDir = config.scenarioDir || 'scenarios'
    } catch {
      // no config — fall back to the default scenarios dir
    }
  }
  const scenarioDir = opts.scenarioDir ? absolutize(root, opts.scenarioDir) : absolutize(root, configScenarioDir)
  const intoPath = opts.into ? absolutize(root, opts.into) : join(root, 'output', 'usecases', 'analysis_result.json')
  return deps.rdraExport({ scenarioDir, intoPath })
}
