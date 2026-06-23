import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario, ScenarioStep, LoadedScenario } from '../../scenario/schema.js'
import type { ComposeRunner } from '../compose/compose.js'

export type ScenarioRunResult = {
  scenarioId: string
  ok: boolean
  failedStepIndex?: number
  /** Human-readable detail — masked, never contains secret values */
  detail: string
  finalUrl: string
}

export type StepsResult = {
  ok: boolean
  failedStepIndex?: number
  /** Human-readable detail — masked, never contains secret/captured values */
  detail: string
  finalUrl: string
}

export type ScenarioExecDeps = {
  pinRunner?: ComposeRunner
  /** {{ENVNAME}} resolution source (falls back to process.env) */
  vars?: Record<string, string>
  /** command run to resolve {{TWO_FACTOR_PIN}} (defaults to the executing scenario's twoFactor.pinCommand) */
  pinCommand?: string
  /** cwd for pinCommand — the scenario's script dir (scenarios/<name>/) */
  scriptDir?: string
  /** values to mask out of detail/logs */
  secrets?: string[]
  /** max ms for wait/submit polling (default 8000) */
  navTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolve a step's navigate target to an absolute URL. */
export function resolveUrl(baseUrl: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target
  return `${baseUrl.replace(/\/$/, '')}/${target.replace(/^\//, '')}`
}

async function resolveInput(raw: string | undefined, deps: ScenarioExecDeps): Promise<string> {
  if (!raw) return ''
  const missing: string[] = []
  let out = raw
  // {{TWO_FACTOR_PIN}} → run pinCommand, take first 4-8 digit run
  if (out.includes('{{TWO_FACTOR_PIN}}')) {
    let pin = ''
    if (deps.pinRunner && deps.pinCommand) {
      const { stdout } = await deps.pinRunner('sh', ['-c', deps.pinCommand], deps.scriptDir ? { cwd: deps.scriptDir } : undefined)
      pin = (stdout.match(/\d{4,8}/) ?? [''])[0]
    }
    if (!pin) missing.push('TWO_FACTOR_PIN')
    out = out.replaceAll('{{TWO_FACTOR_PIN}}', pin)
  }
  // {{ENVNAME}} → vars then process.env. An unresolved reference fails the step
  // (spec §8); only the placeholder NAME (never its value) appears in the error.
  out = out.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name: string) => {
    const v = deps.vars?.[name] ?? process.env[name]
    if (v === undefined) {
      missing.push(name)
      return ''
    }
    return v
  })
  if (missing.length > 0) throw new Error(`unresolved placeholder(s): ${missing.join(', ')}`)
  return out
}

/**
 * Execute a scenario's steps against a live page, deterministically (single-act wrapper).
 * Returns ok:false with the failing step index on the first failure.
 * Credential/PIN values are masked out of the returned detail.
 */
export async function executeScenario(
  page: PageLike,
  target: TargetEnv,
  scenario: Scenario,
  deps: ScenarioExecDeps = {},
): Promise<ScenarioRunResult> {
  // {{TWO_FACTOR_PIN}} resolves via this scenario's own 2FA command (run in its script dir),
  // falling back to deps for the synthetic/login-stage paths.
  const execDeps: ScenarioExecDeps = {
    ...deps,
    pinCommand: scenario.twoFactor?.pinCommand ?? deps.pinCommand,
    scriptDir: (scenario as LoadedScenario).scriptDir ?? deps.scriptDir,
  }
  const r = await executeSteps(page, target, scenario.steps ?? [], execDeps)
  return { scenarioId: scenario.id, ...r }
}

/**
 * Execute a list of steps on a live page with a shared (mutable) vars bag.
 * `capture` writes `vars[step.var]`; `{{VAR}}`/`{{ENV}}`/`{{TWO_FACTOR_PIN}}` are resolved in
 * BOTH input and target. Failure detail shows the RAW (unresolved) target so captured/secret
 * values never leak. Secrets are masked.
 */
