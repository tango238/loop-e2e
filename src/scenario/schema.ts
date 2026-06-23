import { z } from 'zod'
import { join } from 'node:path'
import { readdir, rename, access } from 'node:fs/promises'
import { ensureDir, readYaml, writeYaml } from '../util/fs.js'

// --- Step schema ---
export const ScenarioStepSchema = z.object({
  action: z.string().min(1),
  target: z.string().min(1),
  input: z.string().optional(),
  /** Variable name written by a `capture` step (referenced later as {{VAR}}); uppercase to match resolution. */
  var: z.string().regex(/^[A-Z0-9_]+$/, 'capture var must be UPPER_SNAKE (matches {{VAR}} resolution)').optional(),
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

// --- Persona (multi-act): a named actor with its own session (target reserved for Phase3) ---
export const PersonaSchema = z.object({
  name: z.string().min(1),
  target: z.string().optional(),
  auth: z.enum(['authenticated', 'unauthenticated']),
  loginPath: z.string().optional(),
  credEnv: z.object({ usernameEnv: z.string().min(1), passwordEnv: z.string().min(1) }).optional(),
})
export type Persona = z.infer<typeof PersonaSchema>

// --- Act: a persona-scoped block of steps within a multi-act scenario ---
export const ActSchema = z.object({
  persona: z.string().optional(),
  steps: z.array(ScenarioStepSchema).min(1),
})
export type Act = z.infer<typeof ActSchema>

// --- Scenario-owned 2FA config ---
// Environment-specific 2FA glue lives with the scenario (not in config). `pinCommand` is run
// with cwd = the scenario's script dir (scenarios/<file-basename>/), so it can reference scripts
// placed alongside the scenario (e.g. "bash get-2fa-pin.sh"). loop-e2e core stays env-agnostic.
export const ScenarioTwoFactorSchema = z.object({
  pinCommand: z.string().min(1),
  pinFieldSelector: z.string().default('input[name="pin_code"]'),
  submitSelector: z.string().default('button[type="submit"]'),
  successUrlPattern: z.string().optional(),
})
export type ScenarioTwoFactor = z.infer<typeof ScenarioTwoFactorSchema>

// --- Full scenario schema (spec §3) ---
export const ScenarioSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    businessFlow: z.string().min(1),
    steps: z.array(ScenarioStepSchema).min(1).optional(),
    acts: z.array(ActSchema).min(1).optional(),
    personas: z.array(PersonaSchema).optional(),
    expectedResults: z.array(ExpectedResultSchema).min(1),
    expectedDbState: z.array(ExpectedDbStateSchema),
    precondition: PreconditionSchema.optional(),
    twoFactor: ScenarioTwoFactorSchema.optional(),
  })
  .superRefine((s, ctx) => {
    if ((s.steps !== undefined) === (s.acts !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scenario must have exactly one of `steps` or `acts`' })
    }
    const names = new Set((s.personas ?? []).map((p) => p.name))
    for (const act of s.acts ?? []) {
      if (act.persona !== undefined && !names.has(act.persona)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `act references unknown persona: ${act.persona}` })
      }
    }
    for (const st of [...(s.steps ?? []), ...(s.acts ?? []).flatMap((a) => a.steps)]) {
      if (st.action === 'capture' && !st.var) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'capture step requires `var`' })
      }
    }
  })

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>
export type ExpectedResult = z.infer<typeof ExpectedResultSchema>
export type ExpectedDbState = z.infer<typeof ExpectedDbStateSchema>

/** Full scenario type (replaces the minimal definition in domain/types.ts) */
export type Scenario = z.infer<typeof ScenarioSchema>

/** Acts of a scenario: explicit `acts`, or flat `steps` as one implicit (persona-less) act. */
export function toActs(scenario: Scenario): Act[] {
  return scenario.acts ?? [{ steps: scenario.steps ?? [] }]
}

/** All steps of a scenario, flattened across acts. */
export function allSteps(scenario: Scenario): ScenarioStep[] {
  return toActs(scenario).flatMap((a) => a.steps)
}

/**
 * A scenario as loaded from disk, annotated with its script directory
 * (scenarios/<file-basename>/). `scriptDir` is runtime metadata — it is NOT part of the
 * persisted YAML schema and is stripped before saving.
 */
export type LoadedScenario = Scenario & { scriptDir: string }

const SCENARIO_FILE_SUFFIX = '.scenario.yaml'

/** Scenario ids become filenames — reject anything that isn't a safe slug (no path separators). */
const VALID_ID = /^[A-Za-z0-9_-]+$/
function assertValidId(id: string): void {
  if (!VALID_ID.test(id)) {
    throw new Error(`invalid scenario id (must match [A-Za-z0-9_-]+): ${JSON.stringify(id)}`)
  }
}

/** Strip runtime-only fields (scriptDir) before persisting a scenario to YAML. */
function persistable(scenario: Scenario): Scenario {
  const { scriptDir: _scriptDir, ...rest } = scenario as Scenario & { scriptDir?: string }
  return rest
}

/**
 * Load all *.scenario.yaml files from `dir`, parse, and zod-validate each.
 * Each loaded scenario is annotated with its `scriptDir` (`<dir>/<file-basename>/`).
 * Invalid files are logged and skipped rather than throwing.
 */
export async function loadScenarios(dir: string): Promise<LoadedScenario[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const results: LoadedScenario[] = []
  for (const entry of entries) {
    if (!entry.endsWith(SCENARIO_FILE_SUFFIX)) continue
    const raw = await readYaml<unknown>(join(dir, entry))
    const parsed = ScenarioSchema.safeParse(raw)
    if (parsed.success) {
      const basename = entry.slice(0, -SCENARIO_FILE_SUFFIX.length)
      results.push({ ...parsed.data, scriptDir: join(dir, basename) })
    }
  }
  return results
}

/**
 * Save a scenario to `dir/<id>.scenario.yaml`.
 * Ensures the directory exists before writing. Runtime-only fields (scriptDir) are not persisted.
 */
export async function saveScenario(dir: string, scenario: Scenario): Promise<void> {
  assertValidId(scenario.id)
  await ensureDir(dir)
  const path = join(dir, `${scenario.id}${SCENARIO_FILE_SUFFIX}`)
  await writeYaml(path, persistable(scenario))
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
  await writeYaml(join(proposedDir, `${scenario.id}${SCENARIO_FILE_SUFFIX}`), persistable(scenario))
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
