import { logger } from '../util/logger.js'
import {
  executeScenario as defaultExecuteScenario,
  executeSteps as defaultExecuteSteps,
} from '../services/browser/scenarioExec.js'
import type { ScenarioExecDeps } from '../services/browser/scenarioExec.js'
import {
  ensureAuthenticated as defaultEnsureAuth,
  ensureUnauthenticated as defaultEnsureUnauth,
} from '../services/browser/session.js'
import type { SessionDeps } from '../services/browser/session.js'
import type { PageLike } from '../services/browser/crawler.js'
import type { Scenario, Persona, ScenarioStep } from '../scenario/schema.js'
import type { TargetEnv, VerifyFinding } from '../domain/types.js'

type Creds = { username: string; password: string }

export type ExecuteScenariosDeps = ScenarioExecDeps &
  SessionDeps & {
    executeScenario?: typeof defaultExecuteScenario
    executeSteps?: typeof defaultExecuteSteps
    ensureAuthenticated?: typeof defaultEnsureAuth
    ensureUnauthenticated?: typeof defaultEnsureUnauth
    /** env source for persona credEnv resolution (defaults to process.env) */
    secretsEnv?: Record<string, string | undefined>
    /** Resolve a persona's target name → its TargetEnv + credentials (built from config.targets). */
    resolveTarget?: (name: string) => { target: TargetEnv; creds: Creds } | undefined
  }

/** The auth probe target for an authenticated scenario is its first navigate step (default '/'). */
function firstNavigateTarget(s: Scenario): string {
  const nav = (s.steps ?? []).find((st) => st.action === 'navigate')
  return nav?.target ?? '/'
}

/** First navigate target within a single act's steps (default '/'). */
function firstNavOf(steps: ScenarioStep[]): string {
  return steps.find((st) => st.action === 'navigate')?.target ?? '/'
}

/** Resolve a persona's credentials: credEnv from env when present, else the run credentials. */
export function resolvePersonaCreds(
  persona: Persona | undefined,
  runCreds: Creds,
  env: Record<string, string | undefined>,
): Creds {
  if (persona?.credEnv) {
    return { username: env[persona.credEnv.usernameEnv] ?? '', password: env[persona.credEnv.passwordEnv] ?? '' }
  }
  return runCreds
}

/** Build a scenario VerifyFinding, appending the unverified api/db expectedResults note on success. */
function scenarioFinding(scenario: Scenario, ok: boolean, detail: string, finalUrl: string): VerifyFinding {
  const unverified = scenario.expectedResults.filter((e) => e.kind === 'api' || e.kind === 'db')
  let d = detail
  if (ok && unverified.length > 0) {
    d += ` | unverified expectedResults (needs LLM/manual): ${unverified
      .map((e) => `${e.kind}:${e.assertion}`)
      .join('; ')}`
  }
  return {
    category: 'scenario',
    severity: ok ? 'low' : 'high',
    title: scenario.title,
    detail: d,
    evidence: `${scenario.id} @ ${finalUrl}`,
  }
}

/**
 * Run a multi-act scenario: each act establishes its persona's session (re-login on identity
 * change) and runs its steps against a shared, mutable vars bag (capture → {{VAR}}).
 * Returns a single scenario finding; the first failing act stops the flow.
 */
