import { z } from 'zod'
import { join } from 'node:path'
import { readdir, rename, access } from 'node:fs/promises'
import { ensureDir, readYaml, writeYaml } from '../util/fs.js'

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
  /** Optional machine-readable API endpoint (used by rdra-export; method defaults to ANY). */
  apiEndpoint: z.object({ method: z.string().optional(), path: z.string().min(1) }).optional(),
})

// --- Expected DB state schema ---
export const ExpectedDbStateSchema = z.object({
  connection: z.string().min(1),
  table: z.string().min(1),
  match: z.record(z.string(), z.unknown()),
  expectedValues: z.record(z.string(), z.unknown()),
})

// --- Auth precondition (scenario-exec-engine) ---
export const PreconditionSchema = z.object({
  auth: z.enum(['authenticated', 'unauthenticated']),
})
export type Precondition = z.infer<typeof PreconditionSchema>

// --- Full scenario schema (spec §3) ---
export const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  businessFlow: z.string().min(1),
  steps: z.array(ScenarioStepSchema).min(1),
  expectedResults: z.array(ExpectedResultSchema).min(1),
  expectedDbState: z.array(ExpectedDbStateSchema),
  precondition: PreconditionSchema.optional(),
})

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>
export type ExpectedResult = z.infer<typeof ExpectedResultSchema>
export type ExpectedDbState = z.infer<typeof ExpectedDbStateSchema>

/** Full scenario type (replaces the minimal definition in domain/types.ts) */
export type Scenario = z.infer<typeof ScenarioSchema>

const SCENARIO_FILE_SUFFIX = '.scenario.yaml'

/** Scenario ids become filenames — reject anything that isn't a safe slug (no path separators). */
const VALID_ID = /^[A-Za-z0-9_-]+$/
function assertValidId(id: string): void {
  if (!VALID_ID.test(id)) {
    throw new Error(`invalid scenario id (must match [A-Za-z0-9_-]+): ${JSON.stringify(id)}`)
  }
}

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
  assertValidId(scenario.id)
  await ensureDir(dir)
  const path = join(dir, `${scenario.id}${SCENARIO_FILE_SUFFIX}`)
  await writeYaml(path, scenario)
}

/** Subdirectory under the scenario dir where proposed (unapproved) scenarios live. */
export const PROPOSED_SUBDIR = 'proposed'

/**
 * Save a proposed (not-yet-approved) scenario to `<dir>/proposed/<id>.scenario.yaml`.
 * `loadScenarios(dir)` does NOT load these — they are excluded from `run` until approved.
 */
export async function saveProposedScenario(dir: string, scenario: Scenario): Promise<void> {
  assertValidId(scenario.id)
  const proposedDir = join(dir, PROPOSED_SUBDIR)
  await ensureDir(proposedDir)
  await writeYaml(join(proposedDir, `${scenario.id}${SCENARIO_FILE_SUFFIX}`), scenario)
}

/** Load all proposed scenarios from `<dir>/proposed/`. */
export async function loadProposedScenarios(dir: string): Promise<Scenario[]> {
  return loadScenarios(join(dir, PROPOSED_SUBDIR))
}

/**
 * Promote a proposed scenario to active: move `<dir>/proposed/<id>.scenario.yaml`
 * to `<dir>/<id>.scenario.yaml`. Refuses to overwrite an existing active scenario
 * with the same id (throws); the proposed file is left in place in that case.
 */
export async function approveScenario(dir: string, id: string): Promise<void> {
  assertValidId(id)
  const filename = `${id}${SCENARIO_FILE_SUFFIX}`
  const proposedPath = join(dir, PROPOSED_SUBDIR, filename)
  const activePath = join(dir, filename)

  try {
    await access(proposedPath)
  } catch {
    throw new Error(`proposed scenario not found: ${id}`)
  }

  let activeExists = false
  try {
    await access(activePath)
    activeExists = true
  } catch {
    activeExists = false
  }
  if (activeExists) {
    throw new Error(`active scenario already exists: ${id} (will not overwrite)`)
  }

  await ensureDir(dir)
  await rename(proposedPath, activePath)
}
