import { logger } from '../util/logger.js'
import { executeScenario as defaultExecuteScenario } from '../services/browser/scenarioExec.js'
import type { ScenarioExecDeps } from '../services/browser/scenarioExec.js'
import {
  ensureAuthenticated as defaultEnsureAuth,
  ensureUnauthenticated as defaultEnsureUnauth,
} from '../services/browser/session.js'
import type { SessionDeps } from '../services/browser/session.js'
import type { PageLike } from '../services/browser/crawler.js'
import type { Scenario } from '../scenario/schema.js'
import type { TargetEnv, VerifyFinding } from '../domain/types.js'

export type ExecuteScenariosDeps = ScenarioExecDeps &
  SessionDeps & {
    executeScenario?: typeof defaultExecuteScenario
    ensureAuthenticated?: typeof defaultEnsureAuth
    ensureUnauthenticated?: typeof defaultEnsureUnauth
  }

/** The auth probe target for an authenticated scenario is its first navigate step (default '/'). */
function firstNavigateTarget(s: Scenario): string {
  const nav = (s.steps ?? []).find((st) => st.action === 'navigate')
  return nav?.target ?? '/'
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
    const unverified = scenario.expectedResults.filter((e) => e.kind === 'api' || e.kind === 'db')
    let detail = result.detail
    if (result.ok && unverified.length > 0) {
      detail += ` | unverified expectedResults (needs LLM/manual): ${unverified
        .map((e) => `${e.kind}:${e.assertion}`)
        .join('; ')}`
    }
    findings.push({
      category: 'scenario',
      severity: result.ok ? 'low' : 'high',
      title: scenario.title,
      detail,
      evidence: `${scenario.id} @ ${result.finalUrl}`,
    })
    logger.info({ scenario: scenario.id, ok: result.ok }, 'scenario executed')
  }
  return findings
}