async function runMultiAct(
  page: PageLike,
  runTarget: TargetEnv,
  scenario: Scenario,
  runCreds: Creds,
  deps: ExecuteScenariosDeps,
): Promise<VerifyFinding> {
  const exec = deps.executeSteps ?? defaultExecuteSteps
  const ensureAuth = deps.ensureAuthenticated ?? defaultEnsureAuth
  const ensureUnauth = deps.ensureUnauthenticated ?? defaultEnsureUnauth
  const env = deps.secretsEnv ?? process.env
  const personas = new Map((scenario.personas ?? []).map((p) => [p.name, p]))
  // Seed from the inherited bag (env credentials like {{TARGET_USER}} live in deps.vars) so
  // multi-act scenarios resolve them too; captures then accumulate/override across acts.
  const vars: Record<string, string> = { ...(deps.vars ?? {}) }
  const acts = scenario.acts ?? []
  let prevPersona: string | undefined
  let prevTargetName: string | undefined
  let lastUrl = ''

  for (let ai = 0; ai < acts.length; ai++) {
    const act = acts[ai]
    const persona = act.persona ? personas.get(act.persona) : undefined
    const label = `act ${ai} (persona ${persona?.name ?? '-'})`

    // Resolve the act's target: persona.target → another configured target, else the run target.
    let actTarget = runTarget
    let baseCreds = runCreds
    if (persona?.target) {
      const resolved = deps.resolveTarget?.(persona.target)
      if (!resolved) {
        return scenarioFinding(scenario, false, `${label} cannot use target '${persona.target}' (not in config.targets, or missing auth/credentials)`, lastUrl)
      }
      actTarget = resolved.target
      baseCreds = resolved.creds
    }

    const auth = persona?.auth ?? scenario.precondition?.auth ?? 'authenticated'
    let actSecrets = deps.secrets ?? []
    if (auth === 'authenticated') {
      const personaCreds = resolvePersonaCreds(persona, baseCreds, env)
      if (persona?.credEnv && (!personaCreds.username || !personaCreds.password)) {
        return scenarioFinding(
          scenario, false,
          `${label} persona credEnv not set (check ${persona.credEnv.usernameEnv}/${persona.credEnv.passwordEnv} in .env)`,
          lastUrl,
        )
      }
      actSecrets = [...(deps.secrets ?? []), personaCreds.username, personaCreds.password].filter(Boolean)
      // Re-login only when switching identity ON THE SAME target; a different target is a separate
      // domain/session. Note: clearCookies (forceReauth) wipes the WHOLE context, so an
      // A→B→A' flow (same target A, new identity) also drops B's session — acceptable, rare.
      const forceReauth = ai > 0 && actTarget.name === prevTargetName && persona?.name !== prevPersona
      const r = await ensureAuth(page, actTarget, personaCreds, firstNavOf(act.steps), { ...deps, secrets: actSecrets, forceReauth })
      if (!r.ok) {
        return scenarioFinding(scenario, false, `${label} auth failed: ${r.detail}`, lastUrl)
      }
    } else {
      await ensureUnauth(page, actTarget, deps)
    }
    prevPersona = persona?.name
    prevTargetName = actTarget.name

    const res = await exec(page, actTarget, act.steps, { ...deps, secrets: actSecrets, vars })
    lastUrl = res.finalUrl
    if (!res.ok) {
      return scenarioFinding(scenario, false, `${label} ${res.detail}`, res.finalUrl)
    }
    logger.info({ scenario: scenario.id, act: ai, persona: persona?.name, target: actTarget.name }, 'act executed')
  }

  const stepCount = acts.reduce((n, a) => n + a.steps.length, 0)
  return scenarioFinding(scenario, true, `passed (${acts.length} acts, ${stepCount} steps)`, lastUrl)
}

/**
 * Execute all active scenarios against the live page, applying each scenario's
 * `precondition.auth`, and map results to VerifyFinding(category:'scenario').
 * A single session is reused; if authentication fails, the remaining
 * authenticated scenarios are skipped with one high finding.
 */
export async function executeScenarios(
  page: PageLike,
  target: TargetEnv,
  scenarios: Scenario[],
  creds: { username: string; password: string },
  deps: ExecuteScenariosDeps = {},
): Promise<VerifyFinding[]> {
  const exec = deps.executeScenario ?? defaultExecuteScenario
  const ensureAuth = deps.ensureAuthenticated ?? defaultEnsureAuth
  const ensureUnauth = deps.ensureUnauthenticated ?? defaultEnsureUnauth
  const findings: VerifyFinding[] = []
  let authBlocked = false

  for (const scenario of scenarios) {
    if (scenario.acts && scenario.acts.length > 0) {
      findings.push(await runMultiAct(page, target, scenario, creds, deps))
      continue
    }

    const auth = scenario.precondition?.auth
    if (auth === 'authenticated') {
      if (authBlocked) continue
      const r = await ensureAuth(page, target, creds, firstNavigateTarget(scenario), deps)
      if (!r.ok) {
        authBlocked = true
        findings.push({
          category: 'scenario',
          severity: 'high',
          title: 'authentication failed',
          detail: `could not establish a session for authenticated scenarios: ${r.detail}`,
          evidence: scenario.id,
        })
        continue
      }
    } else if (auth === 'unauthenticated') {
      await ensureUnauth(page, target, deps)
    }

    const result = await exec(page, target, scenario, deps)
    findings.push(scenarioFinding(scenario, result.ok, result.detail, result.finalUrl))
    logger.info({ scenario: scenario.id, ok: result.ok }, 'scenario executed')
  }
  return findings
}
