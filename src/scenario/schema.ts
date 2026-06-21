import { z } from 'zod'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { readYaml, writeYaml } from '../util/fs.js'

// --- Step schema ---
export const ScenarioStepSchema = z.object({
  action: z.string().min(1),
  target: z.string().min(1),
  input: z.string().optional(),
  expectedOutcome: z.string().min(1),
})

// --- Expected result schema ---
export const ExpectedResultSchema = z.object({
  kind: z.enum(['ui', 'api', 'db', 'email', 'log']),
  description: z.string().min(1),
  assertion: z.string().min(1),
})

// --- Expected DB state schema ---
export const ExpectedDbStateSchema = z.object({
  connection: z.string().min(1),
  table: z.string().min(1),
  match: z.record(z.string(), z.unknown()),
  expectedValues: z.record(z.string(), z.unknown()),
})

// --- Full scenario schema (spec §3) ---
export const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  businessFlow: z.string().min(1),
  steps: z.array(ScenarioStepSchema).min(1),
  expectedResults: z.array(ExpectedResultSchema).min(1),
  expectedDbState: z.array(ExpectedDbStateSchema),
})

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>
export type ExpectedResult = z.infer<typeof ExpectedResultSchema>
export type ExpectedDbState = z.infer<typeof ExpectedDbStateSchema>

/** Full scenario type (replaces the minimal definition in domain/types.ts) */
export type Scenario = z.infer<typeof ScenarioSchema>

const SCENARIO_FILE_SUFFIX = '.scenario.yaml'

/**
 * Load all *.scenario.yaml files from `dir`, parse, and zod-validate each.
 * Invalid files are logged and skipped rather than throwing.
 */
export async function loadScenarios(dir: string): Promise<Scenario[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const results: Scenario[] = []
  for (const entry of entries) {
    if (!entry.endsWith(SCENARIO_FILE_SUFFIX)) continue
    const raw = await readYaml<unknown>(join(dir, entry))
    const parsed = ScenarioSchema.safeParse(raw)
    if (parsed.success) {
      results.push(parsed.data)
    }
  }
  return results
}

/**
 * Save a scenario to `dir/<id>.scenario.yaml`.
 * Ensures the directory exists before writing.
 */
export async function saveScenario(dir: string, scenario: Scenario): Promise<void> {
  const path = join(dir, `${scenario.id}${SCENARIO_FILE_SUFFIX}`)
  await writeYaml(path, scenario)
}
