import { runGrow as defaultRunGrow, type RunGrowDeps, type RunGrowOpts } from './grow.js'

export type ScenarioOpts = {
  /** Additional requirement files to merge (--from flag) → forwarded as grow's source fromPaths */
  from?: string[]
}

/** Injectable dependencies for the (deprecated) scenario alias — makes it testable. */
export type ScenarioDeps = {
  /** Injectable for tests */
  runGrow?: (root: string, opts: RunGrowOpts, deps: RunGrowDeps) => Promise<unknown>
  /** Deprecation-warning sink (defaults to stderr) */
  warn?: (msg: string) => void
  /** Real grow deps forwarded to runGrow (browser/llm/repo wiring) */
  growDeps?: Partial<RunGrowDeps>
}

/**
 * @deprecated `scenario` is now an alias of `grow --source-only`. It generates scenarios from
 * repository source/requirements (no live crawl) and saves them as `proposed/` drafts (use
 * `loop-e2e approve` to adopt). Prefer `loop-e2e grow --source-only`.
 */
export async function runScenario(root: string, opts: ScenarioOpts, deps: ScenarioDeps = {}): Promise<void> {
  const runGrow = deps.runGrow ?? defaultRunGrow
  const warn = deps.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  warn('`scenario` is deprecated — it now runs `grow --source-only`. Use `loop-e2e grow --source-only`.')
  await runGrow(root, { sourceOnly: true, fromPaths: opts.from }, (deps.growDeps ?? {}) as RunGrowDeps)
}