export async function executeSteps(
  page: PageLike,
  target: TargetEnv,
  steps: ScenarioStep[],
  deps: ScenarioExecDeps = {},
): Promise<StepsResult> {
  const baseUrl = target.baseUrl
  const secrets = deps.secrets ?? []
  const navTimeoutMs = deps.navTimeoutMs ?? 8000
  const sleep = deps.sleep ?? defaultSleep
  const intervalMs = 250
  const attempts = Math.max(1, Math.ceil(navTimeoutMs / intervalMs))
  const mask = (s: string): string => maskSecrets(s, secrets)

  const fail = (i: number, why: string): StepsResult => ({
    ok: false,
    failedStepIndex: i,
    detail: mask(`step ${i} (${steps[i]?.action}) failed: ${why}`),
    finalUrl: page.url(),
  })

  for (let i = 0; i < steps.length; i++) {
    const step: ScenarioStep = steps[i]
    try {
      const stepTarget = await resolveInput(step.target, deps) // resolve {{VAR}}/{{ENV}} in the target too
      switch (step.action) {
        case 'navigate': {
          await page.goto(resolveUrl(baseUrl, stepTarget), { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await page.waitForLoadState('networkidle')
          break
        }
        case 'click': {
          await page.locator(stepTarget).click()
          break
        }
        case 'fill': {
          await page.locator(stepTarget).fill(await resolveInput(step.input, deps))
          break
        }
        case 'submit': {
          const before = page.url()
          await page.locator(stepTarget).click()
          await page.waitForLoadState('networkidle')
          for (let a = 0; a < attempts; a++) {
            if (page.url() !== before) break
            await sleep(intervalMs)
          }
          break
        }
        case 'wait': {
          const ok = await pollCondition(page, stepTarget, attempts, intervalMs, sleep)
          if (!ok) return fail(i, `wait condition not met: ${step.target}`)
          break
        }
        case 'assert': {
          const ok = await checkCondition(page, stepTarget)
          if (!ok) return fail(i, `assertion not satisfied: ${step.target}`)
          break
        }
        case 'capture': {
          if (!step.var) return fail(i, 'capture step requires `var`')
          const val = await readCapture(page, stepTarget)
          if (val === null) return fail(i, `capture target not found: ${step.target}`)
          if (deps.vars) deps.vars[step.var] = val
          break
        }
        default:
          return fail(i, `unsupported action: ${step.action}`)
      }
    } catch (err) {
      return fail(i, err instanceof Error ? err.message : String(err))
    }
  }

  logger.info({ finalUrl: page.url() }, 'steps passed')
  return { ok: true, detail: `passed (${steps.length} steps)`, finalUrl: page.url() }
}

/** Read a capture target: input value first, then trimmed textContent; null if absent/empty. */
async function readCapture(page: PageLike, selector: string): Promise<string | null> {
  const loc = page.locator(selector)
  if (loc.count && (await loc.count()) === 0) return null
  if (loc.inputValue) {
    try {
      const v = await loc.inputValue()
      if (v !== '') return v
    } catch {
      /* not an input — fall through to textContent */
    }
  }
  if (loc.textContent) {
    const t = await loc.textContent()
    if (t !== null && t.trim() !== '') return t.trim()
  }
  return null
}

/** Evaluate an assert/wait target: text= (content), url= (current URL), else selector existence. */
async function checkCondition(page: PageLike, target: string): Promise<boolean> {
  if (target.startsWith('text=')) return (await page.content()).includes(target.slice(5))
  if (target.startsWith('url=')) return page.url().includes(target.slice(4))
  const loc = page.locator(target)
  return loc.count ? (await loc.count()) > 0 : (await page.content()).includes(target)
}

/** Poll until a condition holds; a bare integer target is a fixed ms sleep. */
async function pollCondition(
  page: PageLike,
  target: string,
  attempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const ms = Number(target)
  if (Number.isFinite(ms) && String(ms) === target.trim()) {
    await sleep(ms)
    return true
  }
  for (let a = 0; a < attempts; a++) {
    if (await checkCondition(page, target)) return true
    await sleep(intervalMs)
  }
  return false
}
