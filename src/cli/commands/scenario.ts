import { loadConfig } from '../../config/load.js'
import { createLlm } from '../../services/llm/client.js'
import { collectRequirements } from '../../services/repo/reader.js'
import { generateScenarios } from '../../services/llm/scenarioGen.js'
import { loadScenarios, saveScenario, type Scenario } from '../../scenario/schema.js'
import { logger } from '../../util/logger.js'
import type { Llm } from '../../services/llm/client.js'
import type { GitLogRunner } from '../../services/repo/gitlog.js'
import type { RequirementContext } from '../../services/repo/reader.js'
import type { AuthHint } from '../../services/llm/prompts/scenario.js'

export type ScenarioOpts = {
  /** Additional requirement files to merge (--from flag) */
  from?: string[]
}

/** Injectable dependencies for scenario command — makes the command testable. */
export type ScenarioDeps = {
  llm?: Llm
  gitLogRunner?: GitLogRunner
  /** Injected for tests; defaults to stdin confirm */
  confirm?: (message: string) => Promise<boolean>
  /** Override collectRequirements for testing */
  collectRequirements?: (
    repos: import('../../config/schema.js').Config['repositories'],
    deps: Parameters<typeof collectRequirements>[1],
  ) => Promise<RequirementContext[]>
  /** Override generateScenarios for testing */
  generateScenarios?: (llm: Llm, contexts: RequirementContext[], authHint?: AuthHint) => Promise<Scenario[]>
}

/**
 * Run the `scenario` command:
 * 1. Load config + secrets.
 * 2. Collect requirements from each repo (clone cache → select → summarize + git log).
 * 3. Call Opus to generate scenarios.
 * 4. For each generated scenario, either save (new) or show diff and confirm (existing).
 */
export async function runScenario(
  root: string,
  opts: ScenarioOpts,
  deps: ScenarioDeps = {},
): Promise<void> {
  const { config, secrets } = await loadConfig(root)

  const llm =
    deps.llm ?? createLlm(secrets.anthropicApiKey, config.models, { language: config.language })

  const collect = deps.collectRequirements ?? collectRequirements
  const generate = deps.generateScenarios ?? generateScenarios
  const confirm = deps.confirm ?? defaultConfirm

  const contexts = await collect(config.repositories, {
    llm,
    token: secrets.githubToken,
    root,
    ingestion: config.ingestion,
    fromPaths: opts.from,
    gitLogRunner: deps.gitLogRunner,
  })

  // Build auth hint from the first configured target (structural info only — no cred values)
  const firstTarget = config.targets[0]
  const authHint: AuthHint | undefined = firstTarget?.auth?.loginPath
    ? { loginPath: firstTarget.auth.loginPath }
    : undefined

  const scenarios = await generate(llm, contexts, authHint)
  logger.info({ count: scenarios.length }, 'Scenarios ready — saving')

  const existing = await loadScenarios(config.scenarioDir)
  const existingById = new Map(existing.map((s) => [s.id, s]))

  for (const scenario of scenarios) {
    const prev = existingById.get(scenario.id)
    if (prev) {
      const changed = JSON.stringify(prev) !== JSON.stringify(scenario)
      if (!changed) {
        logger.info({ id: scenario.id }, 'Scenario unchanged — skipping')
        continue
      }
      const diff = buildDiff(prev, scenario)
      const ok = await confirm(`Scenario ${scenario.id} already exists. Overwrite?\n\n${diff}`)
      if (!ok) {
        logger.info({ id: scenario.id }, 'Scenario overwrite skipped by user')
        continue
      }
    }
    await saveScenario(config.scenarioDir, scenario)
    logger.info({ id: scenario.id }, 'Scenario saved')
  }

  logger.info('scenario command complete')
}

// NOTE: positional/line-by-line diff — may be misleading when array elements shift position.
function buildDiff(prev: Scenario, next: Scenario): string {
  const prevJson = JSON.stringify(prev, null, 2)
  const nextJson = JSON.stringify(next, null, 2)
  const prevLines = prevJson.split('\n')
  const nextLines = nextJson.split('\n')
  const maxLen = Math.max(prevLines.length, nextLines.length)
  const diffLines: string[] = []
  for (let i = 0; i < maxLen; i++) {
    const p = prevLines[i] ?? ''
    const n = nextLines[i] ?? ''
    if (p !== n) {
      if (p) diffLines.push(`- ${p}`)
      if (n) diffLines.push(`+ ${n}`)
    }
  }
  return diffLines.length > 0 ? diffLines.join('\n') : '(no textual diff found)'
}

async function defaultConfirm(message: string): Promise<boolean> {
  process.stdout.write(`${message}\n[y/N] `)
  return new Promise((resolve) => {
    process.stdin.once('data', (d) => {
      resolve(d.toString().trim().toLowerCase() === 'y')
    })
  })
}
